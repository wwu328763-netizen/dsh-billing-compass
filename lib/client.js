window.__ModuleLoader__.load({
  id: 'dsh-billing-compass',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const inject = ['slots', 'timer'];

    // 配色:中性灰(主题 label/border 令牌)+ 单一品牌蓝(--dsw-static-deepseek-*)。
    // 面板尺寸/圆角/阴影照搬宿主 popover 的取值(bg-layer-2 + radius-lg + elevation-prominent),
    // 分隔线统一 .5px border-l2,不再使用渐变、光晕、彩色进度条等装饰。
    const CSS = `
      .dskc-anchor {
        position: relative; display: inline-flex; align-items: center;
        --dskc-brand: var(--dsw-alias-state-business-primary, var(--dsw-static-deepseek-500, #4176e6));
        --dskc-brand-soft: color-mix(in srgb, var(--dskc-brand) 10%, transparent);
        --dskc-ink: var(--dsw-alias-label-primary, #e9e9ec);
        --dskc-ink-2: var(--dsw-alias-label-secondary, rgba(150,152,160,.95));
        --dskc-ink-3: var(--dsw-alias-label-tertiary, rgba(130,133,140,.9));
        --dskc-hair: var(--dsw-alias-border-l2, rgba(128,128,128,.22));
        --dskc-hover: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12));
      }

      /* ---------- 触发行(与宿主统计条同款:小字 + hover 底色) ---------- */
      .dskc-trigger {
        display: inline-flex; align-items: center; gap: 6px;
        font: inherit; font-size: 12px; line-height: 20px;
        color: var(--dskc-ink-3);
        background: transparent; border: 0;
        border-radius: var(--dsw-radius-sm, 8px);
        padding: 0 6px; margin: 0; cursor: pointer; white-space: nowrap;
        font-variant-numeric: tabular-nums; user-select: none;
        transition: background-color .12s ease, color .12s ease;
      }
      .dskc-trigger:hover, .dskc-trigger.is-open { background: var(--dskc-hover); color: var(--dskc-ink); }
      .dskc-trigger b { font-weight: 500; color: var(--dskc-ink); }
      .dskc-trigger b.bad { color: var(--dsw-alias-state-error-primary, #f87171); }
      .dskc-trigger .mut { color: var(--dskc-ink-3); }
      .dskc-trigger .sep { opacity: .45; }
      .dskc-trigger .caret { font-size: 8px; opacity: .5; transition: transform .12s ease; }
      .dskc-trigger.is-open .caret { transform: rotate(180deg); }
      .dskc-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--dskc-brand); }
      .dskc-dot.warn { background: var(--dsw-alias-state-warn-primary, #fbbf24); }
      .dskc-dot.err { background: var(--dsw-alias-state-error-primary, #f87171); }

      /* ---------- 面板:宿主 popover 规格 ---------- */
      .dskc-panel {
        position: fixed; z-index: 100; box-sizing: border-box;
        display: flex; flex-direction: column; overflow: hidden;
        color: var(--dskc-ink);
        background: var(--dsw-alias-bg-layer-2, rgba(30,32,38,.99));
        border-radius: var(--dsw-radius-lg, 16px);
        box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgba(128,128,128,.28), 0 12px 32px rgba(0,0,0,.2));
        font-size: 13px; line-height: 1.6; font-variant-numeric: tabular-nums;
        transform-origin: bottom left;
        animation: dskc-in .13s ease-out;
      }
      @keyframes dskc-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .dskc-panel { animation: none; } }
      .dskc-trigger:focus-visible, .dskc-icon:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--dskc-brand) 55%, transparent); outline-offset: 1px;
      }

      .dskc-head { display: flex; align-items: center; gap: 2px; padding: 12px 10px 0 16px; }
      .dskc-title { font-size: 14px; font-weight: 600; color: var(--dskc-ink); }
      .dskc-head .sp { flex: 1; }
      .dskc-icon {
        width: 28px; height: 28px; padding: 0; border: 0;
        border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: var(--dskc-ink-2); cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 13px; line-height: 1;
        transition: background-color .12s ease, color .12s ease;
      }
      .dskc-icon:hover { background: var(--dskc-hover); color: var(--dskc-ink); }

      .dskc-body { overflow: auto; padding: 0 16px 14px; display: flex; flex-direction: column; }
      .dskc-body::-webkit-scrollbar { width: 8px; }
      .dskc-body::-webkit-scrollbar-thumb {
        background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,.3)); border-radius: 4px;
      }
      .dskc-desc { color: var(--dskc-ink-3); font-size: 12px; margin: 2px 0 12px; }
      .dskc-loading { padding: 18px 0; text-align: center; color: var(--dskc-ink-3); font-size: 12px; }

      /* 宽卡片(与输入框同宽)时:左「余额+指标」/ 右「按模型」两栏 */
      .dskc-cols { display: flex; flex-direction: column; gap: 12px; }
      .dskc-col-left, .dskc-col-right { display: flex; flex-direction: column; min-width: 0; }
      .dskc-panel.is-wide .dskc-cols {
        display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr);
        gap: 4px 20px; align-items: start;
      }
      .dskc-panel.is-wide .dskc-col-right .dskc-section { margin-top: 0; }

      /* ---------- 余额:主指标色块(官方蓝) ---------- */
      .dskc-hero {
        display: flex; flex-direction: column; gap: 1px;
        padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px);
        background: color-mix(in srgb, var(--dskc-brand) 9%, transparent);
        box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dskc-brand) 22%, transparent);
      }
      .dskc-hero-k { color: var(--dskc-ink-3); font-size: 12px; }
      .dskc-hero-v {
        font-size: 25px; font-weight: 650; line-height: 1.25; letter-spacing: -.02em;
        color: var(--dskc-brand);
      }
      .dskc-hero-v.bad { font-size: 14px; color: var(--dsw-alias-state-error-primary, #f87171); }
      .dskc-hero-v.dim { font-size: 15px; font-weight: 500; color: var(--dskc-ink-2); }
      .dskc-hero-s { color: var(--dskc-ink-3); font-size: 12px; }

      /* ---------- 四项指标:2×2 浅色面板 ---------- */
      .dskc-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 10px 0 0; }
      .dskc-kv > div {
        display: flex; flex-direction: column; min-width: 0;
        padding: 8px 10px; border-radius: var(--dsw-radius-md, 12px);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
        transition: background-color .16s ease;
      }
      .dskc-kv > div:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
      .dskc-kv dt { margin: 0; color: var(--dskc-ink-3); font-size: 12px; }
      .dskc-kv dd { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
      .dskc-kv .sub { color: var(--dskc-ink-3); font-size: 11.5px; margin-top: 1px; }

      /* ---------- 按模型 ---------- */
      .dskc-section { margin-top: 16px; }
      .dskc-section-head { display: flex; align-items: baseline; gap: 8px; color: var(--dskc-ink-3); font-size: 12px; }
      .dskc-section-head .sp { flex: 1; }
      .dskc-list { list-style: none; margin: 0; padding: 0; }
      .dskc-item {
        padding: 7px 8px; margin: 0 -8px; border-top: .5px solid var(--dskc-hair);
        border-radius: var(--dsw-radius-sm, 8px);
        transition: background-color .16s ease;
      }
      .dskc-item:hover { background: color-mix(in srgb, var(--dskc-brand) 6%, transparent); }
      /* 消费占比条:单一官方蓝,嵌在模型行内 */
      .dskc-share {
        flex: 1 1 auto; min-width: 28px; height: 3px; border-radius: 2px; overflow: hidden;
        background: color-mix(in srgb, var(--dskc-brand) 15%, transparent);
      }
      .dskc-share i {
        display: block; height: 100%; border-radius: 2px;
        background: var(--dskc-brand); opacity: .9;
        transition: width .3s ease;
      }
      @media (prefers-reduced-motion: reduce) { .dskc-share i { transition: none; } }
      .dskc-item-top { display: flex; align-items: center; gap: 10px; }
      .dskc-item-top .dskc-model { flex: 0 1 auto; max-width: 46%; }
      .dskc-model {
        font-size: 13px; font-weight: 500; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dskc-item.is-current .dskc-model { color: var(--dskc-brand); }
      .dskc-cost { margin-left: auto; font-size: 13px; font-weight: 500; white-space: nowrap; }
      .dskc-item-meta { display: flex; gap: 12px; color: var(--dskc-ink-3); font-size: 12px; margin-top: 2px; }
      .dskc-item-meta .sp { flex: 1; }
      .dskc-empty { color: var(--dskc-ink-3); font-size: 12px; padding: 7px 0; border-top: .5px solid var(--dskc-hair); }
      .dskc-err { color: var(--dsw-alias-state-error-primary, #f87171); font-size: 12px; }
      .dskc-notes { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
      .dskc-hint { color: var(--dskc-ink-3); font-size: 11.5px; line-height: 1.5; }

      .dskc-foot {
        padding: 10px 16px 12px; border-top: .5px solid var(--dskc-hair);
        color: var(--dskc-ink-3); font-size: 11px; line-height: 1.5;
      }
    `;

    // ---------- 格式化 ----------
    const num = (n) => (n === null || n === undefined || Number.isNaN(Number(n))) ? null : Number(n);
    const fmtInt = (n) => { const v = num(n); return v === null ? '—' : v.toLocaleString('en-US'); };
    const money = (n, d) => { const v = num(n); return v === null ? '—' : v.toFixed(d); };
    const trimZero = (s) => (s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
    const compact = (n) => {
      const v = num(n);
      if (v === null) return '—';
      const abs = Math.abs(v);
      if (abs >= 1e9) return trimZero((v / 1e9).toFixed(2)) + 'B';
      if (abs >= 1e6) return trimZero((v / 1e6).toFixed(2)) + 'M';
      if (abs >= 1e3) return trimZero((v / 1e3).toFixed(1)) + 'k';
      return String(Math.round(v));
    };
    const pad2 = (v) => String(v).padStart(2, '0');
    const clockOf = (ts) => { const d = new Date(ts || Date.now()); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
    const curOf = (c) => (c === 'USD' || c === 'usd') ? '$' : '¥';
    const prettyModel = (m) => String(m || '').replace(/^deepseek-/, '');
    const pct = (r) => (r === null || r === undefined) ? '—' : (r * 100).toFixed(1) + '%';

    async function fetchSnapshot(sessionId) {
      const res = await fetch('/api/dsh-billing?sessionId=' + encodeURIComponent(sessionId || ''), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    function useSnapshot(ctx, sessionId) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const load = () => fetchSnapshot(sessionId)
          .then((s) => { if (alive) { setData(s); setError(null); } })
          .catch((e) => { if (alive) setError(String((e && e.message) || e)); });
        load();
        const t = ctx.interval(load, 10000);
        return () => { alive = false; t(); };
      }, [sessionId]);
      const refresh = () => {
        setBusy(true);
        fetchSnapshot(sessionId)
          .then((s) => { setData(s); setError(null); })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false));
      };
      return { data, error, busy, refresh };
    }

    // ---------- 单价(USD / 1M tokens,与宿主实时估算同一张表)----------
    const PRICES = {
      'deepseek-chat': { input: 0.28, cacheHit: 0.028, output: 0.42 },
      'deepseek-reasoner': { input: 0.55, cacheHit: 0.14, output: 2.19 },
      'deepseek-v4-flash': { input: 0.28, cacheHit: 0.028, output: 0.42 },
      'deepseek-v4-pro': { input: 0.55, cacheHit: 0.14, output: 2.19 },
    };
    const DEFAULT_PRICE = { input: 0.28, cacheHit: 0.028, output: 0.42 };
    /** 单价表:优先用宿主下发的 config.pricing,否则用内置表 */
    function priceOf(model, table) {
      const P = (table && typeof table === 'object' && Object.keys(table).length > 0) ? table : PRICES;
      const m = String(model || '');
      if (P[m]) return P[m];
      if (/flash/i.test(m) && P['deepseek-v4-flash']) return P['deepseek-v4-flash'];
      if (/pro|reasoner/i.test(m) && P['deepseek-v4-pro']) return P['deepseek-v4-pro'];
      return P['deepseek-v4-flash'] || DEFAULT_PRICE;
    }
    /** 整段对话用量 → USD 估算(与宿主实时列同口径) */
    function costOfUsage(u, model, table) {
      if (!u) return 0;
      const p = priceOf(model, table);
      const unc = Number(u.uncachedInputTokens) || 0;
      const cr = Number(u.cacheReadTokens) || 0;
      const cw = Number(u.cacheWriteTokens) || 0;
      const out = Number(u.outputTokens) || 0;
      return ((unc + cw) / 1e6) * p.input + (cr / 1e6) * p.cacheHit + (out / 1e6) * p.output;
    }

    // ---------- 面板内容 ----------
    function PanelBody(props) {
      const data = props.data;
      const error = props.error;
      if (!data) {
        return h('div', { className: 'dskc-body' },
          h('div', { className: 'dskc-loading' }, error ? ('加载失败:' + error) : '加载中…'));
      }
      const bal = data.balance || { state: 'pending' };
      const cost = data.cost || { state: 'pending' };
      const off = data.official || {};
      const rt = data.realtime || { totals: { calls: 0, totalTokens: 0, costUsd: 0 }, perModel: [] };
      const sess = data.session || { totals: { calls: 0, totalTokens: 0, costUsd: 0 } };
      const cur = curOf(cost.currency);
      const uptime = Math.floor((data.uptimeSec || 0) / 60) + 'm' + pad2((data.uptimeSec || 0) % 60) + 's';

      // 余额
      let heroV;
      let heroS;
      if (bal.state === 'ok') {
        heroV = h('div', { className: 'dskc-hero-v' }, '¥ ' + money(bal.total, 2));
        heroS = h('div', { className: 'dskc-hero-s' },
          '充值 ' + money(bal.toppedUp, 2) + ' · 赠送 ' + money(bal.granted, 2) + ' · ' + (bal.available ? '可用' : '不可用'));
      } else if (bal.state === 'unconfigured') {
        heroV = h('div', { className: 'dskc-hero-v dim' }, '未配置');
        heroS = h('div', { className: 'dskc-hero-s' }, '缺少凭据 ' + (bal.keyRef || 'DEEPSEEK_API_KEY'));
      } else if (bal.state === 'error') {
        heroV = h('div', { className: 'dskc-hero-v bad' }, '余额获取失败');
        heroS = h('div', { className: 'dskc-hero-s' }, bal.message || '');
      } else {
        heroV = h('div', { className: 'dskc-hero-v' }, '—');
        heroS = h('div', { className: 'dskc-hero-s' }, '余额查询中…');
      }

      const kv = (k, v, s) => h('div', { key: k },
        h('dt', null, k),
        h('dd', null, v),
        s ? h('div', { className: 'sub' }, s) : null);

      const costV = cost.state === 'ok' ? (cur + ' ' + money(cost.total, 2)) : (cost.state === 'unconfigured' ? '未配置' : '—');
      const costS = cost.state === 'ok'
        ? '近两个月 · 官网对账'
        : (cost.state === 'unconfigured' ? '需要 ' + (cost.keyRef || 'DEEPSEEK_USER_TOKEN') : (cost.err || '获取失败'));
      const effV = (data.costPer100m === null || data.costPer100m === undefined) ? '—' : (cur + ' ' + money(data.costPer100m, 2));
      // 本对话消费:整段对话口径(优先宿主日志汇总,其次客户端 tokenUsage 投影,最后退回宿主内存拦截)
      const whole = props.whole || null;
      const sessV = '$ ' + money(whole ? whole.costUsd : (sess.totals && sess.totals.costUsd), 4);
      const sessS = whole
        ? (compact(whole.tokens) + ' tokens' + (whole.steps > 0 ? ' · ' + fmtInt(whole.steps) + ' 步' : ''))
        : (fmtInt(sess.totals && sess.totals.calls) + ' 次调用 · 本次运行');
      const rtV = '$ ' + money(rt.totals.costUsd, 2);
      const rtS = fmtInt(rt.totals.calls) + ' 次调用 · ' + compact(rt.totals.totalTokens) + ' tokens';

      // 按模型(官网用量)
      const all = Array.isArray(data.perModel) ? data.perModel : [];
      const rows = all.filter((m) => Number(m.tokens) > 0).sort((a, b) => Number(b.cost || 0) - Number(a.cost || 0));
      const costSum = rows.reduce((acc, m) => acc + (Number(m.cost) || 0), 0);
      const tokenSum = rows.reduce((acc, m) => acc + (Number(m.tokens) || 0), 0);
      const current = data.currentModel;
      const modelNodes = rows.length === 0
        ? [h('li', { className: 'dskc-empty', key: 'empty' }, '暂无用量数据')]
        : rows.map((m) => {
            const isCur = current && m.model === current;
            const share = costSum > 0 ? (Number(m.cost) || 0) / costSum : (tokenSum > 0 ? (Number(m.tokens) || 0) / tokenSum : 0);
            return h('li', { className: 'dskc-item' + (isCur ? ' is-current' : ''), key: m.model },
              h('div', { className: 'dskc-item-top' },
                h('span', { className: 'dskc-model', title: m.model }, prettyModel(m.model)),
                h('span', { className: 'dskc-share' }, h('i', { style: { width: (Math.max(2, Math.round(share * 100))) + '%' } })),
                h('span', { className: 'dskc-cost' }, cur + ' ' + money(m.cost, 2))),
              h('div', { className: 'dskc-item-meta' },
                h('span', null, compact(m.tokens) + ' tokens'),
                h('span', null, '命中 ' + pct(m.hitRate)),
                h('span', { className: 'sp' }),
                h('span', null, '每亿 ' + (m.per100mCost === null || m.per100mCost === undefined ? '—' : cur + ' ' + money(m.per100mCost, 2)))));
          });

      const notes = [];
      if (cost.state === 'error') notes.push(h('div', { className: 'dskc-err', key: 'n1' }, '官网消费:' + (cost.err || '获取失败')));
      if (off.state === 'error') notes.push(h('div', { className: 'dskc-err', key: 'n2' }, '官网用量:' + (off.err || '获取失败')));
      if (cost.state === 'unconfigured' || off.state === 'unconfigured') {
        notes.push(h('div', { className: 'dskc-hint', key: 'n0' },
          '官网用量与消费需要平台登录 token(' + ((off.keyRef || cost.keyRef) || 'DEEPSEEK_USER_TOKEN') + ');未配置时只显示余额与本地统计。'));
      }

      const online = !!(data.diag && (data.diag.platformToken !== undefined ? data.diag.platformToken : data.diag.userToken));
      return h('div', { className: 'dskc-body' },
        h('div', { className: 'dskc-desc' },
          (online ? '官网已连接' : '仅 API 余额') + ' · 更新 ' + clockOf(bal.at) + ' · 运行 ' + uptime),
        h('div', { className: 'dskc-cols' },
          h('div', { className: 'dskc-col-left' },
            h('div', { className: 'dskc-hero' },
              h('div', { className: 'dskc-hero-k' }, '账户余额'),
              heroV,
              heroS),
            h('dl', { className: 'dskc-kv' },
              kv('官网消费', costV, costS),
              kv('综合每亿 token', effV, '消费 ÷ tokens'),
              kv(whole ? '本对话消费(整段)' : '本对话消费', sessV, sessS),
              kv('本次运行', rtV, rtS))),
          h('div', { className: 'dskc-col-right' },
            h('div', { className: 'dskc-section' },
              h('div', { className: 'dskc-section-head' },
                h('span', null, '按模型'),
                h('span', { className: 'sp' }),
                h('span', null, compact(off.tokens) + ' tokens · ' + fmtInt(off.requests) + ' 次')),
              h('ul', { className: 'dskc-list' }, modelNodes)))),
        notes.length ? h('div', { className: 'dskc-notes' }, notes) : null);
    }

    // ---------- 触发行 + 点击弹出的面板 ----------
    function StatsSegment(props) {
      const sessionId = (props && props.sessionId) || '';
      const snap = useSnapshot(props && props.ctx, sessionId);
      const data = snap.data;
      const error = snap.error;
      const refresh = snap.refresh;

      // 整段对话用量:宿主 session-projection 由完整会话日志汇总,不受宿主重启/前端窗口影响
      const useProjection = (props && props.useProjection) || (() => undefined);
      const tokenUsage = useProjection('tokenUsage');
      const sessionStats = useProjection('sessionStats');

      const hostSess = (data && data.session) || null;
      let whole = null;
      if (hostSess && hostSess.source === 'log' && hostSess.totals) {
        whole = {
          source: 'log',
          costUsd: Number(hostSess.totals.costUsd) || 0,
          tokens: Number(hostSess.totals.totalTokens) || 0,
          steps: Number(hostSess.totals.calls) || 0,
        };
      } else if (tokenUsage) {
        const unc = Number(tokenUsage.uncachedInputTokens) || 0;
        const cr = Number(tokenUsage.cacheReadTokens) || 0;
        const cw = Number(tokenUsage.cacheWriteTokens) || 0;
        const out = Number(tokenUsage.outputTokens) || 0;
        const tokens = unc + cr + cw + out;
        if (tokens > 0) {
          whole = {
            source: 'projection',
            costUsd: costOfUsage(tokenUsage, data && data.currentModel, data && data.pricing),
            tokens,
            steps: Number(sessionStats && sessionStats.steps) || 0,
          };
        }
      }

      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);

      // 点击外部 / Esc 关闭
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
          const t = e.target;
          if (panelRef.current && panelRef.current.contains(t)) return;
          if (triggerRef.current && triggerRef.current.contains(t)) return;
          setOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      // 量取输入框卡片(radius-panel 28px 的那个):面板与「对话框」同宽同位
      const measureCard = () => {
        const input = document.querySelector('[data-composer-input]');
        if (!input) return null;
        let node = input;
        for (let i = 0; i < 6; i += 1) {
          const p = node.parentElement;
          if (!p || p === document.body || p === document.documentElement) break;
          const cs = window.getComputedStyle(p);
          const r = p.getBoundingClientRect();
          const radius = parseFloat(cs.borderTopLeftRadius) || 0;
          if (radius >= 16 && r.width >= 240) return r;
          node = p;
        }
        const r = input.getBoundingClientRect();
        return r.width >= 240 ? r : null;
      };

      const place = React.useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const own = el.getBoundingClientRect();
        const card = measureCard();
        const maxW = window.innerWidth - 24;
        const width = Math.round(Math.min(Math.max(280, card ? card.width : own.width), maxW));
        const left = Math.round(Math.min(Math.max(12, card ? card.left : own.left), Math.max(12, window.innerWidth - width - 12)));
        const bottom = Math.max(12, Math.round(window.innerHeight - own.top + 8));
        const maxHeight = Math.max(220, Math.min(680, Math.round(own.top - 24)));
        setPos({ left, bottom, width, maxHeight, wide: width >= 620 });
      }, []);

      React.useLayoutEffect(() => {
        if (!open) { setPos(null); return undefined; }
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open, place]);

      // 触发条内容
      const bal = (data && data.balance) || {};
      const cost = (data && data.cost) || {};
      const cur = curOf(cost.currency);
      const sess = (data && data.session) || { totals: { costUsd: 0 } };
      const okBalance = bal.state === 'ok';
      const tone = !data ? '' : (bal.state === 'error' ? 'err' : ((cost.state === 'error' || bal.state === 'unconfigured') ? 'warn' : ''));
      let effTxt = null;
      if (data && data.currentModel) {
        const cm = data.currentModel;
        const row = (data.perModel || []).find((m) => m.model === cm);
        if (row && row.per100mCost !== null && row.per100mCost !== undefined) {
          effTxt = '每亿tokens ' + cur + money(row.per100mCost, 2);
        } else {
          const rrow = ((data.realtime || {}).perModel || []).find((m) => m.model === cm);
          if (rrow && rrow.totalTokens > 0) effTxt = '每亿tokens $ ' + money((rrow.costUsd / rrow.totalTokens) * 1e8, 2);
        }
      }
      const costTxt = cost.state === 'ok' ? ('官网消费 ' + cur + money(cost.total, 2)) : '官网消费 —';
      const balTxt = okBalance ? ('¥ ' + money(bal.total, 2)) : (bal.state === 'unconfigured' ? '未配置' : (bal.state === 'error' ? '余额失败' : '余额…'));

      const seg = [];
      seg.push(h('span', { className: 'dskc-dot' + (tone ? ' ' + tone : ''), key: 'd' }));
      seg.push(h('b', { key: 'b', className: okBalance ? '' : 'bad' }, '余额 ' + balTxt));
      seg.push(h('span', { className: 'sep', key: 's1' }, '·'));
      seg.push(h('span', { key: 'c' }, costTxt));
      seg.push(h('span', { className: 'sep', key: 's2' }, '·'));
      seg.push(h('span', { key: 'x' }, '本对话 $' + money(whole ? whole.costUsd : (sess.totals && sess.totals.costUsd), 4)));
      if (whole) {
        seg.push(h('span', { className: 'sep', key: 's3b' }, '·'));
        seg.push(h('span', { className: 'mut', key: 'w' }, compact(whole.tokens) + ' tokens'));
      }
      if (effTxt) {
        seg.push(h('span', { className: 'sep', key: 's3' }, '·'));
        seg.push(h('span', { className: 'mut', key: 'e' }, effTxt));
      }
      seg.push(h('span', { className: 'caret', key: 'k' }, '▼'));

      const panel = open
        ? h('div', {
            className: 'dskc-panel' + (pos && pos.wide ? ' is-wide' : ''),
            ref: panelRef,
            role: 'dialog',
            'aria-label': 'DeepSeek 计费详情',
            style: pos
              ? { left: pos.left + 'px', bottom: pos.bottom + 'px', width: pos.width + 'px', maxHeight: pos.maxHeight + 'px' }
              : { left: '12px', bottom: '80px', width: '560px', maxHeight: 'min(72vh, 640px)' },
          },
          h('header', { className: 'dskc-head' },
            h('span', { className: 'dskc-title' }, '计费罗盘'),
            h('span', { className: 'sp' }),
            h('button', { className: 'dskc-icon', type: 'button', title: '刷新', 'aria-label': '刷新', onClick: refresh }, '⟳'),
            h('button', { className: 'dskc-icon', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => setOpen(false) }, '✕')),
          h(PanelBody, { data, error, whole }),
          h('footer', { className: 'dskc-foot' }, '数据源:DeepSeek 官网(余额 / 用量 / 消费)+ 本地拦截估算;不落盘,重启清零;每 10 秒自动刷新。'))
        : null;

      return h('span', { className: 'dskc-anchor' },
        h('button', {
          ref: triggerRef,
          className: 'dskc-trigger' + (open ? ' is-open' : ''),
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          title: '点击查看计费详情',
          onClick: () => setOpen((v) => !v),
        }, seg),
        panel);
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => { if (style.parentNode) style.parentNode.removeChild(style); }, 'dsh-billing-compass: styles');

      ctx.slots.inject('conversation.composer.dock', () => {
        const dispose = ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'deepseek-billing', order: 10 },
          (props) => h(StatsSegment, {
            sessionId: props && props.sessionId,
            ctx,
            useProjection: props && props.useProjection,
          }));
        return () => { dispose(); };
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
