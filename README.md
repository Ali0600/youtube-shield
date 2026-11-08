# YouTube Shield

A Chrome extension that skips YouTube ads the moment they start and hides YouTube's display ads, without blocking a
single YouTube request. Most blockers stop ads by blocking or rewriting YouTube's own requests, and YouTube now
detects that. This one lets the ad load, mutes it, and jumps it to its end, usually in well under a second. It patches
no built-in function and leaves nothing on the page for YouTube to find.

It is the Chrome version of the YouTube part of
[claude-browser-shield](https://github.com/Ali0600/claude-browser-shield): the same skipper, running in every YouTube
tab from the first moment of the page instead of when an agent starts it.

Measured live on 2026-11-06 (`npm run e2e`, Chromium 145, fresh profiles, Germany). The same 4 videos were played in
two arms:

| | Shield off (control) | Shield on |
|---|---|---|
| Videos that opened with an ad | 4 of 4 | 4 of 4 |
| Time the ad stayed on screen | 15 s, 15 s, two still up after 25 s | 0.3 s, 0.4 s, 1.5 s and 1.6 s (pods of 2–3 ads) |
| Video played in the first 25 s | 9.4 s, 9.6 s, 0 s, 0 s | 12.5 to 20.8 s, with sound |
| Display-ad slots visible on a search page | 2 | 0 |

YouTube showed no ad-blocker notice, and every built-in it can check was still native.

The live run above was in Playwright's Chromium. The shield also ran in an everyday, signed-in Chrome 156 profile on
2026-11-07: there it skipped its first 3 ads (36 s of ads) within minutes of being loaded, read from its saved totals.

## Install

Chrome doesn't load an extension from a folder unless you turn on Developer mode:

1. Get the folder: `git clone https://github.com/Ali0600/youtube-shield.git` (or download the ZIP and unpack it).
2. Open `chrome://extensions`.
3. Switch on **Developer mode** (top right).
4. Click **Load unpacked** and pick the cloned folder (the one holding `manifest.json`).
5. Pin the extension to the toolbar (puzzle icon → pin) to see its count.

**Turn off your other ad blockers on youtube.com** (Adblock Plus, AdBlock, uBlock Origin Lite, AdGuard, and Poper
Blocker, whose YouTube feature rewrites the player's requests and hides `#player-ads`). They block or rewrite YouTube's
requests, which is what makes YouTube show its "Ad blockers are not allowed" notice. When that
notice appears, this shield stands down for the page and says so in its popup.

Chrome keeps an unpacked extension across restarts. After `git pull`, press the reload arrow on its card in
`chrome://extensions`, then reload any open YouTube tabs.

## Use

Just watch YouTube. The toolbar badge counts the ads skipped on the current page and shows **!** if YouTube shows its
ad-blocker notice. The popup has:

- an on/off switch;
- the count for this page, the time the last ad stayed on screen, and an all-time total;
- what the shield did on this page.

To check it yourself, open a popular music video in a fresh window. A pre-roll flashes for a moment and the video
starts with its sound on.

## How it works

```text
YouTube page (MAIN world)                    Extension (isolated world)               Service worker
src/page.js ── youtube-shield:* DOM events ──▶ src/bridge.js ── runtime messages ──▶ src/background.js
  skip in-stream ads, hide display ads   ◀──── on/off from chrome.storage            badge, all-time totals
  stand down at YouTube's notice                                                     src/popup.* reads both
```

- **In-stream ads.** `#movie_player` carries `ad-showing` while an ad plays. The player's own
  `getStatsForNerds().debug_info` says how the ad is delivered:
  - **`USDAI`** (client-side, which is what YouTube served in every live run): the ad is its own clip in the same
    `<video>`. The shield mutes it, seeks it to 0.1 s before its end, and gives the sound back when it is gone.
  - **`SSAP, AD`** (stitched into the video's own stream): seeking the `<video>` would skip the whole video. The shield
    uses the player's `seekTo`, and only when the ad's clock and the video's agree (a pre-roll). uBlock Origin's live
    rule (2026-11-02) does the same.
  - **Neither:** if the player does not say what is playing, or the clip is as long as the video itself, the shield
    never seeks or mutes it. It presses the skip button instead.
- **Display ads.** One stylesheet hides EasyList's and AdGuard's YouTube ad renderers: feed, search, masthead,
  companion, Shorts ad reels and product badges. It never hides `#player-ads`, which uBlock Origin and AdGuard leave
  visible on purpose because YouTube checks it.
- **YouTube's notice.** On `ytd-enforcement-message-view-model`, or on the "Experiencing interruptions?" link inside
  the player, the shield stands down for the rest of the page and gives the sound back. It never hides the notice.
- **Nothing to detect.** The page script runs in YouTube's world because the player's methods live there. It takes
  references to the natives it needs before YouTube's code runs and replaces none of them. It talks to the extension
  only through `youtube-shield:*` events on `document`, so nothing is left on `window`. The manifest asks only for
  `storage`. It has no network rules and no web-accessible resources, so a page cannot fetch a file to find it.

Not covered:

- a stitched (`SSAP`) mid-roll is muted and left to play out;
- Shorts ads are hidden as whole reels, not skipped;
- YouTube Music gets the skipper but has had no live run;
- a page can undo anything the page script does (it is not a security boundary).

## Layout

| Path | What |
|---|---|
| `manifest.json` | Manifest V3: two content scripts (YouTube hosts only), the service worker, the popup |
| `src/page.js` | The skipper and the display-ad stylesheet, in YouTube's own world |
| `src/bridge.js` | Settings in, status and skips out; type-checks everything a page could forge |
| `src/background.js` | Toolbar badge per tab (summed over embedded players) and all-time totals |
| `src/popup.*` | The popup |
| `icons/` | Generated by `scripts/make-icons.mjs` (zero-dependency PNG writer); a test pins them to it |
| `tests/` | `node --test` suites against stub pages and stub `chrome.*` APIs; `mutants.json` for the mutation check |
| `scripts/e2e.mjs` | The live control-vs-shield run on real YouTube |
| `scripts/mutation-check.mjs` | Plants each bug in `tests/mutants.json` in a copy and requires its named test to fail |
| `docs/` | `DECISIONS.md`, `learnings.md` |

## Develop

```bash
npm install          # playwright-core only, for the live run; the extension itself has no dependencies
npm test             # 31 unit tests, under a second
npm run mutants      # 23 planted bugs, each must turn a named test red (about a minute)
npm run e2e          # live: control vs shield on 4 videos (about 5 minutes; reports/ is git-ignored)
```

The live run needs Playwright's Chromium (`npx playwright install chromium`, or set `YTS_CHROMIUM`): Google Chrome
has ignored `--load-extension` since version 142. The window opens off-screen; add `--visible` to watch it.

## Experience Gained

- Built a Manifest V3 Chrome extension that splits its work across Chrome's two script worlds: a skipper in the page's
  own world that replaces none of its 10 checked built-ins, and an isolated bridge that type-checks and bounds every
  field a page could forge. It needs 1 permission (`storage`) and no network rules.
- Measured it live against a control on real YouTube: ads cleared in 0.3 to 1.6 s with the shield, versus 15 s and
  more without it, on 4 of 4 videos; display-ad slots went from 2 visible to 0.
- Built the end-to-end harness on Playwright with fresh throwaway profiles per arm. Reading the frames found that an
  in-page EU consent dialog was what paused every video, which kept a wrong bot-detection theory out of the docs.
- Covered the logic with 31 `node --test` cases against stub DOM and `chrome.*` APIs, plus a mutation harness of 23
  planted bugs that each must turn a named test red. Its first run caught 2 survivors (a redundant guard and a test
  that could not see a re-sent setting).
- Generated the icons with a zero-dependency PNG encoder (`zlib` deflate and CRC-32, supersampled shapes), pinned
  byte-for-byte by a test.

## Licence

MIT (`LICENSE`).
