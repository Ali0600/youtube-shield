// Live check on real YouTube. Loads this extension into Playwright's Chromium (branded Chrome ignores --load-extension
// since Chrome 137), each arm in a fresh throwaway profile, and plays the same videos twice:
//   control: the shield switched off, which proves YouTube is serving ads to this browser at all;
//   shield:  the shield on, measuring how long each ad stays on screen, whether the video then plays, and its sound.
// It also counts visible display-ad slots on a search page, and checks that the page's built-ins are still native.
// After the shield arm's videos it reloads the last one and checks the popup and its switch, off and on (checkPopup).
//
// Run: node scripts/e2e.mjs [--videos 4] [--watch 25] [--visible | --headless] [--arms control,shield] [--query "..."]
// Needs: npm install (playwright-core) and Playwright's Chromium (YTS_CHROMIUM overrides the path).
// Audio is muted at the browser (--mute-audio); the page's own video.muted is what the check reads.
// The browser is left as Playwright launches it: no masking of automation, no user-agent games.
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const VIDEOS = Math.max(1, Math.min(10, Number(opt('videos', '4')) || 4));
const WATCH_S = Math.max(8, Math.min(120, Number(opt('watch', '25')) || 25));
// Default: a real (headed) window parked off the screen and never throttled as hidden. --visible shows it on screen;
// --headless runs without a window (YouTube served ads to headless too, measured 2026-11-06).
const HEADLESS = argv.includes('--headless');
const OFFSCREEN = !HEADLESS && !argv.includes('--visible');
// Arms always run control first (the shield arm replays the control's videos). A name that is not an arm, or no arm at
// all, is a failed run: a typo must never print PASS having run nothing.
const ARM_ARGS = opt('arms', 'control,shield').split(',').map((s) => s.trim()).filter(Boolean);
const ARMS = ['control', 'shield'].filter((a) => ARM_ARGS.includes(a));
const unknownArms = ARM_ARGS.filter((s) => s !== 'control' && s !== 'shield');
if (unknownArms.length || !ARMS.length) {
  console.log(`FAIL\n- --arms ${ARM_ARGS.join(',') || '(empty)'}: ${unknownArms.length ? `unknown arm ${unknownArms.join(', ')}; ` : ''}` +
    'the arms are control and shield');
  process.exit(1);
}
const QUERY = opt('query', 'official music video');
const OUT = join(ROOT, 'reports');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read in YouTube's own world (page.evaluate runs there), from YouTube's own state: the player's class and methods.
const probePlayer = () => {
  const player = document.getElementById('movie_player');
  const video = player && player.querySelector('video');
  let debug = '';
  let playability = '';
  let length = 0;
  try { debug = String((player.getStatsForNerds() || {}).debug_info || ''); } catch { /* not ready */ }
  try {
    const r = player.getPlayerResponse() || {};
    playability = (r.playabilityStatus || {}).status || '';
    length = Number((r.videoDetails || {}).lengthSeconds) || 0;
  } catch { /* not ready */ }
  return {
    t: performance.now(),
    url: location.href,
    hasPlayer: Boolean(player),
    ad: Boolean(player && (player.classList.contains('ad-showing') || debug.startsWith('SSAP, AD'))),
    mode: debug.split(',')[0] || '',
    currentTime: video ? video.currentTime : null,
    duration: video ? video.duration : null,
    paused: video ? video.paused : null,
    muted: video ? video.muted : null,
    length,
    playability,
    enforcement: Boolean(document.querySelector('ytd-enforcement-message-view-model')),
    botCheck: /confirm you.re not a bot/i.test(document.body ? document.body.innerText.slice(0, 5000) : ''),
  };
};

// The shield's own status after each video, asked for over its event channel (it keeps no global to read).
const askShield = () => {
  let got = null;
  const fn = (e) => { try { got = JSON.parse(e.detail); } catch { /* ignore */ } };
  document.addEventListener('youtube-shield:status', fn);
  document.dispatchEvent(new CustomEvent('youtube-shield:hello'));
  document.removeEventListener('youtube-shield:status', fn);
  return got;
};

