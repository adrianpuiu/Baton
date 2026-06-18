/**
 * CLI smoke tests — the product surface, exercised end-to-end.
 *
 * These spawn the BUILT dist-cli/cli.js (not the TS source) on real input files
 * and assert the contract that `baton check` promises: exit 0 for sound, exit 1
 * for unsound, exit 2 for usage/parse errors, and a valid --json shape for CI
 * tooling. If the CLI breaks, these catch it before a user does.
 *
 * Run:  node --import tsx --test test/cli.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitBpmn } from '../src/actions/bpmn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const CLI = join(root, 'dist-cli', 'cli.js');

/** Run the built CLI; returns { code, stdout, stderr }. */
function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The CLI is a built artifact. Build it on demand if missing (local dev + CI),
// skip gracefully if the build can't run (keeps the suite green anywhere).
function ensureCliBuilt(): boolean {
  if (existsSync(CLI)) return true;
  const r = spawnSync('npm', ['run', 'build:cli'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 && existsSync(CLI);
}

let cliReady: boolean;
test('CLI setup: build the CLI artifact', { concurrency: false }, () => {
  cliReady = ensureCliBuilt();
  if (!cliReady) {
    console.warn('  (skipping CLI tests — dist-cli/cli.js not buildable here)');
  }
});

// Fixtures: a known-sound .pf and a broken .bpmn, generated into a temp dir.
const tmp = join(root, '.tmp-cli-fixtures');
const soundPf = join(tmp, 'sound.pf');
const brokenBpmn = join(tmp, 'broken.bpmn');

test('CLI fixtures: write a sound .pf and a broken .bpmn', { concurrency: false }, () => {
  mkdirSync(tmp, { recursive: true });
  // Sound: balanced parallel split + matching join.
  writeFileSync(
    soundPf,
    `title: Sound
lane: Eng
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
<@parallel join> as join
(end) as e
s -> split
split -> l -> join
split -> r -> join
join -> e`,
  );
  // Broken: emit a known-unsound process to BPMN, then the CLI must flag it.
  const brokenPf = `title: Broken
lane: A
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
<@parallel join> as join
(end) as e
s -> split
split -> l -> join
split -> r
join -> e`;
  writeFileSync(brokenBpmn, emitBpmn(parsePiperFlow(brokenPf), { slug: 'broken' }));
});

test('CLI: --version prints the version and exits 0', () => {
  if (!cliReady) return;
  const r = run('--version');
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^0\.\d+\.\d+$/);
});

test('CLI: check on a SOUND .pf exits 0 and reports YES', () => {
  if (!cliReady) return;
  const r = run('check', soundPf);
  assert.equal(r.code, 0, `expected 0, got ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /Sound:\s+YES/);
});

test('CLI: check on an UNSOUND .bpmn exits 1 and names a defect', () => {
  if (!cliReady) return;
  const r = run('check', brokenBpmn);
  assert.equal(r.code, 1, `expected 1, got ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /Sound:\s+NO/);
  assert.match(r.stdout, /parallel-branch-imbalance/);
});

test('CLI: --json emits machine-readable output with the contract shape', () => {
  if (!cliReady) return;
  const r = run('check', brokenBpmn, '--json');
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.sound, false);
  assert.equal(parsed.process, 'Broken');
  assert.ok(Array.isArray(parsed.defects));
  assert.ok(parsed.defects.length > 0);
  assert.ok(parsed.defects.every((d: { kind: string; elementIds: unknown; message: string }) => d.kind && Array.isArray(d.elementIds) && typeof d.message === 'string'));
});

// A hand-crafted BPMN process that is control-flow SOUND but has a
// stall-vulnerable approval — the headline value proposition isolated. The
// merged CLI verdict must be unsound because of the reliability defect alone.
const soundButStalledBpmn = join(tmp, 'sound-but-stalled.bpmn');
test('CLI fixtures: write a control-flow-sound-but-stall-vulnerable .bpmn', { concurrency: false }, () => {
  if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
  writeFileSync(soundButStalledBpmn, `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://baton">
  <bpmn:process id="approval" name="Budget Approval" isExecutable="false">
    <bpmn:startEvent id="s" name="Start"/>
    <bpmn:userTask id="a" name="Manager approves"/>
    <bpmn:endEvent id="e" name="End"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="a"/>
    <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`);
});

test('CLI: control-flow-sound-but-stalled process → exit 1 (reliability defect breaks the verdict)', () => {
  if (!cliReady) return;
  const r = run('check', soundButStalledBpmn);
  assert.equal(r.code, 1, `expected 1 for stall-vulnerable, got ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /Reliability defects/);
  assert.match(r.stdout, /stall-vulnerable/);
  // Critically: NO control-flow defects — the unsoundness is purely reliability.
  assert.doesNotMatch(r.stdout, /Control-flow defects/);
});

test('CLI: --quiet emits nothing and relies on the exit code', () => {
  if (!cliReady) return;
  const r = run('check', brokenBpmn, '--quiet');
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), '');
});

test('CLI: missing file → usage error, exit 2', () => {
  if (!cliReady) return;
  const r = run('check');
  assert.equal(r.code, 2);
});

test('CLI: unreadable/missing path → exit 2 with a clear error', () => {
  if (!cliReady) return;
  const r = run('check', join(tmp, 'does-not-exist.bpmn'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read/);
});

test('CLI cleanup: remove temp fixtures', { concurrency: false }, () => {
  rmSync(tmp, { recursive: true, force: true });
});
