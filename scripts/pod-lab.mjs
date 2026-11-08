// Pod lab: an instrumented live run for one question. In a pod of 2-3 client-side ads, why does the next clip sometimes
// sit unloaded (duration NaN, paused) for seconds after the shield skips the one before it? It plays given videos in
// Playwright's Chromium with a COPY of the extension, patched per --mode, and records every ad break at 100 ms:
//   - the player and <video> state, sampled inside the page every 100 ms (plus the <video>'s own media events and the
//     player's ad classes as they change), drained to Node once a second;
//   - the shield's own status reports, recorded as the page sends them (never asked for until the video's end);
//   - every network request, PASSIVELY (context.on('request' | 'requestfinished' | 'requestfailed')), stored as
//     scheme + host + path and a category, never a query string (they hold tokens). For googlevideo media only a few
//     named parameters are kept (itag, mime, dur, clen, rn, range, sabr) and the clip id is kept only as a hash.
// It never calls route() or anything else that can block, delay or rewrite a request, and it masks no automation.
//
// Modes (--mode): the extension copy is patched by exact-string replacement that must occur exactly once (else the run
// stops before launching); src/ itself is never edited. Every mode tags the shield's 'active' log line with
// [lab:<mode>] and the manifest copy with version_name lab-<mode>, so a run can prove which copy the page ran.
//   off            the shield switched off through chrome.storage.local.enabled = false (natural ads; e2e's control)
//   userskip       the shield switched off, and the lab acts as a viewer: once YouTube's Skip button is visible and
//                  enabled it clicks it with Playwright's real input (locator.click(), trusted events), once per ad, and
//                  once per display-override wait that shows a Skip button
//   seek           the extension as it is: mute, seek the ad clip to duration - 0.1 at once
//   seekafter      the same seek, held until the ad clip's own currentTime is >= 5.5 s of media (muted meanwhile)
//   rate16         instead of seeking, play the ad clip at 16x (counted the same way); when the ad is over, put the
//                  rate back if it is still 16 and log what the rate was (YouTube resets it on each clip load)
//   delay<N>       the same seek, but only once the ad break has been on screen N ms (a timer fires tick() at N ms)
//   clipdelay<N>   the same seek, but only once THIS clip has had a finite duration for N ms (per clip, not per break)
// Every mode runs the same read-only viewer poll every 100 ms (is a Skip button visible?); only userskip clicks.
// Each ad clip is fingerprinted by its exact duration (3 decimals) and its own video id, which the player's
// getStatsForNerds().video_id_and_cpn names during the ad (getVideoData() names the content video; read 2026-11-08).
//
// Run: node scripts/pod-lab.mjs --mode seek [--videos id1,id2] [--watch 60] [--max-watch S] [--out name.json]
//      [--fresh-each] [--visible | --headless]
//      node scripts/pod-lab.mjs --rotate off,userskip,seek,seekafter [--videos id1,id2] [--loads N] [--minutes M]
//      [--watch 60] [--max-watch 300]
//      node scripts/pod-lab.mjs --aggregate [rotation-<stamp>,...]  (every rotation under reports/, or the named ones)
//      node scripts/pod-lab.mjs --mode delay1500 --check-patches   (build and parse the mode's copy, no browser)
//      node scripts/pod-lab.mjs --reanalyse name.json              (re-run the analysis on a saved report or load)
// --watch S watches each video at least S s; if an ad break is still up then, it goes on until the break has been gone
// 5 s, up to --max-watch (default: --watch for --mode, 300 s for --rotate), so an ad that plays to its end is seen end.
// --mode: one profile per run (--fresh-each: one per video); the report (reports/, git-ignored) is rewritten after
// each video.
// --rotate: the pre-registered test of whether the shield provokes YouTube's display-override wait (the rule is in
// scripts/pod-lab-rule.mjs). One fresh browser and one fresh throwaway profile per video load; load i plays arm
// [i % arms] on video [floor(i / arms) % videos], so each video gets every arm in a row and the videos repeat. It stops
// after --loads N (default: one round) or once --minutes M have passed, whichever is first, and writes
// reports/rotation-<stamp>/load-NNN-<arm>-<video>.json per load plus summary.json and summary.txt (the running
// aggregate) after each load. --aggregate re-runs the analysis on every load file and applies the rule per ad x arm.
// Per break it prints the clips (ad/content, duration, pod position, seek, time sat at its end) and, between clips, how
// long the <video> had no src, until the next clip had a duration and readyState >= 2 ("unloaded"), until it played,
// and when that clip's media was first requested; for gaps of 1 s or more, the requests that started or were in flight.
// Then one line per ad transition: the ad's id and duration, how it ended, and whether the override followed it.
// Needs Playwright's Chromium (YTS_CHROMIUM overrides it). Run it alone on an idle machine: timing is the measurement.
import { chromium } from 'playwright-core';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { tabulate, decide, overrideClicks, formatAggregate, isOverride, counts } from './pod-lab-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const die = (msg) => { console.log(`FAIL\n- ${msg}`); process.exit(2); };
// A path named on the command line stays under reports/ (git-ignored), refused if it resolves anywhere else.
const underReports = (name, flag) => {
  const file = resolve(REPORTS, name);
  const rel = relative(REPORTS, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) die(`${flag} must name something under ${REPORTS}`);
  return file;
};

const MODE_RE = /^(off|userskip|seek|seekafter|rate16|delay(\d{1,5})|clipdelay(\d{1,5}))$/;
const MODES = 'off, userskip, seek, seekafter, rate16, delay<ms>, clipdelay<ms>';
const SEEKAFTER_S = 5.5; // seconds of the ad clip's own media before seekafter seeks (Skip showed at 5.0-5.3 s)
const modeOf = (name) => {
  const m = MODE_RE.exec(String(name || ''));
  if (!m) return null;
  const delayMs = Number(m[2] ?? m[3] ?? 0);
  if (delayMs > 60000) die(`--mode ${name}: a delay above 60000 ms is not a skip`);
  return { name: m[1], delayMs, shieldOn: m[1] !== 'off' && m[1] !== 'userskip', viewer: m[1] === 'userskip' };
};

const AGGREGATE = argv.includes('--aggregate');
// --reanalyse <report.json under reports/>: re-run the analysis and the printout on a saved run (no browser).
const REANALYSE = opt('reanalyse', '');
let saved = null;
if (REANALYSE) {
  const file = underReports(REANALYSE, '--reanalyse');
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(`--reanalyse ${file}: ${e.message}`); }
}
const ROTATE = AGGREGATE || saved ? '' : opt('rotate', '');
const ARMS = ROTATE ? ROTATE.split(',').map((s) => s.trim()).filter(Boolean).map((s) => modeOf(s) || die(`--rotate ${s}: the modes are ${MODES}`)) : [];
if (ROTATE && (!ARMS.length || new Set(ARMS.map((a) => a.name)).size !== ARMS.length)) die('--rotate: a comma list of distinct modes');
const SINGLE = AGGREGATE || ROTATE ? null : modeOf(saved ? saved.mode : opt('mode', ''));
if (!AGGREGATE && !ROTATE && !SINGLE) die(`--mode ${saved ? saved.mode : opt('mode', '') || '(missing)'}: the modes are ${MODES} (or --rotate, --aggregate)`);
const DEFAULT_VIDEOS = 'fo2IXZ9G13w,LB72Mbd88mU,psuRGfAaju4,yT_AfrHbAyA,lY5V4hSLWY8'; // served pods on 2026-11-08
const VIDEOS = opt('videos', DEFAULT_VIDEOS).split(',').map((s) => s.trim()).filter(Boolean);
const badIds = VIDEOS.filter((id) => !/^[A-Za-z0-9_-]{11}$/.test(id));
if (!VIDEOS.length || badIds.length) die(`--videos: ${badIds.join(', ') || '(none)'} is not a YouTube video id`);
if (VIDEOS.length > 20) die('--videos: at most 20 per run');
const WATCH_S = Number(opt('watch', '60'));
if (!Number.isFinite(WATCH_S) || WATCH_S < 10 || WATCH_S > 600) die('--watch: seconds per video, 10 to 600');
const MAX_WATCH_S = Number(opt('max-watch', String(ROTATE ? Math.max(300, WATCH_S) : WATCH_S)));
if (!Number.isFinite(MAX_WATCH_S) || MAX_WATCH_S < WATCH_S || MAX_WATCH_S > 900) die('--max-watch: seconds, from --watch to 900');
const LOADS_ARG = opt('loads', '');
const MINUTES_ARG = opt('minutes', '');
const LOADS = LOADS_ARG ? Number(LOADS_ARG) : MINUTES_ARG ? 1000 : ARMS.length * VIDEOS.length;
const MINUTES = MINUTES_ARG ? Number(MINUTES_ARG) : 0;
if (ROTATE && (!Number.isInteger(LOADS) || LOADS < 1 || LOADS > 1000)) die('--loads: a whole number of video loads, 1 to 1000');
if (ROTATE && MINUTES_ARG && (!Number.isFinite(MINUTES) || MINUTES <= 0 || MINUTES > 1440)) die('--minutes: 0 to 1440');
const HEADLESS = argv.includes('--headless');
const OFFSCREEN = !HEADLESS && !argv.includes('--visible');
const FRESH_EACH = argv.includes('--fresh-each');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = SINGLE && !saved ? underReports(opt('out', `pod-lab-${SINGLE.name}-${STAMP}.json`), '--out') : '';
if (OUT && !OUT.endsWith('.json')) die('--out must name a .json file');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha8 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