// For the popup check, the page script's status as it reports it, recorded without asking. Asking (a hello) makes the
// page report, and the bridge caches each report for the popup: the instrument would refresh the very data the popup
// check reads, and a page that reports only when asked would pass. So an init script (YouTube's world, before the
// page's scripts) copies each youtube-shield:status into a data attribute on <html>, from the first report on. It
// leaves nothing on `window` (the natives check looks there) and replaces nothing. It is installed only on the page
// the popup check reloads, never while the skipper is being measured.
const recordStatus = () => {
  let last = null;
  let reports = 0;
  const write = () => {
    const root = document.documentElement;
    if (!root || last === null) return;
    root.dataset.ytsE2eStatus = last;
    root.dataset.ytsE2eReports = String(reports);
  };
  document.addEventListener('youtube-shield:status', (e) => {
    if (typeof e.detail !== 'string') return;
    last = e.detail;
    reports++;
    write();
  });
  document.addEventListener('DOMContentLoaded', write);
};
const probeShield = () => {
  const root = document.documentElement;
  const raw = root && root.dataset.ytsE2eStatus;
  if (!raw) return null;
  try { return { ...JSON.parse(raw), reports: Number(root.dataset.ytsE2eReports) || 0 }; } catch { return null; }
};

// Functions YouTube can check for tampering: each must still be the browser's own.
const probeNatives = () => {
  const fns = {
    fetch: window.fetch, 'XMLHttpRequest.open': XMLHttpRequest.prototype.open, 'XMLHttpRequest.send': XMLHttpRequest.prototype.send,
    'JSON.parse': JSON.parse, 'Response.json': Response.prototype.json, 'Object.defineProperty': Object.defineProperty,
    'EventTarget.addEventListener': EventTarget.prototype.addEventListener, 'HTMLMediaElement.play': HTMLMediaElement.prototype.play,
    setTimeout: window.setTimeout, 'Element.querySelector': Element.prototype.querySelector,
  };
  const out = {};
  for (const [k, f] of Object.entries(fns)) out[k] = typeof f === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f));
  out.windowGlobals = Object.getOwnPropertyNames(window).filter((n) => /shield/i.test(n));
  return out;
};

// Visible display-ad slots (the shield hides these; the control shows how many YouTube served).
const probeDisplayAds = () => {
  const sel = 'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-search-pyv-renderer, #masthead-ad, ytd-promoted-sparkles-web-renderer';
  const all = [...document.querySelectorAll(sel)];
  const visible = all.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return { present: all.length, visible: visible.length };
};

