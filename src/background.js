// YouTube Shield service worker: the toolbar badge (ads skipped on the tab's current page, "!" when YouTube shows its
// ad-blocker notice) and the all-time totals in chrome.storage.local. It never touches a request.
//
// Each frame running the page script reports its own status (the watch page, and any embedded player); the badge is the
// sum over the tab's frames. A status from the top frame with a new run id means the tab loaded a new page, so the
// frames of the old page are dropped.
const tabs = new Map(); // tabId -> { run, frames: Map(frameId -> { adsSkipped, enforcement }) }

const badgeFor = (entry) => {
  let ads = 0;
  let enforcement = false;
  for (const f of entry.frames.values()) {
    ads += f.adsSkipped;
    enforcement = enforcement || f.enforcement;
  }
  if (enforcement) return { text: '!', color: '#b45309' };
  return { text: ads > 0 ? String(Math.min(ads, 999)) : '', color: '#4338ca' };
};

const onStatus = (tabId, frameId, s) => {
  let entry = tabs.get(tabId);
  if (!entry || (frameId === 0 && s.run && s.run !== entry.run)) {
    entry = { run: frameId === 0 ? s.run : entry ? entry.run : '', frames: new Map() };
    tabs.set(tabId, entry);
  }
  entry.frames.set(frameId, { adsSkipped: s.adsSkipped, enforcement: s.enforcement });
  const badge = badgeFor(entry);
  chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
};

// Totals are read, added to and written one skip at a time, so two frames skipping at once both count.
let queue = Promise.resolve();
const addSkip = (seconds) => {
  queue = queue.then(async () => {
    const t = await chrome.storage.local.get({ totalAds: 0, totalSeconds: 0 });
    await chrome.storage.local.set({ totalAds: t.totalAds + 1, totalSeconds: t.totalSeconds + seconds });
  }).catch(() => {});
  return queue;
};

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only our own content scripts, in a tab: never the popup, never another extension.
  if (!msg || !sender || sender.id !== chrome.runtime.id || !sender.tab || typeof sender.tab.id !== 'number') return;
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  if (msg.type === 'status' && msg.status && typeof msg.status === 'object') {
    onStatus(sender.tab.id, frameId, {
      run: typeof msg.status.run === 'string' ? msg.status.run : '',
      adsSkipped: Number.isFinite(msg.status.adsSkipped) ? msg.status.adsSkipped : 0,
      enforcement: msg.status.enforcement === true,
    });
  } else if (msg.type === 'skipped' && Number.isFinite(msg.seconds) && msg.seconds >= 0 && msg.seconds <= 3600) {
    addSkip(msg.seconds);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

// Exposed for the unit tests (tests/background.test.js), which load this file into a stub.
globalThis.__youtubeShieldBackground = { tabs, badgeFor, addSkip, flush: () => queue };
