// src/page.js against a stub page: no browser, no DOM library. Run: node --test tests/
// The live check on real YouTube is scripts/e2e.mjs; this pins the logic between live runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'page.js'), 'utf8');
const ENFORCEMENT = 'ytd-enforcement-message-view-model';
const INTERRUPTIONS_IN_PLAYER = '#movie_player a[href*="support.google.com/youtube/answer/3037019"]';

// signs: selectors document.querySelector answers with an element (matched as whole comma-separated parts).
function makePage(href, { player = null, signs = [], source = SOURCE } = {}) {
  const u = new URL(href);
  const listeners = {};
  const events = [];
  const intervals = [];
  const clock = { t: 1000 };
  const head = {
    children: [],
    appendChild(n) { n.isConnected = true; this.children.push(n); return n; },
  };
  const document = {
    head,
    documentElement: head,
    createElement: (tag) => ({
      tagName: tag, textContent: '', isConnected: false,
      remove() { this.isConnected = false; head.children = head.children.filter((c) => c !== this); },
    }),
    getElementById: (id) => (id === 'movie_player' ? player : null),
    querySelector: (sel) => {
      const parts = String(sel).split(',').map((s) => s.trim());
      if (parts.some((p) => signs.includes(p))) return {};
      if (sel.includes('html5-video-player')) return player;
      return null;
    },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent: (ev) => {
      events.push({ type: ev.type, detail: ev.detail });
      for (const fn of (listeners[ev.type] || []).slice()) fn(ev);
      return true;
    },
  };
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init && init.detail !== undefined ? init.detail : null; }
  }
  const window = {
    location: { hostname: u.hostname, href },
    document,
    CustomEvent,
    performance: { now: () => clock.t },
  };
  const context = {
    window, document, location: window.location, CustomEvent, JSON, Number, String, Boolean, Math, Date, Object, Array,
    WeakSet, Set, Map, Error, TypeError, RegExp,
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    console,
  };
  vm.createContext(context);
  const parsed = (type) => events.filter((e) => e.type === type).map((e) => JSON.parse(e.detail));
  return {
    run: () => vm.runInContext(source, context),
    window, document, context, events, listeners, intervals, clock, head,
    tickAll: () => intervals.forEach((fn) => fn()),
    send: (name, payload) => document.dispatchEvent(new CustomEvent(`youtube-shield:${name}`,
      payload === undefined ? undefined : { detail: typeof payload === 'string' ? payload : JSON.stringify(payload) })),
    statuses: () => parsed('youtube-shield:status'),
    status: () => { const s = parsed('youtube-shield:status'); return s[s.length - 1]; },
    skips: () => parsed('youtube-shield:skipped'),
    style: () => head.children.find((c) => c.tagName === 'style'),
  };
}

function makePlayer({ lengthSeconds = 600, debugInfo = 'USDAI, SABR, s:4' } = {}) {
  const classes = new Set(['html5-video-player']);
  const video = { muted: false, duration: 600, currentTime: 12, src: 'blob:content', addEventListener() {} };
  const skip = { clicks: 0, click() { this.clicks++; } };
  const player = {
    id: 'movie_player', video, skip, seeks: [], progress: { duration: 0, current: 0 }, debugInfo,
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    querySelector: (sel) => (sel.startsWith('video') ? video : sel.includes('skip') && classes.has('ad-showing') ? skip : null),
    getStatsForNerds: () => ({ debug_info: player.debugInfo }),
    getProgressState: () => player.progress,
    getPlayerResponse: () => ({ videoDetails: { lengthSeconds: String(lengthSeconds) } }),
    seekTo: (t) => player.seeks.push(t),
  };
  return player;
}

const YT = 'https://www.youtube.com/watch?v=x';

// Puts the player into a client-side ad: its own clip in the same <video>.
const startAd = (player, { duration = 135.4, currentTime = 3, src = 'blob:ad' } = {}) => {
  player.classList.add('ad-showing');
  Object.assign(player.video, { duration, currentTime, src });
};
const endAdOn = (player) => {
  player.classList.remove('ad-showing');
  Object.assign(player.video, { duration: 600, currentTime: 12, src: 'blob:content' });
};

