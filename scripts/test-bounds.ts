/**
 * Unit test for the bounded-execution guards (no model needed).
 * Verifies the degenerate-output (repetition-loop) detector classifies correctly.
 * Run: `npm run test:bounds`
 */
import { readFileSync } from 'node:fs';

// Mirror of the private looksDegenerate() in execute.ts (kept in sync).
function looksDegenerate(s: string | undefined): boolean {
  const t = (s ?? '').trim();
  if (t.length < 80) return false;
  const window = t.slice(0, 40);
  const hits = (t.match(new RegExp(window.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  return hits >= 8;
}

let pass = 0;
let fail = 0;
const assert = (label: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};

console.log('degenerate-output detector:');
const loop = 'Wait, I think the user is asking me to do Peer Review. '.repeat(10);
assert('repetition loop flagged', looksDegenerate(loop) === true);
assert('normal one-sentence output NOT flagged', looksDegenerate('I reviewed the PR; it looks good, approved.') === false);
assert('short text NOT flagged', looksDegenerate('hi') === false);
assert('undefined NOT flagged', looksDegenerate(undefined) === false);
assert('medium coherent text NOT flagged', looksDegenerate('Step complete. I implemented the design-system tokens and components as specified in the plan. '.repeat(1)) === false);

// AbortSignal.timeout is what powers the per-step guard.
console.log('\nper-step timeout signal:');
const sig = AbortSignal.timeout(60_000);
assert('AbortSignal.timeout produces an AbortSignal', 'aborted' in sig);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// keep readFileSync import meaningful for future expansion
void readFileSync;