// ---- the extension copy, patched per mode -------------------------------------------------------------------------
// Each patch: [what, old, new]. `old` must occur exactly once in the file (counted, not searched), or nothing launches.
const replaceOnce = (text, [what, old, neu], file) => {
  const count = text.split(old).length - 1;
  if (count !== 1) throw new Error(`patch "${what}" in ${file}: expected its text exactly once, found it ${count} times`);
  const out = text.split(old).join(neu); // split/join: no $-patterns, unlike String.replace
  if (out.split(neu).length - 1 < 1) throw new Error(`patch "${what}" in ${file}: the new text is not in the result`);
  return out;
};
const SEEK_LINE = 'video.currentTime = Math.max(0, d - 0.1);';
const SEEK_IF = 'if (Number.isFinite(d) && d > 0 && video.currentTime < d - 0.25) {';
const pagePatches = (mode) => {
  const MODE = mode.name;
  const p = [['active marker', "note('active', location.href);", `note('active', '[lab:${MODE}] ' + location.href);`]];
  if (MODE === 'rate16') {
    p.push(['rate16 state', 'let adStartedAt = 0;',
      "let adStartedAt = 0;\n  let labRateSet = false;\n  let labRateBefore = 1;\n  let labRateNoted = '';"]);
    p.push(['rate16 instead of seek', SEEK_LINE, [
      'if (!labRateSet) { labRateSet = true; labRateBefore = video.playbackRate === 16 ? 1 : video.playbackRate; }',
      '      if (video.playbackRate !== 16) {',
      "        const labKey = d.toFixed(2) + '@' + video.src;",
      "        if (labRateNoted !== labKey) { labRateNoted = labKey; note('lab rate16', '16x on a ' + Math.round(d) + ' s clip, its rate was ' + video.playbackRate); }",
      '        video.playbackRate = 16;',
      '      }',
    ].join('\n')]);
    p.push(['rate16 restore', 'if (inAd && video) video.muted = mutedBefore;', [
      'if (inAd && video) video.muted = mutedBefore;',
      '    if (labRateSet && video) {',
      '      const labWas = video.playbackRate;',
      '      if (labWas === 16) video.playbackRate = labRateBefore;',
      "      note('lab rate16', 'ad over: video rate ' + labWas + (labWas === 16 ? ', set back to ' + labRateBefore : ', left as it was') + ', player rate ' + call(playerVideo()[0], 'getPlaybackRate'));",
      '      labRateSet = false;',
      '    }',
    ].join('\n')]);
  } else if (MODE.startsWith('delay')) {
    p.push(['delay constant', 'let adStartedAt = 0;', `let adStartedAt = 0;\n  const LAB_DELAY = ${mode.delayMs};`]);
    // tick() also runs on media events and every 500 ms; the timer makes the seek land at N ms even with no event.
    p.push(['delay timer', 'adStartedAt = now();', 'adStartedAt = now();\n      setTimeout(tick, LAB_DELAY + 10);']);
    p.push(['delay gate', SEEK_IF, SEEK_IF.replace(') {', ' && now() - adStartedAt >= LAB_DELAY) {')]);
    p.push(['delay note', SEEK_LINE,
      `note('lab ${MODE}', 'seek at ' + Math.round(now() - adStartedAt) + ' ms into the break');\n      ${SEEK_LINE}`]);
  } else if (MODE.startsWith('clipdelay')) {
    p.push(['clipdelay state', 'let adStartedAt = 0;',
      `let adStartedAt = 0;\n  const LAB_DELAY = ${mode.delayMs};\n  let labClipKey = '';\n  let labClipAt = 0;`]);
    p.push(['clipdelay gate', SEEK_IF, [
      "const labKey = d.toFixed(2) + '@' + video.src;",
      '    if (Number.isFinite(d) && d > 0 && labKey !== labClipKey) { labClipKey = labKey; labClipAt = now(); setTimeout(tick, LAB_DELAY + 10); }',
      `    ${SEEK_IF.replace(') {', ' && now() - labClipAt >= LAB_DELAY) {')}`,
    ].join('\n')]);
    p.push(['clipdelay note', SEEK_LINE,
      `note('lab ${MODE}', 'seek at ' + Math.round(now() - labClipAt) + ' ms into the clip, ' + Math.round(now() - adStartedAt) + ' ms into the break');\n      ${SEEK_LINE}`]);
  } else if (MODE === 'seekafter') {
    // The gate reads the clip's own media clock, never a timer: tick() runs on timeupdate (about 4 per second of
    // playback), so the seek lands at 5.5-5.8 s of media however long the clip took to load. begin() above the gate
    // has already muted it.
    p.push(['seekafter constant', 'let adStartedAt = 0;', `let adStartedAt = 0;\n  const LAB_MEDIA_S = ${SEEKAFTER_S};`]);
    p.push(['seekafter gate', SEEK_IF, SEEK_IF.replace(') {', ' && video.currentTime >= LAB_MEDIA_S) {')]);
    p.push(['seekafter note', SEEK_LINE,
      `note('lab seekafter', 'seek at ' + video.currentTime.toFixed(2) + ' s of media of a ' + d.toFixed(3) + ' s clip, ' + Math.round(now() - adStartedAt) + ' ms into the break');\n      ${SEEK_LINE}`]);
  }
  return p;
};
function buildExtension(mode) {
  // Every patch is applied in memory first: a patch that does not match stops the run before any folder exists.
  const manifest = replaceOnce(readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
    ['version_name', '"version": "0.1.0",', `"version": "0.1.0",\n  "version_name": "lab-${mode.name}",`], 'manifest.json');
  JSON.parse(manifest);
  const original = readFileSync(join(ROOT, 'src', 'page.js'), 'utf8');
  const patches = pagePatches(mode);
  let page = original;
  for (const patch of patches) page = replaceOnce(page, patch, 'src/page.js');
  const dir = mkdtempSync(join(tmpdir(), `yts-lab-ext-${mode.name}-`));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), manifest);
  writeFileSync(join(dir, 'src', 'page.js'), page);
  // Read back what the browser will load: each patch's new text is there.
  const written = readFileSync(join(dir, 'src', 'page.js'), 'utf8');
  for (const [what, , neu] of patches) if (!written.includes(neu)) throw new Error(`patch "${what}" is not in the written copy`);
  return {
    dir,
    patches: patches.map(([what, old]) => ({ what, oldSha: sha8(old), applied: 1 })),
    pageSha: { original: sha8(original), copy: sha8(written) },
  };
}

// ---- in the page: the 100 ms sampler and passive recorders (YouTube's own world, top frame only) -------------------
// It leaves nothing on window and replaces nothing: buffers live in this closure and leave only through a
// `yts-lab:dump` event whose detail object Node passes in (the same trick page.js uses for its probe).
const labInstrument = () => {
  if (window.top !== window) return;
  // .ytp-skip-ad-button is the one YouTube renders (read live 2026-11-08: display:none until about 5.3 s of media);
  // the other two are its older names.
  const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button';
  const LIMIT = { samples: 9000, events: 12000, flips: 3000, statuses: 1500, skipped: 200, clicks: 200 };
  const buf = { samples: [], events: [], flips: [], statuses: [], skipped: [], clicks: [] };
  let dropped = 0;
  const push = (k, x) => { if (buf[k].length >= LIMIT[k]) { dropped++; return; } buf[k].push(x); };
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
  const tag = (src) => (src ? (String(src).startsWith('blob:') ? 'b' : 'u') + fnv(String(src)) : ''); // never the URL
  const num = (x, p = 1000) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * p) / p : null);
  const durOf = (d) => (typeof d === 'number' && Number.isFinite(d) ? Math.round(d * 1000) / 1000 : d === Infinity ? 'inf' : null);
  const call = (o, n) => { try { return o && typeof o[n] === 'function' ? o[n]() : undefined; } catch { return undefined; } };
  // The id of what is playing, from the stats panel's "video_id_and_cpn": during a client-side ad it is the ad's own id.
  const idOf = (stats) => (/^\s*([A-Za-z0-9_-]{11})(?=[\s/]|$)/.exec(String((stats || {}).video_id_and_cpn || '')) || [])[1] || '';
  const ahead = (v) => {
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.05 && b.end(i) >= v.currentTime) return num(b.end(i) - v.currentTime, 100);
      return 0;
    } catch { return null; }
  };
  const vstate = (v) => ({
    src: tag(v.src), ct: num(v.currentTime), dur: durOf(v.duration), paused: v.paused, rs: v.readyState, ns: v.networkState,
    rate: v.playbackRate, drate: v.defaultPlaybackRate, muted: v.muted, ended: v.ended, seeking: v.seeking, ahead: ahead(v),
  });
  // 'v' when a Skip button is rendered, shown and enabled; 'h' when one is in the player but hidden; '' when none.
  const skipState = (player) => {
    let seen = '';
    for (const el of player.querySelectorAll(SKIP)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.disabled) return 'v';
      seen = 'h';
    }
    return seen;
  };
  const hooked = new WeakSet();
  const MEDIA_EVENTS = ['loadstart', 'emptied', 'abort', 'loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'canplaythrough',
    'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ratechange', 'ended', 'error'];
  const hookVideo = (v) => {
    if (hooked.has(v)) return;
    hooked.add(v);
    for (const type of MEDIA_EVENTS) {
      v.addEventListener(type, () => push('events', { t: num(performance.now(), 10), w: Date.now(), type, ...vstate(v), err: v.error ? v.error.code : undefined }));
    }
  };
  const adClasses = (p) => [...p.classList].filter((c) => /(^|-)ads?(-|$)/.test(c)).sort().join(' ');
  const hookPlayer = (p) => {
    if (hooked.has(p)) return;
    hooked.add(p);
    let last = null;
    const flip = () => {
      const cls = adClasses(p);
      if (cls === last) return;
      last = cls;
      push('flips', { t: num(performance.now(), 10), w: Date.now(), ad: p.classList.contains('ad-showing'), cls });
    };
    new MutationObserver(flip).observe(p, { attributes: true, attributeFilter: ['class'] });
    flip();
  };
  document.addEventListener('youtube-shield:status', (e) => {
    if (typeof e.detail === 'string') push('statuses', { t: num(performance.now(), 10), w: Date.now(), raw: e.detail.slice(0, 6000) });
  });
  document.addEventListener('youtube-shield:skipped', (e) => {
    if (typeof e.detail === 'string') push('skipped', { t: num(performance.now(), 10), w: Date.now(), raw: e.detail.slice(0, 200) });
  });
  // Every click that reaches a Skip button, with isTrusted (real input says true; a script's el.click() says false) and
  // the ad's media time at that instant. Capture phase, listen only: it never stops or changes the click.
  document.addEventListener('click', (e) => {
    const target = e.target && typeof e.target.closest === 'function' ? e.target.closest(SKIP) : null;
    if (!target) return;
    const player = document.getElementById('movie_player');
    const video = player && (player.querySelector('video.html5-main-video') || player.querySelector('video'));
    push('clicks', {
      t: num(performance.now(), 10), w: Date.now(), trusted: e.isTrusted, ovr: Boolean(player && player.classList.contains('ytp-ad-display-override')),
      ad: Boolean(player && player.classList.contains('ad-showing')), vid: idOf(call(player, 'getStatsForNerds')), ...(video ? vstate(video) : {}),
    });
  }, true);
  // The ad ids the player response lists (externalVideoId / adVideoId under adSlots and adPlacements), in order: a second
  // source for the pre-roll ids, read every second and recorded when the list changes. Bounded walk, read only.
  const adIdsOf = (pr) => {
    const ids = [];
    let budget = 20000;
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 24 || budget <= 0) return;
      for (const k of Object.keys(o)) {
        if (--budget <= 0) return;
        const x = o[k];
        if ((k === 'externalVideoId' || k === 'adVideoId') && typeof x === 'string' && /^[A-Za-z0-9_-]{11}$/.test(x)) { if (!ids.includes(x)) ids.push(x); } else if (x && typeof x === 'object') walk(x, depth + 1);
      }
    };
    if (pr) { walk(pr.adSlots, 0); walk(pr.adPlacements, 0); }
    return ids;
  };
  let lastAdIds = null;
  let nSample = 0;
  let lastDebug = null;
  let lastUi = null;
  const adUi = (player) => {
    const seen = new Set();
    for (const el of player.querySelectorAll('[class*="ytp-ad-"], [class*="ytp-skip-ad"]')) {
      if (!el.getClientRects().length) continue;
      for (const c of el.classList) if (/^ytp-(ad|skip-ad)-/.test(c) && !c.includes('__') && !c.includes('--')) seen.add(c);
      if (seen.size >= 24) break;
    }
    return [...seen].sort().join(' ');
  };
  const sample = () => {
    const player = document.getElementById('movie_player');
    const video = player && (player.querySelector('video.html5-main-video') || player.querySelector('video'));
    if (player) hookPlayer(player);
    if (video) hookVideo(video);
    const stats = call(player, 'getStatsForNerds') || {};
    const debug = String(stats.debug_info || '');
    // debug_info carries the clock (t:) and buffer (b:), which move every sample: an event only when the rest changes.
    const debugKey = debug.replace(/ (t|b|pbs):\S*/g, '');
    if (debugKey !== lastDebug) { lastDebug = debugKey; push('events', { t: num(performance.now(), 10), w: Date.now(), type: 'debug_info', debug: debug.slice(0, 80) }); }
    const ds = (/(?:^|\s)s:(\S+)/.exec(debug) || [])[1]; // in a pod's display-override gap debug_info starts "s:40 ..."
    const classAd = Boolean(player && player.classList.contains('ad-showing'));
    const ps = call(player, 'getPlayerState');
    const prate = call(player, 'getPlaybackRate');
    const pr = call(player, 'getPlayerResponse');
    const s = {
      t: num(performance.now(), 10), w: Date.now(), hasPlayer: Boolean(player), ad: classAd || debug.startsWith('SSAP, AD'), classAd,
      mode: debug.split(',')[0] || '', ds: ds || undefined, ps: typeof ps === 'number' ? ps : null, prate: typeof prate === 'number' ? prate : null,
      len: Number(((pr || {}).videoDetails || {}).lengthSeconds) || 0,
      enf: Boolean(document.querySelector('ytd-enforcement-message-view-model')),
      vid: idOf(stats) || undefined,
      ...(video ? vstate(video) : { src: '' }),
    };
    if (classAd) {
      // "Ad 1 of 2" / "1 of 2" from the player's ad overlay, as the position in the pod (locale is en-US).
      const box = player.querySelector('.video-ads, .ytp-ad-module');
      const m = box ? /(\d+)\s*(?:of|\/)\s*(\d+)/.exec(box.textContent || '') : null;
      if (m) s.pod = `${m[1]}/${m[2]}`;
      s.skip = skipState(player) || undefined;
      if (player.classList.contains('ytp-ad-display-override')) s.ovr = true;
    }
    // Which ad UI blocks are rendered (class names only, never text), as an event when the set changes.
    const ui = classAd ? adUi(player) : '';
    if (ui !== lastUi) { lastUi = ui; push('events', { t: num(performance.now(), 10), w: Date.now(), type: 'adui', ui }); }
    if (nSample++ % 10 === 0 && pr) {
      const ids = adIdsOf(pr);
      const key = `${(pr.videoDetails || {}).videoId}:${ids.join(',')}`;
      if (key !== lastAdIds) { lastAdIds = key; push('events', { t: num(performance.now(), 10), w: Date.now(), type: 'adids', of: (pr.videoDetails || {}).videoId, ids }); }
    }
    push('samples', s);
  };
  setInterval(sample, 100);
  document.addEventListener('yts-lab:dump', (e) => {
    const box = e.detail;
    if (!box || typeof box !== 'object') return;
    for (const k of Object.keys(buf)) box[k] = buf[k].splice(0);
    box.dropped = dropped;
    box.href = location.href;
  });
};
const drainPage = () => {
  const box = {};
  document.dispatchEvent(new CustomEvent('yts-lab:dump', { detail: box }));
  return box;
};

