// Live check on real YouTube. Loads this extension into Playwright's Chromium (branded Chrome ignores --load-extension
// since Chrome 137), each arm in a fresh throwaway profile, and plays the same videos twice:
//   control: the shield switched off, which proves YouTube is serving ads to this browser at all;
//   shield:  the shield on, measuring how long each ad stays on screen, whether the video then plays, and its sound.
// It also counts visible display-ad slots on a search page, and checks that the page's built-ins are still native.
//
// Run: node scripts/e2e.mjs [--videos 4] [--watch 25] [--visible | --headless] [--arms control,shield] [--query "..."]
// Needs: npm install (playwright-core) and Playwright's Chromium (YTS_CHROMIUM overrides the path).
// Audio is muted at the browser (--mute-audio); the page's own video.muted is what the check reads.
// The browser is left as Playwright launches it: no masking of automation, no user-agent games.
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
const ARMS = opt('arms', 'control,shield').split(',').map((s) => s.trim()).filter((s) => s === 'control' || s === 'shield');
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

// The shield's own status, asked for over its event channel (it keeps no global to read).
const probeShield = () => {
  let got = null;
  const fn = (e) => { try { got = JSON.parse(e.detail); } catch { /* ignore */ } };
  document.addEventListener('youtube-shield:status', fn);
  document.dispatchEvent(new CustomEvent('youtube-shield:hello'));
  document.removeEventListener('youtube-shield:status', fn);
  return got;
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
  const shield = await page.evaluate(probeShield).catch(() => null);
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

async function runArm(arm, ids) {
  const { context, profile, ua } = await launch(arm);
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
}
console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
