/**
 * Soundness analysis tests — formal control-flow defect detection.
 *
 * These guard the Petri-net (workflow-net) soundness checker. The valuable
 * property: it catches bugs a syntax check can't see and a human reviewer
 * often misses — the classic parallel-join imbalance deadlock, dead branches,
 * improper completion. Each test constructs a deliberately broken (or known-
 * sound) process and asserts the right verdict with the offending element named.
 *
 * Run:  node --import tsx --test test/soundness.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { checkSoundness } from '../src/compiler/soundness.js';
import { toPetriNet } from '../src/compiler/petri.js';

/** Run soundness on a DSL string and return the result. */
function check(dsl: string) {
  return checkSoundness(parsePiperFlow(dsl));
}

const LINEAR = `title: linear
lane: A
(start) as s
[Build] as build
(end) as e
s -> build -> e`;

const BALANCED_PARALLEL = `title: balanced
lane: A
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
<@parallel join> as join
(end) as e
s -> split
split -> l -> join
split -> r -> join
join -> e`;

// ---------------------------------------------------------------------------
// Petri-net translation sanity.
// ---------------------------------------------------------------------------

test('toPetriNet: every place/transition/arc is wired; source & sink present', () => {
  const net = toPetriNet(parsePiperFlow(LINEAR));
  assert.ok(net.places.some((p) => p.id === net.sourceId), 'has a source place');
  assert.ok(net.places.some((p) => p.id === net.sinkId), 'has a sink place');
  // Every arc endpoint references a real place or transition.
  const ids = new Set([...net.places.map((p) => p.id), ...net.transitions.map((t) => t.id)]);
  for (const a of net.arcs) {
    assert.ok(ids.has(a.from), `arc from unknown: ${a.from}`);
    assert.ok(ids.has(a.to), `arc to unknown: ${a.to}`);
  }
});

// ---------------------------------------------------------------------------
// Known-sound processes must pass clean.
// ---------------------------------------------------------------------------

test('sound: a simple linear process is sound', () => {
  assert.equal(check(LINEAR).sound, true);
});

test('sound: a balanced parallel split + matching join is sound', () => {
  assert.equal(check(BALANCED_PARALLEL).sound, true);
});

test('sound: an exclusive split with both branches rejoining is sound', () => {
  const dsl = `title: xor
lane: A
(start) as s
<Approved?> as g
[Yes] as y
[No] as n
(end) as e
s -> g
g -> y -> e
g -> n -> e`;
  assert.equal(check(dsl).sound, true);
});

test('sound: nested parallel splits with matching joins are sound', () => {
  const dsl = `title: nested
lane: A
(start) as s
<@parallel split> as split
[A] as a
<@parallel split2> as split2
[B] as b
[C] as c
<@parallel join2> as join2
<@parallel join> as join
(end) as e
s -> split
split -> a -> join
split -> split2
split2 -> b -> join2
split2 -> c -> join2
join2 -> join
join -> e`;
  assert.equal(check(dsl).sound, true);
});

// ---------------------------------------------------------------------------
// THE classic BPMN bug: parallel split, missing branch at the join.
// ---------------------------------------------------------------------------

test('defect: parallel split with only ONE branch rejoining → imbalance, named at the split', () => {
  const dsl = `title: mismatch
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
  const r = check(dsl);
  assert.equal(r.sound, false);
  const issue = r.issues.find((i) => i.kind === 'parallel-branch-imbalance');
  assert.ok(issue, 'flagged as a parallel-branch-imbalance');
  assert.ok(issue!.elementIds.includes('split'), 'points at the split');
});

test('defect: parallel split with NEITHER branch rejoining → imbalance', () => {
  const dsl = `title: neither
lane: A
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
<@parallel join> as join
(end) as e
s -> split
split -> l
split -> r
join -> e`;
  const r = check(dsl);
  assert.equal(r.sound, false);
  assert.ok(r.issues.some((i) => i.kind === 'parallel-branch-imbalance'));
});

test('defect: an implicit XOR-join after a parallel split is flagged (strict BPMN soundness)', () => {
  // Two parallel branches rejoin at a TASK (implicit XOR-join), not a parallel
  // gateway. Baton's sequential compiled output tolerates this, but strict BPMN
  // soundness requires a parallel join — the checker enforces the standard.
  const dsl = `title: implicit join
lane: A
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
[Finish] as finish
(end) as e
s -> split
split -> l -> finish
split -> r -> finish
finish -> e`;
  const r = check(dsl);
  assert.equal(r.sound, false);
  assert.ok(r.issues.some((i) => i.kind === 'parallel-branch-imbalance'));
});

// ---------------------------------------------------------------------------
// Honesty: caveats are surfaced, not hidden.
// ---------------------------------------------------------------------------

test('caveat: inclusive gateways are flagged as approximated', () => {
  const dsl = `title: inc
lane: A
(start) as s
<@inclusive g?> as g
[A] as a
[B] as b
(end) as e
s -> g
g -> a -> e
g -> b -> e`;
  const r = check(dsl);
  assert.ok(r.notes.some((n) => /inclusive/i.test(n)), 'notes the inclusive approximation');
});

test('stats: the checker reports markings explored and bounded flag', () => {
  const r = check(LINEAR);
  assert.ok(r.stats.markingsExplored > 0);
  assert.equal(r.stats.bounded, true);
});
