// Plants each deliberate bug in tests/mutants.json into a fresh copy of the repo and requires its named test to fail.
// A guard whose mutant survives has no test that can see it break. Run: node scripts/mutation-check.mjs [M01 M05 ...]
//
// For each mutant: `old` must occur exactly once in its file (else it is refused, not skipped), the copy's bytes must
// change, and the run must report the named test as failed ("not ok ... <name>") and exit non-zero. First, the
// unmutated copy must pass every named test, or a red mutant would prove nothing.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COPY = ['src', 'tests', 'scripts', 'icons', 'manifest.json', 'package.json'];
const all = JSON.parse(readFileSync(join(ROOT, 'tests', 'mutants.json'), 'utf8'));
const only = process.argv.slice(2);
const mutants = only.length ? all.filter((m) => only.includes(m.id)) : all;
if (only.length && mutants.length !== only.length) {
  console.error(`unknown mutant id in: ${only.join(' ')}`);
  process.exit(2);
}

const freshCopy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yts-mutant-'));
  for (const p of COPY) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  return dir;
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const runTests = (dir, name) => {
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${escape(name)}`, 'tests/*.test.js'],
    { cwd: dir, encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const lines = out.split('\n');
  const failed = lines.some((l) => /^\s*not ok \d+ - /.test(l) && l.includes(name));
  const passed = lines.some((l) => /^\s*ok \d+ - /.test(l) && l.includes(name));
  return { status: r.status, failed, passed, out };
};

// Baseline: every named test exists and passes on the unmutated code.
const base = freshCopy();
let broken = 0;
try {
  for (const name of [...new Set(mutants.map((m) => m.test))]) {
    const r = runTests(base, name);
    if (r.status !== 0 || !r.passed) {
      broken++;
      console.error(`BASELINE: "${name}" did not pass on unmutated code (exit ${r.status})`);
    }
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
if (broken) process.exit(1);

let survivors = 0;
for (const m of mutants) {
  const dir = freshCopy();
  try {
    const file = join(dir, m.file);
    const before = readFileSync(file, 'utf8');
    const count = before.split(m.old).length - 1;
    if (count !== 1) {
      survivors++;
      console.log(`REFUSED ${m.id}: its text occurs ${count} times in ${m.file} (must be exactly 1)`);
      continue;
    }
    const after = before.replace(m.old, () => m.new);
    if (after === before) {
      survivors++;
      console.log(`REFUSED ${m.id}: the replacement changed nothing`);
      continue;
    }
    writeFileSync(file, after);
    if (readFileSync(file, 'utf8') !== after) throw new Error(`${m.id}: the mutated file did not read back`);
    const r = runTests(dir, m.test);
    if (r.status !== 0 && r.failed) {
      console.log(`caught   ${m.id} by "${m.test}"`);
    } else {
      survivors++;
      console.log(`SURVIVED ${m.id}: "${m.test}" ${r.passed ? 'still passed' : 'did not report as failed'} (exit ${r.status})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\n${mutants.length - survivors} of ${mutants.length} mutants caught`);
process.exit(survivors ? 1 : 0);