// YouTube asks for cookie consent in the EU, either on consent.youtube.com or as an in-page "Before you continue to
// YouTube" dialog over the page; the in-page one pauses the video until it is answered (measured 2026-11-06, DE). The
// answer is always "Reject all".
async function rejectConsent(page) {
  if (/consent\./.test(page.url())) {
    await page.locator('button:has-text("Reject all")').first().click({ timeout: 15000 });
    await page.waitForURL(/^https:\/\/(www|m)\.youtube\.com\//, { timeout: 20000 });
    return 'rejected (consent page)';
  }
  const reject = page.locator('ytd-consent-bump-v2-lightbox button:has-text("Reject all"), tp-yt-paper-dialog button:has-text("Reject all")').first();
  try {
    await reject.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    return 'none';
  }
  await reject.click();
  await reject.waitFor({ state: 'hidden', timeout: 15000 });
  return 'rejected (dialog)';
}

const EXE = process.env.YTS_CHROMIUM || chromium.executablePath();

async function launch(arm) {
  const profile = mkdtempSync(join(tmpdir(), `yts-e2e-${arm}-`));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: EXE,
    headless: HEADLESS,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`,
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      ...(OFFSCREEN ? ['--window-position=-2400,-2400', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'] : []),
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const enabled = arm === 'shield';
  await worker.evaluate((on) => chrome.storage.local.set({ enabled: on }), enabled);
  const stored = await worker.evaluate(() => chrome.storage.local.get('enabled'));
  if (stored.enabled !== enabled) throw new Error(`could not set enabled=${enabled} for the ${arm} arm`);
  const ua = await worker.evaluate(() => navigator.userAgent);
  return { context, profile, worker, ua };
}

async function findVideos(page) {
  await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(QUERY)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ytd-video-renderer a#video-title[href*="/watch?v="]', { timeout: 30000 });
  await sleep(2500);
  const ids = await page.evaluate(() => [...document.querySelectorAll('ytd-video-renderer a#video-title[href*="/watch?v="]')]
    .map((a) => new URL(a.href).searchParams.get('v')).filter(Boolean));
  return [...new Set(ids)].slice(0, VIDEOS);
}

async function watch(page, id) {
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  const samples = [];
  const end = Date.now() + WATCH_S * 1000;
  while (Date.now() < end) {
    try { samples.push(await page.evaluate(probePlayer)); } catch { /* navigating */ }
    await sleep(100);
  }
  // Ad episodes: runs of samples with an ad up, timed by the page's own clock. "parked" marks an ad that ended its run
  // paused within 0.3 s of its own end: seeked there by the shield, then paused by something else (the in-page consent
  // dialog did this before it was answered). Playing on would end it in a tenth of a second; it is not "cleared".
  const episodes = [];
  let open = null;
  const parkedAt = (s) => Boolean(s && s.paused && Number.isFinite(s.duration) && s.duration > 1 && s.currentTime >= s.duration - 0.3);
  for (const s of samples) {
    if (s.ad && !open) open = { start: s.t, mode: s.mode, last: s };
    else if (s.ad && open) open.last = s;
    else if (!s.ad && open) { episodes.push({ ms: Math.round(s.t - open.start), mode: open.mode }); open = null; }
  }
  if (open) {
    episodes.push({
      ms: Math.round(open.last.t - open.start), mode: open.mode, stillUp: true, parked: parkedAt(open.last),
      at: open.last.currentTime == null ? null : `${open.last.currentTime.toFixed(2)} of ${Number(open.last.duration).toFixed(2)} s`,
    });
  }
  const content = samples.filter((s) => !s.ad && s.hasPlayer && s.currentTime != null && s.length && Math.abs(s.duration - s.length) <= 2);
  const played = content.length >= 2 ? content.at(-1).currentTime - content[0].currentTime : 0;
  const lastContent = content.at(-1) || {};
  const shield = await page.evaluate(askShield).catch(() => null);
  const natives = await page.evaluate(probeNatives).catch(() => null);
  const last = samples.at(-1) || {};
  // One sample a second, for reading a run afterwards: was it playing, paused, in an ad?
  const t0 = samples.length ? samples[0].t : 0;
  const timeline = samples.filter((s, i) => i % 10 === 0).map((s) => ({
    s: Math.round((s.t - t0) / 100) / 10, ad: s.ad, mode: s.mode || undefined, ct: s.currentTime == null ? null : Math.round(s.currentTime * 10) / 10,
    dur: s.duration == null || !Number.isFinite(s.duration) ? null : Math.round(s.duration), paused: s.paused, player: s.hasPlayer,
  }));
  return {
    id, timeline, episodes, adMs: episodes.reduce((a, e) => a + e.ms, 0), reachedContent: content.length > 0,
    contentPlayedS: Math.round(played * 10) / 10,
    contentMuted: lastContent.muted ?? null, playability: last.playability, enforcement: samples.some((s) => s.enforcement),
    botCheck: samples.some((s) => s.botCheck), shield: shield && { enabled: shield.enabled, adsSkipped: shield.adsSkipped, enforcement: shield.enforcement, lastAdMs: shield.lastAdMs, log: shield.log },
    natives,
  };
}

// The popup and its switch, live. The popup is opened as an extension page in a second tab of the same window. It reads
// the active tab of its window (chrome.tabs.query), so the YouTube tab is brought to the front first: measured
// 2026-11-08, page.bringToFront() makes it the tab that query returns, and the popup tab behind it keeps polling. The
// switch is clicked where a user clicks it, on its label (the checkbox itself is a 1 px transparent box under the
// track, which Playwright refuses to click), and judged by what it changes: the page's own status (recorded, never
// asked for), whether an element the stylesheet hides is rendered hidden, chrome.storage read in the service worker,
// and the popup's switch, state line and newest activity line. Each outcome must then HOLD for HOLD_MS, and hold again
// in a reopened popup that nobody clicked, where the switch can only come from storage.
const HOLD_MS = 2000; // covers page.js's 500 ms watch() (which re-mounts the stylesheet) and the popup's 1 s re-read
// A display-ad element, matched by one of page.js's HIDE selectors, planted on the page and judged by computed style.
const PROBE_CLASS = 'ytp-ad-image-overlay';
// The probe only means something while page.js still hides that selector: checked before the popup check runs, so a
// future edit of the HIDE list fails as an instrument error rather than as a broken switch.
const probeStillHidden = () => readFileSync(join(ROOT, 'src', 'page.js'), 'utf8').includes(`'.${PROBE_CLASS}'`);
const probeHidden = (cls) => {
  let el = document.querySelector(`div.${cls}[data-yts-e2e-probe]`);
  if (!el) {
    el = document.createElement('div');
    el.className = cls;
    el.dataset.ytsE2eProbe = '';
    el.style.cssText = 'position:absolute;left:0;top:0;width:4px;height:4px;visibility:hidden;pointer-events:none';
    document.body.appendChild(el);
  }
  return getComputedStyle(el).display;
};
const removeProbe = () => { for (const el of document.querySelectorAll('[data-yts-e2e-probe]')) el.remove(); };
const probePopup = () => {
  // How far the switch's thumb is slid, as rendered (popup.css moves it 16px when the box is checked): the switch a
  // user sees, not just the checkbox property behind it.
  const thumb = document.querySelector('label.switch .thumb');
  const m = thumb ? /matrix\(([^)]+)\)/.exec(getComputedStyle(thumb).transform) : null;
  return {
    pageAds: document.getElementById('pageAds').textContent,
    pageLabel: document.getElementById('pageLabel').textContent,
    state: document.getElementById('state').textContent,
    checked: document.getElementById('enabled').checked,
    thumbX: thumb ? (m ? Math.round(Number(m[1].split(',')[4])) : 0) : null,
    log: [...document.querySelectorAll('#log li')].map((li) => li.textContent), // newest first
  };
};
const THUMB_ON_X = 16;
// Which tab the popup's own query returns, and that tab's top frame's answer (what the popup itself asks for).
const probePopupTab = async () => {
  const self = await chrome.tabs.getCurrent();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let run = null;
  let error = '';
  if (active) {
    try {
      const s = await chrome.tabs.sendMessage(active.id, { type: 'get-status' }, { frameId: 0 });
      run = s && typeof s.run === 'string' ? s.run : null;
    } catch (e) { error = String((e && e.message) || e).slice(0, 120); }
  }
  return { popupTab: self ? self.id : null, activeTab: active ? active.id : null, run, error };
};
const ON_STATE = /^(Watching for ads|Skipping an ad)/;
const OFF_STATE = 'Off: ads play as usual';
const LOADING_STATE = 'Checking this tab…';
const SWITCH_LINE = { false: 'off: switched off', true: 'on: switched on' };
// Skipper lines may land above the switch's line (an ad can start as the shield comes back on); nothing else may.
const newestNonAd = (log) => log.find((l) => !/^ad (skipped|gone|muted): /.test(l));
// A status no page reports on its own: 37 ads, a run id of its own. Sent from the page's world through the real bridge.
const SYNTHETIC = { run: 'e2esynth', enabled: true, enforcement: false, adsSkipped: 37, secondsSaved: 0, adPlaying: false,
  log: ['e2e: a synthetic status with 37 ads'] };

const within = (p, ms, what = '') => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what ? `${what}: ` : ''}no answer in ${ms} ms`); })]);
// Reads until `judge` finds nothing wrong (or settleMs passes), then keeps reading for holdMs: every reading in that
// window must be clean too, so an outcome that comes and goes fails. Returns the problems of the reading that failed.
async function steady(read, judge, settleMs, holdMs = HOLD_MS) {
  const sample = async () => {
    const v = await within(read(), 20000).catch((e) => ({ error: String((e && e.message) || e).split('\n')[0].slice(0, 160) }));
    return { v, readError: Boolean(v.error), bad: v.error ? [`could not read it (${v.error})`] : judge(v) };
  };
  const end = Date.now() + settleMs;
  let s = await sample();
  while (s.bad.length) {
    if (Date.now() >= end) return { ok: false, phase: 'settle', ...s };
    await sleep(250);
    s = await sample();
  }
  const start = Date.now();
  let readings = 1;
  while (Date.now() - start < holdMs) {
    await sleep(250);
    s = await sample();
    readings++;
    // A read that failed is the instrument not seeing, not the state changing: its own phase, still a failure.
    if (s.bad.length) return { ok: false, phase: s.readError ? 'read' : 'hold', heldMs: Date.now() - start, ...s };
  }
  // Too few readings is the instrument's shortfall (a slow host), not the switch changing: its own phase says so.
  if (holdMs && readings < 4) {
    return { ok: false, phase: 'sampling', heldMs: Date.now() - start, v: s.v, bad: [`only ${readings} readings in the ${holdMs} ms hold (the host read too slowly to judge it)`] };
  }
  return { ok: true, v: s.v, heldMs: Date.now() - start, readings };
}