// ---- the viewer: a read-only poll every 100 ms in every mode; in userskip it also clicks Skip ------------------------
const SKIP_SEL = '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button';
const viewerRead = (sel) => {
  const p = document.getElementById('movie_player');
  if (!p) return null;
  const v = p.querySelector('video.html5-main-video') || p.querySelector('video');
  let stats = null;
  try { stats = typeof p.getStatsForNerds === 'function' ? p.getStatsForNerds() : null; } catch { /* none */ }
  const vid = (/^\s*([A-Za-z0-9_-]{11})(?=[\s/]|$)/.exec(String((stats || {}).video_id_and_cpn || '')) || [])[1] || '';
  let skip = false;
  for (const el of p.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.disabled) { skip = true; break; }
  }
  let h = 0x811c9dc5;
  const src = v ? String(v.src || '') : '';
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return {
    w: Date.now(), ad: p.classList.contains('ad-showing'), ovr: p.classList.contains('ytp-ad-display-override'), vid,
    dur: v && Number.isFinite(v.duration) ? Math.round(v.duration * 1000) / 1000 : null,
    ct: v ? Math.round(v.currentTime * 1000) / 1000 : null, src: src ? (h >>> 0).toString(16) : '', skip,
  };
};
// Clicks once per ad (its id, duration and src) and once per display-override wait, with Playwright's own input (a
// trusted click at the element), as soon as a Skip button is visible and enabled. Never throws; stops when `over()`.
async function viewerLoop(page, t0, over, clicks, mode, stats) {
  const done = new Set();
  let episode = 0;
  let wasOvr = false;
  let lastPoll = 0;
  while (!over()) {
    const st = await page.evaluate(viewerRead, SKIP_SEL).catch(() => null);
    const nowMs = Date.now();
    if (lastPoll) stats.maxGapMs = Math.max(stats.maxGapMs, nowMs - lastPoll);
    lastPoll = nowMs;
    stats.polls++;
    if (st) {
      if (st.ovr && !wasOvr) episode++;
      wasOvr = st.ovr;
      if (st.ad && st.skip) {
        stats.skipSeen++;
        const key = st.ovr ? `override#${episode}` : `${st.vid}|${st.dur}|${st.src}`;
        if (mode.viewer && !done.has(key)) {
          done.add(key);
          const rec = { kind: st.ovr ? 'override' : 'ad', r: st.w - t0, vid: st.vid, dur: st.dur, ctSeen: st.ct };
          const at = Date.now();
          try {
            await page.locator('#movie_player').locator(SKIP_SEL).filter({ visible: true }).first().click({ timeout: 2500 });
            rec.clickR = Date.now() - t0;
            rec.clickTookMs = Date.now() - at;
            rec.landed = true;
          } catch (e) {
            rec.error = String((e && e.message) || e).split('\n')[0].slice(0, 160);
          }
          if (rec.landed) {
            // What changed within 2.5 s of the click (the analysis judges it again from the samples).
            const t1 = Date.now();
            while (Date.now() - t1 < 2500 && !over()) {
              const s = await page.evaluate(viewerRead, SKIP_SEL).catch(() => null);
              if (s && (!s.ad || s.ovr !== st.ovr || (!st.ovr && (s.src !== st.src || s.dur !== st.dur || s.vid !== st.vid)))) {
                rec.changedMs = s.w - t0 - rec.clickR;
                rec.after = { ad: s.ad, ovr: s.ovr, vid: s.vid, dur: s.dur, ct: s.ct };
                break;
              }
              await sleep(100);
            }
          }
          clicks.push(rec);
          continue;
        }
      }
    }
    await sleep(100);
  }
}

// ---- probes and consent, as scripts/e2e.mjs has them (copied: importing e2e.mjs would run it) ----------------------
// The shield's own status, asked for over its event channel once the video's window is over.
const askShield = () => {
  let got = null;
  const fn = (e) => { try { got = JSON.parse(e.detail); } catch { /* ignore */ } };
  document.addEventListener('youtube-shield:status', fn);
  document.dispatchEvent(new CustomEvent('youtube-shield:hello'));
  document.removeEventListener('youtube-shield:status', fn);
  return got;
};
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

