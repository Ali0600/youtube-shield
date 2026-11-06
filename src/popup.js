// YouTube Shield popup: the on/off switch, this page's counts and the all-time totals. Everything shown is written with
// textContent: the status comes from a YouTube page.
const $ = (id) => document.getElementById(id);

const duration = (seconds) => {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

const setState = (kind, text, hint) => {
  $('state').dataset.kind = kind;
  $('state').textContent = text;
  $('hint').hidden = !hint;
  $('hint').textContent = hint || '';
};

const showStatus = (s, enabled) => {
  if (!s) {
    $('pageAds').textContent = '–';
    $('pageLabel').textContent = 'open a YouTube tab to see its count';
    setState(enabled ? 'idle' : 'off', enabled ? 'Not a YouTube tab' : 'Off everywhere');
    return;
  }
  $('pageAds').textContent = String(s.adsSkipped);
  $('pageLabel').textContent = s.adsSkipped === 1 ? 'ad skipped on this page' : 'ads skipped on this page';
  $('lastAd').textContent = s.lastAdMs ? `${(s.lastAdMs / 1000).toFixed(1)} s` : '–';
  $('pageSaved').textContent = s.secondsSaved ? duration(s.secondsSaved) : '–';
  if (!enabled || !s.enabled) {
    setState('off', 'Off: ads play as usual', 'Switch it back on, then reload the page to skip a pre-roll that already started.');
  } else if (s.enforcement) {
    setState('warn', 'YouTube showed its ad-blocker notice, so the shield stood down on this page.',
      'This shield blocks no requests. Another ad blocker in this Chrome profile (Adblock Plus, AdBlock, uBlock Origin ' +
      'Lite, AdGuard) is the usual trigger: switch it off for youtube.com and reload.');
  } else if (s.adPlaying) {
    setState('ok', `Skipping an ad${s.adMode === 'SSAP' ? ' (stitched into the video)' : ''}…`);
  } else {
    setState('ok', 'Watching for ads');
  }
  const log = $('log');
  log.replaceChildren(...s.log.slice().reverse().map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
  $('logBox').hidden = s.log.length === 0;
};

const load = async () => {
  const { enabled = true, totalAds = 0, totalSeconds = 0 } = await chrome.storage.local.get(['enabled', 'totalAds', 'totalSeconds']);
  $('enabled').checked = enabled !== false;
  $('total').textContent = totalAds ? `${totalAds} ads · ${duration(totalSeconds)}` : '–';
  let status = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && typeof tab.id === 'number') status = await chrome.tabs.sendMessage(tab.id, { type: 'get-status' }, { frameId: 0 });
  } catch { /* no page script in this tab: not YouTube */ }
  showStatus(status || null, enabled !== false);
};

$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  setTimeout(load, 150);
});

load();
setInterval(load, 1000);
