window.__ModuleLoader__.load({
  id: 'dsh-billing-compass',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    /**
     * 面板必须 portal 到 document.body：输入框所在的 composer dock/容器带有
     * transform/filter/overflow 时，position: fixed 会以它为包含块并被裁切，
     * 导致弹窗相对输入框偏移、右边缘被截断。宿主自己的统计弹窗也是 portal 到 body 的。
     */
    let createPortal = null;
    try {
      const reactDom = require('react-dom');
      createPortal = reactDom && (reactDom.createPortal || (reactDom.default && reactDom.default.createPortal)) || null;
    } catch (_error) {
      createPortal = null;
    }

    const inject = ['slots', 'timer'];
    const VERSION = '1.0.7';

    // 配色:中性灰(主题 label/border 令牌)+ 单一品牌蓝(--dsw-static-deepseek-*)。
    // 面板尺寸/圆角/阴影照搬宿主 popover 的取值(bg-layer-2 + radius-lg + elevation-prominent),
    // 分隔线统一 .5px border-l2,不再使用渐变、光晕、彩色进度条等装饰。
    const CSS = `
      /* 主题变量必须同时挂在面板上：panel 通过 portal 挂到 document.body，
         不再是 .dskc-anchor 的后代，只写在 .dskc-anchor 上的变量不会继承进面板。
         注意：布局属性只属于 .dskc-anchor，不能写进这条共用规则，否则会把
         align-items:center 等泄漏到面板上，导致面板内容整体居中。 */
      .dskc-anchor {
        position: relative; display: inline-flex; align-items: center;
      }
      .dskc-anchor, .dskc-panel {
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
      .dskc-icon:disabled { opacity: .45; cursor: default; }
      .dskc-icon:disabled:hover { background: transparent; color: var(--dskc-ink-2); }

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

      /* ---------- 自动获取:同意卡片 + 加载动画 ---------- */
      @keyframes dskc-rise { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }
      @keyframes dskc-shimmer { 0% { background-position: -160% 0; } 100% { background-position: 260% 0; } }
      @keyframes dskc-spin { to { transform: rotate(360deg); } }
      @keyframes dskc-pulse { 0%, 100% { opacity: .35; } 50% { opacity: .85; } }
      @keyframes dskc-pop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }

      .dskc-consent {
        display: flex; gap: 12px; align-items: flex-start;
        margin: 4px 0 12px; padding: 12px 14px;
        border-radius: var(--dsw-radius-md, 12px);
        background: color-mix(in srgb, var(--dskc-brand) 7%, transparent);
        box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dskc-brand) 30%, transparent);
        animation: dskc-rise .28s cubic-bezier(.2, .9, .3, 1) both;
      }
      .dskc-consent.is-done { animation: dskc-pop .32s cubic-bezier(.2, .9, .3, 1) both; }
      .dskc-consent-icon {
        width: 28px; height: 28px; flex: none; border-radius: 50%;
        display: grid; place-items: center; font-size: 15px; font-weight: 700;
        color: #fff; background: var(--dskc-brand);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--dskc-brand) 16%, transparent);
        animation: dskc-pulse 2.4s ease-in-out infinite;
      }
      .dskc-consent.is-done .dskc-consent-icon { animation: dskc-pop .34s ease-out both; }
      .dskc-consent-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
      .dskc-consent-title { font-size: 13px; font-weight: 600; color: var(--dskc-ink); }
      .dskc-consent-text { font-size: 12px; color: var(--dskc-ink-3); line-height: 1.55; }
      .dskc-consent-actions { display: flex; gap: 8px; margin-top: 8px; }
      .dskc-btn {
        font: inherit; font-size: 12px; line-height: 22px; padding: 0 10px;
        border-radius: var(--dsw-radius-sm, 8px); border: 0; cursor: pointer;
        transition: background-color .15s ease, opacity .15s ease, filter .15s ease;
      }
      .dskc-btn-primary {
        position: relative; overflow: hidden; color: #fff; background: var(--dskc-brand);
      }
      .dskc-btn-primary::after {
        content: ''; position: absolute; inset: 0; pointer-events: none;
        background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, .35) 45%, transparent 70%);
        background-size: 220% 100%; background-repeat: no-repeat; background-position: -160% 0;
        animation: dskc-shimmer 2.2s ease-in-out infinite;
      }
      .dskc-btn-primary:hover { filter: brightness(1.06); }
      .dskc-btn-ghost { color: var(--dskc-ink-2); background: transparent; }
      .dskc-btn-ghost:hover { background: var(--dskc-hover); color: var(--dskc-ink); }
      .dskc-spin { display: inline-block; animation: dskc-spin .9s linear infinite; }
      .dskc-skeleton {
        height: 12px; margin: 10px 0; border-radius: 6px;
        background: color-mix(in srgb, var(--dskc-ink) 10%, transparent);
        animation: dskc-pulse 1.4s ease-in-out infinite;
      }
      .dskc-skeleton.w40 { width: 40%; }
      .dskc-skeleton.w70 { width: 70%; }
      .dskc-skeleton.w55 { width: 55%; }
      @media (prefers-reduced-motion: reduce) {
        .dskc-consent, .dskc-consent-icon, .dskc-btn-primary::after,
        .dskc-skeleton, .dskc-spin { animation: none !important; }
      }

      /* ---------- 更新提示 ---------- */
      .dskc-update .dskc-consent-icon { animation: none; }
      .dskc-update-cmd {
        display: inline-block; margin-left: 4px; padding: 0 6px;
        border-radius: 6px; background: color-mix(in srgb, var(--dskc-ink) 8%, transparent);
        font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--dskc-ink-2);
        overflow-wrap: anywhere;
      }
      .dskc-btn { text-decoration: none; }
      .dskc-btn-ghost { display: inline-flex; align-items: center; }
      .dskc-update-badge {
        color: var(--dskc-brand); font-weight: 600;
        animation: dskc-pulse 2.4s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .dskc-update-badge { animation: none; }
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

    // ---------- 自动获取：用户同意记录(仅浏览器本地) ----------
    const AUTO_CONSENT_KEY = 'dsh.billingCompass.autoConsent';
    function readAutoConsent() {
      try {
        const value = window.localStorage.getItem(AUTO_CONSENT_KEY);
        return value === 'granted' ? 'granted' : (value === 'denied' ? 'denied' : null);
      } catch (_error) {
        return null;
      }
    }
    function writeAutoConsent(value) {
      try {
        if (value === 'granted' || value === 'denied') window.localStorage.setItem(AUTO_CONSENT_KEY, value);
        else window.localStorage.removeItem(AUTO_CONSENT_KEY);
      } catch (_error) {
        /* 本地存储不可用时只在本次会话生效 */
      }
    }

    // ---------- 更新提示：忽略某个版本只记录在浏览器本地 ----------
    const UPDATE_DISMISS_KEY = 'dsh.billingCompass.dismissedUpdate';
    function readDismissedUpdate() {
      try {
        return window.localStorage.getItem(UPDATE_DISMISS_KEY);
      } catch (_error) {
        return null;
      }
    }
    function writeDismissedUpdate(version) {
      try {
        if (version) window.localStorage.setItem(UPDATE_DISMISS_KEY, version);
        else window.localStorage.removeItem(UPDATE_DISMISS_KEY);
      } catch (_error) {
        /* 本地存储不可用时忽略 */
      }
    }

    async function fetchSnapshot(sessionId, autoGranted) {
      const url = '/api/dsh-billing?sessionId=' + encodeURIComponent(sessionId || '') + (autoGranted ? '&auto=1' : '');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    /** 快照轮询：页面不可见时暂停；同一时刻只允许一个请求；手动刷新保留 busy 状态。 */
    function useSnapshot(ctx, sessionId, autoGranted) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const aliveRef = React.useRef(true);
      const inflightRef = React.useRef(false);
      const refreshRef = React.useRef(null);
      React.useEffect(() => {
        aliveRef.current = true;
        const load = (manual) => {
          if (!aliveRef.current || inflightRef.current) return;
          if (!manual && typeof document !== 'undefined' && document.hidden) return;
          inflightRef.current = true;
          if (manual) setBusy(true);
          fetchSnapshot(sessionId, autoGranted)
            .then((s) => { if (aliveRef.current) { setData(s); setError(null); } })
            .catch((e) => { if (aliveRef.current) setError(String((e && e.message) || e)); })
            .finally(() => {
              inflightRef.current = false;
              if (aliveRef.current && manual) setBusy(false);
            });
        };
        refreshRef.current = () => load(true);
        load(false);
        const timer = ctx.interval(() => load(false), 10000);
        // 从后台切回来时立刻补一次，避免顶着 10 秒前的数据。
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) load(false); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
        return () => {
          aliveRef.current = false;
          refreshRef.current = null;
          timer();
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        };
      }, [sessionId, autoGranted]);
      const refresh = () => { if (refreshRef.current) refreshRef.current(); };
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
          error
            ? h('div', { className: 'dskc-loading' }, '加载失败:' + error)
            : h('div', { className: 'dskc-loading' },
              h('div', { className: 'dskc-skeleton w40' }),
              h('div', { className: 'dskc-skeleton w70' }),
              h('div', { className: 'dskc-skeleton w55' })));
      }
      const bal = data.balance || { state: 'pending' };
      const cost = data.cost || { state: 'pending' };
      const off = data.official || {};
      const rt = data.realtime || { totals: { calls: 0, totalTokens: 0, costUsd: 0 }, perModel: [] };
      const sess = data.session || { totals: { calls: 0, totalTokens: 0, costUsd: 0 } };
      const account = data.account || null;
      const upd = data.update || null;
      const cur = curOf(cost.currency);
      const uptime = Math.floor((data.uptimeSec || 0) / 60) + 'm' + pad2((data.uptimeSec || 0) % 60) + 's';

      // 余额
      let heroV;
      let heroS;
      if (bal.state === 'ok') {
        heroV = h('div', { className: 'dskc-hero-v' }, '¥ ' + money(bal.total, 2));
        heroS = h('div', { className: 'dskc-hero-s' },
          '充值 ' + money(bal.toppedUp, 2) + ' · 赠送 ' + money(bal.granted, 2) + ' · ' +
          (bal.available ? '可用' : '不可用') +
          (bal.source === 'account' ? ' · DSH 账号自动获取' : ''));
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
      // 子代理/子智能体的消费已由宿主并入 sess.totals;这里额外展示明细
      const sub = (sess && sess.children) || { count: 0, costUsd: 0, tokens: 0, calls: 0 };
      const subagentPending = Number(sess.subagentTotal || 0) > Number(sub.count || 0);
      const sessS = whole
        ? (compact(whole.tokens) + ' tokens' + (whole.steps > 0 ? ' · ' + fmtInt(whole.steps) + ' 步' : '') +
          (sub.count > 0 ? ' · 含 ' + fmtInt(sub.count) + ' 个子代理' : (subagentPending ? ' · 子代理统计中…' : '')))
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
      const autoSources = [];
      const autoAccount = account && account.consent === true;
      if (account && account.balanceSource === 'account') autoSources.push('余额');
      if (account && account.officialSource === 'account') autoSources.push('用量');
      if (account && account.costSource === 'account') autoSources.push('消费');
      if (autoAccount && autoSources.length > 0) {
        notes.push(h('div', { className: 'dskc-hint', key: 'n3' }, '由 DSH 账号自动获取:' + autoSources.join('、') + '。'));
      }
      if (cost.state === 'error') notes.push(h('div', { className: 'dskc-err', key: 'n1' }, '官网消费:' + (cost.err || '获取失败')));
      if (off.state === 'error') notes.push(h('div', { className: 'dskc-err', key: 'n2' }, '官网用量:' + (off.err || '获取失败')));
      if (cost.state === 'unconfigured' || off.state === 'unconfigured') {
        notes.push(h('div', { className: 'dskc-hint', key: 'n0' },
          '官网用量与消费需要平台登录 token(' + ((off.keyRef || cost.keyRef) || 'DEEPSEEK_USER_TOKEN') + ');未配置时只显示余额与本地统计。'));
      }
      if (sub.count > 0) {
        notes.push(h('div', { className: 'dskc-hint', key: 'n4' },
          '「本对话」已计入 ' + fmtInt(sub.count) + ' 个子代理/子智能体的消费。'));
      } else if (subagentPending) {
        notes.push(h('div', { className: 'dskc-hint', key: 'n5' }, '正在汇总子代理/子智能体的消费…'));
      }

      const online = !!(data.diag && (data.diag.platformToken !== undefined ? data.diag.platformToken : data.diag.userToken));
      const descAuto = [];
      if (account && account.balanceSource === 'account') descAuto.push('余额');
      if (account && account.officialSource === 'account') descAuto.push('用量');
      if (account && account.costSource === 'account') descAuto.push('消费');
      const autoDesc = descAuto.length > 0 ? 'DSH 账号自动:' + descAuto.join('/') : '';
      return h('div', { className: 'dskc-body' },
        props.consentNode ? props.consentNode : null,
        props.updateNode ? props.updateNode : null,
        h('div', { className: 'dskc-desc' },
          (online ? '官网已连接' : '仅 API 余额') +
          (autoDesc ? '(' + autoDesc + ')' : '') +
          ' · 更新 ' + clockOf(bal.at) + ' · 运行 ' + uptime),
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
              sub.count > 0
                ? kv('子代理/子智能体', '$ ' + money(sub.costUsd, 4), fmtInt(sub.calls) + ' 次调用 · ' + compact(sub.tokens) + ' tokens')
                : null,
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
      // 自动获取是显式同意制：只有用户点过"允许自动获取"才在请求里带 auto=1。
      const [consent, setConsent] = React.useState(readAutoConsent());
      const [consentDone, setConsentDone] = React.useState(false);
      const [dismissedUpdate, setDismissedUpdate] = React.useState(readDismissedUpdate());
      const [copiedUpdate, setCopiedUpdate] = React.useState(false);
      const snap = useSnapshot(props && props.ctx, sessionId, consent === 'granted');
      const data = snap.data;
      const error = snap.error;
      const refresh = snap.refresh;
      const busy = snap.busy;
      const account = (data && data.account) || null;

      const grantAuto = () => {
        writeAutoConsent('granted');
        setConsent('granted');
        setConsentDone(true);
        refresh();
        window.setTimeout(() => setConsentDone(false), 2400);
      };
      const denyAuto = () => {
        writeAutoConsent('denied');
        setConsent('denied');
      };
      const allowAgain = () => {
        writeAutoConsent(null);
        setConsent(null);
      };

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

      // 量取输入框卡片：宿主在输入框卡片上带了稳定的 data-composer-card 标记，
      // 面板与它同宽、同左边界对齐；没有标记时再沿 data-composer-input 向上找最宽的圆角容器。
      const measureCard = () => {
        const cardElement = document.querySelector('[data-composer-card]');
        if (cardElement) {
          const rect = cardElement.getBoundingClientRect();
          if (rect.width >= 240 && rect.height >= 40) return rect;
        }
        const input = document.querySelector('[data-composer-input]');
        if (!input) return null;
        let node = input;
        const candidates = [];
        for (let i = 0; i < 8; i += 1) {
          const p = node.parentElement;
          if (!p || p === document.body || p === document.documentElement) break;
          const cs = window.getComputedStyle(p);
          const r = p.getBoundingClientRect();
          const radius = parseFloat(cs.borderTopLeftRadius) || 0;
          if (radius >= 16 && r.width >= 240 && r.height >= 40) candidates.push({ r, radius });
          node = p;
        }
        if (candidates.length > 0) {
          // 内层输入行也有圆角但更窄；取最宽的圆角容器才是整张输入框卡片。
          const outer = candidates.filter((c) => c.radius >= 20);
          const pool = outer.length > 0 ? outer : candidates;
          const widest = pool.reduce((a, b) => (b.r.width > a.r.width ? b : a));
          return widest.r;
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
        // 面板吸附在输入框卡片上方：触发条在输入框下面，若以它定位会把输入框盖住。
        const anchorTop = Math.max(24, Math.round(card ? card.top : own.top));
        const bottom = Math.max(12, Math.round(window.innerHeight - anchorTop + 10));
        const maxHeight = Math.max(220, Math.min(680, anchorTop - 24));
        const wide = width >= 620;
        // 滚动/resize 会高频触发：位置没变就不重新渲染。
        setPos((prev) => (prev && prev.left === left && prev.bottom === bottom && prev.width === width
          && prev.maxHeight === maxHeight && prev.wide === wide ? prev : { left, bottom, width, maxHeight, wide }));
      }, []);

      const closePanel = React.useCallback((refocus) => {
        setOpen(false);
        if (refocus === true) {
          const el = triggerRef.current;
          if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
        }
      }, []);

      const openPanel = React.useCallback(() => {
        place();
        setOpen(true);
      }, [place]);

      // 点击外部关闭（不抢焦点）/ Esc 关闭并把焦点归还触发行。
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
          const t = e.target;
          if (panelRef.current && panelRef.current.contains(t)) return;
          if (triggerRef.current && triggerRef.current.contains(t)) return;
          closePanel(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') closePanel(true); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open, closePanel]);

      React.useLayoutEffect(() => {
        if (!open) { setPos(null); return undefined; }
        place();
        let frame = 0;
        const schedule = () => {
          if (frame) return;
          frame = (typeof window.requestAnimationFrame === 'function')
            ? window.requestAnimationFrame(() => { frame = 0; place(); })
            : window.setTimeout(() => { frame = 0; place(); }, 16);
        };
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        // 输入框长高/变矮（多行输入、附件条出现）时同步重算，避免面板又盖住输入区。
        let observer = null;
        const target = document.querySelector('[data-composer-card]') || document.querySelector('[data-composer-input]');
        if (target && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule);
          observer.observe(target);
        }
        return () => {
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
          if (observer) observer.disconnect();
          if (frame) {
            if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
            else window.clearTimeout(frame);
          }
        };
      }, [open, place]);

      // 打开时把焦点交给面板，键盘用户可以直接 Tab 进面板内容。
      React.useEffect(() => {
        if (!open) return undefined;
        const timer = window.setTimeout(() => {
          const el = panelRef.current;
          if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
        }, 0);
        return () => window.clearTimeout(timer);
      }, [open]);

      // 自动获取同意卡片：检测到 DSH 账号且还没做过选择时出现；被拒绝后仅当数据缺失时再提示。
      const missingData = !data || !data.balance || data.balance.state !== 'ok'
        || !data.official || data.official.state !== 'ok'
        || !data.cost || data.cost.state !== 'ok';
      const needsConsent = !!(account && account.available === true
        && (consent === null || (consent === 'denied' && missingData)));
      let consentNode = null;
      if (needsConsent) {
        if (consentDone) {
          consentNode = h('div', { className: 'dskc-consent is-done', key: 'consent', 'aria-live': 'polite' },
            h('span', { className: 'dskc-consent-icon' }, '✓'),
            h('div', { className: 'dskc-consent-main' },
              h('div', { className: 'dskc-consent-title' }, '已开启自动获取'),
              h('div', { className: 'dskc-consent-text' }, '正在用 DSH 账号读取账户余额；官网用量/消费仍沿用你配置的 token。')));
        } else if (consent === 'denied') {
          consentNode = h('div', { className: 'dskc-consent', key: 'consent', 'aria-live': 'polite' },
            h('span', { className: 'dskc-consent-icon' }, '🔒'),
            h('div', { className: 'dskc-consent-main' },
              h('div', { className: 'dskc-consent-title' }, '自动获取已关闭'),
              h('div', { className: 'dskc-consent-text' }, '仍可手动配置 DEEPSEEK_API_KEY / DEEPSEEK_USER_TOKEN。'),
              h('div', { className: 'dskc-consent-actions' },
                h('button', { className: 'dskc-btn dskc-btn-ghost', type: 'button', onClick: allowAgain }, '重新允许'))));
        } else {
          consentNode = h('div', { className: 'dskc-consent', key: 'consent', 'aria-live': 'polite' },
            h('span', { className: 'dskc-consent-icon' }, '✨'),
            h('div', { className: 'dskc-consent-main' },
              h('div', { className: 'dskc-consent-title' }, '自动获取余额'),
              h('div', { className: 'dskc-consent-text' }, '检测到已登录 DeepSeek 账号。允许本插件自动读取账户余额吗？官网用量/消费仍沿用你配置的 token；数据只在本机使用，不会上传。'),
              h('div', { className: 'dskc-consent-actions' },
                h('button', { className: 'dskc-btn dskc-btn-primary', type: 'button', onClick: grantAuto }, '允许自动获取'),
                h('button', { className: 'dskc-btn dskc-btn-ghost', type: 'button', onClick: denyAuto }, '暂不'))));
        }
      }

      // 更新提示卡片：有新版本且未被忽略时出现;复制升级命令后按钮短暂变"已复制"
      const upd = (data && data.update) || null;
      let updateNode = null;
      if (upd && upd.hasUpdate && upd.latest && dismissedUpdate !== upd.latest) {
        const command = 'dsh plugin add dsh-billing-compass@' + upd.latest;
        const copyCommand = () => {
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(command).catch(() => {});
            }
          } catch (_error) { /* 忽略 */ }
          setCopiedUpdate(true);
          window.setTimeout(() => setCopiedUpdate(false), 2200);
        };
        const dismissUpdate = () => {
          writeDismissedUpdate(upd.latest);
          setDismissedUpdate(upd.latest);
        };
        updateNode = h('div', { className: 'dskc-consent dskc-update', key: 'update', 'aria-live': 'polite' },
          h('span', { className: 'dskc-consent-icon' }, '↑'),
          h('div', { className: 'dskc-consent-main' },
            h('div', { className: 'dskc-consent-title' }, '发现新版本 v' + upd.latest),
            h('div', { className: 'dskc-consent-text' },
              '当前 v' + (upd.current || VERSION) + '，升级后重启 Harness 生效。命令：',
              h('code', { className: 'dskc-update-cmd' }, command)),
            h('div', { className: 'dskc-consent-actions' },
              h('button', { className: 'dskc-btn dskc-btn-primary', type: 'button', onClick: copyCommand }, copiedUpdate ? '已复制 ✓' : '复制升级命令'),
              h('a', {
                className: 'dskc-btn dskc-btn-ghost', href: 'https://github.com/wwu328763-netizen/dsh-billing-compass/releases/latest',
                target: '_blank', rel: 'noreferrer', onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); },
              }, '更新说明'),
              h('button', { className: 'dskc-btn dskc-btn-ghost', type: 'button', onClick: dismissUpdate }, '忽略此版本'))));
      }

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

      const panelNode = open
        ? h('div', {
            id: 'dskc-panel',
            className: 'dskc-panel' + (pos && pos.wide ? ' is-wide' : ''),
            ref: panelRef,
            role: 'dialog',
            'aria-label': 'DeepSeek 计费详情',
            'aria-modal': 'false',
            tabIndex: -1,
            style: pos
              ? { left: pos.left + 'px', bottom: pos.bottom + 'px', width: pos.width + 'px', maxHeight: pos.maxHeight + 'px' }
              : { left: '12px', bottom: '80px', width: '560px', maxHeight: 'min(72vh, 640px)' },
          },
          h('header', { className: 'dskc-head' },
            h('span', { className: 'dskc-title' }, '计费罗盘'),
            h('span', { className: 'sp' }),
            h('button', {
              className: 'dskc-icon', type: 'button', title: busy ? '刷新中…' : '刷新', 'aria-label': '刷新',
              disabled: busy, onClick: refresh,
            }, busy ? h('span', { className: 'dskc-spin' }, '⟳') : '⟳'),
            h('button', { className: 'dskc-icon', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => closePanel(true) }, '✕')),
          h(PanelBody, { data, error, whole, consentNode, updateNode }),
          h('footer', { className: 'dskc-foot' },
            '数据源:DeepSeek 官网(余额 / 用量 / 消费)+ 本地拦截估算;不落盘,重启清零;每 10 秒自动刷新。 · v' + VERSION,
            upd && upd.hasUpdate && upd.latest ? h('span', { className: 'dskc-update-badge' }, ' · v' + upd.latest + ' 可更新') : null))
        : null;
      const panel =
        panelNode !== null && createPortal !== null && typeof document !== 'undefined'
          ? createPortal(panelNode, document.body)
          : panelNode;

      return h('span', { className: 'dskc-anchor' },
        h('button', {
          ref: triggerRef,
          className: 'dskc-trigger' + (open ? ' is-open' : ''),
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          'aria-controls': 'dskc-panel',
          title: '点击查看计费详情',
          onClick: () => (open ? closePanel(false) : openPanel()),
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
