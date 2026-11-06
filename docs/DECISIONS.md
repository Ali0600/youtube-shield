# Decisions

## Backlog: alternatives worth trying later

- **Prune ads from the player's responses before the player sees them** (uBlock Origin's approach, 2026-11-06). This
  is the only way an ad never loads at all. It is the main road not taken; see "How ads are removed" for why. Revisit
  hook: a separate `src/prune.js` content script (MAIN world, `document_start`) behind an opt-in switch in the popup
  that is off by default. Pair it with an e2e arm that watches for YouTube's notice and the "fake buffering" signature
  (`buffer_health_seconds "0.00 s"`, `resolution "0x0"`).
- **Skip a stitched (`SSAP`) mid-roll.** Today it is muted and left to end. AdGuard's 2026 filter reads the stitched
  ad's start and end from cue objects (`namespace: 'ssap'`), but only by wrapping `Array.prototype.push`, a patch this
  extension refuses. SponsorBlock's patch-free check (`player.getCurrentTime()` against `video.currentTime`) can tell
  a stitched timeline apart. Revisit hook: the `SSAP` branch of `tick()` in `src/page.js`, once a live run captures a
  stitched mid-roll (none has appeared yet).
- **Skip Shorts ads instead of hiding the reel.** Shorts play in `#shorts-player`, so `ad-showing` never fires there.
  Revisit hook: a watcher on `ytd-reel-video-renderer[is-active]` that contains `ytd-ad-slot-renderer`.

## 2026-11-06: how ads are removed

Context: the mainstream blockers (Adblock Plus, AdBlock, uBlock Origin) "don't work on YouTube" for the owner.
Research on 2026-11-06 found that uBlock Origin Lite, AdGuard and uBlock Origin all have open "ads slip through" or
"fake buffering" reports from October and November 2026.

- **Skip each ad as it starts: mute it, seek the clip to its end, give the sound back**: chosen. It is carried from
  claude-browser-shield, which measured it on 2026-10-26, and it was measured again here: 4 of 4 pre-rolls cleared in
  0.3 to 1.6 s against a control. Nothing is blocked and nothing is patched, so there is little for YouTube to detect.
- **Prune `adPlacements`, `adSlots` and `playerAds` from responses, or edit the outgoing player request** (uBlock
  Origin's rules as of 2026-11-02): deferred, see the backlog. It needs wrapped `fetch`/`XHR`/`JSON.parse` or
  `Promise.prototype.then`. YouTube reads natives from a sandboxed iframe to spot such wrappers, and the October 2026
  "fake buffering" reports follow blockers that do this.
- **Block ad requests with `declarativeNetRequest`**: rejected. YouTube's ads come from its own hosts, and blocking
  `ad_status.js`-style bait is a known detection trigger. A test pins the manifest to `storage` only.
- **Speed the ad up (`playbackRate = 16`)**: rejected for client-side ads, because seeking is faster. It is unproven
  against stitched ads: the only claim found is a vendor's.

## 2026-11-06: what happens at YouTube's ad-blocker notice

- **Stand down for the rest of the page, give the sound back, never hide the notice**: chosen. It is carried from
  claude-browser-shield, where evading YouTube's detection is out of scope. The popup explains that another blocker
  in the profile is the usual trigger.
- **Hide the notice or the "Experiencing interruptions?" snackbar** (uBlock Origin does this): rejected, same reason.

## 2026-11-06: how the page script talks to the extension

- **`youtube-shield:*` CustomEvents on `document`, JSON-string payloads, no globals**: chosen. MAIN-world code cannot
  use `chrome.*`, and a `window.__youtubeShield` like the one in claude-browser-shield would be something for YouTube
  to look for. The bridge type-checks every field because the page can dispatch the same events.
- **`window.postMessage`**: rejected. It is visible to every script and frame on the page, with the same forgery
  risk and wider reach.
- **Toggling by registering and unregistering content scripts (`chrome.scripting`)**: rejected. It needs the
  `scripting` permission and a reload to take effect; the event switch works on the live page.

## 2026-11-06: how it is tested live

- **Playwright's Chromium with `--load-extension`, two arms (shield off as control, shield on) on the same videos,
  fresh profiles**: chosen. Google Chrome has ignored `--load-extension` since 142 (Chromium commit 04f6233). Without
  a control showing ads, "no ads seen" would prove nothing.
- **Masking automation** (`--disable-blink-features=AutomationControlled`, user-agent rewriting): rejected. It is
  bot-detection evasion, and it was not needed. Every video paused about 1 s in until the frames were read: the
  cause was YouTube's in-page EU consent dialog, not automation. The harness now answers it with "Reject all".
