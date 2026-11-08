# Learnings

### Chrome extensions run content scripts in two worlds

A content script runs in an "isolated world" by default: it sees the same DOM as the page, but not the page's
JavaScript objects. With `"world": "MAIN"` (Chrome 111+), it runs in the page's own world instead and loses
`chrome.*`.

**Why it came up:** the skipper needs YouTube's player methods (`getStatsForNerds`, `seekTo`), which exist only as
JavaScript properties on `#movie_player`. An isolated script sees the element but not those methods. So `page.js`
runs in MAIN and `bridge.js` stays isolated to reach `chrome.storage`. The two talk through DOM events, carrying JSON
strings, which cross worlds safely.

**Takeaway:** split an extension at the world boundary: page-object work in MAIN, `chrome.*` in isolated, and a
string-only event channel between them that treats every message as page-forgeable.

### Google Chrome ignores `--load-extension`; test unpacked extensions in Chromium

Branded Chrome no longer honours the switch: Chromium commit 04f6233, first in 142, removed the last way to turn it
back on. It prints "--load-extension is not allowed in Google Chrome, ignoring." and starts without the extension.

**Why it came up:** the live test has to load this folder into a real browser. Playwright's bundled Chromium (or
Chrome for Testing) still honours the flag, and `launchPersistentContext` exposes the extension's service worker for
setting its storage.

**Takeaway:** automate extension tests in Chromium or Chrome for Testing. In Google Chrome, load by hand with
Developer mode → Load unpacked.

### A modal in the test browser looks like the system under test failing

YouTube showed an EU cookie-consent dialog over the watch page, and while it was open, every video paused about a
second in.

**Why it came up:** both arms (shield off and on) stalled the same way. That nearly went into the docs as "YouTube
stops automated browsers". A screenshot of the frame showed the dialog. Answering it ("Reject all") let videos play
12 to 21 s in the 25 s window.

**Takeaway:** an anomaly shared by the control and the treatment belongs to the environment. Look at the whole frame
before naming a cause.

### `Number(null)` is 0, so coerce-then-check lets `null` through

`Number.isFinite(Number(x))` accepts `null`, `""`, `false` and `[]` as 0. `Number.isFinite(x)` on the raw value
never coerces and refuses them all.

**Why it came up:** the bridge forwarded `{"seconds": null}` from the page as a real 0-second skip. A unit test with
`null` among its bad inputs caught it. Later, the mutation check showed an extra `typeof x === 'number'` guard was
redundant with `Number.isFinite(x)`, and it was dropped.

**Takeaway:** validate untrusted numbers with `Number.isFinite` on the raw value, never after `Number()`.

### A mutation check finds tests that cannot fail

Plant each bug a guard exists to stop, in a copy of the repo, and require a named test to go red.

**Why it came up:** the first run caught 21 of 23 mutants. The 2 survivors were real gaps. One guard was redundant.
One test asserted the last setting sent, which looked the same whether or not the setting was re-sent, so it could
not see the re-send removed.

**Takeaway:** a guard whose mutant survives either has no test that can see it break, or isn't needed.

### A check that causes the value it reads proves nothing about the code meant to cause it

If the instrument writes, refreshes or toggles the thing it then reads, a reading can only show the instrument worked.

**Why it came up:** the first live popup check read the page's status by sending `youtube-shield:hello`, which makes
the page report. The bridge caches each report, and the popup shows that cache, so every read refreshed what the
popup was about to show. The switch had the same trap: right after a click, `checked` is the click's own toggle, and
before any click it is popup.html's default. A reviewer showed the line binding the switch to storage could be
deleted and the check still passed. Now an init script records each status the page sends on its own, the page is
reloaded first, and the popup is reopened with no click after each flip. Deleting `report()` from the page's switch
handler, or the switch-from-storage line, now turns the live check red.

**Takeaway:** read passively, and read the result where your own action cannot have put it (a fresh load, a reopened
view, a second reader).

### "It became true" is not "it stays true"

A wait-until-true check returns at the first good reading, so a state that only flickers passes.

**Why it came up:** `page.js` re-mounts its stylesheet every 500 ms. With its `!state.enabled` guard removed, the
shield switched off and then hid ads again by itself; the first check caught that in 1 of 2 runs (the reviewer's
count). Now every outcome must hold for 2 s, longer than the 500 ms re-mount and the popup's 1 s re-read. The planted
bug went red in 2 of 2 runs. Both times no clean reading arrived at all; the hold is what turns a lucky reading in
the gap into a red one.

**Takeaway:** after a state settles, require it to hold for longer than the slowest loop that could undo it.

### Skipping an ad does not make YouTube send the video sooner

YouTube's server holds back the video's own media for most of the ad's length. Whatever happens to the ad on screen,
the video's media is not sent before then.

**Why it came up:** after a skip, the video often sat loaded but frozen for 6–12 s. In the lab, the video's media was
re-requested at the same moment with the shield off and on, for each ad layout, within about 1 s. yt-dlp's developers
measured the same wait in 2025 at about 0.8 × the ad's length. So the shield takes the ad off screen in about a second,
but after a 10–15 s ad that can't be skipped, the video starts only about 2.5–4 s sooner.

**Takeaway:** measure "the thing went away" and "the thing you wanted arrived" as separate numbers. The second can be
gated somewhere you don't control.

### When the environment picks the treatment unit, per-arm rates measure the mix

When each run gets a different random draw of what it is tested on (here, which ads YouTube serves), a per-arm
rate compares the draws, not the arms.

**Why it came up:** one delayed-skip strategy showed 0 of 6 YouTube 7 s waits against 4 of 16 for the instant skip, and
looked like a partial fix. A skeptic matched the ads by exact clip duration. That delayed arm had only been served ads
that never caused the wait in any arm, while each ad that did cause it did so every time it was served. The first
analysis's "ads of 17.5 s or more, 20–30% of the time" had the same flaw: the threshold was chosen after seeing the
data, and transitions within one pod were counted as independent.

**Takeaway:** identify the unit the environment varies (here, which ad), stratify or interleave by it, fix thresholds
before looking, and count clustered events once per cluster.