// ---- network, passively ------------------------------------------------------------------------------------------
const MEDIA_PARAMS = ['itag', 'mime', 'dur', 'clen', 'rn', 'range', 'sabr'];
const describeUrl = (raw) => {
  let u;
  try { u = new URL(raw); } catch { return { url: '(unparsable)', cat: 'other' }; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return { url: `${u.protocol}`, cat: 'other' };
  const host = u.hostname;
  const path = u.pathname;
  const out = { url: `${u.protocol}//${u.host}${path}` }; // never the query string: it holds tokens
  const gv = /(^|\.)googlevideo\.com$/.test(host);
  if (gv && path.startsWith('/videoplayback')) {
    out.cat = 'media';
    for (const k of MEDIA_PARAMS) { const v = u.searchParams.get(k); if (v != null) out[k] = v.slice(0, 40); }
    const id = u.searchParams.get('id');
    if (id) out.vid = sha8(id); // which clip, as a hash only
  } else if (path === '/youtubei/v1/player/ad_break') out.cat = 'ad_break';
  else if (path === '/youtubei/v1/player') out.cat = 'player';
  else if (path === '/youtubei/v1/next') out.cat = 'next';
  else if (path === '/youtubei/v1/log_event') out.cat = 'log_event';
  else if (path.startsWith('/api/stats/ads')) out.cat = 'stats_ads';
  else if (path.startsWith('/api/stats/qoe')) out.cat = 'qoe';
  else if (path.startsWith('/api/stats/')) out.cat = 'stats_other';
  else if (path.startsWith('/ptracking')) out.cat = 'ptracking';
  else if (path.includes('/pagead/')) out.cat = 'pagead';
  else if (/(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com)$/.test(host) || /googleads/.test(host)) out.cat = 'doubleclick';
  else if (gv) out.cat = 'media_other';
  else out.cat = 'other';
  return out;
};
function recordNetwork(context, sink) {
  const live = new Map();
  context.on('request', (req) => {
    const rec = { n: sink.length, seen: Date.now(), m: req.method(), type: req.resourceType(), ...describeUrl(req.url()) };
    sink.push(rec);
    live.set(req, rec);
  });
  const settle = (req, rec) => {
    rec.done = Date.now();
    let t = null;
    try { t = req.timing(); } catch { /* none */ }
    // The browser's own start time when it is sane, else when Node heard of it (same machine clock either way).
    if (t && t.startTime > 0 && Math.abs(t.startTime - rec.seen) < 10000) {
      rec.start = Math.round(t.startTime);
      if (t.responseEnd >= 0) rec.end = Math.round(t.startTime + t.responseEnd);
    }
    rec.start ??= rec.seen;
    rec.end ??= rec.done;
  };
  context.on('requestfinished', async (req) => {
    const rec = live.get(req);
    if (!rec) return;
    live.delete(req);
    settle(req, rec);
    try {
      const resp = await req.response();
      if (resp) {
        rec.status = resp.status();
        const len = resp.headers()['content-length'];
        if (len) rec.size = Number(len);
      }
    } catch { /* gone */ }
  });
  context.on('requestfailed', (req) => {
    const rec = live.get(req);
    if (!rec) return;
    live.delete(req);
    settle(req, rec);
    rec.failed = String((req.failure() || {}).errorText || 'failed').slice(0, 60);
  });
}

// ---- launch, as e2e.mjs does it, with the patched copy -------------------------------------------------------------
const EXE = process.env.YTS_CHROMIUM || chromium.executablePath();
async function launch(mode, extDir, net) {
  const profile = mkdtempSync(join(tmpdir(), `yts-lab-${mode.name}-`));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: EXE,
    headless: HEADLESS,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      ...(OFFSCREEN ? ['--window-position=-2400,-2400', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'] : []),
    ],
  });
  try {
    recordNetwork(context, net);
    await context.addInitScript(labInstrument);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const enabled = mode.shieldOn;
    await worker.evaluate((on) => chrome.storage.local.set({ enabled: on }), enabled);
    const stored = await worker.evaluate(() => chrome.storage.local.get('enabled'));
    if (stored.enabled !== enabled) throw new Error(`could not set enabled=${enabled}`);
    // Which copy the browser loaded: the manifest's version_name is set only in this mode's copy.
    const loaded = await worker.evaluate(() => chrome.runtime.getManifest().version_name || '');
    if (loaded !== `lab-${mode.name}`) throw new Error(`the browser loaded version_name "${loaded}", not this run's copy (lab-${mode.name})`);
    const ua = await worker.evaluate(() => navigator.userAgent);
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
    const consent = await rejectConsent(page);
    return { context, profile, page, ua, loaded, consent, enabled };
  } catch (e) {
    await context.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    throw e;
  }
}

// ---- analysis ----------------------------------------------------------------------------------------------------
const MERGE_MS = 500; // ad runs closer than this are one break (the gaps merged are listed)
const OVERRIDE_CLASS = 'ytp-ad-display-override';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const commonest = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  let best = null;
  for (const [x, n] of c) if (best == null || n > c.get(best)) best = x;
  return best;
};

// The shield's log as one list: each status carries the last 8 lines, so join each onto the end by its overlap.
function mergeLog(statuses) {
  const merged = [];
  for (const st of statuses) {
    const lines = Array.isArray(st.s && st.s.log) ? st.s.log.map(String) : [];
    let k = Math.min(merged.length, lines.length);
    for (; k > 0; k--) {
      let same = true;
      for (let j = 0; j < k; j++) if (merged[merged.length - k + j].line !== lines[j]) { same = false; break; }
      if (same) break;
    }
    for (const line of lines.slice(k)) merged.push({ r: st.r, line });
  }
  return merged;
}

// One timeline of the <video>: the 100 ms samples plus its media events, which keep exact times while the page's main
// thread is too busy for the sampler (measured 2026-11-08: 1.3-1.4 s sampler gaps while the watch page loads). An
// event carries the <video> state but not the player's; it takes `ad` and `len` from the sample before it.
function timelineOf(S, E) {
  const pts = S.map((s) => ({ ...s, from: 's' }));
  for (const e of E) if (typeof e.src === 'string') pts.push({ ...e, from: 'e' });
  pts.sort((a, b) => a.r - b.r || (a.from === b.from ? 0 : a.from === 'e' ? -1 : 1));
  let last = {};
  for (const p of pts) {
    if (p.from === 's') last = p;
    else { p.ad = last.ad; p.len = last.len; }
  }
  return pts;
}

// Clips: runs of one src (a src-less stretch belongs to no clip); within one src, a new duration can start a new clip.
function clipsOf(T) {
  const clips = [];
  let c = null;
  const open = (src, i) => { c = { src, i0: i, i1: i, dur: null }; clips.push(c); };
  for (let i = 0; i < T.length; i++) {
    const s = T[i];
    if (!s.src) continue;
    const fin = isNum(s.dur);
    if (c && c.src === s.src) {
      // The player refines a clip's duration in place (measured: 126.0 -> 126.9 s in one src). A new clip in the same
      // src is a jump of more than 2 s, or of more than 0.5 s after a stretch with no duration (a re-init).
      const jump = fin && c.dur != null ? Math.abs(s.dur - c.dur) : 0;
      if (jump > 2 || (jump > 0.5 && c.nanFrom != null)) {
        // A new clip, from the first point that lost the old duration.
        const from = c.nanFrom ?? i;
        c.i1 = from - 1;
        open(s.src, from);
      } else if (!fin && c.dur != null) c.nanFrom ??= i;
      else if (fin) c.nanFrom = undefined;
    } else open(s.src, i);
    c.i1 = i;
    if (fin) c.dur = s.dur;
  }
  return clips.map((cl, k) => {
    const seg = T.slice(cl.i0, cl.i1 + 1);
    const first = (pred) => { const s = seg.find(pred); return s ? s.r : null; };
    // A seek: a `seeking` event, or the clock jumping further than playback at its rate can carry it (16x moves
    // 1.6 s per 100 ms).
    let seekAt = null;
    for (let j = 0; j < seg.length && seekAt == null; j++) {
      const s = seg[j];
      if (s.type === 'seeking') { seekAt = s.r; break; }
      const p = seg[j - 1];
      if (!p || !isNum(s.ct) || !isNum(p.ct)) continue;
      const carried = ((s.r - p.r) / 1000) * Math.max(1, p.rate || 1, s.rate || 1);
      if (s.ct - p.ct > carried * 1.5 + 0.5) seekAt = s.r;
    }
    const len = (seg.find((s) => s.len) || {}).len || 0;
    const sampled = seg.filter((s) => s.from === 's');
    const adShare = (sampled.length ? sampled : seg).filter((s) => s.ad).length / (sampled.length || seg.length);
    // Media time played before any seek (what the ad really played), and the last reading before the seek.
    const beforeSeek = seg.filter((s) => isNum(s.ct) && (seekAt == null || s.r < seekAt));
    const sampledAd = sampled.filter((s) => s.ad);
    const skipShown = sampled.find((s) => s.skip === 'v');
    const waiting = seekAt != null ? sampledAd.filter((s) => s.r < seekAt && isNum(s.ct) && s.ct > 0.3) : [];
    return {
      k, src: cl.src,
      kind: cl.dur != null && len && Math.abs(cl.dur - len) <= 2 ? 'content' : adShare >= 0.5 ? 'ad' : '?',
      from: T[cl.i0].r, to: T[cl.i1].r, leftAt: cl.i1 + 1 < T.length ? T[cl.i1 + 1].r : null,
      dur: cl.dur,
      metaAt: first((s) => isNum(s.dur)),
      loadedAt: first((s) => isNum(s.dur) && s.rs >= 2),
      unpausedAt: first((s) => s.paused === false),
      playingAt: first((s) => s.paused === false && s.rs >= 3),
      seekAt,
      atEndAt: cl.dur != null ? first((s) => isNum(s.ct) && s.ct >= cl.dur - 0.3) : null,
      rate16At: first((s) => s.rate === 16),
      ended: seg.some((s) => s.ended),
      maxCt: Math.max(0, ...seg.map((s) => (isNum(s.ct) ? s.ct : 0))),
      ct0: (seg.find((s) => isNum(s.ct)) || {}).ct ?? null,
      playedCt: beforeSeek.length ? Math.max(...beforeSeek.map((s) => s.ct)) : null,
      ctBeforeSeek: seekAt != null && beforeSeek.length ? beforeSeek.at(-1).ct : null,
      vid: commonest(sampledAd.map((s) => s.vid).filter(Boolean)),
      pmode: commonest(sampled.map((s) => s.mode).filter(Boolean)), // USDAI (client-side) or SSAP (stitched)
      skipAt: skipShown ? skipShown.r : null, skipCt: skipShown ? skipShown.ct : null,
      mutedWhileWaiting: waiting.length ? Math.round((waiting.filter((s) => s.muted).length / waiting.length) * 100) / 100 : null,
      pods: [...new Set(seg.map((s) => s.pod).filter(Boolean))],
      events: seg.filter((s) => s.from === 'e').length,
    };
  });
}

// SABR media requests (POST, sabr=1) carry no `dur`; each clip's requests share one hashed `id` (vid). A vid belongs to
// the clip in whose window [from - 2 s, to] most of its requests started (by timing, so a guess: `by` says which).
function mediaGroups(R, clips) {
  const groups = new Map();
  for (const r of R) {
    if (r.cat !== 'media') continue;
    const key = r.vid || `dur${r.dur || '?'}`;
    if (!groups.has(key)) groups.set(key, { vid: key, reqs: [] });
    groups.get(key).reqs.push(r);
  }
  return [...groups.values()].map((g) => {
    const durs = [...new Set(g.reqs.map((r) => r.dur).filter(Boolean))];
    let clip = null;
    let by = '';
    if (durs.length === 1) {
      const c = clips.find((x) => x.dur != null && Math.abs(Number(durs[0]) - x.dur) < 0.15);
      if (c) { clip = c.k; by = 'dur'; }
    }
    if (clip == null) {
      let best = 0;
      for (const c of clips) {
        const n = g.reqs.filter((r) => r.st >= c.from - 2000 && r.st <= c.to).length;
        if (n > best) { best = n; clip = c.k; by = 'timing'; }
      }
    }
    return {
      vid: g.vid, n: g.reqs.length, first: Math.min(...g.reqs.map((r) => r.st)), last: Math.max(...g.reqs.map((r) => r.st)),
      itags: [...new Set(g.reqs.map((r) => r.itag).filter(Boolean))], sabr: g.reqs.some((r) => r.sabr === '1'),
      failed: g.reqs.filter((r) => r.failed).length, clip, by,
    };
  });
}

