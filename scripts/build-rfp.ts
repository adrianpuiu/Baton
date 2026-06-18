/**
 * Offline build for the RFP Response showcase:
 * parse → check (soundness + reliability) → render (PNG + BPMN) → compile (Flue).
 *
 * This is the canonical demo for the "SonarQube for BPMN" wedge: a real
 * enterprise procurement process that is control-flow SOUND but whose single
 * human gate (the Go/No-Go review) can stall the entire bid pipeline forever
 * — because no escalation timer watches it. Run `baton check` on the output to
 * see Baton zero in on exactly that one step.
 *
 * Run: `npm run rfp:build`
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitFlueWorkflow } from '../src/compiler/emit.js';
import type { SkillWireEntry } from '../src/compiler/emit.js';
import { renderDiagram } from '../src/actions/render.js';
import { checkSoundness, checkReliability } from '../src/compiler/soundness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dsl = readFileSync(join(root, 'src', 'samples', 'rfp-response.pf'), 'utf8');

const ast = parsePiperFlow(dsl);
console.log(`✓ Parsed "${ast.title}"`);
console.log(`  ${ast.lanes.length} lanes across ${new Set(ast.lanes.map((l) => l.pool)).size} pools · ${ast.elements.length} elements · ${ast.edges.length} edges`);

// The headline: control-flow sound, reliability broken on the human gate.
const soundness = checkSoundness(ast);
const reliability = checkReliability(ast);
console.log(`✓ Control-flow sound: ${soundness.sound ? 'YES' : 'NO'} (${soundness.stats.markingsExplored} states)`);
console.log(`✓ Reliability defects: ${reliability.length}`);
for (const r of reliability) {
  console.log(`    • ${r.kind} [${r.elementIds.join(', ')}]`);
}

mkdirSync(join(root, 'diagrams'), { recursive: true });
const rendered = await renderDiagram(dsl, join(root, 'diagrams', 'rfp-response.png'), { bpmn: true });
console.log(`✓ Rendered: ${rendered.image.replace(root + '/', '')}${rendered.bpmn ? ` + ${rendered.bpmn.replace(root + '/', '')}` : ''}`);
if (rendered.fallback) console.log(`  ↳ processpiper layout failed (${rendered.fallbackReason}); used Graphviz structural fallback`);

mkdirSync(join(root, 'src', 'workflows'), { recursive: true });
let skillWiring: Record<string, SkillWireEntry[]> | undefined;
try {
  const wiringPath = join(root, 'skills.wiring.json');
  if (existsSync(wiringPath)) skillWiring = (JSON.parse(readFileSync(wiringPath, 'utf-8')) as { lanes: Record<string, SkillWireEntry[]> }).lanes;
} catch { /* no wiring → local capabilities only */ }
const code = emitFlueWorkflow(ast, { name: 'rfp-response', model: 'vllm/Capybara', ...(skillWiring ? { skillWiring } : {}) });
const wfPath = join(root, 'src', 'workflows', 'gen-rfp-response.ts');
writeFileSync(wfPath, code);
console.log(`✓ Compiled: ${wfPath.replace(root + '/', '')}`);
