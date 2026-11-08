// The pre-registered decision rule for the pod lab's rotation (scripts/pod-lab.mjs --rotate / --aggregate), as pure
// functions over transition records, so a test can pin it (tests/pod-lab-rule.test.js). Fixed on 2026-11-08 before any
// rotation data existed; implement what it needs, never change its thresholds after seeing data.
//
// Question: does YouTube's ytp-ad-display-override wait (7.0-7.2 s, no clip attached) also happen without the shield?
// Unit: an ad = its own video id when known, else its exact clip duration to 3 decimals (two ids with one duration are
// two ads). A transition = the end of one ad clip followed by the next clip or the content; each counts once, and the
// breaks they came from are counted too.
// An ad is OVERRIDE-PRONE if the override (>= 6.5 s) followed it at least once in ANY arm. Per override-prone ad:
//   (A) "YouTube does it without the shield": the override followed it at least once in arm off or arm userskip.
//   (B) "The shield provokes it": the override followed it in arm seek in >= 3 transitions, AND it ended naturally in
//       arm off in >= 3 transitions with 0 overrides, AND (if it is skippable) a landed viewer click ended it in arm
//       userskip in >= 3 transitions with 0 overrides.
//   (C) "Inconclusive" otherwise, naming the missing counts.
// Overall: (A) if any override-prone ad meets (A); else (B) if at least 2 override-prone ads meet (B); else (C).
// Seek-after arm: "avoids it" only if every ad meeting (B) has >= 3 seek-after transitions with 0 overrides; "does not
// avoid it" if the override followed any such ad in arm seekafter; else inconclusive.
// A viewer click during an override is reported only as numbers (ms to the next clip after the click, against the
// 7.0-7.2 s baseline), and only with n >= 3 is anything said about it.
//
// How the lab's records meet the rule (the operational choices, stated once):
//   - an override counts when its class was present for >= 6.5 s, or when the lab's viewer clicked Skip during it
//     (the state was entered before any click; the click can only shorten it). A shorter, unclicked one is not counted;
//   - a transition counts when the next clip or the content came within the watch, or when a counted override was
//     seen (an ad whose end the watch never saw is no transition);
//   - "skippable" is true once a Skip button was seen visible (or clicked) during the ad in any arm, false once the ad
//     played to its natural end or 8 s of media without one, and unknown otherwise; an unknown ad cannot meet (B).

export const RULE = Object.freeze({
  overrideMinMs: 6500, // the override must last this long to count, unless the viewer clicked during it
  minN: 3, // the per-ad count every (B) and seek-after condition needs
  minAdsForB: 2, // override-prone ads meeting (B) for the overall (B)
  shieldFree: Object.freeze(['off', 'userskip']),
  baselineMs: Object.freeze([7000, 7200]), // the override's measured length before the rotation (n=11)
});

export const adKey = (t) => (t.vid ? t.vid : typeof t.dur === 'number' && Number.isFinite(t.dur) ? `dur:${t.dur.toFixed(3)}` : null);
export const isOverride = (t) => Boolean(t.override) && (Number(t.overrideMs) >= RULE.overrideMinMs || Boolean(t.overrideClicked));
export const counts = (t) => t.to != null || isOverride(t);

const emptyArm = () => ({ n: 0, overrides: 0, breaks: [], ends: {}, overrideMs: [] });

// Per ad (key) and arm: transitions, the breaks they came from, overrides, and how each ended (with overrides per end).
export function tabulate(transitions) {
  const ads = new Map();
  for (const t of transitions) {
    const key = adKey(t);
    if (!key || !counts(t)) continue;
    let ad = ads.get(key);
    if (!ad) { ad = { key, vid: t.vid || null, durs: [], skippable: null, arms: {} }; ads.set(key, ad); }
    if (typeof t.dur === 'number' && !ad.durs.includes(t.dur)) ad.durs.push(t.dur);
    if (t.skippable === true) ad.skippable = true;
    else if (t.skippable === false && ad.skippable == null) ad.skippable = false;
    const arm = (ad.arms[t.arm] ??= emptyArm());
    arm.n++;
    if (!arm.breaks.includes(t.breakId)) arm.breaks.push(t.breakId);
    const ov = isOverride(t);
    if (ov) { arm.overrides++; arm.overrideMs.push(t.overrideMs); }
    const end = (arm.ends[t.end] ??= { n: 0, overrides: 0 });
    end.n++;
    if (ov) end.overrides++;
  }
  return ads;
}