function analyse(S, E, F, R) {
  const T = timelineOf(S, E);
  const clips = clipsOf(T);
  const media = mediaGroups(R, clips);
  const runs = [];
  let open = null;
  for (let i = 0; i < S.length; i++) {
    if (S[i].ad) { if (!open) open = { i0: i, i1: i }; else open.i1 = i; }
    else if (open) { runs.push(open); open = null; }
  }
  if (open) runs.push({ ...open, stillUp: true });
  const breaks = [];
  for (const run of runs) {
    const prev = breaks.at(-1);
    if (prev && !prev.stillUp && S[run.i0].r - S[prev.i1 + 1].r <= MERGE_MS) {
      prev.merged.push(S[run.i0].r - S[prev.i1 + 1].r);
      prev.i1 = run.i1;
      prev.stillUp = run.stillUp;
    } else breaks.push({ ...run, merged: [] });
  }
  const reqIn = (a, b) => ({
    started: R.filter((r) => r.st >= a && r.st <= b).map((r) => r.n),
    finished: R.filter((r) => r.en != null && r.en >= a && r.en <= b && r.st < a).map((r) => r.n),
    inflight: R.filter((r) => r.st < a && r.en != null && r.en > b).map((r) => r.n),
    // Started before and never reported finished or failed in the window (measured: font and icon fetches, likely
    // answered by YouTube's service worker, never fire requestfinished), so not known to be in flight.
    unsettled: R.filter((r) => r.st < a && r.en == null).map((r) => r.n),
  });
  // The player's ad classes at a moment, and the ones it carried over a window that it did not carry at the break's
  // start (from the class flips): e.g. ytp-ad-display-override, which can arrive just before the clip leaves.
  const clsAt = (r) => { let c = ''; for (const f of F) { if (f.r > r) break; c = f.cls; } return c; };
  const gained = (since, a, b) => {
    const base = new Set(clsAt(since).split(' ').filter(Boolean));
    const out = new Set();
    for (const cls of [clsAt(a), ...F.filter((f) => f.r > a && f.r <= b).map((f) => f.cls)]) {
      for (const c of cls.split(' ')) if (c && !base.has(c)) out.add(c);
    }
    return [...out];
  };
  const adUiIn = (a, b) => [...new Set(E.filter((e) => e.type === 'adui' && e.r >= a && e.r <= b).map((e) => e.ui))];
  const out = breaks.map((b, bi) => {
    // Edges from the class flips where one falls between the edge samples (exact), else from the samples.
    const prevR = b.i0 > 0 ? S[b.i0 - 1].r : -Infinity;
    const fStart = F.find((f) => f.ad && f.r > prevR && f.r <= S[b.i0].r);
    const startAt = fStart ? fStart.r : S[b.i0].r;
    const lastAd = S[b.i1].r;
    const fEnd = b.stillUp ? null : F.find((f) => !f.ad && f.r > lastAd && f.r <= S[b.i1 + 1].r);
    const endAt = b.stillUp ? null : fEnd ? fEnd.r : S[b.i1 + 1].r;
    const nextStart = bi + 1 < breaks.length ? S[breaks[bi + 1].i0].r : Infinity;
    const list = clips.filter((c) => c.to >= startAt && c.from <= lastAd);
    const tail = list.at(-1);
    if (tail && tail.kind !== 'content') {
      const after = clips[tail.k + 1];
      if (after && after.from < nextStart) list.push(after);
    }
    const transitions = [];
    for (let j = 0; j + 1 < list.length; j++) {
      const a = list[j];
      const c = list[j + 1];
      if (a.leftAt == null) continue;
      const until = c.loadedAt ?? c.to;
      const group = media.find((g) => g.clip === c.k);
      transitions.push({
        from: a.k, to: c.k, fromKind: a.kind, toKind: c.kind, fromDur: a.dur, toDur: c.dur, leftAt: a.leftAt,
        fromSatAtEndMs: a.atEndAt != null ? a.leftAt - a.atEndAt : null,
        noSrcMs: c.from - a.leftAt, // the <video> had no src at all
        unloadedMs: c.loadedAt != null ? c.loadedAt - a.leftAt : null, // to a finite duration and readyState >= 2
        unpausedMs: c.unpausedAt != null ? c.unpausedAt - a.leftAt : null,
        playingMs: c.playingAt != null ? c.playingAt - a.leftAt : null,
        nextFirstMediaMs: group ? group.first - a.leftAt : null, // < 0: fetched before the clip switch
        nextMediaBy: group ? group.by : undefined,
        classesGained: gained(startAt, a.leftAt, until),
        adUi: adUiIn(a.leftAt, until),
        requests: reqIn(a.leftAt, until),
      });
    }
    // From the break's end to the content clock moving: two points of one src after the end, the later one ahead.
    let contentRunsMs = null;
    if (endAt != null) {
      const after = T.filter((p) => p.r >= endAt && p.r < nextStart);
      for (let i = 1; i < after.length; i++) {
        const p = after[i - 1];
        const s = after[i];
        if (s.src && s.src === p.src && isNum(s.ct) && isNum(p.ct) && s.ct > p.ct + 0.02 && s.ct - p.ct < 1 && s.paused === false) {
          contentRunsMs = s.r - endAt;
          break;
        }
      }
    }
    const first = list.find((c) => c.kind === 'ad');
    return {
      n: bi + 1, startAt, endAt, exactEdges: { start: Boolean(fStart), end: Boolean(fEnd) }, stillUp: Boolean(b.stillUp),
      onScreenMs: (endAt ?? lastAd) - startAt,
      mode: (S.slice(b.i0, b.i1 + 1).find((s) => s.mode) || {}).mode || '', mergedGapsMs: b.merged,
      firstAdLoadedMs: first && first.loadedAt != null ? first.loadedAt - startAt : null,
      clips: list.map((c) => c.k), transitions, contentRunsMs,
      requestsDuring: reqIn(startAt, endAt ?? lastAd).started.length,
    };
  });
  let maxGap = 0;
  for (let i = 1; i < S.length; i++) maxGap = Math.max(maxGap, S[i].r - S[i - 1].r);
  return { samplerMaxGapMs: maxGap, clips, media, breaks: out };
}

// The display-override waits, from the player's class flips: [on, off] (off null if it was still up at the end).
function overridesOf(F) {
  const out = [];
  let on = null;
  for (const f of F) {
    const has = f.cls.split(' ').includes(OVERRIDE_CLASS);
    if (has && on == null) on = f.r;
    else if (!has && on != null) { out.push({ on, off: f.r }); on = null; }
  }
  if (on != null) out.push({ on, off: null });
  return out;
}

// One record per ad that ended within the watch (the unit of the rule in scripts/pod-lab-rule.mjs): which ad (its own id
// and exact duration), how it ended, and whether the display-override wait came between it and the next clip.
// A clip the player reloads near its end with the same ad (seen after a seek) is the same ad, not a new transition.
function adTransitionsOf(v, mode) {
  const { clips, breaks } = v.analysis;
  const endR = v.endR ?? (v.samples.at(-1) || {}).r ?? 0;
  const waits = overridesOf(v.flips || []);
  const pageClicks = (v.skipClicks || []).filter((k) => k.trusted);
  const viewer = (v.viewerClicks || []).filter((k) => k.landed);
  const sameAd = (a, c) => (a.vid && c.vid ? a.vid === c.vid : a.dur != null && c.dur != null && Math.abs(a.dur - c.dur) < 0.0005);
  const vidOf = (c) => (c.vid && c.vid !== v.id ? c.vid : null);
  const out = [];
  for (const b of breaks) {
    const occ = [];
    for (const k of b.clips) {
      const c = { ...clips[k], vid: clips[k].kind === 'ad' ? vidOf(clips[k]) : null };
      const prev = occ.at(-1);
      if (c.kind === 'ad' && prev && prev.kind === 'ad' && sameAd(prev.last, c) && c.ct0 != null && c.dur != null && c.ct0 >= c.dur - 1.5) {
        prev.clips.push(c);
        prev.last = c;
        continue;
      }
      occ.push({ kind: c.kind, clips: [c], first: c, last: c });
    }
    for (let j = 0; j < occ.length; j++) {
      const o = occ[j];
      if (o.kind !== 'ad') continue;
      const a = o.last;
      if (a.leftAt == null) continue; // still on screen when the watch ended
      const next = occ[j + 1] ? occ[j + 1].first : null;
      const fromR = o.first.from;
      const dur = a.dur ?? o.first.dur;
      const vid = o.first.vid || a.vid || null;
      // The click as the page saw it (trusted, with the media time at that instant); else as the lab sent it.
      const pageClick = pageClicks.find((k) => !k.ovr && k.r >= fromR - 200 && k.r <= a.leftAt);
      const viewerClick = viewer.find((k) => k.kind === 'ad' && k.clickR >= fromR - 200 && k.clickR <= a.leftAt + 500);
      const click = pageClick || (viewerClick ? { r: viewerClick.clickR, ct: viewerClick.ctSeen, fromLab: true } : null);
      const seeked = o.clips.find((c) => c.seekAt != null);
      const playedCt = Math.max(...o.clips.map((c) => c.playedCt ?? 0));
      let end;
      if (click && a.leftAt - click.r <= 2500 && !(isNum(click.ct) && isNum(dur) && click.ct >= dur - 0.5)) end = 'viewer-skip';
      else if (seeked) end = mode.name === 'seek' ? 'shield-seek' : mode.name === 'seekafter' ? 'seek-after' : `seek(${mode.name})`;
      else if (o.clips.some((c) => c.atEndAt != null)) end = 'natural';
      else end = 'cut';
      const skipShown = o.clips.find((c) => c.skipAt != null);
      // Skip shows at 5.0-5.3 s of media and stays up to the end: an ad that played to its end or 8 s without one has none.
      const skippable = skipShown || click ? true : playedCt >= 8 || end === 'natural' ? false : null;
      // The wait starts as the clip leaves (measured 2-15 ms after it, n=9) and ends just before the next clip attaches.
      const wait = waits.find((x) => x.on >= a.leftAt - 1500 && x.on <= (next ? next.from : b.endAt ?? endR));
      const waitEnd = wait ? wait.off ?? endR : null;
      const waitClick = wait ? pageClicks.find((k) => k.ovr && k.r >= wait.on && k.r <= waitEnd) : null;
      const t = {
        break: b.n, from: o.first.k, to: next ? next.k : null, toKind: next ? next.kind : null, vid, dur, reloads: o.clips.length - 1,
        end, playedCt, skippable, skipCt: skipShown ? skipShown.skipCt : null,
        nextFromMs: next ? next.from - a.leftAt : null, nextLoadedMs: next && next.loadedAt != null ? next.loadedAt - a.leftAt : null,
        override: Boolean(wait), overrideMs: wait ? waitEnd - wait.on : null, overrideOpen: Boolean(wait && wait.off == null),
        overrideStartMs: wait ? wait.on - a.leftAt : null, overrideClicked: Boolean(waitClick),
      };
      if (end === 'viewer-skip') {
        Object.assign(t, { clickCt: click.ct, clickToLeaveMs: a.leftAt - click.r, clickSeenInPage: !click.fromLab, viewerClickTookMs: viewerClick ? viewerClick.clickTookMs : null });
      }
      if (seeked) Object.assign(t, { seekCt: seeked.ctBeforeSeek, seekWallMs: seeked.seekAt - seeked.from, mutedWhileWaiting: seeked.mutedWhileWaiting });
      if (waitClick) {
        Object.assign(t, {
          clickIntoOverrideMs: waitClick.r - wait.on, clickToNextMs: next ? next.from - waitClick.r : null,
          clickToOverrideEndMs: wait.off != null ? wait.off - waitClick.r : null,
        });
      }
      out.push(t);
    }
  }
  return out;
}

