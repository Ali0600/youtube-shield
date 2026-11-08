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
- **Find out whether YouTube's 7 s display-override wait also happens when nothing skips** (2026-11-08). This is the
  decisive test of whether the shield provokes it. Run one profile and alternate the shield on and off per video,
  repeating the same videos, with ads fingerprinted by exact clip duration (or their ad video id, read passively), until
  each override-prone ad has ended naturally several times. Also add an arm that lets the ad play past its skip offset
  (about 5.3 s of media) before seeking: no arm got past about 2.8 s.
  **Ran 2026-11-08 for 2 hours, result inconclusive.** The run used `scripts/pod-lab.mjs --rotate
  off,userskip,seek,seekafter`, 82 loads plus 7 smoke loads, one fresh browser each.
  - The arms: `userskip` clicks Skip with trusted input, as a viewer would; `seekafter` seeks once the clip reaches
    5.5 s of media.
  - How ads were identified: by their own video id, from `getStatsForNerds().video_id_and_cpn`.
  - The decision rule: `scripts/pod-lab-rule.mjs`. Its thresholds are pinned by `tests/pod-lab-rule.test.js`, which
    was written before any rotation data. The module's operational clauses were finished after the first smoke load;
    none of them binds here.
  - Verdict: (C) inconclusive. Ads that trigger the wait were served 4 times in 89 loads (3 different ads), never to
    the shield-off arm. The wait followed 4 of 128 ad transitions (3 %), lasting 7.04–7.19 s each.
  - Both skeptics re-derived every count from the raw records and agreed.

  Also learned from that run:
  - A viewer's Skip on ad 1 of a 2-ad pod dropped the second ad too: 6 of 6, from 3 distinct ads in one session.
  - Up to 8 different ads share one exact duration, so the earlier duration-only labels are unreliable.
  - The next ad's identity does not drive the wait: an ad that followed two waits also followed other ads 9 times
    without one.

  Revisit hook: rerun the rotation over several sessions (`--loads`, `--minutes`) until the off arm has seen the
  wait-triggering ads end naturally at least 3 times. At this serving rate that is hundreds of loads.
- **Click the Skip button YouTube shows during the display-override wait** (2026-11-08). In that state `tick()` does
  nothing: `debug_info` has no `USDAI` prefix and the clip's duration is NaN. Run this only after the test above shows
  the shield causes the wait. A routine, scripted click on Skip for an ad that played 0 s is a new behavioural signal
  for YouTube; the existing click branch has never fired in any recorded run. Test it by interleaving click and
  no-click per override within one run (3–5 clicked overrides settle it against the fixed 7.0–7.2 s baseline). Check
  for detection over several days in a signed-in profile. Revisit hook: a branch in `tick()` guarded on the player's
  `ytp-ad-display-override` class and a non-finite clip duration.

## 2026-11-08: how and when to skip

Context: in the 2026-11-08 live runs, 11 of 33 ad breaks (all pods) stayed up 2.6–15 s. A lab (`scripts/pod-lab.mjs`)
ran 13 interleaved runs, one browser at a time: no shield, today's instant seek, 16× playback and delayed seeks.
Each run was timed at 100 ms with the network observed, and two independent skeptics re-derived the numbers.

- **Mute and seek the ad clip to its end at once**: kept. Single ads were on screen for a median 1.27 s, against 2.01
  s for 16× and 2.38 s for a 1.5 s delay. No variant reached the video sooner.
- **Fast-forward the ad at 16× instead of seeking**: rejected. YouTube reset the rate to 1 on every clip load (15 of
  15). A long ad stays up for its length / 16 (a 235 s ad stayed up 22.7 s). It met the display-override wait as
  often as seeking.
- **Seek only after the ad has been up 1.5 s or 3 s**: rejected. It adds about 1.1 s of visible ad per break, the video
  starts no sooner, and the override still happened with both delays. Its 0 overrides in 6 pods was ad mix: it was
  never served an override-prone ad.
- **Seek only once the ad reaches its skip point (5.5 s of media)**: rejected after the 2026-11-08 rotation.
  - It keeps every ad on screen, muted, about 5.5 s longer.
  - The 7 s wait still followed both wait-triggering ads it met (n=1 each, so by the rule this is inconclusive).
  - One of those ads only offered Skip at 10 s, so "the skip point" is not a fixed 5 s.
- **Try to start the video before YouTube's content gate**: rejected. YouTube's server holds the video back for most
  of the ad's length. The video was re-requested at the same time with the shield off and on, for each ad layout,
  within about 1 s (yt-dlp measured the gate at about 0.8 × the ad's length). Getting the video earlier than YouTube
  allows would be evading its ad enforcement, which is out of scope.

What the stall is, as far as the data shows:
- In a pod, the 7 s gap is YouTube's `ytp-ad-display-override` state: 7.0–7.2 s every time (n=11), no clip attached,
  no media in flight, the next clip requested only at its end.
- It followed specific ads every time they were served (all-or-nothing per exact clip duration), and never the common
  20.02 s skippable ad (0 of 22).
- The first analysis read it as "ads of 17.5 s or more, 20–30% of the time". The skeptics showed that was the ad mix:
  the threshold was set after seeing the data, and the transitions were not independent.
- Seeking also costs one extra media request per ad→ad switch: about 0.2–0.3 s, small.

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