async function checkPopup(context, page, worker) {
  const problems = [];
  const out = { problems };
  const fail = (label, r) => {
    const why = r.phase === 'hold' ? ` (it held ${r.heldMs} ms of the ${HOLD_MS} ms window, then changed)`
      : r.phase === 'read' ? ` (a read ${r.heldMs} ms into the ${HOLD_MS} ms hold: the check could not see, the state may be fine)` : '';
    for (const b of r.bad) problems.push(`${label}: ${b}${why}`); // 'sampling' and 'settle' say so in b
  };
  if (!probeStillHidden()) {
    problems.push(`popup check instrument: src/page.js no longer hides '.${PROBE_CLASS}', so the planted element cannot tell on from off; point PROBE_CLASS at another HIDE selector`);
    return out;
  }
  const id = new URL(worker.url()).host;
  // The service worker can be stopped and restarted (each status from the page wakes it): read the live one.
  const sw = () => context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`)) || worker;
  const pageStatus = () => within(page.evaluate(probeShield), 5000, 'the page');
  const popupRead = (fn) => within(popup.evaluate(fn), 5000, 'the popup');
  // The same video loaded afresh with the recorder installed, so the bridge holds nothing an instrument asked for. A
  // pre-roll on the reload is let come and go first (up to 20 s), so the count is not moving under the checks below.
  await page.addInitScript(recordStatus);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const quietBy = Date.now() + 20000;
  let quiet = null;
  while (Date.now() < quietBy) {
    quiet = await page.evaluate(() => ({ ad: Boolean(document.querySelector('#movie_player.ad-showing')), hasPlayer: Boolean(document.getElementById('movie_player')) }))
      .then(async (p) => ({ ...p, status: await pageStatus() })).catch(() => null);
    if (quiet && quiet.hasPlayer && !quiet.ad && quiet.status && !quiet.status.adPlaying) break;
    await sleep(500);
  }
  out.reload = quiet && { ad: quiet.ad, recorded: Boolean(quiet.status), adsSkipped: quiet.status ? quiet.status.adsSkipped : null, reports: quiet.status ? quiet.status.reports : null };
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${id}/src/popup.html`, { waitUntil: 'load' });
    await page.bringToFront();

    // The tab the popup reads is the YouTube page: not the popup's own tab, and its top frame answers with the run id
    // of the page's own status.
    const tab = await steady(async () => ({ t: await popupRead(probePopupTab), page: await pageStatus() }), (v) => {
      const bad = [];
      if (v.t.popupTab == null) bad.push('chrome.tabs.getCurrent() gave the popup no tab id');
      if (v.t.activeTab == null) bad.push('its active-tab query returned no tab');
      else if (v.t.activeTab === v.t.popupTab) bad.push('its active-tab query returned the popup\'s own tab');
      if (!v.page) bad.push('the page has reported no status');
      else if (v.t.run !== v.page.run) bad.push(`the active tab's top frame answered run ${v.t.run}${v.t.error ? ` (${v.t.error})` : ''}, the page's own run is ${v.page.run}`);
      return bad;
    }, 10000, 0);
    out.tab = tab.v.error ? tab.v : { ...tab.v.t, pageRun: tab.v.page ? tab.v.page.run : null };
    if (!tab.ok) fail('popup tab', tab);

    // The four reads are independent (two in the page, one in the service worker, one in the popup), so they run at
    // once: read one after another they took long enough on a busy YouTube page to fit fewer than 4 readings in a hold.
    const readAll = async () => {
      const [pageNow, display, stored, popupNow] = await Promise.all([
        pageStatus(),
        within(page.evaluate(probeHidden, PROBE_CLASS), 5000, 'the page'),
        within(sw().evaluate(() => chrome.storage.local.get('enabled')), 5000, 'the service worker'),
        popupRead(probePopup),
      ]);
      return { page: pageNow, display, stored: stored.enabled, popup: popupNow };
    };
    const judgeSwitch = (on, { line = false, reopened = false } = {}) => (v) => {
      const bad = [];
      if (reopened && v.popup.state === LOADING_STATE) return ['the reopened popup never finished loading'];
      if (!v.page) bad.push('the page has reported no status');
      else if (v.page.enabled !== on) bad.push(`the page's own status says enabled:${v.page.enabled}`);
      if ((v.display === 'none') !== on) bad.push(`a display-ad element planted on the page is ${v.display === 'none' ? 'hidden (display:none)' : `rendered (display:${v.display})`}`);
      if (v.stored !== on) bad.push(`chrome.storage.local.enabled is ${v.stored}`);
      if (v.popup.checked !== on) bad.push(`the popup's switch shows ${v.popup.checked ? 'on' : 'off'}`);
      if (v.popup.thumbX !== (on ? THUMB_ON_X : 0)) bad.push(`the popup's switch is drawn ${v.popup.thumbX === THUMB_ON_X ? 'on' : v.popup.thumbX === 0 ? 'off' : `with its thumb at ${v.popup.thumbX}px`}`);
      if (on ? !ON_STATE.test(v.popup.state) : v.popup.state !== OFF_STATE) bad.push(`the popup's state reads "${v.popup.state}"`);
      if (line && newestNonAd(v.popup.log) !== SWITCH_LINE[on]) bad.push(`the popup's newest activity line is "${newestNonAd(v.popup.log)}", expected "${SWITCH_LINE[on]}"`);
      return bad;
    };
    const brief = (r) => (r.v.error ? r.v : {
      ok: r.ok, phase: r.ok ? undefined : r.phase, heldMs: r.heldMs, readings: r.readings, pageEnabled: r.v.page ? r.v.page.enabled : null,
      pageReports: r.v.page ? r.v.page.reports : null, display: r.v.display, stored: r.v.stored, checked: r.v.popup.checked, thumbX: r.v.popup.thumbX,
      state: r.v.popup.state, line: newestNonAd(r.v.popup.log), pageAds: r.v.popup.pageAds, adsSkipped: r.v.page ? r.v.page.adsSkipped : null,
    });

    // Before any click: the shield on everywhere, and the count the page itself reported.
    const shown = await steady(readAll, (v) => {
      const bad = judgeSwitch(true)(v);
      if (v.page && v.popup.pageAds !== String(v.page.adsSkipped)) bad.push(`the popup shows ${v.popup.pageAds} ads skipped, the page reported ${v.page.adsSkipped}`);
      return bad;
    }, 8000);
    out.shown = brief(shown);
    if (!shown.ok) fail('popup', shown);

    // The switch, off then on. Each judged after the click, then again in the popup reopened with no click.
    for (const on of [false, true]) {
      const name = `switch ${on ? 'on' : 'off'}`;
      await popup.locator('label.switch').click({ timeout: 10000 });
      const flipped = await steady(readAll, judgeSwitch(on, { line: true }), 6000);
      out[name] = brief(flipped);
      if (!flipped.ok) fail(name, flipped);
      await popup.reload({ waitUntil: 'load' });
      await page.bringToFront();
      const reopened = await steady(readAll, judgeSwitch(on, { line: true, reopened: true }), 6000);
      out[`${name} reopened`] = brief(reopened);
      if (!reopened.ok) fail(`${name}, popup reopened`, reopened);
    }

    // The count at a value an idle page never has: a synthetic status from the page's world, through the real bridge
    // and the popup's own get-status. Sent again on each reading, in case the page reports on its own in between.
    const synth = await steady(async () => {
      await page.evaluate((s) => document.dispatchEvent(new CustomEvent('youtube-shield:status', { detail: JSON.stringify(s) })), SYNTHETIC);
      return { popup: await popupRead(probePopup), t: await popupRead(probePopupTab) };
    }, (v) => {
      const bad = [];
      if (v.popup.pageAds !== String(SYNTHETIC.adsSkipped)) bad.push(`the popup shows ${v.popup.pageAds} ads skipped, the page sent ${SYNTHETIC.adsSkipped}`);
      if (v.popup.log[0] !== SYNTHETIC.log[0]) bad.push(`the popup's newest activity line is "${v.popup.log[0]}"`);
      if (v.t.run !== SYNTHETIC.run) bad.push(`the bridge answered run ${v.t.run}`);
      return bad;
    }, 5000, 0);
    out.synthetic = synth.v.error ? synth.v : { pageAds: synth.v.popup.pageAds, run: synth.v.t.run };
    if (!synth.ok) fail('popup count', synth);
    // Back to the page's own status: the one place the check asks the page to report.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('youtube-shield:hello')));
    const restored = await steady(async () => ({ page: await pageStatus(), popup: await popupRead(probePopup), t: await popupRead(probePopupTab) }), (v) => {
      if (!v.page || v.page.run === SYNTHETIC.run) return ['the page did not report its own status again'];
      const bad = [];
      if (v.t.run !== v.page.run) bad.push(`the bridge still answers run ${v.t.run}, the page's is ${v.page.run}`);
      if (v.popup.pageAds !== String(v.page.adsSkipped)) bad.push(`the popup shows ${v.popup.pageAds}, the page reported ${v.page.adsSkipped}`);
      return bad;
    }, 5000, 0);
    out.restored = restored.v.error ? restored.v : { pageAds: restored.v.popup.pageAds, run: restored.v.t.run };
    if (!restored.ok) fail('popup count restored', restored);
  } finally {
    await page.evaluate(removeProbe).catch(() => {});
    await popup.close().catch(() => {});
  }
  return out;
}

