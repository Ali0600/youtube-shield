// The pod lab's pre-registered decision rule (scripts/pod-lab-rule.mjs), pinned at literal sample points: each case
// builds transition records the way scripts/pod-lab.mjs writes them and checks the verdict the rule must give.
const test = require('node:test');
const assert = require('node:assert/strict');

const rule = import('../scripts/pod-lab-rule.mjs');
let seq = 0;
// One transition: an ad that ended (and what came next), in one arm. Each gets its own break unless one is given.
const tr = (arm, vid, end, extra = {}) => ({
  arm, vid, dur: 19.041, end, to: 7, override: false, overrideMs: null, overrideClicked: false, skippable: true,
  breakId: `b${++seq}`, ...extra,
});
const ov = (arm, vid, end, extra = {}) => tr(arm, vid, end, { override: true, overrideMs: 7100, ...extra });
const times = (n, f) => Array.from({ length: n }, f);
// An ad the shield provokes, by the rule's letter: 3 seek overrides, 3 clean natural ends, 3 clean viewer skips.
const provoked = (vid, extra = {}) => [
  ...times(3, () => ov('seek', vid, 'shield-seek', extra)),
  ...times(3, () => tr('off', vid, 'natural', extra)),
  ...times(3, () => tr('userskip', vid, 'viewer-skip', extra)),
];
const run = async (transitions) => {
  const { tabulate, decide } = await rule;
  return decide(tabulate(transitions));
};
const outcomeOf = (verdict, key) => (verdict.ads.find((a) => a.key === key) || {}).outcome;

test('the thresholds are the pre-registered ones', async () => {
  const { RULE } = await rule;
  assert.equal(RULE.overrideMinMs, 6500);
  assert.equal(RULE.minN, 3);
  assert.equal(RULE.minAdsForB, 2);
  assert.deepEqual([...RULE.shieldFree], ['off', 'userskip']);
});

test('(A): one override in arm off or arm userskip makes it YouTube without the shield, overall too', async () => {
  for (const arm of ['off', 'userskip']) {
    const v = await run([...provoked('AAAAAAAAAAA'), ...provoked('BBBBBBBBBBB'), ov(arm, 'CCCCCCCCCCC', 'natural'), ov('seek', 'CCCCCCCCCCC', 'shield-seek')]);
    assert.equal(outcomeOf(v, 'CCCCCCCCCCC'), 'A', arm);
    assert.equal(v.overall, 'A', `${arm}: any (A) ad wins over two (B) ads`);
  }
});

test('(B) needs two ads meeting it; one is overall (C)', async () => {
  const two = await run([...provoked('AAAAAAAAAAA'), ...provoked('BBBBBBBBBBB')]);
  assert.deepEqual(two.ads.map((a) => a.outcome), ['B', 'B']);
  assert.equal(two.overall, 'B');
  const one = await run(provoked('AAAAAAAAAAA'));
  assert.equal(outcomeOf(one, 'AAAAAAAAAAA'), 'B');
  assert.equal(one.overall, 'C');
});

test('(B) fails to (C) one count short, and names what is missing', async () => {
  const cases = [
    ['seek', 'shield-seek', /seek: the override after 2/],
    ['off', 'natural', /off: 2 natural/],
    ['userskip', 'viewer-skip', /userskip: 2 end/],
  ];
  for (const [arm, end, why] of cases) {
    const ts = provoked('AAAAAAAAAAA');
    ts.splice(ts.findIndex((t) => t.arm === arm && t.end === end), 1);
    const v = await run([...ts, ...provoked('BBBBBBBBBBB')]);
    const ad = v.ads.find((a) => a.key === 'AAAAAAAAAAA');
    assert.equal(ad.outcome, 'C', arm);
    assert.match(ad.missing.join('; '), why);
    assert.equal(v.overall, 'C', `${arm}: only one ad meets (B)`);
  }
});

test('(B): off ends other than natural do not count; a non-skippable ad needs no viewer skips; an unknown one cannot pass', async () => {
  const cut = provoked('AAAAAAAAAAA').map((t) => (t.arm === 'off' ? { ...t, end: 'cut' } : t));
  assert.equal(outcomeOf(await run(cut), 'AAAAAAAAAAA'), 'C');
  const noSkip = provoked('AAAAAAAAAAA', { skippable: false }).filter((t) => t.arm !== 'userskip');
  assert.equal(outcomeOf(await run(noSkip), 'AAAAAAAAAAA'), 'B');
  const unknown = provoked('AAAAAAAAAAA', { skippable: null }).filter((t) => t.arm !== 'userskip');
  const u = (await run(unknown)).ads[0];
  assert.equal(u.outcome, 'C');
  assert.match(u.missing.join('; '), /skippable or not: unknown/);
});

