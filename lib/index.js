/**
 * DeepSeek 计费罗盘 · Billing Compass —— 宿主半边。
 *
 * 数据来源:
 *   1. 余额        GET https://api.deepseek.com/user/balance           (BALANCE_KEY, 默认 DEEPSEEK_API_KEY)
 *   2. 官网用量    GET https://platform.deepseek.com/api/v0/usage/amount?month&year   (PLATFORM_TOKEN, 默认 DEEPSEEK_USER_TOKEN)
 *   3. 官网消费    GET https://platform.deepseek.com/api/v0/usage/export?month&year   (同上,zip 内 cost-*.csv)
 *   4. 本次运行    localStorage 拦截 llm/stream 的 usage × 内置单价(仅内存)
 *   5. 整段对话   只读解析 $DSH_HOME/sessions/<cwd>/<sessionId>/session.vN.jsonl.zstd
 *
 * 设计约束:
 *   - 不落盘:所有统计只在内存,进程重启即清零(会话日志只读不改)。
 *   - 无外部依赖:HTTP 用 node:https,zstd/zip 用 node:zlib,不依赖 pwsh/curl/解压工具。
 *   - 凭据缺失 = "未配置"而不是报错:只隐藏对应指标,不影响其它数据。
 */
export const name = 'dsh-billing-compass'
export const inject = ['timer', 'webServer']

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const PLATFORM = 'https://platform.deepseek.com'
const MAX_CALLS = 3000
const UA = 'Mozilla/5.0 (compatible; dsh-billing-compass)'

/** 内置单价:USD / 1M tokens,仅用于"实时/整段"估算,可按 config.pricing 覆盖。 */
const DEFAULT_PRICING = {
  'deepseek-chat': { input: 0.28, cacheHit: 0.028, output: 0.42 },
  'deepseek-reasoner': { input: 0.55, cacheHit: 0.14, output: 2.19 },
  'deepseek-v4-flash': { input: 0.28, cacheHit: 0.028, output: 0.42 },
  'deepseek-v4-pro': { input: 0.55, cacheHit: 0.14, output: 2.19 },
}
const FALLBACK_PRICE = { input: 0.28, cacheHit: 0.028, output: 0.42 }

