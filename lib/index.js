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

import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import https from 'node:https'
import zlib from 'node:zlib'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const PLATFORM = 'https://platform.deepseek.com'
/** 复用 TLS 连接:余额每 30s 一次,握手能省就省。 */
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 6 })
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
  const OFFICIAL_MS = Math.max(30000, num(cfg.officialIntervalMs, 120000))
  const RETRY_MS = Math.max(10000, num(cfg.retryIntervalMs, 30000))
  const ENABLE_SESSION_LOG = cfg.sessionLog !== false
  const UPDATE_ENABLED = cfg.updateCheck !== false
  const UPDATE_MS = Math.max(60000, num(cfg.updateCheckIntervalMs, 6 * 60 * 60 * 1000))

  const startedAt = Date.now()
  let calls = []
  const recentCalls = new Map()
  let balance = { state: 'pending', at: startedAt }
  let official = emptyOfficial('pending')
  let cost = emptyCost('pending')
  let fetching = null
  let offFetching = null
  let costFetching = null
  /** 官网 token 是否可用(只在抓取时更新,路由直接用,避免每次请求解析凭据/读文件)。 */
  let platformTokenSeen = null
  /** 官网凭据来源:'ref'(手动配置) | 'account'(DSH 账号,需用户同意) | null。 */
  let platformTokenSource = null
  /** 官网用量与消费各自的凭据来源(两者可能不同)。 */
  let officialSource = null
  let costSource = null
  /** 账号凭据在官网接口上的首轮结果(诊断用,不含 token)。 */
  let officialAccountAttempt = null
  let costAccountAttempt = null
  /** 账号凭据被对应官网接口拒绝后置位,避免每次刷新都重试失败。 */
  let officialAccountUnsupported = false
  let costAccountUnsupported = false
  /** 用户在面板里点过"允许自动获取"后才读 DSH 账号数据(路由 auto=1)。 */
  let autoConsent = false
  /** DSH 账号状态(本地读取,不含凭据)。 */
  let accountPresence = { available: false, status: 'unknown', checkedAt: 0 }
  /** 从 DSH 账号读到的平台登录凭据缓存(60s,避免每次刷新都换 token)。 */
  let platformSessionCache = null
  /** 账号平台凭据的最近一次尝试(仅用于诊断,不含 token)。 */
  let accountPlatformDiag = { attempted: false, session: false, origin: '', error: null }
  const ACCOUNT_CLIENT = Object.freeze({
    version: '1.0.7',
    locale: String(Intl.DateTimeFormat().resolvedOptions().locale || 'en'),
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  })
  /** 更新检查:当前版本从插件自己的 package.json 读取,npm dist-tags 里取 latest。 */
  let currentVersion = null
  let updateInfo = { checkedAt: 0, current: null, latest: null, hasUpdate: false, error: null }
  const currentVersionReady = (async () => {
    try {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
      currentVersion = typeof pkg.version === 'string' ? pkg.version : null
    } catch (e) {
      currentVersion = null
    }
    return currentVersion
  })()
  /** 最近一次各数据源的抓取耗时(ms),用于自检与诊断。 */
  const timings = { balance: 0, official: 0, cost: 0, log: 0 }
  /** 最近被请求过的 sessionId(后台预热会话日志,最多 3 个)。 */
  const wantedSessions = []
  function rememberSession(sessionId) {
    if (!sessionId || wantedSessions[0] === sessionId) return
    const at = wantedSessions.indexOf(sessionId)
    if (at >= 0) wantedSessions.splice(at, 1)
    wantedSessions.unshift(sessionId)
    if (wantedSessions.length > 3) wantedSessions.length = 3
  }

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
        req = https.request(url, { method: 'GET', headers, timeout: timeoutMs, agent: keepAliveAgent }, (res) => {
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

  // ================= 0) 更新检查(默认 6 小时一次,失败静默) =================
  function compareVersion(a, b) {
    const pa = String(a || '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
    const pb = String(b || '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < 3; i += 1) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
    }
    return 0
  }

  async function checkUpdate(force = false) {
    if (!UPDATE_ENABLED) return updateInfo
    const now = Date.now()
    if (!force && updateInfo.checkedAt && now - updateInfo.checkedAt < UPDATE_MS) return updateInfo
    await currentVersionReady
    const registries = []
    if (typeof cfg.updateRegistry === 'string' && cfg.updateRegistry.trim()) registries.push(cfg.updateRegistry.trim().replace(/\/+$/, ''))
    registries.push('https://registry.npmjs.org', 'https://registry.npmmirror.com')
    const errors = []
    for (const registry of registries) {
      try {
        const res = await httpGet(registry + '/-/package/dsh-billing-compass/dist-tags', {
          Accept: 'application/json', 'User-Agent': UA,
        }, { maxBytes: 256 * 1024, timeoutMs: 8000 })
        if (res.status !== 200) throw new Error(res.error || ('HTTP ' + res.status))
        const tags = JSON.parse(res.body.toString('utf8'))
        const latest = tags && typeof tags.latest === 'string' ? tags.latest : null
        if (!latest) throw new Error('dist-tags.latest 缺失')
        const hasUpdate = !!(currentVersion && compareVersion(latest, currentVersion) > 0)
        updateInfo = { checkedAt: now, current: currentVersion, latest, hasUpdate, error: null, registry }
        return updateInfo
      } catch (e) {
        errors.push(registry.replace(/^https:\/\//, '') + ': ' + String((e && e.message) || e).slice(0, 60))
      }
    }
    updateInfo = Object.assign({}, updateInfo, {
      checkedAt: now,
      current: currentVersion,
      error: errors.join('; ').slice(0, 200),
    })
    return updateInfo
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
    // 宿主进程不一定导出 DSH_HOME;依次尝试环境变量、profile 目录反推、用户目录兜底
    const candidates = [
      process.env.DSH_HOME,
      process.env.DSH_PROJECT ? join(process.env.DSH_PROJECT, '.dsh-home') : '',
      process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, '..', '..') : '',
      join(homedir(), '.dsh'),
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().replace(/[\\/]+$/, '')
    }
    return ''
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

  /** 凭据解析缓存:同一个 key 在 30 秒内不重复查 credentials 服务/读 .credentials.yaml。 */
  const secretCache = new Map()
  const SECRET_TTL = 30000
  async function resolveSecret(key) {
    const now = Date.now()
    const cached = secretCache.get(key)
    if (cached && now - cached.at < SECRET_TTL) return cached.value
    let value
    const fromEnv = process.env[key]
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
      value = fromEnv.trim()
    } else {
      try {
        const credentials = ctx.get('credentials')
        if (credentials && typeof credentials.resolve === 'function') {
          const hit = await credentials.resolve(key)
          if (hit && hit.value) value = hit.value
        }
      } catch (e) { /* 服务不可用:继续走文件 */ }
      if (value === undefined) {
        const home = dshHome()
        if (home) {
          try {
            value = readYamlScalar(await readFile(join(home, '.credentials.yaml'), 'utf8'), key)
          } catch (e) {
            value = undefined
          }
        }
      }
    }
    secretCache.set(key, { at: now, value })
    return value
  }

  // ================= DSH 账号自动获取(必须用户手动同意) =================
  // DSH 登录的 DeepSeek 账号能提供钱包余额和平台登录态。插件默认不碰它:
  // 只有客户端在路由里带 auto=1(面板里点过"允许自动获取")时才读取。
  function accountService() {
    try {
      const svc = ctx.get('deepseekAccount')
      return (svc && typeof svc.getState === 'function') ? svc : null
    } catch (e) {
      return null
    }
  }

  async function refreshAccountPresence(force = false) {
    const now = Date.now()
    if (!force && now - accountPresence.checkedAt < 10000) return accountPresence
    const svc = accountService()
    if (!svc) {
      accountPresence = { available: false, status: 'unavailable', checkedAt: now }
      return accountPresence
    }
    try {
      const state = await svc.getState()
      accountPresence = {
        available: !!(state && state.status === 'credential-stored'),
        status: (state && state.status) || 'unknown',
        checkedAt: now,
      }
    } catch (e) {
      accountPresence = { available: false, status: 'error', checkedAt: now }
    }
    return accountPresence
  }

  /** DSH 账号的平台登录凭据:只在同意后读取,缓存 60s。 */
  async function platformAccountCredential() {
    if (!autoConsent) return null
    const now = Date.now()
    if (platformSessionCache && now - platformSessionCache.at < 60000) return platformSessionCache
    const svc = accountService()
    if (!svc || typeof svc.getPlatformSession !== 'function') {
      accountPlatformDiag = { attempted: true, session: false, origin: '', error: 'no-service' }
      return null
    }
    accountPlatformDiag = { attempted: true, session: false, origin: '', error: null }
    try {
      const session = await svc.getPlatformSession()
      if (session && typeof session.token === 'string' && session.token) {
        accountPlatformDiag = {
          attempted: true,
          session: true,
          origin: String(session.origin || ''),
          error: null,
          headers: session.requestHeaders ? Object.keys(session.requestHeaders) : [],
        }
        platformSessionCache = {
          token: session.token,
          headers: (session.requestHeaders && typeof session.requestHeaders === 'object') ? session.requestHeaders : null,
          origin: String(session.origin || ''),
          at: now,
        }
        return platformSessionCache
      }
      accountPlatformDiag = { attempted: true, session: false, origin: '', error: 'no-session' }
    } catch (e) {
      accountPlatformDiag = { attempted: true, session: false, origin: '', error: String((e && e.message) || e).slice(0, 160) }
    }
    return null
  }

  /** 同意后用 DSH 账号钱包余额代替人工 API key(充值 + 赠送)。 */
  async function accountBalanceIfAllowed() {
    if (!autoConsent) return null
    const svc = accountService()
    if (!svc || typeof svc.getBalance !== 'function') return null
    try {
      const result = await svc.getBalance(ACCOUNT_CLIENT)
      if (!result || result.status !== 'ready') return null
      const sumOf = (list) => (Array.isArray(list) ? list : []).reduce((acc, wallet) => acc + (Number(wallet && wallet.balance) || 0), 0)
      const recharge = sumOf(result.value)
      const bonus = sumOf(result.bonusWallets)
      const wallets = Array.isArray(result.value) ? result.value : []
      const wallet = wallets.find((item) => item && (item.currency === 'CNY' || item.currency === 'USD')) || null
      return {
        state: 'ok',
        source: 'account',
        available: true,
        currency: (wallet && wallet.currency) || 'CNY',
        total: round2(recharge + bonus),
        granted: round2(bonus),
        toppedUp: round2(recharge),
        at: Date.now(),
      }
    } catch (e) {
      return null
    }
  }

  // ================= 1) 余额 =================
  async function refreshBalance() {
    if (fetching) return fetching
    fetching = (async () => {
      const t0 = Date.now()
      try {
        // 同意自动获取时优先用 DSH 账号钱包;失败则回退人工 API key
        if (autoConsent) {
          const autoBalance = await accountBalanceIfAllowed()
          if (autoBalance) {
            balance = autoBalance
            return
          }
        }
        const key = await resolveSecret(BALANCE_KEY_REF)
        if (!key) {
          balance = {
            state: 'unconfigured', keyRef: BALANCE_KEY_REF, at: Date.now(),
            accountAvailable: accountPresence.available, consent: autoConsent,
          }
          return
        }
        const data = jsonOf(await httpGet(BALANCE_URL, {
          Authorization: 'Bearer ' + key, Accept: 'application/json', 'User-Agent': UA,
        }))
        const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
        const info = infos[0] || null
        balance = {
          state: 'ok',
          source: 'api-key',
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
        timings.balance = Date.now() - t0
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

  async function refPlatformCredential() {
    const token = await resolveSecret(PLATFORM_TOKEN_REF)
    return token ? { token, headers: null, source: 'ref' } : null
  }

  /** 按数据源选择凭据:同意自动获取时优先 DSH 账号,被该接口拒绝过则直接手动凭据。 */
  async function choosePlatformCredential(kind) {
    const unsupported = kind === 'official' ? officialAccountUnsupported : costAccountUnsupported
    if (autoConsent && !unsupported) {
      const account = await platformAccountCredential()
      if (account) return { token: account.token, headers: account.headers || null, source: 'account' }
    }
    return refPlatformCredential()
  }

  function platformRequestHeaders(credential, accept) {
    return Object.assign(
      { 'User-Agent': UA, Accept: accept },
      (credential && credential.headers) || {},
      { Authorization: 'Bearer ' + credential.token },
    )
  }

  function parseOfficialResponses(responses) {
    const perModel = new Map()
    let apiErr = null
    let got = false
    for (const res of responses) {
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
    return { perModel, apiErr, got }
  }

  function summarizeOfficial(parsed) {
    const list = []
    let tokens = 0, hit = 0, miss = 0, output = 0, requests = 0
    for (const g of parsed.perModel.values()) {
      const t = g.hit + g.miss + g.output
      list.push({ model: g.model, hit: g.hit, miss: g.miss, output: g.output, requests: g.requests, tokens: t })
      tokens += t; hit += g.hit; miss += g.miss; output += g.output; requests += g.requests
    }
    list.sort((a, b) => b.tokens - a.tokens)
    return {
      state: 'ok', err: parsed.apiErr, fetchedAt: Date.now(), tokens, hit, miss, output, requests,
      hitRate: (hit + miss) > 0 ? hit / (hit + miss) : null, perModel: list,
    }
  }

  async function fetchOfficial() {
    if (offFetching) return offFetching
    offFetching = (async () => {
      const t0 = Date.now()
      try {
        let credential = await choosePlatformCredential('official')
        platformTokenSeen = !!credential
        platformTokenSource = credential ? credential.source : null
        if (!credential) {
          official = Object.assign(emptyOfficial('unconfigured'), {
            keyRef: PLATFORM_TOKEN_REF,
            accountAvailable: accountPresence.available,
            consent: autoConsent,
          })
          return
        }
        const fetchWith = async (cred) => {
          const headers = platformRequestHeaders(cred, 'application/json')
          const responses = await Promise.all(recentMonths().map((p) =>
            httpGet(`${PLATFORM}/api/v0/usage/amount?month=${p.m}&year=${p.y}`, headers)))
          return parseOfficialResponses(responses)
        }
        let result = await fetchWith(credential)
        if (credential.source === 'account') officialAccountAttempt = { got: result.got, err: result.apiErr || null }
        // 账号凭据被官网拒绝时,回退到手动配置的 platform token 再试一次
        if (!result.got && credential.source === 'account') {
          officialAccountUnsupported = true
          accountPlatformDiag = Object.assign({}, accountPlatformDiag, {
            attempted: true, rejected: String(result.apiErr || 'empty').slice(0, 160),
          })
          const fallback = await refPlatformCredential()
          if (fallback) {
            const retry = await fetchWith(fallback)
            if (retry.got) {
              result = retry
              credential = fallback
              platformTokenSource = 'ref'
              platformTokenSeen = true
            }
          }
        }
        if (!result.got && result.apiErr) throw new Error(result.apiErr)
        officialSource = credential.source
        official = summarizeOfficial(result)
      } catch (e) {
        official = Object.assign(emptyOfficial('error', String((e && e.message) || e).slice(0, 300)), { fetchedAt: Date.now() })
      } finally {
        timings.official = Date.now() - t0
        offFetching = null
      }
    })()
    return offFetching
  }

  // ================= 3) 官网消费(导出 zip → cost-*.csv) =================
  function parseCostResponses(zips) {
    let total = 0
    let currency = 'CNY'
    let errMsg = null
    let got = false
    const perModel = new Map()
    for (const res of zips) {
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
    return { total, currency, errMsg, got, perModel }
  }

  function summarizeCost(parsed) {
    return {
      state: 'ok', err: parsed.errMsg, fetchedAt: Date.now(), total: round2(parsed.total), currency: parsed.currency,
      perModel: [...parsed.perModel.values()].map((g) => ({ model: g.model, cost: round2(g.cost) })).sort((a, b) => b.cost - a.cost),
    }
  }

  async function fetchCost() {
    if (costFetching) return costFetching
    costFetching = (async () => {
      const t0 = Date.now()
      try {
        let credential = await choosePlatformCredential('cost')
        platformTokenSeen = !!credential
        platformTokenSource = credential ? credential.source : null
        if (!credential) {
          cost = Object.assign(emptyCost('unconfigured'), {
            keyRef: PLATFORM_TOKEN_REF,
            accountAvailable: accountPresence.available,
            consent: autoConsent,
          })
          return
        }
        const fetchWith = async (cred) => {
          const headers = platformRequestHeaders(cred, 'application/zip')
          const zips = await Promise.all(recentMonths().map((p) =>
            httpGet(`${PLATFORM}/api/v0/usage/export?month=${p.m}&year=${p.y}`, headers, { maxBytes: 32 * 1024 * 1024 })))
          return parseCostResponses(zips)
        }
        let parsed = await fetchWith(credential)
        if (credential.source === 'account') costAccountAttempt = { got: parsed.got, err: parsed.errMsg || null }
        if (!parsed.got && credential.source === 'account') {
          costAccountUnsupported = true
          accountPlatformDiag = Object.assign({}, accountPlatformDiag, {
            attempted: true, rejected: String(parsed.errMsg || 'empty').slice(0, 160),
          })
          const fallback = await refPlatformCredential()
          if (fallback) {
            const retry = await fetchWith(fallback)
            if (retry.got) {
              parsed = retry
              credential = fallback
              platformTokenSource = 'ref'
              platformTokenSeen = true
            }
          }
        }
        if (!parsed.got && parsed.errMsg) throw new Error(parsed.errMsg)
        costSource = credential.source
        cost = summarizeCost(parsed)
      } catch (e) {
        cost = Object.assign(emptyCost('error', String((e && e.message) || e).slice(0, 300)), { fetchedAt: Date.now() })
      } finally {
        timings.cost = Date.now() - t0
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
  /** 子代理/子智能体会话树缓存:root sessionId -> { at, ids }。 */
  const FAMILY_CACHE = new Map()
  const FAMILY_TTL = 20000
  /** 会话日志头索引(worker -> parent)缓存,用于 subagents 服务不可用时回退。 */
  let sessionHeaderIndex = null
  const SESSION_INDEX_TTL = 60000

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

  /** 从 start 字节开始解码后续完整帧;返回 { parts, end }(end 是已消费到的偏移)。 */
  function decodeFramesFrom(buf, start) {
    const unzstd = (zlib && typeof zlib.zstdDecompressSync === 'function') ? zlib.zstdDecompressSync : null
    if (!unzstd) return null
    const parts = []
    let pos = start
    while (pos + 8 <= buf.length) {
      if (!(buf[pos] === ZMAGIC[0] && buf[pos + 1] === ZMAGIC[1] && buf[pos + 2] === ZMAGIC[2] && buf[pos + 3] === ZMAGIC[3])) break
      const len = frameByteLength(buf, pos)
      if (len <= 0) break
      try { parts.push(unzstd(buf.subarray(pos, pos + len))) } catch (e) { break }
      pos += len
    }
    return { parts, end: pos }
  }

  /** 把一段已解码文本累加进 entry(只统计 assistant/message 的 usage);保留末尾未完成的行。 */
  function accumulateSessionLog(entry, text) {
    const per = entry.perModel
    const totals = entry.totals
    let all = entry.carry + text
    let rest = ''
    const cut = all.lastIndexOf('\n')
    if (cut >= 0) {
      rest = all.slice(cut + 1)
      all = all.slice(0, cut)
    } else {
      rest = all
      all = ''
    }
    for (const line of all.split('\n')) {
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
    entry.carry = rest
  }

  function emptySessionEntry() {
    return {
      path: null, offset: 0, carry: '', at: 0, busy: false, value: null,
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
      perModel: new Map(),
    }
  }

  function sessionLogSnapshot(entry) {
    const perModel = [...entry.perModel.values()]
      .map((m) => Object.assign({}, m, { costUsd: round2(m.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd)
    return {
      source: 'log',
      at: entry.at,
      perModel,
      totals: Object.assign({}, entry.totals, { costUsd: round2(entry.totals.costUsd) }),
    }
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

  /**
   * 后台刷新:只解码「上次消费偏移之后」新增的帧,累加到已有结果上。
   * 首次(offset=0)为全量解析;之后每次只处理新增部分,长会话也不会越跑越慢。
   */
  async function refreshSessionLog(sessionId) {
    if (!ENABLE_SESSION_LOG || !sessionId) return
    let entry = SESSION_LOG_CACHE.get(sessionId)
    if (!entry) { entry = emptySessionEntry(); SESSION_LOG_CACHE.set(sessionId, entry) }
    if (entry.busy) return
    entry.busy = true
    const t0 = Date.now()
    try {
      const path = entry.path || (await findSessionLog(sessionId))
      if (!path) return
      const info = await stat(path)
      if (entry.path !== path || info.size < entry.offset) {
        const fresh = emptySessionEntry()
        fresh.path = path
        Object.assign(entry, fresh)
      }
      if (info.size === entry.offset && entry.value) {
        entry.at = Date.now()
        return
      }
      const buf = await readFile(path)
      if (entry.offset > buf.length) {
        const fresh = emptySessionEntry()
        fresh.path = path
        Object.assign(entry, fresh)
      }
      const part = decodeFramesFrom(buf, entry.offset)
      if (!part) return
      if (part.parts.length > 0) accumulateSessionLog(entry, Buffer.concat(part.parts).toString('utf8'))
      entry.offset = part.end
      entry.at = Date.now()
      entry.value = sessionLogSnapshot(entry)
      timings.log = Date.now() - t0
    } catch (e) {
      /* 保留上一次成功的结果 */
    } finally {
      entry.busy = false
    }
  }

  /** 请求路径只读缓存:立即返回,过期则丢到后台刷新(不阻塞响应)。 */
  function sessionLogValue(sessionId) {
    if (!ENABLE_SESSION_LOG || !sessionId) return null
    rememberSession(sessionId)
    const entry = SESSION_LOG_CACHE.get(sessionId)
    if (!entry || !entry.value) {
      refreshSessionLog(sessionId).catch(() => {})
      return null
    }
    if (Date.now() - entry.at > SESSION_LOG_TTL) refreshSessionLog(sessionId).catch(() => {})
    return entry.value
  }

  /** 会话目录里版本号最高的日志文件名。 */
  async function newestSessionFile(sessionDir) {
    let files = null
    try { files = await readdir(sessionDir) } catch (e) { return null }
    const best = files
      .map((f) => { const mm = /^session\.v(\d+)\.jsonl\.zstd$/.exec(f); return mm ? { f, v: Number(mm[1]) } : null })
      .filter(Boolean)
      .sort((a, b) => b.v - a.v)[0]
    return best ? join(sessionDir, best.f) : null
  }

  /** 只读会话日志第一帧的会话头(type:"session"),拿 parentSession/origin。 */
  async function readSessionHeader(sessionDir) {
    const path = await newestSessionFile(sessionDir)
    if (!path) return null
    let buf = null
    try {
      const handle = await open(path, 'r')
      try {
        const info = await handle.stat()
        const size = Math.min(info.size, 256 * 1024)
        buf = Buffer.alloc(size)
        const read = await handle.read(buf, 0, size, 0)
        buf = buf.subarray(0, read.bytesRead)
      } finally {
        await handle.close()
      }
    } catch (e) {
      return null
    }
    const part = decodeFramesFrom(buf, 0)
    if (!part || part.parts.length === 0) return null
    const text = Buffer.concat(part.parts).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.charCodeAt(0) !== 123 || line.indexOf('"type":"session"') < 0) continue
      try {
        const rec = JSON.parse(line)
        if (rec && rec.type === 'session') return rec
      } catch (e) { /* 继续找下一行 */ }
    }
    return null
  }

  /** 扫描所有会话日志头,建立 child -> parent 映射(60s 缓存)。 */
  async function indexSessionHeaders() {
    const now = Date.now()
    if (sessionHeaderIndex && now - sessionHeaderIndex.at < SESSION_INDEX_TTL) return sessionHeaderIndex
    const byChild = new Map()
    const home = dshHome()
    const root = home ? join(home, 'sessions') : ''
    let spaces = []
    try { spaces = root ? await readdir(root, { withFileTypes: true }) : [] } catch (e) { spaces = [] }
    for (const ws of spaces) {
      if (!ws.isDirectory()) continue
      let dirs = []
      try { dirs = await readdir(join(root, ws.name), { withFileTypes: true }) } catch (e) { continue }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        const header = await readSessionHeader(join(root, ws.name, dir.name))
        if (header && header.parentSession) {
          byChild.set(dir.name, String(header.parentSession).replace(/^session-/, ''))
        }
      }
    }
    sessionHeaderIndex = { at: now, byChild }
    return sessionHeaderIndex
  }

  /**
   * 列出 root 会话下所有子代理/子智能体会话 id(含嵌套)。
   * 优先用宿主 subagents 服务的 catalog;不可用时回退到会话日志头里的 parentSession。
   */
  async function descendantSessionIds(rootSessionId) {
    if (!rootSessionId) return []
    const key = String(rootSessionId).replace(/^session-/, '')
    const cached = FAMILY_CACHE.get(key)
    const now = Date.now()
    if (cached && now - cached.at < FAMILY_TTL) return cached.ids
    let ids = []
    let serviceUsable = false
    let service = null
    try { service = ctx.get('subagents') } catch (e) { service = null }
    if (service && typeof service.listDescendants === 'function') {
      try {
        const rows = await service.listDescendants(key)
        const list = Array.isArray(rows) ? rows : []
        ids = list
          .filter((row) => row && row.kind === 'child' && row.id)
          .map((row) => String(row.id).replace(/^session-/, ''))
        // 目录读取失败(诊断行)时也允许回退到日志头扫描
        serviceUsable = !list.some((row) => row && row.kind === 'diagnostic')
      } catch (e) {
        serviceUsable = false
      }
    }
    if (!serviceUsable) {
      try {
        const index = await indexSessionHeaders()
        const childrenOf = new Map()
        for (const [child, parent] of index.byChild) {
          if (!childrenOf.has(parent)) childrenOf.set(parent, [])
          childrenOf.get(parent).push(child)
        }
        const queue = [key]
        const seen = new Set([key])
        while (queue.length > 0 && ids.length < 64) {
          const current = queue.shift()
          const kids = childrenOf.get(current) || []
          for (const child of kids) {
            if (seen.has(child)) continue
            seen.add(child)
            ids.push(child)
            queue.push(child)
          }
        }
      } catch (e) { ids = [] }
    }
    FAMILY_CACHE.set(key, { at: now, ids })
    return ids
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

  /** 把子代理/子智能体的会话日志汇总并入根会话,得到「整段对话」合计。 */
  function mergeSessionValues(base, children) {
    const totals = Object.assign({}, base.totals)
    const perModel = new Map((base.perModel || []).map((m) => [m.model, Object.assign({}, m)]))
    const summary = { count: 0, costUsd: 0, tokens: 0, calls: 0 }
    for (const child of children || []) {
      if (!child || !child.totals) continue
      const t = child.totals
      for (const key of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
        totals[key] = (Number(totals[key]) || 0) + (Number(t[key]) || 0)
      }
      totals.costUsd = (Number(totals.costUsd) || 0) + (Number(t.costUsd) || 0)
      summary.count += 1
      summary.costUsd += Number(t.costUsd) || 0
      summary.tokens += Number(t.totalTokens) || 0
      summary.calls += Number(t.calls) || 0
      for (const m of (child.perModel || [])) {
        const target = perModel.get(m.model) || {
          model: m.model, calls: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0,
        }
        target.calls += Number(m.calls) || 0
        target.inputTokens += Number(m.inputTokens) || 0
        target.outputTokens += Number(m.outputTokens) || 0
        target.cacheReadTokens += Number(m.cacheReadTokens) || 0
        target.cacheWriteTokens += Number(m.cacheWriteTokens) || 0
        target.totalTokens += Number(m.totalTokens) || 0
        target.costUsd += Number(m.costUsd) || 0
        perModel.set(m.model, target)
      }
    }
    totals.costUsd = round2(totals.costUsd)
    summary.costUsd = round2(summary.costUsd)
    return {
      source: base.source,
      at: base.at || Date.now(),
      perModel: [...perModel.values()].sort((a, b) => (Number(b.costUsd) || 0) - (Number(a.costUsd) || 0)),
      totals,
      children: summary,
    }
  }

  function snapshot(sessionId, logSession, childSessions, descendantCount) {
    const sid = typeof sessionId === 'string' ? sessionId : ''
    const rt = aggRecords(calls)
    let sess
    if (logSession && logSession.totals) {
      sess = mergeSessionValues(logSession, childSessions)
    } else {
      sess = aggRecords(sid ? calls.filter((r) => r.sid === sid) : [])
      sess.children = { count: 0, costUsd: 0, tokens: 0, calls: 0 }
    }
    sess.subagentTotal = Number(descendantCount) || 0
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
      version: currentVersion,
      update: updateInfo,
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
        let autoRequested = null
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          sessionId = url.searchParams.get('sessionId') || ''
          const auto = url.searchParams.get('auto')
          if (auto === '1') autoRequested = true
          else if (auto === '0') autoRequested = false
        } catch (e) { /* 保持空 */ }
        // auto=1 只有在用户面板里点过"允许自动获取"后才会带上;auto=0 立刻停止读取账号数据
        if (autoRequested === true && !autoConsent) {
          autoConsent = true
          platformSessionCache = null
          officialAccountUnsupported = false
          costAccountUnsupported = false
          refreshAccountPresence(true).catch(() => {})
          refreshBalance().catch(() => {})
          fetchOfficial().catch(() => {})
          fetchCost().catch(() => {})
        } else if (autoRequested === false && autoConsent) {
          autoConsent = false
          platformSessionCache = null
          officialAccountUnsupported = false
          costAccountUnsupported = false
        }
        await refreshAccountPresence()
        if (UPDATE_ENABLED) {
          if (!updateInfo.checkedAt) {
            // 首次请求等最多 1.2s,让面板第一次打开就能显示更新状态
            await Promise.race([
              checkUpdate().catch(() => {}),
              new Promise((resolve) => { const t = setTimeout(resolve, 1200); if (t && typeof t.unref === 'function') t.unref() }),
            ])
          } else {
            checkUpdate().catch(() => {})
          }
        }
        const t0 = Date.now()
        // 子代理/子智能体会话:把它们的整段消费并入本对话合计(日志缓存就绪前先返回 0,下一次轮询补上)
        const descendantIds = sessionId ? await descendantSessionIds(sessionId) : []
        const childSessions = []
        for (const childId of descendantIds) {
          try {
            const value = sessionLogValue(childId)
            if (value && value.totals) childSessions.push(value)
            else refreshSessionLog(childId).catch(() => {})
          } catch (e) { /* 单个子会话失败不影响主对话 */ }
        }
        // 会话日志只读缓存(过期时丢到后台刷新),路由本身永不被它阻塞
        const logSession = sessionLogValue(sessionId)
        const body = snapshot(sessionId, logSession, childSessions, descendantIds.length)
        body.account = {
          available: accountPresence.available,
          status: accountPresence.status,
          consent: autoConsent,
          balanceSource: (balance && balance.source) || null,
          platformSource: platformTokenSource,
          officialSource,
          costSource,
        }
        body.diag = {
          balance: balance.state,
          platformToken: platformTokenSeen === true,
          tokenKnown: platformTokenSeen !== null,
          account: accountPresence.status,
          accountAvailable: accountPresence.available,
          accountPlatform: accountPlatformDiag,
          officialSource,
          costSource,
          officialAccountAttempt,
          costAccountAttempt,
          version: currentVersion,
          update: { latest: updateInfo.latest, hasUpdate: updateInfo.hasUpdate, error: updateInfo.error },
          autoConsent,
          zstd: (zlib && typeof zlib.zstdDecompressSync === 'function') ? true : false,
          sessionLog: logSession ? logSession.source : null,
          subagents: { total: descendantIds.length, merged: childSessions.length },
          node: process.versions.node,
          timing: { balance: timings.balance, official: timings.official, cost: timings.cost, log: timings.log, route: Date.now() - t0 },
          home: dshHome(),
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
  // 失败/未配置时快速自愈(30s 一次),不影响正常节奏
  ctx.interval(() => {
    if (official.state === 'error' || official.state === 'unconfigured') fetchOfficial().catch(() => {})
    if (cost.state === 'error' || cost.state === 'unconfigured') fetchCost().catch(() => {})
  }, RETRY_MS)
  // 官网用量/消费:并行拉取,默认 2 分钟一次(可被 config.officialIntervalMs 覆盖)
  ctx.interval(() => { fetchOfficial().catch(() => {}); fetchCost().catch(() => {}) }, OFFICIAL_MS)
  // 会话日志:后台增量刷新(只解码新增帧),与请求路径解耦
  ctx.interval(() => {
    for (const sid of wantedSessions) refreshSessionLog(sid).catch(() => {})
  }, SESSION_LOG_TTL)

  // 更新检查:启动 5s 后先查一次,之后每 UPDATE_MS 查一次(失败静默)
  if (UPDATE_ENABLED) {
    const warmed = () => { checkUpdate().catch(() => {}) }
    try {
      if (typeof ctx.timeout === 'function') ctx.timeout(warmed, 5000)
      else setTimeout(warmed, 5000)
    } catch (e) {
      setTimeout(warmed, 5000)
    }
    ctx.interval(() => { checkUpdate().catch(() => {}) }, UPDATE_MS)
  }

  refreshAccountPresence().catch(() => {})
  refreshBalance().catch(() => {})
  fetchOfficial().catch(() => {})
  fetchCost().catch(() => {})
}