test('only YouTube hosts: anywhere else the script does nothing', () => {
  for (const href of ['https://example.com/', 'https://notyoutube.com/', 'https://youtube.com.evil.example/', 'http://localhost:5173/']) {
    const page = makePage(href, { player: makePlayer() });
    page.run();
    assert.equal(page.events.length, 0, href);
    assert.equal(page.head.children.length, 0, href);
    assert.equal(page.intervals.length, 0, href);
  }
  for (const href of [YT, 'https://music.youtube.com/watch?v=x', 'https://m.youtube.com/', 'https://www.youtube-nocookie.com/embed/x']) {
    const page = makePage(href);
    page.run();
    assert.ok(page.style(), href);
  }
});

test('a pre-roll is muted and seeked to its end; the sound comes back after; the video itself is never seeked', () => {
  const player = makePlayer();
  const page = makePage(YT, { player });
  page.run();
  startAd(player);
  page.tickAll();
  assert.equal(player.video.currentTime, 135.3);
  assert.equal(player.video.muted, true);
  assert.equal(page.status().adsSkipped, 1);
  assert.equal(page.status().adPlaying, true);
  assert.deepEqual(page.skips(), [{ seconds: 132.4, kind: 'client' }]);

  page.clock.t += 420;
  endAdOn(player);
  page.tickAll();
  assert.equal(player.video.muted, false, 'sound back once the ad is gone');
  assert.equal(player.video.currentTime, 12, 'content position untouched');
  assert.equal(page.status().adPlaying, false);
  assert.equal(page.status().lastAdMs, 420);
  assert.equal(page.status().secondsSaved, 132);
});

test('a viewer who had muted the video stays muted after the ad', () => {
  const player = makePlayer();
  const page = makePage(YT, { player });
  player.video.muted = true;
  page.run();
  startAd(player);
  page.tickAll();
  endAdOn(player);
  player.video.muted = true;
  page.tickAll();
  assert.equal(player.video.muted, true);
});

test('each ad of a pod counts once; repeated ticks on the same ad do not count again', () => {
  const player = makePlayer();
  const page = makePage(YT, { player });
  page.run();
  startAd(player, { duration: 15.2, src: 'blob:ad1' });
  page.tickAll();
  player.video.currentTime = 3; // the player rewound it, or a tick ran before the seek landed
  page.tickAll();
  startAd(player, { duration: 30.1, src: 'blob:ad2' });
  page.tickAll();
  assert.equal(page.status().adsSkipped, 2);
  assert.equal(page.skips().length, 2);
});

test('a reloaded clip of an ad already seeked to its end is seeked again but not counted again', () => {
  const player = makePlayer();
  const page = makePage(YT, { player });
  page.run();
  startAd(player, { duration: 23.4, currentTime: 1, src: 'blob:ad1' });
  page.tickAll();
  assert.equal(page.status().adsSkipped, 1);
  // Measured live 2026-11-06: the player swapped the blob URL and stepped back 0.3 s from where the seek left it.
  startAd(player, { duration: 23.4, currentTime: 23.0, src: 'blob:ad1-reloaded' });
  page.tickAll();
  assert.ok(Math.abs(player.video.currentTime - 23.3) < 1e-9, 'still pushed to its end');
  assert.equal(page.status().adsSkipped, 1);
  assert.equal(page.skips().length, 1);
});

test('an ad longer than a short video is still skipped', () => {
  const player = makePlayer({ lengthSeconds: 40 });
  const page = makePage(YT, { player });
  page.run();
  startAd(player, { duration: 135.4 });
  page.tickAll();
  assert.equal(player.video.currentTime, 135.3);
});

test('a clip as long as the video itself is never seeked or muted; the skip button is pressed instead', () => {
  const player = makePlayer({ lengthSeconds: 135 });
  const page = makePage(YT, { player });
  page.run();
  startAd(player, { duration: 135.4, currentTime: 3 });
  page.tickAll();
  assert.equal(player.video.currentTime, 3);
  assert.equal(player.video.muted, false);
  assert.equal(player.skip.clicks, 1);
  assert.equal(page.status().adsSkipped, 0);
});

