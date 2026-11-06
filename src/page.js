// YouTube Shield page script. Chrome runs it in YouTube's own JavaScript world ("MAIN") at document_start, in every
// YouTube page and embedded player, so it sees the player's own methods (getStatsForNerds, seekTo) the way YouTube does.
//
// What it does:
//   - skips each in-stream ad the moment it starts: mutes it, seeks the ad clip to its end, gives the sound back;
//   - hides YouTube's display ads (feed, search, masthead, companion, overlays) with one stylesheet;
//   - stands down for the rest of the page when YouTube shows its ad-blocker notice, and never hides that notice.
// What it never does: replace a built-in function, block, rewrite or delay a request, or leave a global on `window`.
// YouTube looks for the first two, which is how request-blocking ad blockers get caught.
//
// It talks to the extension (src/bridge.js, in Chrome's isolated world) only through DOM events on `document`, with
// JSON strings as payloads:
//   youtube-shield:settings  in   {"enabled": bool}
//   youtube-shield:hello     in   asks for a status event now
//   youtube-shield:status    out  the status object (see status() below)
//   youtube-shield:skipped   out  {"seconds": n, "kind": "client" | "stitched"} once per ad skipped
//   youtube-shield:probe     both a second copy asks whether one already runs; the first answers by setting detail.found
//
// The skipper is ported from claude-browser-shield's page/shield.js (same author, MIT), measured there 2026-10-26.
(() => {
  const VERSION = 1;
  const EVENT = 'youtube-shield';
  const w = window;
  const doc = document;
  const host = String(location.hostname).toLowerCase();
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;

  // Natives captured (never replaced) before any page script runs, so a page that swaps them later cannot blind us.
  const CustomEvt = w.CustomEvent;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const now = () => (w.performance && typeof w.performance.now === 'function' ? w.performance.now() : Date.now());
  const emit = (name, payload) => {
    try { doc.dispatchEvent(new CustomEvt(`${EVENT}:${name}`, { detail: stringify(payload) })); } catch { /* no listener side */ }
  };
  const on = (name, fn) => doc.addEventListener(`${EVENT}:${name}`, fn);
  const read = (e) => {
    try { return typeof e.detail === 'string' ? parse(e.detail) : null; } catch { return null; }
  };

  // One copy per document: a copy that finds another already running stays out.
  const probe = { found: false };
  try { doc.dispatchEvent(new CustomEvt(`${EVENT}:probe`, { detail: probe })); } catch { /* ignore */ }
  if (probe.found) return;
  on('probe', (e) => { if (e.detail && typeof e.detail === 'object') e.detail.found = true; });

  const state = {
    version: VERSION, host, enabled: true, enforcement: false, enforcementSign: '',
    adsSkipped: 0, secondsSaved: 0, adPlaying: false, adMode: '', lastAdMs: 0, log: [],
  };
  const note = (kind, detail) => {
    state.log.push(`${kind}: ${String(detail).slice(0, 140)}`);
    if (state.log.length > 20) state.log.shift();
  };

  // ---- display ads out of sight -----------------------------------------------------------------------------------
  // EasyList's and AdGuard's youtube.com hiding rules as of 2026-10-26 (carried from claude-browser-shield), plus
  // EasyList's Shorts ad reel and in-player product badge (unchanged in EasyList since 2026-08-13, read 2026-11-06).
  // Not #player-ads: uBlock Origin and AdGuard deliberately un-hide it, since YouTube checks it. Never the ad-blocker
  // notice: that stays visible (a test pins both).
  const HIDE = [
    '#masthead-ad', 'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-display-ad-renderer',
    'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)', 'ytd-rich-item-renderer:has(ytd-display-ad-renderer)',
    'ytd-search-pyv-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-sparkles-text-search-renderer',
    'ytd-promoted-video-renderer', 'ytd-companion-slot-renderer', 'ytd-action-companion-ad-renderer',
    'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer', 'ytd-video-masthead-ad-v3-renderer',
    'ytd-primetime-promo-renderer', 'ytd-merch-shelf-renderer', '#shopping-timely-shelf', 'yt-overlay-product-sticker',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    '.ytp-ad-overlay-container', '.ytp-ad-image-overlay', 'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytm-promoted-sparkles-web-renderer', 'ytm-companion-ad-renderer', 'ad-slot-renderer',
    '#shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)',
    '.ytp-suggested-action-badge',
  ];
  const style = doc.createElement('style');
  style.textContent = HIDE.map((s) => `${s} { display: none !important; }`).join('\n');
  const mountStyle = () => {
    if (!state.enabled || style.isConnected) return;
    const root = doc.head || doc.documentElement;
    if (root) root.appendChild(style);
  };

  // ---- in-stream ads ----------------------------------------------------------------------------------------------
  // YouTube inserts most ads client-side (getStatsForNerds().debug_info begins "USDAI"): each ad is its own clip in the
  // same <video> while #movie_player carries `ad-showing`; seeking the clip to its end clears it. Under server-stitched
  // ads ("SSAP, AD") the <video> holds ad and content as one timeline, so seeking it would skip the whole video: there
  // the player's own seekTo is used, only while the ad's progress and the video's clock agree (a pre-roll); a stitched
  // ad whose position is not the video clock is muted and left to end.
  let inAd = false;
  let mutedBefore = false;
  let lastAd = '';
  let waitingNoted = '';
  let adStartedAt = 0;
  const SIGNS = [
    ['ytd-enforcement-message-view-model', 'ad-blocker notice'],
    [['#movie_player', 'ytd-popup-container', 'tp-yt-paper-dialog', '#error-screen', 'yt-playability-error-supported-renderers']
      .map((c) => `${c} a[href*="support.google.com/youtube/answer/3037019"]`).join(', '), '"Experiencing interruptions?" link'],
  ];
  const call = (o, name) => { try { return o && typeof o[name] === 'function' ? o[name]() : undefined; } catch { return undefined; } };
  const playerVideo = () => {
    const player = doc.getElementById('movie_player') || doc.querySelector('.html5-video-player');
    return [player, player && (player.querySelector('video.html5-main-video') || player.querySelector('video'))];
  };
  // Tells this page load apart from the tab's next one, so the badge starts again at 0 after a reload.
  const RUN = Math.random().toString(36).slice(2, 10);
  const status = () => ({
    run: RUN, version: state.version, host: state.host, enabled: state.enabled, enforcement: state.enforcement,
    enforcementSign: state.enforcementSign || undefined, adsSkipped: state.adsSkipped,
    secondsSaved: Math.round(state.secondsSaved), adPlaying: state.adPlaying, adMode: state.adMode || undefined,
    lastAdMs: state.lastAdMs ? Math.round(state.lastAdMs) : undefined, log: state.log.slice(-8),
  });
  const report = () => emit('status', status());

  // The ad left the screen (or the skipper stopped): sound back, and how long the ad was up.
  const endAd = () => {
    const [, video] = playerVideo();
    if (inAd && video) video.muted = mutedBefore;
    inAd = false;
    if (state.adPlaying) {
      state.adPlaying = false;
      state.lastAdMs = now() - adStartedAt;
      note('ad gone', `${Math.round(state.lastAdMs)} ms on screen`);
      report();
    }
  };
  const watchEnforcement = () => {
    for (const [sel, what] of SIGNS) {
      if (doc.querySelector(sel)) {
        endAd();
        state.enforcement = true;
        state.enforcementSign = what;
        note('stopped', `YouTube shows its ${what}; the shield stands down and leaves it in place`);
        report();
        return true;
      }
    }
    return false;
  };
  // An ad counts once. The player can reload a clip that was already seeked (a new blob URL, the same ad near its end),
  // which shows up as a new key with under a second left: that is the same ad, seeked again but not counted again.
  const counted = (key, seconds, kind) => {
    if (key === lastAd) return;
    if (seconds < 1) { lastAd = key; return; }
    lastAd = key;
    state.adsSkipped++;
    state.secondsSaved += Math.max(0, seconds);
    note('ad skipped', `${Math.round(seconds)} s${kind === 'stitched' ? ' (stitched)' : ''}`);
    emit('skipped', { seconds: Math.max(0, Math.round(seconds * 10) / 10), kind });
    report();
  };
  const tick = () => {
    if (!state.enabled || state.enforcement || watchEnforcement()) return;
    const [player, video] = playerVideo();
    if (!player) return;
    const mode = String((call(player, 'getStatsForNerds') || {}).debug_info || '');
    const ssap = mode.startsWith('SSAP, AD');
    const showing = player.classList.contains('ad-showing') || ssap;
    if (!showing) {
      endAd();
      return;
    }
    if (!state.adPlaying) {
      state.adPlaying = true;
      state.adMode = mode.split(',')[0] || 'unknown';
      adStartedAt = now();
      report();
    }
    const begin = () => { if (!inAd) { inAd = true; mutedBefore = video ? video.muted : false; } if (video) video.muted = true; };
    if (mode.startsWith('SSAP')) {
      const p = call(player, 'getProgressState');
      begin();
      if (p && p.duration > 0 && video && Math.abs(p.current - video.currentTime) < 0.5 && p.current < p.duration - 0.25
          && typeof player.seekTo === 'function') {
        counted(`ssap ${Math.round(p.duration)}`, p.duration - p.current, 'stitched');
        player.seekTo(p.duration);
      } else if (waitingNoted !== mode) {
        waitingNoted = mode;
        note('ad muted', 'a stitched ad whose position is not the video clock: left to end');
      }
      return;
    }
    if (!video) return;
    const d = video.duration;
    const length = Number(((call(player, 'getPlayerResponse') || {}).videoDetails || {}).lengthSeconds) || 0;
    const skip = player.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button');
    if (!mode || !length || Math.abs(d - length) <= 1.5) {
      // The player did not say what is playing (a stitched timeline would look like a long "ad" here), there is no
      // length to compare with, or the clip is as long as the video itself: it may be the video. Never seek or mute it.
      if (skip) skip.click();
      return;
    }
    begin();
    if (Number.isFinite(d) && d > 0 && video.currentTime < d - 0.25) {
      counted(`${d.toFixed(2)}@${video.src}`, d - video.currentTime, 'client');
      video.currentTime = Math.max(0, d - 0.1);
    }
  };

  // Players and videos already hooked, kept here rather than as a property on YouTube's elements.
  const hooked = new WeakSet();
  const watch = () => {
    mountStyle();
    const [player] = playerVideo();
    if (player && !hooked.has(player)) {
      hooked.add(player);
      new MutationObserver(tick).observe(player, { attributes: true, attributeFilter: ['class'] });
    }
    const video = player && player.querySelector('video');
    if (video && !hooked.has(video)) {
      hooked.add(video);
      for (const ev of ['loadedmetadata', 'durationchange', 'playing', 'timeupdate']) video.addEventListener(ev, tick);
    }
    tick();
  };

  const setEnabled = (enabled) => {
    if (enabled === state.enabled) return;
    state.enabled = enabled;
    if (enabled) {
      mountStyle();
      note('on', 'switched on');
      tick();
    } else {
      endAd();
      style.remove();
      note('off', 'switched off');
    }
    report();
  };
  on('settings', (e) => {
    const s = read(e);
    if (s && typeof s.enabled === 'boolean') setEnabled(s.enabled);
  });
  on('hello', report);

  watch();
  setInterval(watch, 500);
  doc.addEventListener('yt-navigate-finish', watch);
  doc.addEventListener('DOMContentLoaded', watch);
  note('active', location.href);
  emit('ready', { version: VERSION });
  report();
})();
