/**
 * Soundness report — analyse a PiperFlow process for formal control-flow defects.
 *
 *   node --import tsx scripts/check-soundness.ts <path/to/process.pf>
 *
 * Exits non-zero if the process is unsound, with a human-readable report of each
 * defect pointing at the offending element. This is the formal-analysis surface:
 * it catches deadlocks, parallel-join imbalances, dead branches, and improper
 * completion — bugs a syntax check can't see and a human reviewer often misses.
 */
import { readFileSync } from 'node:fs';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { checkSoundness } from '../src/compiler/soundness.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: check-soundness.ts <process.pf>');
  process.exit(2);
}

const dsl = readFileSync(file, 'utf8');
const ast = parsePiperFlow(dsl);
const result = checkSoundness(ast);

console.log(`Process: ${ast.title}`);
console.log(`Sound:   ${result.sound ? 'YES ✓' : 'NO ✗'}`);
console.log(`States explored: ${result.stats.markingsExplored}  (bounded: ${result.stats.bounded})`);

if (result.issues.length) {
  console.log(`\nDefects (${result.issues.length}):`);
  for (const i of result.issues) {
    const where = i.elementIds.length ? ` [${i.elementIds.join(', ')}]` : '';
    console.log(`  • ${i.kind}${where}\n    ${i.message}`);
  }
}
if (result.notes.length) {
  console.log('\nCaveats:');
  for (const n of result.notes) console.log(`  · ${n}`);
}

process.exit(result.sound ? 0 : 1);
