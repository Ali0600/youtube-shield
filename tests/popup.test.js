// src/popup.js against a stub DOM built from src/popup.html's own elements, and stub chrome.storage and chrome.tabs.
// Run: node --test tests/. The live popup is checked by scripts/e2e.mjs; this pins what it shows and writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeStorage } = require('./chrome-storage');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'popup.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'popup.html'), 'utf8');
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
// Values made inside the sandbox carry its realm's prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

// An element stub. Writing innerHTML is recorded and, like a browser, leaves only the text outside tags as textContent.
function makeElement(tag, { id = '', attrs = '', text = '' } = {}) {
  const listeners = {};
  let content = text;
  const el = {
    tagName: tag.toUpperCase(), id, children: [], dataset: {}, htmlWrites: [],
    hidden: /\shidden(\s|=|$)/.test(attrs),
    checked: /\schecked(\s|=|$)/.test(attrs),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    listeners,
    replaceChildren(...nodes) { el.children = nodes; },
  };
  const kind = attrs.match(/\sdata-kind="([^"]*)"/);
  if (kind) el.dataset.kind = kind[1];
  Object.defineProperty(el, 'textContent', { get: () => content, set: (v) => { content = String(v); }, enumerable: true });
  Object.defineProperty(el, 'innerHTML', {
    get: () => content,
    set: (v) => { el.htmlWrites.push(String(v)); content = String(v).replace(/<[^>]*>/g, ''); },
  });
  return el;
}

// Every element of popup.html that has an id, with the state the HTML gives it (checked, hidden, data-kind, its text).
function parseHtml() {
  const out = {};
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  for (let m; (m = re.exec(HTML));) {
    const attrs = ` ${m[2]}`;
    const id = attrs.match(/\sid="([^"]+)"/);
    if (!id) continue;
    const after = HTML.slice(re.lastIndex).match(new RegExp(`^([^<]*)</${m[1]}>`, 'i'));
    out[id[1]] = makeElement(m[1], { id: id[1], attrs, text: after ? after[1] : '' });
  }
  return out;
}

const ON = { run: 'abc12345', enabled: true, enforcement: false, adsSkipped: 0, secondsSaved: 0, adPlaying: false, log: ['active: https://www.youtube.com/watch?v=x'] };

// store: chrome.storage.local; tab: what chrome.tabs.query returns; status: what the page's bridge answers (a function
// is called per ask), or noReceiver: the tab has no content script (not YouTube), so sendMessage rejects.
function makePopup({ store = {}, tab = { id: 7 }, status = ON, noReceiver = false } = {}) {
  const els = parseHtml();
  const created = [];
  const timers = { intervals: [], timeouts: [] };
  const calls = { get: [], set: [], query: [], sendMessage: [] };
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => { created.push(tag); return makeElement(tag); },
  };
  const storage = makeStorage(store);
  const chrome = {
    storage: {
      local: {
        get: async (keys) => { calls.get.push(keys); return storage.get(keys); },
        set: async (v) => { calls.set.push({ ...v }); return storage.set(v); },
      },
    },
    tabs: {
      query: async (q) => { calls.query.push(q); return tab ? [tab] : []; },
      sendMessage: async (id, msg, opts) => {
        calls.sendMessage.push({ id, msg, opts });
        if (noReceiver) throw new Error('Could not establish connection. Receiving end does not exist.');
        return typeof status === 'function' ? status() : status;
      },
    },
  };
  const context = vm.createContext({
    document, chrome, String, Math, Number, Array, Object, JSON, Promise, Error,
    setInterval: (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; },
    setTimeout: (fn, ms) => { timers.timeouts.push({ fn, ms }); return timers.timeouts.length; },
  });
  return {
    els, created, timers, calls, store,
    open: async () => { vm.runInContext(SOURCE, context); await flush(); },
    poll: async () => { for (const t of timers.intervals) t.fn(); await flush(); },
    // A click on the switch, as a browser does it: the box toggles, then "click", "input" and "change" fire in order,
    // so a listener moved from one of those events to another still sees the click.
    click: async () => {
      els.enabled.checked = !els.enabled.checked;
      for (const type of ['click', 'input', 'change']) {
        for (const fn of els.enabled.listeners[type] || []) await fn({ type, target: els.enabled });
      }
      await flush();
    },
    runTimeouts: async () => { const due = timers.timeouts.splice(0); for (const t of due) t.fn(); await flush(); },
    shown: () => ({
      checked: els.enabled.checked, state: els.state.textContent, kind: els.state.dataset.kind, hint: els.hint.hidden ? null : els.hint.textContent,
      pageAds: els.pageAds.textContent, pageLabel: els.pageLabel.textContent, log: els.log.children.map((li) => li.textContent),
    }),
  };
}

test('popup: the switch follows storage when the popup opens, not the checked box popup.html starts with', async () => {
  const p = makePopup({ store: { enabled: false } });
  assert.equal(p.els.enabled.checked, true, 'precondition: popup.html marks the box checked');
  await p.open();
  assert.equal(p.shown().checked, false, 'stored off: the switch opens off');
  assert.equal(p.shown().state, 'Off: ads play as usual');

  // While open it keeps following storage, read once a second.
  p.store.enabled = true;
  await p.poll();
  assert.equal(p.shown().checked, true);
  p.store.enabled = false;
  await p.poll();
  assert.equal(p.shown().checked, false);

  for (const store of [{}, { enabled: true }]) {
    const q = makePopup({ store });
    q.els.enabled.checked = false; // so "on" must come from storage, not from the HTML
    await q.open();
    assert.equal(q.shown().checked, true, JSON.stringify(store));
  }
});

