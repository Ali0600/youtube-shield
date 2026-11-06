// YouTube Shield bridge. Chrome runs it in the extension's isolated world beside src/page.js, at document_start in every
// YouTube page and embedded player. It carries the on/off setting to the page script, and the page script's status and
// skips to the service worker, through DOM events whose payloads are JSON strings (the protocol is in src/page.js).
// The page can dispatch those events too, so everything read from them is type-checked and bounded here.
(() => {
  const EVENT = 'youtube-shield';
  const SIGNS = new Set(['ad-blocker notice', '"Experiencing interruptions?" link']);
  let enabled = true;
  let last = null;

  const send = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* the extension was reloaded or removed: this copy is orphaned and stays quiet */ }
  };
  const read = (e) => {
    try { return typeof e.detail === 'string' ? JSON.parse(e.detail) : null; } catch { return null; }
  };
  const count = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : 0);
  const fire = (name, payload) => {
    document.dispatchEvent(new CustomEvent(`${EVENT}:${name}`, payload === undefined ? undefined : { detail: JSON.stringify(payload) }));
  };
  const pushSettings = () => fire('settings', { enabled });

  // Only the fields the popup shows, each with its type checked and its size bounded.
  const clean = (s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    return {
      run: typeof s.run === 'string' ? s.run.slice(0, 16) : '',
      enabled: s.enabled !== false,
      enforcement: s.enforcement === true,
      enforcementSign: SIGNS.has(s.enforcementSign) ? s.enforcementSign : undefined,
      adsSkipped: count(s.adsSkipped, 100000),
      secondsSaved: count(s.secondsSaved, 10000000),
      adPlaying: s.adPlaying === true,
      adMode: typeof s.adMode === 'string' && /^[A-Za-z]{1,12}$/.test(s.adMode) ? s.adMode : undefined,
      lastAdMs: count(s.lastAdMs, 3600000) || undefined,
      log: Array.isArray(s.log) ? s.log.filter((l) => typeof l === 'string').slice(-8).map((l) => l.slice(0, 160)) : [],
    };
  };

  document.addEventListener(`${EVENT}:status`, (e) => {
    const s = clean(read(e));
    if (!s) return;
    last = s;
    send({ type: 'status', status: s });
  });
  document.addEventListener(`${EVENT}:skipped`, (e) => {
    const s = read(e);
    // Number.isFinite never coerces: "12", null and true are refused as they are (Number(null) would be a 0 s skip).
    const seconds = s && typeof s === 'object' ? s.seconds : undefined;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return;
    send({ type: 'skipped', seconds });
  });
  // The page script announces itself when it starts; whichever of the two runs second, the setting still arrives.
  document.addEventListener(`${EVENT}:ready`, pushSettings);

  chrome.storage.local.get({ enabled: true }).then((v) => {
    enabled = v.enabled !== false;
    pushSettings();
    fire('hello');
  }, () => fire('hello'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    pushSettings();
  });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === 'get-status') reply(last);
  });
})();
