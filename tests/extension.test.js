// src/bridge.js, src/background.js and manifest.json against stubs of the chrome.* APIs. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function makeChrome(initial = {}) {
  const store = { ...initial };
  const sent = [];
  const badges = [];
  const onMessage = [];
  const onChanged = [];
  const onRemoved = [];
  const chrome = {
    runtime: {
      id: 'self',
      sendMessage: (m) => { sent.push(m); return Promise.resolve(); },
      onMessage: { addListener: (fn) => onMessage.push(fn) },
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...store }),
        set: async (v) => {
          const changes = {};
          for (const [k, nv] of Object.entries(v)) { changes[k] = { oldValue: store[k], newValue: nv }; store[k] = nv; }
          onChanged.forEach((fn) => fn(changes, 'local'));
        },
      },
      onChanged: { addListener: (fn) => onChanged.push(fn) },
    },
    action: {
      setBadgeText: async (o) => { badges.push(o); },
      setBadgeBackgroundColor: async () => {},
    },
    tabs: { onRemoved: { addListener: (fn) => onRemoved.push(fn) } },
  };
  return { chrome, store, sent, badges, onMessage, onChanged, onRemoved };
}

function makeBridge(initial) {
  const c = makeChrome(initial);
  const listeners = {};
  const events = [];
  const document = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (ev) => { events.push(ev); (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail !== undefined ? init.detail : null; } }
  const ctx = vm.createContext({ chrome: c.chrome, document, CustomEvent, JSON, Number, Math, Array, Set, Promise, String });
  vm.runInContext(src('src/bridge.js'), ctx);
  const fromPage = (name, payload) => document.dispatchEvent(new CustomEvent(`youtube-shield:${name}`,
    { detail: typeof payload === 'string' ? payload : JSON.stringify(payload) }));
  const settings = () => events.filter((e) => e.type === 'youtube-shield:settings').map((e) => JSON.parse(e.detail));
  return { ...c, events, fromPage, settings };
}

test('bridge: the stored setting reaches the page at start, again when the page script announces itself, and on change', async () => {
  const b = makeBridge({ enabled: false });
  await flush();
  assert.deepEqual(b.settings(), [{ enabled: false }]);
  assert.ok(b.events.some((e) => e.type === 'youtube-shield:hello'));
  // A page script that started after that first push missed it: its "ready" must get the setting sent again.
  b.fromPage('ready', { version: 1 });
  assert.equal(b.settings().length, 2, 'sent again on ready');
  assert.deepEqual(b.settings().at(-1), { enabled: false });
  await b.chrome.storage.local.set({ enabled: true });
  assert.deepEqual(b.settings().at(-1), { enabled: true });
});

test('bridge: a status is forwarded with only known fields, each type-checked and bounded', async () => {
  const b = makeBridge();
  await flush();
  b.fromPage('status', {
    run: 'abc123', enabled: true, enforcement: 'yes', enforcementSign: '<img src=x>', adsSkipped: 3, secondsSaved: -5,
    adPlaying: true, adMode: 'SSAP<script>', lastAdMs: 420, log: ['ok', 7, 'x'.repeat(500)], extra: 'dropped',
  });
  const msg = b.sent.find((m) => m.type === 'status');
  assert.deepEqual(Object.keys(msg.status).sort(),
    ['adMode', 'adPlaying', 'adsSkipped', 'enabled', 'enforcement', 'enforcementSign', 'lastAdMs', 'log', 'run', 'secondsSaved']);
  assert.equal(msg.status.enforcement, false);
  assert.equal(msg.status.enforcementSign, undefined);
  assert.equal(msg.status.secondsSaved, 0);
  assert.equal(msg.status.adMode, undefined);
  assert.equal(msg.status.adsSkipped, 3);
  assert.deepEqual(msg.status.log.map((l) => l.length), [2, 160], 'non-strings dropped, long lines cut');
  for (const bad of ['not json', '[1,2]', 'null']) b.fromPage('status', bad);
  assert.equal(b.sent.filter((m) => m.type === 'status').length, 1);
});

test('bridge: skips are forwarded only with a plausible number of seconds', async () => {
  const b = makeBridge();
  await flush();
  for (const s of [12.5, -1, 99999, 'x', '12', null, true]) b.fromPage('skipped', { seconds: s });
  for (const bad of ['null', '[]', 'nope']) b.fromPage('skipped', bad);
  const skips = JSON.parse(JSON.stringify(b.sent.filter((m) => m.type === 'skipped'))); // out of the sandbox's realm
  assert.deepEqual(skips, [{ type: 'skipped', seconds: 12.5 }]);
});

test('bridge: the popup gets the last status it heard', async () => {
  const b = makeBridge();
  await flush();
  let got;
  b.onMessage[0]({ type: 'get-status' }, {}, (r) => { got = r; });
  assert.equal(got, null);
  b.fromPage('status', { run: 'r1', adsSkipped: 2, log: [] });
  b.onMessage[0]({ type: 'get-status' }, {}, (r) => { got = r; });
  assert.equal(got.adsSkipped, 2);
});