test('with no video length to compare, the clip is never seeked or muted', () => {
  const player = makePlayer({ lengthSeconds: 0 });
  const page = makePage(YT, { player });
  page.run();
  startAd(player);
  page.tickAll();
  assert.equal(player.video.currentTime, 3);
  assert.equal(player.video.muted, false);
});

test('when the player does not say what is playing, the <video> is never seeked or muted', () => {
  for (const variant of ['empty debug_info', 'no getStatsForNerds']) {
    const player = makePlayer();
    if (variant === 'empty debug_info') player.debugInfo = '';
    else delete player.getStatsForNerds;
    // A stitched timeline: ad plus content in one <video>, which an unlabelled check would read as a long ad.
    const page = makePage(YT, { player });
    page.run();
    startAd(player, { duration: 630, currentTime: 2, src: 'blob:stitched' });
    page.tickAll();
    assert.equal(player.video.currentTime, 2, variant);
    assert.equal(player.video.muted, false, variant);
    assert.equal(player.skip.clicks, 1, `${variant}: the skip button is still pressed`);
  }
});

test('a server-stitched pre-roll is skipped through the player, never by seeking the <video>', () => {
  const player = makePlayer({ debugInfo: 'SSAP, AD, s:4' });
  const page = makePage(YT, { player });
  page.run();
  player.progress = { duration: 20, current: 2 };
  player.video.currentTime = 2;
  page.tickAll();
  assert.deepEqual(player.seeks, [20]);
  assert.equal(player.video.currentTime, 2);
  assert.equal(player.video.muted, true);
  assert.equal(page.status().adMode, 'SSAP');
  assert.deepEqual(page.skips(), [{ seconds: 18, kind: 'stitched' }]);
});

test('a stitched mid-roll whose position is not the video clock is muted and left to end', () => {
  const player = makePlayer({ debugInfo: 'SSAP, AD, s:4' });
  const page = makePage(YT, { player });
  page.run();
  player.progress = { duration: 30, current: 4 };
  player.video.currentTime = 312;
  page.tickAll();
  assert.deepEqual(player.seeks, []);
  assert.equal(player.video.currentTime, 312);
  assert.equal(player.video.muted, true);
  assert.equal(page.status().adsSkipped, 0);
  player.debugInfo = 'SSAP, s:4';
  page.tickAll();
  assert.equal(player.video.muted, false, 'sound back when the stitched ad ends');
});

for (const [label, sign] of [['ad-blocker notice', ENFORCEMENT], ['"Experiencing interruptions?" link', INTERRUPTIONS_IN_PLAYER]]) {
  test(`at YouTube's ${label} the skipper stands down for the page, gives the sound back, and reports it`, () => {
    const player = makePlayer();
    const signs = [];
    const page = makePage(YT, { player, signs });
    page.run();
    startAd(player, { duration: 15.2, src: 'blob:ad1' });
    page.tickAll();
    assert.equal(player.video.muted, true);
    signs.push(sign);
    page.tickAll();
    assert.equal(player.video.muted, false);
    assert.equal(page.status().enforcement, true);
    assert.equal(page.status().enforcementSign, label);
    signs.length = 0;
    startAd(player, { duration: 30.1, currentTime: 2, src: 'blob:ad2' });
    page.tickAll();
    assert.equal(player.video.currentTime, 2, 'no skipping for the rest of the page');
    assert.equal(page.status().adsSkipped, 1);
  });
}

test('the interruptions link counts only inside the player or a notice, never elsewhere on the page', () => {
  const player = makePlayer();
  const page = makePage(YT, { player, signs: ['ytd-comments a[href*="support.google.com/youtube/answer/3037019"]'] });
  page.run();
  page.tickAll();
  assert.equal(page.status().enforcement, false);
});