// Did the page run this mode's code? Judged from the shield's own log, the samples and the click records, never from
// the file.
function checkVariant(v, mode) {
  const MODE = mode.name;
  const lines = v.shieldLog.map((l) => l.line);
  const marker = lines.some((l) => l.startsWith(`active: [lab:${MODE}] `));
  const lab = lines.filter((l) => l.startsWith('lab '));
  const skips = lines.filter((l) => l.startsWith('ad skipped'));
  const ads = v.samples.some((s) => s.ad);
  const adClips = v.analysis.clips.filter((c) => c.kind === 'ad');
  const T = v.adTransitions || [];
  const pageClicks = v.skipClicks || [];
  const trusted = pageClicks.filter((k) => k.trusted);
  const problems = [];
  const evidence = [];
  let unproven = ads ? '' : 'no ad';
  if (!marker) problems.push(`no "active: [lab:${MODE}]" line in the shield's log`);
  else evidence.push('marker');
  if (!mode.viewer && trusted.length) problems.push(`${trusted.length} trusted click(s) on Skip in a mode where the lab never clicks`);
  if (MODE === 'off' || MODE === 'userskip') {
    if (!lines.includes('off: switched off')) problems.push('no "off: switched off" line');
    if (v.shieldFinal && v.shieldFinal.enabled !== false) problems.push('the page says enabled');
    if (skips.length) problems.push(`${skips.length} "ad skipped" lines with the shield off`);
    if (pageClicks.some((k) => !k.trusted)) problems.push(`${pageClicks.filter((k) => !k.trusted).length} untrusted click(s) on Skip with the shield off`);
    evidence.push('switched off');
    if (MODE === 'off') {
      const natural = T.filter((t) => t.end === 'natural').length;
      if (ads) evidence.push(`${natural} of ${T.length} ad(s) ended naturally`);
    }
  }
  if (MODE === 'userskip') {
    const tried = v.viewerClicks || [];
    const landed = tried.filter((k) => k.landed);
    const ended = T.filter((t) => t.end === 'viewer-skip');
    evidence.push(`${tried.length} click(s) tried (${tried.filter((k) => k.kind === 'override').length} in an override), ${landed.length} landed, ` +
      `${trusted.length} trusted click event(s) on Skip in the page; ${ended.length} ad(s) ended by the click` +
      `${ended.length ? ` at ${ended.map((t) => `${t.clickCt}s`).join(', ')} of media, gone ${ended.map((t) => `${t.clickToLeaveMs}ms`).join(', ')} later` : ''}`);
    for (const k of tried.filter((x) => x.error)) problems.push(`click at ${(k.r / 1000).toFixed(1)}s failed: ${k.error}`);
    // A Skip button up for 1.5 s in an ad clip with no click tried: the viewer missed it.
    for (const c of adClips.filter((x) => x.skipAt != null)) {
      const until = c.leftAt ?? v.endR ?? c.to;
      const tryIn = tried.some((k) => k.r >= c.from - 200 && k.r <= until);
      if (!tryIn && until - c.skipAt > 1500) problems.push(`Skip shown ${until - c.skipAt} ms on a ${c.dur} s clip with no click`);
    }
    // Shown: a sample saw it, or the viewer's own poll did (a click can land and end the clip between two samples).
    const shown = adClips.some((c) => c.skipAt != null) || tried.length > 0 || Boolean(v.viewer && v.viewer.skipSeen);
    if (ads && !shown) unproven = 'no Skip button shown';
    else if (ads && !ended.length && !problems.length) unproven = 'no ad ended by a click';
  } else if (MODE === 'seek') {
    if (lab.length) problems.push(`lab lines in an unpatched run: ${lab[0]}`);
    const seeked = adClips.filter((c) => c.seekAt != null).length;
    if (ads) evidence.push(`${skips.length} skips, ${seeked} ad clips seeked`);
  } else if (MODE === 'seekafter') {
    const at = lab.map((l) => /seek at ([\d.]+) s of media/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    const early = at.filter((x) => x < SEEKAFTER_S);
    if (early.length) problems.push(`seek before ${SEEKAFTER_S} s of media (shield log): ${early.join(', ')}`);
    // Independent of the log: the media time sampled just before each seek (a sample lags the seek by up to ~0.1 s of
    // playback, so 0.3 s of slack), and how long the clip had played on the wall clock by then.
    const seeked = adClips.filter((c) => c.seekAt != null);
    const sampledEarly = seeked.filter((c) => c.ctBeforeSeek != null && c.ctBeforeSeek < SEEKAFTER_S - 0.3);
    if (sampledEarly.length) problems.push(`sampled media time before a seek below ${SEEKAFTER_S - 0.3} s: ${sampledEarly.map((c) => c.ctBeforeSeek).join(', ')}`);
    const unmuted = seeked.filter((c) => c.mutedWhileWaiting != null && c.mutedWhileWaiting < 0.9);
    if (unmuted.length) problems.push(`not muted while waiting: ${unmuted.map((c) => c.mutedWhileWaiting).join(', ')} of samples muted`);
    if (ads && skips.length && !at.length) problems.push('no "lab seekafter: seek at" line though ads were skipped');
    // A client-side ad with time left that played a full second past the gate unseeked: the gate never fired.
    const missed = adClips.filter((c) => c.seekAt == null && c.pmode !== 'SSAP' && (c.playedCt ?? 0) >= SEEKAFTER_S + 1 && c.dur != null && c.dur - (c.playedCt ?? 0) > 1);
    if (missed.length) problems.push(`ad(s) played past ${SEEKAFTER_S + 1} s of media unseeked: ${missed.map((c) => `${c.dur} s clip to ${c.playedCt} s`).join(', ')}`);
    if (at.length || seeked.length) {
      evidence.push(`seeks at ${at.map((x) => `${x}s`).join(', ') || '-'} of media (shield log); sampled just before: ` +
        `${seeked.map((c) => `${c.ctBeforeSeek}s media / ${c.seekAt - c.from}ms wall since the clip attached`).join(', ')}; ` +
        `muted while waiting: ${seeked.map((c) => c.mutedWhileWaiting).join(', ')}`);
    }
    if (ads && !seeked.length && !problems.length) unproven = 'no ad seeked after 5.5 s of media';
  } else if (MODE === 'rate16') {
    const sped = v.samples.filter((s) => s.ad && s.rate === 16).length;
    const seeked = adClips.filter((c) => c.seekAt != null).length;
    if (ads && !lab.some((l) => l.startsWith('lab rate16: 16x'))) problems.push('no "lab rate16: 16x" line while ads showed');
    if (ads && !sped) problems.push('no ad sample at playbackRate 16');
    evidence.push(`${lab.filter((l) => l.includes('16x on')).length} clips set to 16x, ${sped} ad samples at 16x, ${seeked} ad clips with a >1 s jump`);
  } else if (MODE !== 'off' && MODE !== 'userskip') {
    const at = lab.map((l) => /seek at (\d+) ms/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    if (ads && skips.length && !at.length) problems.push(`no "lab ${MODE}: seek at" line though ads were skipped`);
    const early = at.filter((ms) => ms < mode.delayMs - 5);
    if (early.length) problems.push(`seeks before ${mode.delayMs} ms: ${early.join(', ')}`);
    if (at.length) evidence.push(`seeks at ${at.join(', ')} ms`);
  }
  if (MODE === 'off') unproven = ads ? '' : 'no ad';
  const ran = problems.length ? 'NO' : !marker ? 'NO' : unproven ? `unproven (${unproven})` : 'yes';
  return { ran, evidence, problems };
}

// ---- one video ---------------------------------------------------------------------------------------------------
async function watchVideo(page, id, net, mode) {
  const t0 = Date.now();
  const raw = { samples: [], events: [], flips: [], statuses: [], skipped: [], clicks: [], dropped: 0 };
  let lastAdW = null;
  const drain = async () => {
    const box = await page.evaluate(drainPage).catch(() => null);
    if (!box || !Array.isArray(box.samples)) return;
    for (const k of ['samples', 'events', 'flips', 'statuses', 'skipped', 'clicks']) if (Array.isArray(box[k])) raw[k].push(...box[k]);
    raw.dropped = Math.max(raw.dropped, box.dropped || 0);
    const lastAd = box.samples.findLast((s) => s.ad);
    if (lastAd) lastAdW = lastAd.w;
  };
  const netFrom = net.length;
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  const minEnd = t0 + WATCH_S * 1000;
  const hardEnd = t0 + MAX_WATCH_S * 1000;
  // At least --watch; then on while a break is up (its last sample says ad), and 5 s past a break that ended late.
  const keepGoing = () => {
    const t = Date.now();
    if (t >= hardEnd) return false;
    if (t < minEnd) return true;
    const last = raw.samples.at(-1);
    if (last && last.ad) return true;
    return lastAdW != null && t < lastAdW + 5000;
  };
  let watching = true;
  const clicks = [];
  const viewerStats = { polls: 0, maxGapMs: 0, skipSeen: 0 };
  const viewerDone = viewerLoop(page, t0, () => !watching, clicks, mode, viewerStats).catch((e) => { viewerStats.error = String((e && e.message) || e).slice(0, 160); });
  try {
    while (keepGoing()) {
      await sleep(Math.min(1000, Math.max(0, (Date.now() < minEnd ? minEnd : hardEnd) - Date.now())));
      await drain();
    }
  } finally {
    watching = false;
    await viewerDone;
  }
  const shieldFinal = await page.evaluate(askShield).catch(() => null);
  await drain();
  const natives = await page.evaluate(probeNatives).catch(() => null);
  const tEnd = Date.now();
  const rel = (w) => w - t0;
  const samples = raw.samples.filter((s) => s.w >= t0).sort((a, b) => a.w - b.w).map((s) => ({ r: rel(s.w), ...s, w: undefined }));
  const requests = net.slice(netFrom).filter((q) => q.seen >= t0 && q.seen <= tEnd).map((q, n) => {
    const { seen, done, start, end: qEnd, n: _global, ...rest } = q;
    return { n, st: rel(start ?? seen), en: qEnd != null ? rel(qEnd) : null, ...rest };
  });
  const statuses = raw.statuses.map((st) => { let s = null; try { s = JSON.parse(st.raw); } catch { /* not ours */ } return { r: rel(st.w), s }; });
  const v = {
    id, t0: new Date(t0).toISOString(), watchS: WATCH_S, maxWatchS: MAX_WATCH_S, watchedS: Math.round((tEnd - t0) / 100) / 10, endR: rel(tEnd),
    dropped: raw.dropped,
    samples,
    events: raw.events.map((e) => ({ r: rel(e.w), ...e, w: undefined })),
    flips: raw.flips.map((f) => ({ r: rel(f.w), ...f, w: undefined })),
    statuses: statuses.map((st) => ({ r: st.r, adsSkipped: st.s && st.s.adsSkipped, adPlaying: st.s && st.s.adPlaying, enabled: st.s && st.s.enabled, lastAdMs: st.s && st.s.lastAdMs })),
    skipped: raw.skipped.map((k) => ({ r: rel(k.w), raw: k.raw })),
    skipClicks: raw.clicks.map((k) => ({ r: rel(k.w), ...k, w: undefined })),
    viewerClicks: clicks, viewer: viewerStats,
    shieldLog: mergeLog([...statuses, ...(shieldFinal ? [{ r: rel(tEnd), s: shieldFinal }] : [])]),
    shieldFinal: shieldFinal && { enabled: shieldFinal.enabled, adsSkipped: shieldFinal.adsSkipped, enforcement: shieldFinal.enforcement, lastAdMs: shieldFinal.lastAdMs, log: shieldFinal.log },
    natives, enforcement: samples.some((s) => s.enf),
    requests,
  };
  analyseVideo(v, mode);
  return v;
}
const analyseVideo = (v, mode) => {
  v.analysis = analyse(v.samples, v.events, v.flips, v.requests);
  v.adTransitions = adTransitionsOf(v, mode);
  v.variant = checkVariant(v, mode);
  return v;
};

// ---- printing ----------------------------------------------------------------------------------------------------
const sec = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`);
const catCounts = (ids, R) => {
  const c = {};
  for (const n of ids) { const k = R[n].cat; c[k] = (c[k] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
};
const signed = (ms) => (ms == null ? '?' : `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(1)}s`);
const describeTransition = (t) => {
  const how = t.end === 'viewer-skip' ? ` (Skip clicked at ${t.clickCt}s of media, clip gone ${t.clickToLeaveMs} ms later)`
    : t.seekCt != null ? ` (seek after ${t.seekCt}s of media, ${t.seekWallMs} ms after the clip attached)` : t.end === 'natural' ? ` (played ${t.playedCt}s)` : '';
  const ovr = t.override
    ? `OVERRIDE ${sec(t.overrideMs)}${t.overrideOpen ? '+ (still up at the end)' : ''}${isOverride(t) ? '' : ' (under 6.5 s, not counted)'}` +
      `${t.overrideClicked ? `, Skip clicked ${sec(t.clickIntoOverrideMs)} in, next clip ${sec(t.clickToNextMs)} after the click` : ''}`
    : 'no override';
  return `ad ${t.vid || '(no id)'} ${t.dur == null ? '?' : t.dur.toFixed(3)}s${t.reloads ? ` (+${t.reloads} reload)` : ''} skip:${t.skippable == null ? '?' : t.skippable ? `yes@${t.skipCt ?? '?'}s` : 'no'} ` +
    `ended ${t.end}${how} -> ${t.toKind || 'end of watch'} after ${sec(t.nextFromMs)}: ${ovr}${counts(t) ? '' : ' [not a counted transition]'}`;
};
function printVideo(v, mode, prefix = `[${mode.name}]`) {
  const { clips, breaks } = v.analysis;
  const log = v.shieldLog.map((l) => l.line).filter((l) => !l.startsWith('active: ')).join(' | ') || '-';
  console.log(`${prefix} ${v.id}: ${breaks.length} break(s)${v.enforcement ? ' ENFORCEMENT' : ''}; variant ${v.variant.ran}` +
    `${v.variant.evidence.length ? ` (${v.variant.evidence.join('; ')})` : ''}${v.variant.problems.length ? ` PROBLEMS: ${v.variant.problems.join('; ')}` : ''}` +
    `; sampler max gap ${sec(v.analysis.samplerMaxGapMs)}; watched ${v.watchedS ?? v.watchS}s; shield log: ${log}`);
  for (const b of breaks) {
    const parts = [];
    for (const k of b.clips) {
      const c = clips[k];
      const marks = [];
      if (c.kind === 'ad' && c.seekAt != null) marks.push(`seek ${signed(c.seekAt - c.from)}`);
      if (c.kind === 'ad' && c.rate16At != null) marks.push(`16x ${signed(c.rate16At - c.from)}`);
      if (c.kind === 'ad' && c.loadedAt == null) marks.push('never rs>=2');
      const t = b.transitions.find((x) => x.from === c.k);
      if (t && t.fromSatAtEndMs != null && c.kind === 'ad') marks.push(`at end ${sec(t.fromSatAtEndMs)}`);
      parts.push(`${c.kind} ${c.dur == null ? '?' : `${c.dur.toFixed(1)}s`}${c.pods.length ? ` ${c.pods.join(',')}` : ''}${marks.length ? ` (${marks.join(', ')})` : ''}`);
      if (t) {
        // The ad UI in the gap, cut to the telling names (the report keeps every rendered ytp-ad-* block).
        const ui = [...new Set(t.adUi.flatMap((u) => u.split(' ')))].filter((x) => /skip|endcap|interstitial|survey|action|display|preview|countdown|text-ad/.test(x));
        const extra = [...t.classesGained.map((x) => `+${x}`), ...(ui.length ? [`ui ${ui.join(' ')}`] : [])];
        parts.push(`-[no src ${sec(t.noSrcMs)}, unloaded ${sec(t.unloadedMs)}, playing ${sec(t.playingMs)}` +
          `${t.nextFirstMediaMs != null ? `, its media ${signed(t.nextFirstMediaMs)}` : ''}${extra.length ? `; ${extra.join(', ')}` : ''}]->`);
      }
    }
    const gaps = b.transitions.filter((t) => t.unloadedMs == null || t.unloadedMs >= 1000)
      .map((t) => {
        const open = t.requests.unsettled.filter((n) => v.requests[n].cat !== 'other');
        return `gap ${t.from}->${t.to} started: ${catCounts(t.requests.started, v.requests)}; in flight: ${catCounts(t.requests.inflight, v.requests)}` +
          `${open.length ? `; never settled: ${catCounts(open, v.requests)}` : ''}`;
      });
    console.log(`  break ${b.n} at ${sec(b.startAt)}: on screen ${sec(b.onScreenMs)}${b.stillUp ? ' (STILL UP)' : ''} ${b.mode || '?'}` +
      `${b.mergedGapsMs.length ? ` merged ${b.mergedGapsMs.join('/')} ms` : ''}; ${parts.join(' ')}; ` +
      `content runs ${sec(b.contentRunsMs)} after${gaps.length ? ` | ${gaps.join(' | ')}` : ''}`);
    for (const t of (v.adTransitions || []).filter((x) => x.break === b.n)) console.log(`    ${describeTransition(t)}`);
  }
}

// ---- the rotation's records, for the running summary and --aggregate ---------------------------------------------
// Every load file is analysed again from its raw records (so an improved analysis applies to old loads); a load whose
// arm did not provably run as designed (variant NO) is left out and counted.
function loadRecords(rep, label) {
  const mode = modeOf(rep.mode);
  const out = { transitions: [], excluded: [], videos: 0, enforcement: 0 };
  if (!mode) { out.excluded.push(`${label}: mode ${rep.mode} is not a lab mode`); return out; }
  for (const v of rep.videos || []) {
    analyseVideo(v, mode);
    out.videos++;
    if (v.enforcement) out.enforcement++;
    if (v.variant.ran === 'NO') { out.excluded.push(`${label}: ${mode.name} did not run as designed (${v.variant.problems.join('; ')})`); continue; }
    for (const t of v.adTransitions) out.transitions.push({ ...t, arm: mode.name, load: label, video: v.id, breakId: `${label}#${v.id}#${t.break}` });
  }
  return out;
}
function aggregateLines(transitions, armOrder, header) {
  const ads = tabulate(transitions);
  const verdict = decide(ads);
  const clicks = overrideClicks(transitions);
  const counted = transitions.filter(counts);
  const noId = counted.filter((t) => !t.vid).length;
  const lines = [...header,
    `${counted.length} counted ad transitions (${transitions.length} recorded; ${noId} without an ad id, keyed by duration), ${ads.size} distinct ads`,
    'per ad: <id> <duration> skip:<yes|no|?> | <arm> <transitions>tr/<breaks>brk <overrides>ov [<how it ended> <n>/<overrides>ov]', '',
    ...formatAggregate(ads, verdict, clicks, armOrder)];
  const json = {
    verdict, overrideClicks: clicks,
    ads: [...ads.values()].map((ad) => ({ ...ad, arms: Object.fromEntries(Object.entries(ad.arms).map(([k, a]) => [k, { ...a, breaks: a.breaks.length }])) })),
  };
  return { lines, json };
}