test('override threshold: 6.5 s counts, 6.499 s does not (unless the viewer clicked during it)', async () => {
  const { isOverride } = await rule;
  assert.equal(isOverride({ override: true, overrideMs: 6500 }), true);
  assert.equal(isOverride({ override: true, overrideMs: 6499 }), false);
  assert.equal(isOverride({ override: true, overrideMs: 2000, overrideClicked: true }), true);
  assert.equal(isOverride({ override: false, overrideMs: 7100 }), false);
  const short = await run([ov('seek', 'AAAAAAAAAAA', 'shield-seek', { overrideMs: 6499 })]);
  assert.equal(short.ads.length, 0, 'not override-prone');
  const free = await run([ov('off', 'AAAAAAAAAAA', 'natural', { overrideMs: 6499 }), ...times(3, () => ov('seek', 'AAAAAAAAAAA', 'shield-seek'))]);
  assert.equal(outcomeOf(free, 'AAAAAAAAAAA'), 'C', 'a short override in arm off is no (A)');
});

test('an ad is its id when known, else its duration to 3 decimals; a transition with no next clip and no full override is not counted', async () => {
  const { tabulate, adKey, counts } = await rule;
  assert.equal(adKey({ vid: 'AAAAAAAAAAA', dur: 19.041 }), 'AAAAAAAAAAA');
  assert.equal(adKey({ vid: null, dur: 19.0409 }), 'dur:19.041');
  assert.equal(adKey({ vid: null, dur: null }), null);
  const ads = tabulate([tr('off', 'AAAAAAAAAAA', 'natural'), tr('off', 'BBBBBBBBBBB', 'natural'), tr('off', null, 'natural'), tr('off', null, 'natural', { breakId: 'b-same' }), tr('off', null, 'natural', { breakId: 'b-same' })]);
  assert.deepEqual([...ads.keys()].sort(), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'dur:19.041'], 'one duration, two ids: two ads');
  assert.equal(ads.get('dur:19.041').arms.off.n, 3, 'each transition counts');
  assert.equal(ads.get('dur:19.041').arms.off.breaks.length, 2, 'and the breaks they came from');
  assert.equal(counts({ to: null, override: true, overrideMs: 3000 }), false);
  assert.equal(counts({ to: null, override: true, overrideMs: 7000 }), true);
  assert.equal(counts({ to: 4 }), true);
});

test('seek-after: avoids it, does not avoid it, inconclusive', async () => {
  const base = [...provoked('AAAAAAAAAAA'), ...provoked('BBBBBBBBBBB')];
  const after = (vid, n, withOverride) => times(n, (_, i) => (withOverride && i === 0 ? ov : tr)('seekafter', vid, 'seek-after'));
  assert.equal((await run([...base, ...after('AAAAAAAAAAA', 3), ...after('BBBBBBBBBBB', 3)])).seekafter.verdict, 'avoids it');
  assert.equal((await run([...base, ...after('AAAAAAAAAAA', 3), ...after('BBBBBBBBBBB', 2)])).seekafter.verdict, 'inconclusive', 'every (B) ad needs 3');
  assert.equal((await run([...base, ...after('AAAAAAAAAAA', 3), ...after('BBBBBBBBBBB', 1, true)])).seekafter.verdict, 'does not avoid it');
  assert.equal((await run(base.filter((t) => t.arm !== 'off'))).seekafter.verdict, 'inconclusive', 'no (B) ad');
});

test('clicks during an override: numbers only, and no claim below n=3', async () => {
  const { overrideClicks } = await rule;
  const clicked = (ms) => ov('userskip', 'AAAAAAAAAAA', 'viewer-skip', { overrideClicked: true, overrideMs: ms, clickIntoOverrideMs: 1000, clickToNextMs: ms - 1000 });
  assert.match(overrideClicks([clicked(1500), clicked(1600)]).claim, /n=2 \(< 3\): no claim/);
  const three = overrideClicks([clicked(1500), clicked(1600), clicked(7100), ov('seek', 'AAAAAAAAAAA', 'shield-seek')]);
  assert.equal(three.n, 3);
  assert.match(three.claim, /2 ended before 6.9 s, 1 within the baseline/);
  assert.deepEqual(three.unclickedMs, [7100]);
});