test('popup: the count, last ad, time skipped and all-time total come from the page status and storage', async () => {
  const p = makePopup({
    store: { enabled: true, totalAds: 3, totalSeconds: 3725 },
    status: { ...ON, adsSkipped: 37, lastAdMs: 1530, secondsSaved: 125 },
  });
  await p.open();
  assert.equal(p.els.pageAds.textContent, '37');
  assert.equal(p.els.pageLabel.textContent, 'ads skipped on this page');
  assert.equal(p.els.lastAd.textContent, '1.5 s');
  assert.equal(p.els.pageSaved.textContent, '2 min 5 s');
  assert.equal(p.els.total.textContent, '3 ads · 1 h 2 min');

  const one = makePopup({ status: { ...ON, adsSkipped: 1 } });
  await one.open();
  assert.equal(one.els.pageAds.textContent, '1');
  assert.equal(one.els.pageLabel.textContent, 'ad skipped on this page');
  assert.equal(one.els.lastAd.textContent, '–');
  assert.equal(one.els.total.textContent, '–');
});

test('popup: the state line says off, notice, skipping, watching or not a YouTube tab', async () => {
  const OFF = 'Off: ads play as usual';
  const cases = [
    ['not a YouTube tab (no page script answers)', { noReceiver: true }, 'idle', 'Not a YouTube tab', false],
    ['no active tab', { tab: null }, 'idle', 'Not a YouTube tab', false],
    ['off, and not a YouTube tab', { store: { enabled: false }, noReceiver: true }, 'off', 'Off everywhere', false],
    ['off in storage while the page still reports on', { store: { enabled: false } }, 'off', OFF, true],
    ['the page reports off', { status: { ...ON, enabled: false } }, 'off', OFF, true],
    ['YouTube showed its notice', { status: { ...ON, enforcement: true, enforcementSign: 'ad-blocker notice' } }, 'warn',
      'YouTube showed its ad-blocker notice, so the shield stood down on this page.', true],
    ['the notice outranks an ad still flagged as playing', { status: { ...ON, enforcement: true, adPlaying: true } }, 'warn',
      'YouTube showed its ad-blocker notice, so the shield stood down on this page.', true],
    ['an ad is being skipped', { status: { ...ON, adPlaying: true, adMode: 'USDAI' } }, 'ok', 'Skipping an ad…', false],
    ['a stitched ad is being skipped', { status: { ...ON, adPlaying: true, adMode: 'SSAP' } }, 'ok', 'Skipping an ad (stitched into the video)…', false],
    ['watching', {}, 'ok', 'Watching for ads', false],
  ];
  for (const [label, opts, kind, text, hint] of cases) {
    const p = makePopup(opts);
    await p.open();
    const s = p.shown();
    assert.equal(s.state, text, label);
    assert.equal(s.kind, kind, label);
    assert.equal(s.hint !== null, hint, `${label}: hint ${hint ? 'shown' : 'hidden'}`);
    if (text === 'Not a YouTube tab' || text === 'Off everywhere') assert.equal(s.pageAds, '–', label);
  }
  const warn = makePopup({ status: { ...ON, enforcement: true } });
  await warn.open();
  assert.match(warn.shown().hint, /Adblock Plus/);
});

test('popup: activity lines are rendered as text, newest first, and the box hides when there are none', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  let status = { ...ON, log: ['active: https://www.youtube.com/watch?v=x', 'ad skipped: 15 s', evil] };
  const p = makePopup({ status: () => status });
  await p.open();
  assert.deepEqual(p.shown().log, [evil, 'ad skipped: 15 s', 'active: https://www.youtube.com/watch?v=x']);
  assert.deepEqual(p.created, ['li', 'li', 'li'], 'only list items are made');
  for (const el of [...Object.values(p.els), ...p.els.log.children]) assert.deepEqual(el.htmlWrites, [], `${el.id || el.tagName}: no innerHTML`);
  assert.equal(p.els.logBox.hidden, false);

  status = { ...ON, log: [] };
  await p.poll();
  assert.deepEqual(p.shown().log, []);
  assert.equal(p.els.logBox.hidden, true);
});

test('popup: a click on the switch writes chrome.storage.local.enabled, then shows the new state', async () => {
  let status = ON;
  const p = makePopup({ store: { enabled: true }, status: () => status });
  await p.open();
  assert.equal(p.shown().state, 'Watching for ads');

  await p.click();
  assert.deepEqual(p.calls.set, [{ enabled: false }]);
  assert.equal(p.store.enabled, false);
  status = { ...ON, enabled: false, log: [...ON.log, 'off: switched off'] };
  assert.deepEqual(p.timers.timeouts.map((t) => t.ms), [150], 're-read soon after the write');
  await p.runTimeouts();
  assert.equal(p.shown().state, 'Off: ads play as usual');
  assert.equal(p.shown().checked, false);
  assert.equal(p.shown().log[0], 'off: switched off');

  await p.click();
  assert.deepEqual(p.calls.set, [{ enabled: false }, { enabled: true }]);
  assert.equal(p.store.enabled, true);
});

test('popup: it asks only the top frame of the active tab, and asks again every second', async () => {
  let status = { ...ON, adsSkipped: 2 };
  const p = makePopup({ tab: { id: 41 }, status: () => status });
  await p.open();
  assert.deepEqual(plain(p.calls.query), [{ active: true, currentWindow: true }]);
  assert.deepEqual(plain(p.calls.sendMessage), [{ id: 41, msg: { type: 'get-status' }, opts: { frameId: 0 } }],
    'an embedded player in another frame must not answer for the page');
  assert.deepEqual(p.timers.intervals.map((t) => t.ms), [1000]);
  assert.equal(p.els.pageAds.textContent, '2');
  status = { ...status, adsSkipped: 5 };
  await p.poll();
  assert.equal(p.els.pageAds.textContent, '5');
});
