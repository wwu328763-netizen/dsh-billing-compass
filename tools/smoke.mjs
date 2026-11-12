// 零依赖自检：宿主半边可加载 + 路由返回快照；客户端半边可在无浏览器环境注册。
// 用法: npm test   (node tools/smoke.mjs)
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

async function hostTest() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-billing-smoke-'));
  const previousHome = process.env.DSH_HOME;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousToken = process.env.DEEPSEEK_USER_TOKEN;
  process.env.DSH_HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_USER_TOKEN;
  try {
    const plugin = await import(new URL('lib/index.js', root).href);
    check('host exports name/inject/apply', () => {
      assert.equal(typeof plugin.apply, 'function');
      assert.equal(plugin.name, 'dsh-billing-compass');
      assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('webServer'));
    });

    const routes = [];
    const ctx = {
      on() {},
      interval() { return () => {}; },
      effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
      get() { return undefined; },
      webServer: { register(route) { routes.push(route); return () => {}; } },
    };
    plugin.apply(ctx, { sessionLog: false, balanceIntervalMs: 600000, officialIntervalMs: 600000, retryIntervalMs: 600000 });
    check('host registers /api/dsh-billing route', () => {
      assert.equal(routes.length, 1);
      assert.equal(routes[0].path, '/api/dsh-billing');
      assert.equal(typeof routes[0].handler, 'function');
    });

    // 等首轮抓取落定（没有凭据时只会标记 unconfigured，不发起网络请求）。
    await new Promise((resolve) => setTimeout(resolve, 150));

    const responses = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      end(body) { responses.push({ status: this.statusCode, headers: this.headers, body }); },
    };
    await routes[0].handler({ url: '/api/dsh-billing?sessionId=smoke', headers: {} }, res);
    const body = JSON.parse(responses[0].body);
    check('snapshot has the documented shape', () => {
      assert.equal(responses[0].status, 200);
      assert.equal(responses[0].headers['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(body.balance.state, 'unconfigured');
      assert.equal(body.official.state, 'unconfigured');
      assert.equal(body.cost.state, 'unconfigured');
      assert.ok(Array.isArray(body.perModel));
      assert.ok(body.costPer100m === null || typeof body.costPer100m === 'number');
      assert.ok(body.pricing['deepseek-v4-flash']);
      assert.ok(body.account && typeof body.account.available === 'boolean');
      assert.equal(body.account.consent, false);
      assert.ok(body.session && body.session.children && typeof body.session.children.count === 'number');
      assert.equal(typeof body.session.subagentTotal, 'number');
      assert.ok(body.diag && typeof body.diag.zstd === 'boolean');
      assert.equal(body.diag.platformToken, false);
      assert.ok(body.diag.timing);
    });

    const badRes = { statusCode: 200, setHeader() {}, end() {} };
    await routes[0].handler({ url: '/api/dsh-billing', headers: {} }, badRes);
    check('route works without a sessionId', () => {
      assert.equal(badRes.statusCode, 200);
    });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousToken !== undefined) process.env.DEEPSEEK_USER_TOKEN = previousToken;
    await rm(home, { recursive: true, force: true });
  }
}

function makeReact() {
  const states = [];
  let cursor = 0;
  return {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat().filter((child) => child !== undefined && child !== null && child !== false),
      };
    },
    useState(initial) {
      const index = cursor++;
      if (states[index] === undefined) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
  };
}

async function clientTest() {
  const source = await readFile(new URL('lib/client.js', root), 'utf8');
  const react = makeReact();
  const styleNode = () => ({ textContent: '', setAttribute() {}, appendChild() {}, parentNode: null, style: {} });
  const documentStub = {
    head: { appendChild() {} },
    body: {},
    documentElement: {},
    hidden: false,
    createElement: styleNode,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  let factory = null;
  const windowStub = {
    innerWidth: 1280,
    innerHeight: 860,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    __ModuleLoader__: { load(spec) { factory = spec.factory; } },
  };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    setTimeout,
    clearTimeout,
    URL,
    fetch: async () => { throw new Error('offline'); },
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });

  check('client registers through the module loader', () => {
    assert.equal(typeof factory, 'function');
  });

  const fakeRequire = (name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return { createPortal: (node) => node };
    throw new Error('unexpected require: ' + name);
  };
  const exports = factory(fakeRequire);
  check('client exports inject/apply', () => {
    assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'));
    assert.equal(typeof exports.apply, 'function');
  });

  let registered = null;
  const componentCtx = {
    interval() { return () => {}; },
    slots: {
      inject(name, register) { register(); },
      register(options, component) { registered = component; return () => {}; },
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  exports.apply(componentCtx);
  check('client registers the composer dock entry', () => {
    assert.equal(typeof registered, 'function');
  });

  check('shared CSS rule does not leak layout props into the panel', () => {
    const selector = '.dskc-anchor, .dskc-panel {';
    const at = source.indexOf(selector);
    assert.ok(at >= 0, 'shared CSS rule missing');
    const block = source.slice(at, source.indexOf('}', at + selector.length));
    assert.ok(!/align-items/.test(block), 'align-items leaked into the shared rule');
    assert.ok(!/display:/.test(block), 'display leaked into the shared rule');
    assert.ok(source.includes('const VERSION = '), 'version marker missing');
  });

  const element = registered({ sessionId: 'smoke', ctx: componentCtx, useProjection: () => undefined });
  const tree = element.type({ ...element.props, useProjection: () => undefined });
  const trigger = tree.children.find((child) => child && child.props && String(child.props.className || '').includes('dskc-trigger'));
  check('closed trigger renders without a browser', () => {
    assert.ok(trigger, 'trigger element missing');
    assert.equal(trigger.props['aria-expanded'], 'false');
    const text = JSON.stringify(trigger);
    assert.ok(text.includes('余额'));
    assert.ok(text.includes('官网消费'));
  });
}

async function marketIndexTest() {
  const index = JSON.parse(await readFile(new URL('market/index.json', root), 'utf8'));
  check('market index is valid format 1', () => {
    assert.equal(index.format, 1);
    assert.ok(Array.isArray(index.plugins) && index.plugins.length > 0);
    const plugin = index.plugins.find((entry) => entry.name === 'dsh-billing-compass');
    assert.ok(plugin, 'plugin entry missing');
    assert.ok(plugin.versions.length > 0);
    for (const version of plugin.versions) {
      assert.match(String(version.version), /^\d+\.\d+\.\d+/);
      assert.ok(Number.isInteger(version.publishTimestamp));
      assert.ok(version.source && (version.source.type === 'npm' || version.source.type === 'git'));
    }
  });
}

await hostTest();
await clientTest();
await marketIndexTest();
console.log(`\nALL ${passed} CHECKS PASSED`);