test('the hiding style hides display ads, never #player-ads and never YouTube\'s notice', () => {
  const page = makePage(YT);
  page.run();
  const css = page.style().textContent;
  assert.match(css, /ytd-ad-slot-renderer \{ display: none !important; \}/);
  assert.match(css, /#masthead-ad/);
  assert.match(css, /ytd-reel-video-renderer > ytd-ad-slot-renderer/, 'the Shorts ad reel goes as a whole');
  assert.doesNotMatch(css, /#player-ads/);
  assert.doesNotMatch(css, /enforcement|3037019|popup-container|paper-dialog|error-screen/);
});

test('switched off: the style goes, ads play, the sound comes back; switched on again: both return', () => {
  const player = makePlayer();
  const page = makePage(YT, { player });
  page.run();
  startAd(player, { duration: 15.2, src: 'blob:ad1' });
  page.tickAll();
  assert.equal(player.video.muted, true);
  page.send('settings', { enabled: false });
  assert.equal(page.style(), undefined);
  assert.equal(player.video.muted, false);
  assert.equal(page.status().enabled, false);
  startAd(player, { duration: 30.1, currentTime: 2, src: 'blob:ad2' });
  page.tickAll();
  assert.equal(player.video.currentTime, 2);
  page.send('settings', { enabled: true });
  assert.ok(page.style());
  assert.equal(player.video.currentTime, 30, 'the ad already up is skipped as soon as it is back on');
});

test('settings that are not JSON with a boolean are ignored', () => {
  const page = makePage(YT, { player: makePlayer() });
  page.run();
  for (const bad of ['nope', '{"enabled":"false"}', '{"enabled":0}', 'null', '[]']) page.send('settings', bad);
  page.document.dispatchEvent({ type: 'youtube-shield:settings', detail: { enabled: false } });
  assert.ok(page.style());
  assert.equal(page.status().enabled, true);
});

test('hello answers with a status; ready is announced once at start', () => {
  const page = makePage(YT);
  page.run();
  const before = page.statuses().length;
  page.send('hello');
  assert.equal(page.statuses().length, before + 1);
  assert.equal(page.events.filter((e) => e.type === 'youtube-shield:ready').length, 1);
  assert.match(page.status().run, /^[a-z0-9]{1,8}$/);
});

test('a second copy in the same document stays out', () => {
  const page = makePage(YT, { player: makePlayer() });
  page.run();
  const intervals = page.intervals.length;
  const styles = page.head.children.length;
  page.run();
  assert.equal(page.intervals.length, intervals);
  assert.equal(page.head.children.length, styles);
  assert.equal(page.events.filter((e) => e.type === 'youtube-shield:ready').length, 1);
});

test('it leaves no global on window and replaces no built-in function', () => {
  const page = makePage(YT, { player: makePlayer() });
  const proto = {
    fetch: () => {}, open: () => {}, setTimeout: () => {}, addEventListener: () => {},
  };
  Object.assign(page.window, proto);
  const xhr = { open() {}, send() {} };
  page.context.XMLHttpRequest = { prototype: xhr };
  const natives = {
    windowKeys: Object.getOwnPropertyNames(page.window).sort(),
    globalKeys: Object.getOwnPropertyNames(page.context).sort(),
    docKeys: Object.getOwnPropertyNames(page.document).sort(),
    fns: Object.fromEntries(Object.entries(proto).map(([k]) => [k, page.window[k]])),
    xhrOpen: xhr.open, xhrSend: xhr.send, parse: JSON.parse, stringify: JSON.stringify,
    dispatch: page.document.dispatchEvent, listen: page.document.addEventListener, CustomEvent: page.window.CustomEvent,
  };
  page.run();
  startAd(page.document.getElementById('movie_player'));
  page.tickAll();
  assert.deepEqual(Object.getOwnPropertyNames(page.window).sort(), natives.windowKeys);
  assert.deepEqual(Object.getOwnPropertyNames(page.context).sort(), natives.globalKeys);
  assert.deepEqual(Object.getOwnPropertyNames(page.document).sort(), natives.docKeys);
  for (const [k, fn] of Object.entries(natives.fns)) assert.equal(page.window[k], fn, k);
  assert.equal(xhr.open, natives.xhrOpen);
  assert.equal(xhr.send, natives.xhrSend);
  assert.equal(JSON.parse, natives.parse);
  assert.equal(JSON.stringify, natives.stringify);
  assert.equal(page.document.dispatchEvent, natives.dispatch);
  assert.equal(page.document.addEventListener, natives.listen);
  assert.equal(page.window.CustomEvent, natives.CustomEvent);
  const player = page.document.getElementById('movie_player');
  assert.deepEqual(Object.keys(player.video).sort(), ['addEventListener', 'currentTime', 'duration', 'muted', 'src']);
});