function makeBackground(initial) {
  const c = makeChrome(initial);
  const ctx = vm.createContext({ chrome: c.chrome, Map, Number, Math, String, Promise, globalThis: null });
  ctx.globalThis = ctx;
  vm.runInContext(src('src/background.js'), ctx);
  const bg = ctx.__youtubeShieldBackground;
  const msg = (m, tabId = 7, frameId = 0, id = 'self') => c.onMessage[0](m, { id, tab: { id: tabId }, frameId });
  const badge = (tabId = 7) => c.badges.filter((b) => b.tabId === tabId).at(-1)?.text;
  return { ...c, bg, msg, badge };
}

test('background: the badge is the sum over a tab\'s frames, "!" at the ad-blocker notice, and resets on a new page', () => {
  const b = makeBackground();
  b.msg({ type: 'status', status: { run: 'p1', adsSkipped: 2, enforcement: false } });
  assert.equal(b.badge(), '2');
  b.msg({ type: 'status', status: { run: 'e1', adsSkipped: 1, enforcement: false } }, 7, 3);
  assert.equal(b.badge(), '3');
  b.msg({ type: 'status', status: { run: 'e1', adsSkipped: 1, enforcement: true } }, 7, 3);
  assert.equal(b.badge(), '!');
  b.msg({ type: 'status', status: { run: 'p2', adsSkipped: 0, enforcement: false } });
  assert.equal(b.badge(), '', 'a reload drops the old page\'s frames');
  b.onRemoved[0](7);
  assert.equal(b.bg.tabs.has(7), false);
});

test('background: every skip adds to the totals, even two at once', async () => {
  const b = makeBackground({ totalAds: 4, totalSeconds: 100 });
  b.msg({ type: 'skipped', seconds: 30 });
  b.msg({ type: 'skipped', seconds: 15.5 }, 7, 2);
  await b.bg.flush();
  await b.bg.flush();
  assert.equal(b.store.totalAds, 6);
  assert.equal(b.store.totalSeconds, 145.5);
});

test('background: messages from another extension, from outside a tab, or out of bounds are ignored', async () => {
  const b = makeBackground();
  b.msg({ type: 'skipped', seconds: 30 }, 7, 0, 'other-extension');
  b.onMessage[0]({ type: 'skipped', seconds: 30 }, { id: 'self' });
  b.msg({ type: 'skipped', seconds: 4000 });
  b.msg({ type: 'skipped', seconds: '30' });
  await b.bg.flush();
  assert.equal(b.store.totalAds, undefined);
});

test('manifest: the page script runs in YouTube\'s world at document_start; the bridge in the isolated world', () => {
  const m = JSON.parse(src('manifest.json'));
  assert.equal(m.manifest_version, 3);
  const [page, bridge] = m.content_scripts;
  assert.deepEqual(page.js, ['src/page.js']);
  assert.equal(page.world, 'MAIN');
  assert.equal(page.run_at, 'document_start');
  assert.equal(page.all_frames, true);
  assert.deepEqual(bridge.js, ['src/bridge.js']);
  assert.ok(bridge.world === undefined || bridge.world === 'ISOLATED');
  assert.equal(bridge.run_at, 'document_start');
  assert.equal(bridge.all_frames, true);
  assert.ok(Number(m.minimum_chrome_version) >= 111, 'world: MAIN needs Chrome 111');
});

test('manifest: YouTube only, no request blocking, nothing beyond storage', () => {
  const m = JSON.parse(src('manifest.json'));
  for (const cs of m.content_scripts) {
    assert.deepEqual(cs.matches, ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*']);
    assert.equal(cs.exclude_matches, undefined);
  }
  assert.deepEqual(m.permissions, ['storage']);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.optional_permissions, undefined);
  assert.equal(m.declarative_net_request, undefined);
  assert.equal(m.web_accessible_resources, undefined, 'nothing a page can fetch to detect the extension');
});

test('manifest: every file it names exists, and each icon is a PNG of its stated size', () => {
  const m = JSON.parse(src('manifest.json'));
  const files = [m.background.service_worker, m.action.default_popup, ...m.content_scripts.flatMap((c) => c.js)];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  for (const [size, f] of [...Object.entries(m.icons), ...Object.entries(m.action.default_icon)]) {
    const png = fs.readFileSync(path.join(ROOT, f));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', f);
    assert.equal(png.readUInt32BE(16), Number(size), `${f} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${f} height`);
  }
});

test('icons: the committed PNGs are exactly what scripts/make-icons.mjs draws', async () => {
  const { pathToFileURL } = require('node:url');
  const { SIZES, draw, iconPath } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'make-icons.mjs')).href);
  for (const size of SIZES) assert.ok(fs.readFileSync(iconPath(size)).equals(draw(size)), `icons/icon-${size}.png`);
});