// Apply the rule to a tabulate() result.
export function decide(ads) {
  const { minN } = RULE;
  const verdicts = [];
  for (const ad of ads.values()) {
    const arm = (name) => ad.arms[name] || emptyArm();
    const total = Object.values(ad.arms).reduce((s, a) => s + a.overrides, 0);
    if (!total) continue; // not override-prone
    const free = RULE.shieldFree.reduce((s, name) => s + arm(name).overrides, 0);
    const missing = [];
    let outcome;
    if (free >= 1) outcome = 'A';
    else {
      const seek = arm('seek');
      const offNatural = arm('off').ends.natural || { n: 0, overrides: 0 };
      const viewerSkips = arm('userskip').ends['viewer-skip'] || { n: 0, overrides: 0 };
      if (seek.overrides < minN) missing.push(`seek: the override after ${seek.overrides} transition(s), needs ${minN}`);
      if (offNatural.n < minN || offNatural.overrides) missing.push(`off: ${offNatural.n} natural end(s), needs ${minN} with 0 overrides`);
      if (ad.skippable === true && (viewerSkips.n < minN || viewerSkips.overrides)) {
        missing.push(`userskip: ${viewerSkips.n} end(s) by a landed viewer click, needs ${minN} with 0 overrides`);
      }
      if (ad.skippable == null) missing.push('skippable or not: unknown (no Skip button seen, and it never played to its end or 8 s)');
      outcome = missing.length ? 'C' : 'B';
    }
    verdicts.push({ key: ad.key, vid: ad.vid, durs: ad.durs, skippable: ad.skippable, outcome, missing });
  }
  const overall = verdicts.some((v) => v.outcome === 'A') ? 'A'
    : verdicts.filter((v) => v.outcome === 'B').length >= RULE.minAdsForB ? 'B' : 'C';
  const bAds = verdicts.filter((v) => v.outcome === 'B').map((v) => ads.get(v.key));
  let seekafter;
  if (!bAds.length) seekafter = { verdict: 'inconclusive', why: 'no override-prone ad meets (B)' };
  else if (bAds.some((ad) => (ad.arms.seekafter || emptyArm()).overrides > 0)) {
    seekafter = { verdict: 'does not avoid it', why: `the override followed ${bAds.filter((ad) => (ad.arms.seekafter || emptyArm()).overrides > 0).map((ad) => ad.key).join(', ')} in arm seekafter` };
  } else {
    const short = bAds.filter((ad) => ((ad.arms.seekafter || emptyArm()).ends['seek-after'] || { n: 0 }).n < minN);
    seekafter = short.length
      ? { verdict: 'inconclusive', why: short.map((ad) => `${ad.key}: ${((ad.arms.seekafter || emptyArm()).ends['seek-after'] || { n: 0 }).n} seek-after transition(s), needs ${minN}`).join('; ') }
      : { verdict: 'avoids it', why: `every (B) ad has >= ${minN} seek-after transitions with 0 overrides` };
  }
  return { overall, ads: verdicts, seekafter };
}

