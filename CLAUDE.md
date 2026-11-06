# youtube-shield — agent contract

## Gate (run before every commit)

```bash
npm test && node scripts/make-icons.mjs --check
```

After changing a guard in `src/` or `manifest.json`, also run `npm run mutants`. Add a mutant to `tests/mutants.json` for any
new guard: each one must turn a named test red. A mutant's `old` is exact source text that must occur exactly once, so
after editing a line a mutant targets, rerun `npm run mutants` (it refuses a mutant whose text no longer matches).

After changing `src/page.js` (the skipper or the stylesheet), run the live check and read its verdict lines:

```bash
npm run e2e
```

It takes about 5 minutes. It is only evidence if the control arm showed ads. It prints `PASS`/`FAIL` and writes
`reports/e2e-*.json` (git-ignored, with a per-second timeline per video).

## Rules

- **Never block, rewrite or delay a YouTube request, and never replace a built-in function in `src/page.js`.** YouTube
  checks for both (it reads natives from a sandboxed iframe). That is how request-blocking ad blockers get caught.
  Tests pin it: `manifest.json` has no network rules, and the page script leaves `window`, `document` and the
  natives untouched.
- **Never hide YouTube's ad-blocker notice, and never hide `#player-ads`.** At the notice the shield stands down for
  the page. `#player-ads` stays visible because uBlock Origin and AdGuard un-hide it on purpose. Evading YouTube's
  detection is out of scope (`docs/DECISIONS.md`).
- **Never seek the `<video>` unless the player says the ad is client-side** (`debug_info` present and not `SSAP`)
  and the clip is not as long as the video. Under stitched ads, `<video>.duration` covers the whole video.
- **Everything from a `youtube-shield:*` event is page-controlled.** Type-check and bound it in `src/bridge.js`, and
  render it with `textContent` only.
- **The live run never masks automation** (no `--disable-blink-features`, no user-agent rewriting). It answers
  YouTube's EU consent dialog with "Reject all" only.
- **The icons are generated**: change `scripts/make-icons.mjs` and rerun it. Never hand-edit the PNGs.
- Load the extension with Developer mode → Load unpacked. Google Chrome ignores `--load-extension` (since 142), so the
  live run uses Playwright's Chromium.
