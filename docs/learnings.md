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