// Viewer clicks during an override, as numbers only, against the baseline (and the unclicked overrides in the same data).
export function overrideClicks(transitions) {
  const clicked = transitions.filter((t) => t.override && t.overrideClicked).map((t) => ({
    key: adKey(t), arm: t.arm, clickIntoMs: t.clickIntoOverrideMs ?? null, clickToNextMs: t.clickToNextMs ?? null,
    clickToOverrideEndMs: t.clickToOverrideEndMs ?? null, overrideMs: t.overrideMs ?? null,
  }));
  const unclicked = transitions.filter((t) => isOverride(t) && !t.overrideClicked && !t.overrideOpen).map((t) => t.overrideMs);
  const n = clicked.length;
  let claim = `n=${n} (< ${RULE.minN}): no claim`;
  if (n >= RULE.minN) {
    const lens = clicked.map((c) => c.overrideMs).filter((x) => typeof x === 'number');
    const [lo, hi] = RULE.baselineMs;
    const early = lens.filter((x) => x < lo - 100).length;
    const same = lens.filter((x) => x >= lo - 100 && x <= hi + 100).length;
    claim = `n=${n}: the override lasted ${fmtRange(lens)} with a click (baseline ${lo / 1000}-${hi / 1000} s): ` +
      `${early} ended before ${(lo - 100) / 1000} s, ${same} within the baseline, ${lens.length - early - same} other`;
  }
  return { n, clicked, unclickedMs: unclicked, claim };
}

const fmtS = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '?');
function fmtRange(xs) {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return '-';
  return v.length === 1 ? fmtS(v[0]) : `${fmtS(v[0])}-${fmtS(v.at(-1))} (median ${fmtS(v[Math.floor(v.length / 2)])})`;
}

// The aggregate as text: one line per ad (override-prone ones first), then the verdicts.
export function formatAggregate(ads, verdict, clicks, armOrder) {
  const lines = [];
  const prone = new Set(verdict.ads.map((v) => v.key));
  const rows = [...ads.values()].sort((a, b) => Number(prone.has(b.key)) - Number(prone.has(a.key))
    || Object.values(b.arms).reduce((s, x) => s + x.n, 0) - Object.values(a.arms).reduce((s, x) => s + x.n, 0));
  const arms = [...new Set([...armOrder, ...rows.flatMap((r) => Object.keys(r.arms))])];
  for (const ad of rows) {
    const cells = arms.map((name) => {
      const a = ad.arms[name];
      if (!a) return `${name} -`;
      const ends = Object.entries(a.ends).map(([k, e]) => `${k} ${e.n}${e.overrides ? `/${e.overrides}ov` : ''}`).join(', ');
      return `${name} ${a.n}tr/${a.breaks.length}brk ${a.overrides}ov [${ends}]`;
    });
    const durs = ad.durs.map((d) => d.toFixed(3)).join('/') || '?';
    lines.push(`${prone.has(ad.key) ? '*' : ' '} ${ad.vid || '(no id)'} ${durs}s skip:${ad.skippable == null ? '?' : ad.skippable ? 'yes' : 'no'} | ${cells.join(' | ')}`);
  }
  lines.push('');
  lines.push(`override-prone ads (* above): ${verdict.ads.length}`);
  for (const v of verdict.ads) {
    lines.push(`  ${v.key} (${v.durs.map((d) => d.toFixed(3)).join('/')} s): (${v.outcome})${v.missing.length ? ` missing: ${v.missing.join('; ')}` : ''}`);
  }
  const say = { A: 'YouTube does it without the shield', B: 'the shield provokes it', C: 'inconclusive' };
  lines.push(`OVERALL: (${verdict.overall}) ${say[verdict.overall]}`);
  lines.push(`seek-after arm: ${verdict.seekafter.verdict} (${verdict.seekafter.why})`);
  lines.push(`viewer click during an override: ${clicks.claim}` +
    `${clicks.n ? `; per click: ${clicks.clicked.map((c) => `${c.key} clicked ${fmtS(c.clickIntoMs)} in, next clip ${fmtS(c.clickToNextMs)} later, override ${fmtS(c.overrideMs)}`).join('; ')}` : ''}` +
    `; unclicked overrides in this data: ${fmtRange(clicks.unclickedMs)}`);
  return lines;
}