export function apply(ctx, config) {
  const cfg = (config && typeof config === 'object') ? config : {}
  const round2 = (n) => Math.round(n * 100) / 100
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v)) ? v : d

  const PRICING = Object.assign({}, DEFAULT_PRICING, (cfg.pricing && typeof cfg.pricing === 'object') ? cfg.pricing : {})
  const BALANCE_KEY_REF = String(cfg.balanceKeyRef || 'DEEPSEEK_API_KEY')
  const PLATFORM_TOKEN_REF = String(cfg.platformTokenRef || 'DEEPSEEK_USER_TOKEN')
  const BALANCE_MS = Math.max(10000, num(cfg.balanceIntervalMs, 30000))
  const OFFICIAL_MS = Math.max(60000, num(cfg.officialIntervalMs, 300000))
  const RETRY_MS = Math.max(10000, num(cfg.retryIntervalMs, 30000))
  const ENABLE_SESSION_LOG = cfg.sessionLog !== false

  const startedAt = Date.now()
  let calls = []
  const recentCalls = new Map()
  let balance = { state: 'pending', at: startedAt }
  let official = emptyOfficial('pending')
  let cost = emptyCost('pending')
  let fetching = null
  let offFetching = null
  let costFetching = null

  function emptyOfficial(state, err = null) {
    return { state, err, fetchedAt: 0, tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, hitRate: null, perModel: [] }
  }
  function emptyCost(state, err = null) {
    return { state, err, fetchedAt: 0, total: 0, currency: 'CNY', perModel: [] }
  }
  function priceOf(model) {
    const key = String(model || '')
    if (PRICING[key]) return PRICING[key]
    if (/flash/i.test(key)) return PRICING['deepseek-v4-flash'] || FALLBACK_PRICE
    if (/pro|reasoner/i.test(key)) return PRICING['deepseek-v4-pro'] || FALLBACK_PRICE
    return FALLBACK_PRICE
  }

  // ================= 实时:拦截每次模型调用(仅内存) =================
  ctx.on('llm/stream', (options, next) => {
    const chained = next()
    return (async function* () {
      let usage = null
      for await (const chunk of chained) {
        if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage
        yield chunk
      }
      if (usage) recordUsage(options, usage)
    })()
  })

  function recordUsage(options, usage) {
    const model = typeof options.model === 'string' ? options.model : 'unknown'
    const key = `${options.sessionId || ''}|${model}|${(options.messages || []).length}|${(options.system || '').length}`
    const now = Date.now()
    const last = recentCalls.get(key)
    if (last !== undefined && now - last < 10000) return
    recentCalls.set(key, now)
    if (recentCalls.size > 200) {
      for (const [k, t] of recentCalls) if (now - t > 60000) recentCalls.delete(k)
    }
    const input = usage.inputTokens || 0
    const output = usage.outputTokens || 0
    const cacheRead = usage.cacheReadTokens || 0
    const cacheWrite = usage.cacheWriteTokens || 0
    const p = priceOf(model)
    const c = ((input + cacheWrite) / 1e6) * p.input + (cacheRead / 1e6) * p.cacheHit + (output / 1e6) * p.output
    calls.push({ t: now, sid: typeof options.sessionId === 'string' ? options.sessionId : '', m: model, i: input, o: output, cr: cacheRead, cw: cacheWrite, c: c })
    if (calls.length > MAX_CALLS) calls = calls.slice(calls.length - MAX_CALLS)
  }

  // ================= HTTP(纯 node,不依赖 curl/pwsh) =================
  function httpGet(url, headers, opts = {}) {
    const maxBytes = num(opts.maxBytes, 8 * 1024 * 1024)
    const timeoutMs = num(opts.timeoutMs, 20000)
    const depth = num(opts.depth, 0)
    return new Promise((resolve) => {
      let req
      try {
        req = https.request(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
          const status = res.statusCode || 0
          const loc = res.headers && res.headers.location
          if (status >= 300 && status < 400 && loc && depth < 5) {
            res.resume()
            resolve(httpGet(new URL(loc, url).toString(), headers, { maxBytes, timeoutMs, depth: depth + 1 }))
            return
          }
          const chunks = []
          let size = 0
          res.on('data', (c) => {
            size += c.length
            if (size > maxBytes) { req.destroy(new Error('响应过大')); return }
            chunks.push(c)
          })
          res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }))
        })
      } catch (e) {
        resolve({ status: 0, body: Buffer.alloc(0), error: String((e && e.message) || e) })
        return
      }
      req.on('timeout', () => req.destroy(new Error('请求超时')))
      req.on('error', (e) => resolve({ status: 0, body: Buffer.alloc(0), error: String((e && e.message) || e) }))
      req.end()
    })
  }

  function jsonOf(res) {
    if (res.status === 0) throw new Error(res.error || '网络错误')
    if (res.status !== 200) throw new Error('HTTP ' + res.status)
    const text = res.body.toString('utf8')
    try { return JSON.parse(text) } catch (e) { throw new Error('响应不是 JSON: ' + text.slice(0, 160)) }
  }

  // ================= ZIP / CSV(纯 node:zlib) =================
  /** 极简 ZIP 解析:支持 stored(0) 与 deflate(8),够用于导出的 CSV 包。 */
  function unzip(buf) {
    let eocd = -1
    const floor = Math.max(0, buf.length - 65558)
    for (let i = buf.length - 22; i >= floor; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('zip 结构无法识别')
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    const entries = []
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏')
      const method = buf.readUInt16LE(p + 10)
      const compSize = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      const localOff = buf.readUInt32LE(p + 42)
      const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen)
      if (localOff + 30 <= buf.length) {
        const lNameLen = buf.readUInt16LE(localOff + 26)
        const lExtraLen = buf.readUInt16LE(localOff + 28)
        const start = localOff + 30 + lNameLen + lExtraLen
        const raw = buf.subarray(start, start + compSize)
        let data = null
        if (method === 0) data = raw
        else if (method === 8) {
          try { data = zlib.inflateRawSync(raw) } catch (e) { data = null }
        }
        if (data) entries.push({ name: entryName, data })
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  }

  function parseCsv(text) {
    const rows = []
    let row = []
    let field = ''
    let quoted = false
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
        } else field += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') { row.push(field); field = '' }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (ch !== '\r') field += ch
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
    return rows.filter((r) => r.some((c) => String(c).trim().length > 0))
  }

  // ================= 凭据:env → credentials 服务 → .credentials.yaml =================
  function dshHome() {
    const fromEnv = process.env.DSH_HOME || (process.env.DSH_PROJECT ? join(process.env.DSH_PROJECT, '.dsh-home') : '')
    return fromEnv ? String(fromEnv).replace(/[\\/]+$/, '') : ''
  }

  function readYamlScalar(text, key) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const strip = (raw) => {
      let v = String(raw).trim()
      if (v.length >= 2) {
        const a = v[0]
        const b = v[v.length - 1]
        if ((a === '"' && b === '"') || (a === "'" && b === "'")) v = v.slice(1, -1)
      }
      return v.length > 0 ? v : undefined
    }
    const block = new RegExp('^[ \\t]*' + esc + ':[ \\t]*(.+?)[ \\t]*$', 'm').exec(text)
    if (block) {
      const v = strip(block[1])
      if (v !== undefined) return v
    }
    const flow = new RegExp('[{\\[,][ \\t]*' + esc + ':[ \\t]*([^,}\\]]+)').exec(text)
    if (flow) return strip(flow[1])
    return undefined
  }

  async function resolveSecret(key) {
    const fromEnv = process.env[key]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
    try {
      const credentials = ctx.get('credentials')
      if (credentials && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(key)
        if (hit && hit.value) return hit.value
      }
    } catch (e) { /* 服务不可用:继续走文件 */ }
    const home = dshHome()
    if (!home) return undefined
    try {
      return readYamlScalar(await readFile(join(home, '.credentials.yaml'), 'utf8'), key)
    } catch (e) {
      return undefined
    }
  }

  // ================= 1) 余额 =================
  async function refreshBalance() {
    if (fetching) return fetching
    fetching = (async () => {
      try {
        const key = await resolveSecret(BALANCE_KEY_REF)
        if (!key) {
          balance = { state: 'unconfigured', keyRef: BALANCE_KEY_REF, at: Date.now() }
          return
        }
        const data = jsonOf(await httpGet(BALANCE_URL, {
          Authorization: 'Bearer ' + key, Accept: 'application/json', 'User-Agent': UA,
        }))
        const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
        const info = infos[0] || null
        balance = {
          state: 'ok',
          available: data.is_available === true,
          currency: info ? String(info.currency) : 'CNY',
          total: info && info.total_balance !== undefined ? Number(info.total_balance) : null,
          granted: info && info.granted_balance !== undefined ? Number(info.granted_balance) : null,
          toppedUp: info && info.topped_up_balance !== undefined ? Number(info.topped_up_balance) : null,
          at: Date.now(),
        }
      } catch (err) {
        balance = { state: 'error', message: String((err && err.message) || err).slice(0, 300), at: Date.now() }
      } finally {
        fetching = null
      }
    })()
    return fetching
  }

  // ================= 2) 官网用量(本月 + 上月) =================
  function recentMonths() {
    const now = new Date()
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return [
      { m: now.getMonth() + 1, y: now.getFullYear() },
      { m: prev.getMonth() + 1, y: prev.getFullYear() },
    ]
  }

  async function fetchOfficial() {
    if (offFetching) return offFetching
    offFetching = (async () => {
      try {
        const token = await resolveSecret(PLATFORM_TOKEN_REF)
        if (!token) {
          official = Object.assign(emptyOfficial('unconfigured'), { keyRef: PLATFORM_TOKEN_REF })
          return
        }
        const headers = { Authorization: 'Bearer ' + token, 'User-Agent': UA, Accept: 'application/json' }
        const perModel = new Map()
        let apiErr = null
        let got = false
        for (const p of recentMonths()) {
          const res = await httpGet(`${PLATFORM}/api/v0/usage/amount?month=${p.m}&year=${p.y}`, headers)
          if (res.status !== 200) { apiErr = apiErr || ('HTTP ' + res.status); continue }
          let j = null
          try { j = JSON.parse(res.body.toString('utf8')) } catch (e) { apiErr = apiErr || '响应解析失败'; continue }
          if (!j || j.code !== 0) { apiErr = apiErr || ('官网 code ' + (j && j.code) + (j && j.msg ? ': ' + j.msg : '')); continue }
          got = true
          const biz = j.data && j.data.biz_data
          const days = biz && Array.isArray(biz.days) ? biz.days : []
          for (const d of days) {
            for (const mm of (Array.isArray(d && d.data) ? d.data : [])) {
              if (!mm || !mm.model) continue
              const g = perModel.get(mm.model) || { model: mm.model, hit: 0, miss: 0, output: 0, requests: 0 }
              for (const u of (Array.isArray(mm.usage) ? mm.usage : [])) {
                if (!u || !u.type) continue
                const amount = parseFloat(u.amount) || 0
                if (u.type === 'PROMPT_CACHE_HIT_TOKEN') g.hit += amount
                else if (u.type === 'PROMPT_CACHE_MISS_TOKEN') g.miss += amount
                else if (u.type === 'RESPONSE_TOKEN') g.output += amount
                else if (u.type === 'REQUEST') g.requests += amount
              }
              perModel.set(mm.model, g)
            }
          }
        }
        if (!got && apiErr) throw new Error(apiErr)
        const list = []
        let tokens = 0, hit = 0, miss = 0, output = 0, requests = 0
        for (const g of perModel.values()) {
          const t = g.hit + g.miss + g.output
          list.push({ model: g.model, hit: g.hit, miss: g.miss, output: g.output, requests: g.requests, tokens: t })
          tokens += t; hit += g.hit; miss += g.miss; output += g.output; requests += g.requests
        }
        list.sort((a, b) => b.tokens - a.tokens)
        official = {
          state: 'ok', err: apiErr, fetchedAt: Date.now(), tokens, hit, miss, output, requests,
          hitRate: (hit + miss) > 0 ? hit / (hit + miss) : null, perModel: list,
        }
      } catch (e) {
        official = Object.assign(emptyOfficial('error', String((e && e.message) || e).slice(0, 300)), { fetchedAt: Date.now() })
      } finally {
        offFetching = null
      }
    })()
    return offFetching
  }

  // ================= 3) 官网消费(导出 zip → cost-*.csv) =================
  async function fetchCost() {
    if (costFetching) return costFetching
    costFetching = (async () => {
      try {
        const token = await resolveSecret(PLATFORM_TOKEN_REF)
        if (!token) {
          cost = Object.assign(emptyCost('unconfigured'), { keyRef: PLATFORM_TOKEN_REF })
          return
        }
        const headers = { Authorization: 'Bearer ' + token, 'User-Agent': UA, Accept: 'application/zip' }
        let total = 0
        let currency = 'CNY'
        let errMsg = null
        let got = false
        const perModel = new Map()
        for (const p of recentMonths()) {
          const res = await httpGet(`${PLATFORM}/api/v0/usage/export?month=${p.m}&year=${p.y}`, headers, { maxBytes: 32 * 1024 * 1024 })
          if (res.status !== 200) { errMsg = errMsg || ('导出 HTTP ' + res.status); continue }
          let entries = []
          try { entries = unzip(res.body) } catch (e) { errMsg = errMsg || ('zip 解析失败: ' + ((e && e.message) || e)); continue }
          const target = entries.filter((en) => /(^|\/)cost-[^/]*\.csv$/i.test(en.name))
          if (target.length === 0) { errMsg = errMsg || '导出包内没有 cost-*.csv'; continue }
          got = true
          for (const en of target) {
            const rows = parseCsv(en.data.toString('utf8'))
            if (rows.length < 2) continue
            const head = rows[0].map((h) => String(h).trim().toLowerCase())
            const iModel = head.indexOf('model')
            const iCost = head.indexOf('cost')
            const iCur = head.indexOf('currency')
            if (iCost < 0) continue
            for (let r = 1; r < rows.length; r += 1) {
              const row = rows[r]
              const c = Number(row[iCost])
              if (!Number.isFinite(c)) continue
              total += c
              const cur = iCur >= 0 ? String(row[iCur] || '').trim() : ''
              if (cur) currency = cur
              const model = iModel >= 0 ? String(row[iModel] || '').trim() : ''
              if (model) {
                const g = perModel.get(model) || { model, cost: 0 }
                g.cost += c
                perModel.set(model, g)
              }
            }
          }
        }
        if (!got && errMsg) throw new Error(errMsg)
        cost = {
          state: 'ok', err: errMsg, fetchedAt: Date.now(), total: round2(total), currency,
          perModel: [...perModel.values()].map((g) => ({ model: g.model, cost: round2(g.cost) })).sort((a, b) => b.cost - a.cost),
        }
      } catch (e) {
        cost = Object.assign(emptyCost('error', String((e && e.message) || e).slice(0, 300)), { fetchedAt: Date.now() })
      } finally {
        costFetching = null
      }
    })()
    return costFetching
  }

  // ================= 4) 整段对话:只读解析会话日志 =================
  // 日志是「多帧 zstd」追加流;node 的 zstdDecompressSync 只解第一帧,这里按帧结构手工切帧。
  const SESSION_LOG_CACHE = new Map()
  const SESSION_LOG_TTL = 60000
  const ZMAGIC = [0x28, 0xb5, 0x2f, 0xfd]

  function frameByteLength(buf, off) {
    if (off + 5 > buf.length) return -1
    const desc = buf[off + 4]
    const fcsFlag = desc >> 6
    const singleSegment = (desc >> 5) & 1
    const dictIdFlag = desc & 3
    const hasChecksum = (desc >> 2) & 1
    let p = off + 5
    if (!singleSegment) p += 1
    p += [0, 1, 2, 4][dictIdFlag]
    p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]
    for (;;) {
      if (p + 3 > buf.length) return -1
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      p += 3
      if (type === 1) {
        if (p + 1 > buf.length) return -1
        p += 1
      } else {
        if (p + size > buf.length) return -1
        p += size
      }
      if (last) break
    }
    if (hasChecksum) p += 4
    if (p > buf.length) return -1
    return p - off
  }

  function decodeSessionLog(buf) {
    const unzstd = (zlib && typeof zlib.zstdDecompressSync === 'function') ? zlib.zstdDecompressSync : null
    if (!unzstd) return null
    const parts = []
    let pos = 0
    while (pos + 8 <= buf.length) {
      if (!(buf[pos] === ZMAGIC[0] && buf[pos + 1] === ZMAGIC[1] && buf[pos + 2] === ZMAGIC[2] && buf[pos + 3] === ZMAGIC[3])) break
      const len = frameByteLength(buf, pos)
      if (len <= 0) break
      try { parts.push(unzstd(buf.subarray(pos, pos + len))) } catch (e) { break }
      pos += len
    }
    if (parts.length === 0) return null
    return Buffer.concat(parts).toString('utf8')
  }

  function summarizeSessionLog(text) {
    const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 }
    const per = new Map()
    for (const line of text.split('\n')) {
      if (line.charCodeAt(0) !== 123 || line.indexOf('"assistant/message"') < 0) continue
      let rec = null
      try { rec = JSON.parse(line) } catch (e) { continue }
      if (!rec || rec.type !== 'assistant/message') continue
      const data = rec.data || {}
      const usage = data.usage
      if (!usage) continue
      const model = (data.message && data.message.source && data.message.source.model) || 'unknown'
      const i = Number(usage.inputTokens) || 0
      const o = Number(usage.outputTokens) || 0
      const cr = Number(usage.cacheReadTokens) || 0
      const cw = Number(usage.cacheWriteTokens) || 0
      const p = priceOf(model)
      const c = ((i + cw) / 1e6) * p.input + (cr / 1e6) * p.cacheHit + (o / 1e6) * p.output
      let m = per.get(model)
      if (!m) {
        m = { model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 }
        per.set(model, m)
      }
      m.calls += 1; m.inputTokens += i; m.outputTokens += o; m.cacheReadTokens += cr; m.cacheWriteTokens += cw
      m.totalTokens += i + o + cr + cw; m.costUsd += c
      totals.calls += 1; totals.inputTokens += i; totals.outputTokens += o; totals.cacheReadTokens += cr
      totals.cacheWriteTokens += cw; totals.totalTokens += i + o + cr + cw; totals.costUsd += c
    }
    const perModel = [...per.values()].map((m) => Object.assign({}, m, { costUsd: round2(m.costUsd) })).sort((a, b) => b.costUsd - a.costUsd)
    totals.costUsd = round2(totals.costUsd)
    return { perModel, totals }
  }

  async function findSessionLog(sessionId) {
    if (!sessionId) return null
    const home = dshHome()
    if (!home) return null
    const root = join(home, 'sessions')
    let dirs = null
    try { dirs = await readdir(root, { withFileTypes: true }) } catch (e) { return null }
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue
      const dir = join(root, ent.name, sessionId)
      let files = null
      try { files = await readdir(dir) } catch (e) { continue }
      const best = files
        .map((f) => { const mm = /^session\.v(\d+)\.jsonl\.zstd$/.exec(f); return mm ? { f, v: Number(mm[1]) } : null })
        .filter(Boolean)
        .sort((a, b) => b.v - a.v)[0]
      if (best) return join(dir, best.f)
    }
    return null
  }

  async function sessionLogTotals(sessionId) {
    if (!ENABLE_SESSION_LOG || !sessionId) return null
    const now = Date.now()
    const cached = SESSION_LOG_CACHE.get(sessionId)
    if (cached && now - cached.at < SESSION_LOG_TTL) return cached.value
    try {
      const path = (cached && cached.path) || (await findSessionLog(sessionId))
      if (!path) return cached ? cached.value : null
      const info = await stat(path)
      if (cached && cached.path === path && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        cached.at = now
        return cached.value
      }
      const text = decodeSessionLog(await readFile(path))
      if (!text) return cached ? cached.value : null
      const value = Object.assign({ source: 'log', at: now }, summarizeSessionLog(text))
      SESSION_LOG_CACHE.set(sessionId, { path, size: info.size, mtimeMs: info.mtimeMs, at: now, value })
      return value
    } catch (e) {
      return cached ? cached.value : null
    }
  }

  // ================= 快照 =================
  function aggRecords(list) {
    const per = new Map()
    const tot = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 }
    for (const r of list) {
      let m = per.get(r.m) || { model: r.m, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
      m.calls += 1
      m.inputTokens += r.i
      m.outputTokens += r.o
      m.cacheReadTokens += r.cr
      m.cacheWriteTokens += r.cw
      m.costUsd += r.c
      per.set(r.m, m)
    }
    const models = []
    for (const m of per.values()) {
      const t = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens
      models.push(Object.assign({}, m, { name: m.model, totalTokens: t, costUsd: round2(m.costUsd) }))
    }
    models.sort((a, b) => b.costUsd - a.costUsd)
    for (const m of models) {
      tot.calls += m.calls; tot.inputTokens += m.inputTokens; tot.outputTokens += m.outputTokens
      tot.cacheReadTokens += m.cacheReadTokens; tot.cacheWriteTokens += m.cacheWriteTokens
      tot.totalTokens += m.totalTokens; tot.costUsd += m.costUsd
    }
    tot.costUsd = round2(tot.costUsd)
    return { perModel: models, totals: tot }
  }

  function snapshot(sessionId, logSession) {
    const sid = typeof sessionId === 'string' ? sessionId : ''
    const rt = aggRecords(calls)
    const sess = (logSession && logSession.totals) ? logSession : aggRecords(sid ? calls.filter((r) => r.sid === sid) : [])
    const costByModel = new Map()
    for (const m of cost.perModel) costByModel.set(m.model, m.cost)
    const perModel = official.perModel.map((m) => ({
      model: m.model,
      tokens: m.tokens,
      hit: m.hit,
      miss: m.miss,
      output: m.output,
      requests: m.requests,
      hitRate: (m.hit + m.miss) > 0 ? m.hit / (m.hit + m.miss) : null,
      cost: costByModel.get(m.model) || 0,
      per100mCost: (m.tokens > 0 && (costByModel.get(m.model) || 0) > 0) ? round2((costByModel.get(m.model) / m.tokens) * 1e8) : null,
    }))
    let currentModel = null
    try {
      const sel = ctx.get('agentDefaultModel')
      if (sel && typeof sel.currentSelection === 'function') {
        const s = sel.currentSelection()
        if (s && typeof s.model === 'string') currentModel = s.model
      }
    } catch (e) { /* 无该服务时忽略 */ }
    return {
      balance,
      official,
      cost,
      perModel,
      costPer100m: (official.tokens > 0 && cost.total > 0) ? round2((cost.total / official.tokens) * 1e8) : null,
      realtime: rt,
      session: sess,
      currentModel,
      pricing: PRICING,
      now: Date.now(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }
  }

  // ================= 路由 =================
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-billing',
    async handler(req, res) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      try {
        let sessionId = ''
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          sessionId = url.searchParams.get('sessionId') || ''
        } catch (e) { /* 保持空 */ }
        const logSession = await sessionLogTotals(sessionId)
        const body = snapshot(sessionId, logSession)
        body.diag = {
          balance: balance.state,
          platformToken: (await resolveSecret(PLATFORM_TOKEN_REF)) ? true : false,
          zstd: (zlib && typeof zlib.zstdDecompressSync === 'function') ? true : false,
          sessionLog: logSession ? logSession.source : null,
          node: process.versions.node,
        }
        res.end(JSON.stringify(body))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String((e && e.message) || e) }))
      }
    },
  }), 'dsh-billing-compass: route')

  // ================= 刷新节奏 =================
  ctx.interval(() => { refreshBalance().catch(() => {}) }, BALANCE_MS)
  ctx.interval(() => {
    if (official.state === 'error' || official.state === 'unconfigured') fetchOfficial().catch(() => {})
    if (cost.state === 'error' || cost.state === 'unconfigured') fetchCost().catch(() => {})
  }, RETRY_MS)
  ctx.interval(() => { fetchOfficial().catch(() => {}); fetchCost().catch(() => {}) }, OFFICIAL_MS)

  refreshBalance().catch(() => {})
  fetchOfficial().catch(() => {})
  fetchCost().catch(() => {})
}