async function runArm(arm, ids) {
  const { context, profile, ua, worker } = await launch(arm);
  const result = { arm, ua, consent: 'none', videos: [], displayAds: null };
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
    result.consent = await rejectConsent(page);
    if (!ids) ids = await findVideos(page);
    else await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(QUERY)}`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    result.displayAds = await page.evaluate(probeDisplayAds).catch(() => null);
    for (const id of ids) {
      const v = await watch(page, id);
      result.videos.push(v);
      const eps = v.episodes.map((e) => `${(e.ms / 1000).toFixed(1)}s${e.mode ? ` ${e.mode}` : ''}` +
        `${e.parked ? ` (parked at its end, ${e.at}, playback stopped)` : e.stillUp ? ' (still up)' : ''}`).join(', ') || 'none';
      console.log(`[${arm}] ${id}: ads ${eps}; video ${v.reachedContent ? 'reached' : 'NOT reached'}, played ${v.contentPlayedS}s, muted=${v.contentMuted}; ` +
        `${v.enforcement ? 'ENFORCEMENT ' : ''}${v.botCheck ? 'BOT-CHECK ' : ''}shield=${v.shield ? `${v.shield.enabled ? 'on' : 'off'} skipped ${v.shield.adsSkipped}` : 'none'}`);
    }
    if (arm === 'shield') {
      const shot = join(OUT, 'e2e-shield-last.png');
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: shot }).catch(() => {});
      try {
        result.popup = await checkPopup(context, page, worker);
      } catch (e) {
        result.popup = { problems: [`popup: the check stopped: ${String((e && e.message) || e).split('\n')[0]}`] };
      }
    }
  } finally {
    await context.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  return { result, ids };
}

const report = { when: new Date().toISOString(), chromium: chromium.executablePath(), videos: VIDEOS, watchS: WATCH_S, arms: [] };
let ids = null;
for (const arm of ARMS) {
  const { result, ids: used } = await runArm(arm, ids);
  ids = used;
  report.arms.push(result);
}

// Verdict: the control must show ads (else this run proves nothing), and with the shield on every ad must clear fast,
// the video must play with its sound, nothing may be patched, and YouTube must not show its notice.
const control = report.arms.find((a) => a.arm === 'control');
const shield = report.arms.find((a) => a.arm === 'shield');
const problems = [];
if (control) {
  const served = control.videos.filter((v) => v.episodes.some((e) => e.ms >= 4000 || e.stillUp)).length;
  report.controlVideosWithAds = served;
  if (served === 0) problems.push('control: no video showed an ad, so this run cannot show the shield works (try more --videos)');
}
if (shield) {
  const eps = shield.videos.flatMap((v) => v.episodes);
  report.shieldCleared = eps.filter((e) => !e.stillUp && e.ms <= 2500).length;
  report.shieldParked = eps.filter((e) => e.parked).length;
  if (eps.length && !report.shieldCleared) problems.push('shield: no ad was cleared outright, so parked ones prove nothing');
  for (const v of shield.videos) {
    const parked = v.episodes.some((e) => e.parked);
    for (const e of v.episodes) {
      if (e.parked) continue;
      if (e.ms > 2500 || e.stillUp) problems.push(`shield: ${v.id} kept an ad up ${e.ms} ms${e.stillUp ? ` (still up at the end, at ${e.at})` : ''} (${e.mode || '?'})`);
    }
    if (!v.reachedContent && !parked) problems.push(`shield: ${v.id} the video itself was never reached`);
    const c = control && control.videos.find((x) => x.id === v.id);
    if (c && v.contentPlayedS < c.contentPlayedS - 0.5) {
      problems.push(`shield: ${v.id} played ${v.contentPlayedS} s of the video, the control ${c.contentPlayedS} s`);
    }
    if (v.contentMuted) problems.push(`shield: ${v.id} content left muted`);
    if (v.enforcement) problems.push(`shield: ${v.id} YouTube showed its ad-blocker notice`);
    if (v.natives) for (const [k, ok] of Object.entries(v.natives)) if (k !== 'windowGlobals' && !ok) problems.push(`shield: ${v.id} ${k} is not native`);
    if (v.natives && v.natives.windowGlobals.length) problems.push(`shield: globals on window: ${v.natives.windowGlobals.join(', ')}`);
  }
  if (shield.displayAds && shield.displayAds.visible) problems.push(`shield: ${shield.displayAds.visible} display-ad slots visible on the search page`);
  if (!shield.popup) problems.push('popup: the popup and switch check did not run');
  else problems.push(...shield.popup.problems);
}
report.problems = problems;
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `e2e-${report.when.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nreport: ${file}`);
if (control) console.log(`control: ${report.controlVideosWithAds} of ${control.videos.length} videos showed an ad; display-ad slots visible: ${control.displayAds ? control.displayAds.visible : '?'}`);
if (shield) {
  const cleared = shield.videos.flatMap((v) => v.episodes).filter((e) => !e.stillUp);
  console.log(`shield: ${report.shieldCleared} ads cleared (longest on screen ${Math.max(0, ...cleared.map((e) => e.ms))} ms), ` +
    `${report.shieldParked} parked at their end when playback stopped; display-ad slots visible: ${shield.displayAds ? shield.displayAds.visible : '?'}`);
  // The popup's lines, apart from the skipper's above: read them on their own.
  const p = shield.popup || { problems: ['did not run'] };
  const ok = (x) => x && !x.error;
  const sw = (x) => (!x ? '?' : x.error ? `unread (${x.error})` : `page enabled:${x.pageEnabled}, planted ad element ` +
    `${x.display === 'none' ? 'hidden' : `rendered (${x.display})`}, storage ${x.stored}, switch ${x.checked ? 'on' : 'off'}, "${x.state}", ` +
    `newest line "${x.line}", ${x.ok ? `held ${(x.heldMs / 1000).toFixed(1)} s` : `FAILED in its ${x.phase}`}`);
  console.log(`popup: ${p.problems.length ? `FAILED (${p.problems.length})` : 'ok'}`);
  console.log(`popup: tab ${ok(p.tab) ? `${p.tab.activeTab} (popup ${p.tab.popupTab}) answers run ${p.tab.run}, the page's own run is ${p.tab.pageRun}` : '?'}`);
  console.log(`popup: count ${ok(p.shown) ? `shows ${p.shown.pageAds}, the page reported ${p.shown.adsSkipped}${p.shown.adsSkipped === 0 ? ' (compared at 0: unproven)' : ''}` : '?'}; ` +
    `a synthetic ${SYNTHETIC.adsSkipped} through the bridge shows ${ok(p.synthetic) ? p.synthetic.pageAds : '?'}; restored to ${ok(p.restored) ? p.restored.pageAds : '?'}`);
  for (const name of ['switch off', 'switch on']) console.log(`popup: ${name} -> ${sw(p[name])}; reopened -> ${sw(p[`${name} reopened`])}`);
} else {
  console.log('popup: not run (shield arm not selected)');
}
console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
