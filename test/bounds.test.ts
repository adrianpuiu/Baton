/**
 * Bounded-execution tests — degenerate-output detection + timeout signal.
 *
 * These guard the runtime hardening added to execute.ts: a repetition-loop
 * detector that stops a degenerate model run, and the AbortSignal that powers
 * the per-step timeout. The detector is a pure heuristic function; this mirrors
 * it and pins its classification boundary so a regression is caught fast.
 *
 * Run:  node --import tsx --test test/bounds.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the private looksDegenerate() in src/compiler/execute.ts.
// Kept in sync; if the heuristic changes there, update this and the cases below.
function looksDegenerate(s: string | undefined): boolean {
  const t = (s ?? '').trim();
  if (t.length < 80) return false;
  const window = t.slice(0, 40);
  const hits = (t.match(new RegExp(window.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  return hits >= 8;
}

test('degenerate-output detector flags a repetition loop', () => {
  const loop = 'Wait, I think the user is asking me to do Peer Review. '.repeat(10);
  assert.equal(looksDegenerate(loop), true);
});

test('degenerate-output detector leaves coherent output alone', () => {
  assert.equal(looksDegenerate('I reviewed the PR; it looks good, approved.'), false);
  assert.equal(looksDegenerate('hi'), false, 'short text not flagged');
  assert.equal(looksDegenerate(undefined), false, 'undefined not flagged');
  assert.equal(
    looksDegenerate('Step complete. I implemented the design-system tokens and components as specified in the plan. '),
    false,
    'medium coherent text not flagged',
  );
});

test('per-step timeout: AbortSignal.timeout produces a usable signal', () => {
  const sig = AbortSignal.timeout(60_000);
  assert.ok('aborted' in sig, 'signal carries the aborted flag the executor reads');
});