// ---- run ---------------------------------------------------------------------------------------------------------
if (AGGREGATE) {
  const names = opt('aggregate', '');
  let dirs;
  try {
    dirs = names ? names.split(',').map((n) => underReports(n.trim(), '--aggregate'))
      : readdirSync(REPORTS, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('rotation-')).map((d) => join(REPORTS, d.name));
  } catch (e) { die(`--aggregate: ${e.message}`); }
  if (!dirs.length) die(`--aggregate: no rotation-* folder under ${REPORTS}`);
  const all = [];
  const excluded = [];
  let loads = 0;
  let videos = 0;
  let enforcement = 0;
  const armOrder = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) die(`--aggregate: ${dir} does not exist`);
    const files = readdirSync(dir).filter((f) => /^load-\d+-.+\.json$/.test(f)).sort();
    for (const f of files) {
      let rep;
      try { rep = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) { excluded.push(`${f}: unreadable (${e.message})`); continue; }
      loads++;
      for (const a of (rep.rotation && rep.rotation.arms) || []) if (!armOrder.includes(a)) armOrder.push(a);
      const got = loadRecords(rep, `${relative(REPORTS, dir)}/${f}`);
      all.push(...got.transitions);
      excluded.push(...got.excluded);
      videos += got.videos;
      enforcement += got.enforcement;
    }
  }
  const { lines } = aggregateLines(all, armOrder, [
    `aggregate of ${dirs.map((d) => relative(REPORTS, d)).join(', ')}: ${loads} loads, ${videos} videos, ${enforcement} with YouTube's ad-blocker notice, ` +
      `${excluded.length} left out${excluded.length ? `:\n  - ${excluded.join('\n  - ')}` : ''}`]);
  console.log(lines.join('\n'));
  process.exit(0);
}
if (saved) {
  const mode = SINGLE;
  for (const v of saved.videos || []) {
    analyseVideo(v, mode);
    printVideo(v, mode);
  }
  process.exit(0);
}
const close = async (session) => {
  if (!session) return;
  await session.context.close().catch(() => {});
  rmSync(session.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
};

if (ROTATE) {
  const exts = new Map();
  try {
    for (const m of ARMS) exts.set(m.name, buildExtension(m));
  } catch (e) {
    for (const x of exts.values()) rmSync(x.dir, { recursive: true, force: true });
    die(String((e && e.message) || e));
  }
  const dir = join(REPORTS, `rotation-${STAMP}`);
  mkdirSync(dir, { recursive: true });
  const names = ARMS.map((m) => m.name);
  const started = Date.now();
  const deadline = MINUTES ? started + MINUTES * 60000 : Infinity;
  const summary = {
    stamp: STAMP, arms: names, videos: VIDEOS, loadsPlanned: LOADS, minutes: MINUTES || undefined, watchS: WATCH_S, maxWatchS: MAX_WATCH_S,
    chromium: EXE, offscreen: OFFSCREEN, headless: HEADLESS, started: new Date(started).toISOString(), loads: [],
  };
  const transitions = [];
  const excluded = [];
  let failed = 0;
  let errorsInARow = 0; // three loads in a row that errored (no network, YouTube refusing): stop rather than burn the list
  console.log(`[rotation] ${names.join(' -> ')} over ${VIDEOS.join(', ')}; up to ${LOADS} loads${MINUTES ? ` or ${MINUTES} min` : ''}; ` +
    `watch ${WATCH_S}-${MAX_WATCH_S}s; folder ${relative(ROOT, dir)}`);
  try {
    for (let i = 0; i < LOADS; i++) {
      if (Date.now() >= deadline) { summary.stoppedBy = `--minutes ${MINUTES}`; break; }
      const mode = ARMS[i % ARMS.length];
      const id = VIDEOS[Math.floor(i / ARMS.length) % VIDEOS.length];
      const ext = exts.get(mode.name);
      const file = `load-${String(i + 1).padStart(3, '0')}-${mode.name}-${id}.json`;
      const prefix = `[${i + 1}/${LOADS} ${mode.name}]`;
      const rep = {
        when: new Date().toISOString(), mode: mode.name, rotation: { stamp: STAMP, load: i + 1, of: LOADS, arms: names, video: id },
        chromium: EXE, watchS: WATCH_S, maxWatchS: MAX_WATCH_S, offscreen: OFFSCREEN, headless: HEADLESS,
        patches: ext.patches, pageSha: ext.pageSha, sessions: [], videos: [], errors: [],
      };
      const net = [];
      let session = null;
      try {
        session = await launch(mode, ext.dir, net);
        rep.sessions.push({ ua: session.ua, loaded: session.loaded, consent: session.consent, enabled: session.enabled, firstVideo: id });
        const v = await watchVideo(session.page, id, net, mode);
        rep.videos.push(v);
        printVideo(v, mode, `${prefix} browser ${session.loaded}, enabled=${session.enabled}, consent ${session.consent};`);
      } catch (e) {
        const msg = String((e && e.message) || e).split('\n')[0].slice(0, 200);
        rep.errors.push({ id, error: msg });
        console.log(`${prefix} ${id}: ERROR ${msg}`);
      } finally {
        await close(session);
      }
      writeFileSync(join(dir, file), JSON.stringify(rep));
      const got = loadRecords(rep, file);
      transitions.push(...got.transitions);
      excluded.push(...got.excluded);
      const v = rep.videos[0];
      if (rep.errors.length || (v && v.variant.ran === 'NO')) failed++;
      summary.loads.push({
        n: i + 1, arm: mode.name, video: id, file, error: rep.errors.length ? rep.errors[0].error : undefined,
        variant: v ? v.variant.ran : undefined, breaks: v ? v.analysis.breaks.length : 0, watchedS: v ? v.watchedS : undefined,
        transitions: got.transitions.length, overrides: got.transitions.filter(isOverride).length,
      });
      summary.updated = new Date().toISOString();
      summary.minutesSoFar = Math.round((Date.now() - started) / 6000) / 10;
      const agg = aggregateLines(transitions, names, [
        `rotation ${STAMP}: ${summary.loads.length} of ${LOADS} loads, ${summary.minutesSoFar} min; ${failed} failed or not as designed` +
          `${excluded.length ? `; left out:\n  - ${excluded.join('\n  - ')}` : ''}`]);
      summary.excluded = excluded;
      summary.aggregate = agg.json;
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
      writeFileSync(join(dir, 'summary.txt'), `${agg.lines.join('\n')}\n`);
      console.log(`${prefix} saved ${file}; running verdict (${agg.json.verdict.overall}), ${agg.json.verdict.ads.length} override-prone ad(s), ` +
        `${transitions.filter(counts).length} counted transitions`);
      errorsInARow = rep.errors.length ? errorsInARow + 1 : 0;
      if (errorsInARow >= 3) {
        summary.stoppedBy = `${errorsInARow} loads in a row errored`;
        writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
        console.log(`[rotation] stopped: ${summary.stoppedBy}`);
        break;
      }
    }
  } finally {
    for (const x of exts.values()) rmSync(x.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(`\n${readFileSync(join(dir, 'summary.txt'), 'utf8')}`);
  console.log(`folder: ${dir}`);
  if (failed) { console.log(`FAIL\n- ${failed} load(s) errored or did not run as designed (see summary.json)`); process.exit(1); }
  process.exit(0);
}

const MODE = SINGLE.name;
let ext;
try {
  ext = buildExtension(SINGLE);
} catch (e) {
  die(String((e && e.message) || e));
}
// --check-patches: build this mode's copy, parse its page.js, print the patches, and stop before any browser starts.
if (argv.includes('--check-patches')) {
  const code = readFileSync(join(ext.dir, 'src', 'page.js'), 'utf8');
  let parsed = 'parses';
  try { new vm.Script(code, { filename: 'page.js (lab copy)' }); } catch (e) { parsed = `DOES NOT PARSE: ${e.message}`; }
  const loadedName = JSON.parse(readFileSync(join(ext.dir, 'manifest.json'), 'utf8')).version_name;
  console.log(`[${MODE}] copy: ${ext.patches.map((p) => p.what).join(', ')} (each matched once); page.js ${ext.pageSha.original} -> ${ext.pageSha.copy}, ${parsed}; manifest version_name ${loadedName}`);
  rmSync(ext.dir, { recursive: true, force: true });
  process.exit(parsed === 'parses' ? 0 : 1);
}
const report = {
  when: new Date().toISOString(), mode: MODE, delayMs: SINGLE.delayMs || undefined, chromium: EXE, watchS: WATCH_S, maxWatchS: MAX_WATCH_S,
  freshEach: FRESH_EACH, offscreen: OFFSCREEN, headless: HEADLESS, patches: ext.patches, pageSha: ext.pageSha, sessions: [], videos: [], errors: [],
};
const save = () => { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report)); };
const net = [];
let session = null;
try {
  for (const id of VIDEOS) {
    try {
      if (!session || FRESH_EACH) {
        await close(session);
        session = null;
        session = await launch(SINGLE, ext.dir, net);
        report.sessions.push({ ua: session.ua, loaded: session.loaded, consent: session.consent, firstVideo: id });
        console.log(`[${MODE}] browser: ${session.loaded} loaded, consent ${session.consent}`);
      }
      const v = await watchVideo(session.page, id, net, SINGLE);
      report.videos.push(v);
      printVideo(v, SINGLE);
    } catch (e) {
      const msg = String((e && e.message) || e).split('\n')[0].slice(0, 200);
      report.errors.push({ id, error: msg });
      console.log(`[${MODE}] ${id}: ERROR ${msg}`);
    }
    save();
  }
} finally {
  await close(session);
  rmSync(ext.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const allBreaks = report.videos.flatMap((v) => v.analysis.breaks);
const gaps = allBreaks.flatMap((b) => b.transitions.filter((t) => t.toKind === 'ad').map((t) => t.unloadedMs));
const notRan = report.videos.filter((v) => v.variant.ran === 'NO').map((v) => v.id);
console.log(`\n[${MODE}] ${report.videos.length} videos, ${allBreaks.length} breaks; on screen: ${allBreaks.map((b) => sec(b.onScreenMs) + (b.stillUp ? '+' : '')).join(', ') || '-'}; ` +
  `ad-to-ad unloaded gaps: ${gaps.map(sec).join(', ') || '-'}; content ran after: ${allBreaks.filter((b) => !b.stillUp).map((b) => sec(b.contentRunsMs)).join(', ') || '-'}`);
console.log(`report: ${OUT}`);
if (report.errors.length || notRan.length) {
  console.log(`FAIL\n- ${[...report.errors.map((e) => `${e.id}: ${e.error}`), ...notRan.map((id) => `${id}: the page did not show the ${MODE} variant running`)].join('\n- ')}`);
  process.exit(1);
}
process.exit(0);
