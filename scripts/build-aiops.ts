/**
 * Full offline pipeline for the AIOps self-healing sample:
 * parse → render (PNG + BPMN) → compile (runnable Flue workflow).
 * Surfaces orphan/gateway warnings. Run: `npm run aiops:build`
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitFlueWorkflow } from '../src/compiler/emit.js';
import { renderDiagram } from '../src/actions/render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dsl = readFileSync(join(root, 'src', 'samples', 'aiops-self-healing.pf'), 'utf8');

// 1. Parse + validate (orphans, dangling refs, gateway count)
const ast = parsePiperFlow(dsl);
console.log(`✓ Parsed "${ast.title}"`);
console.log(`  ${ast.lanes.length} lanes across ${new Set(ast.lanes.map((l) => l.pool)).size} pools · ${ast.elements.length} elements · ${ast.edges.length} edges`);
const gateways = ast.elements.filter((e) => e.category === 'gateway');
console.log(`  ${gateways.length} gateways: ${gateways.map((g) => g.label).join(' | ')}`);

// 2. Render PNG + BPMN XML (with graceful fallback to Graphviz on layout failure)
const r = await renderDiagram(dsl, join(root, 'diagrams', 'aiops-self-healing.png'), { bpmn: true });
console.log(`✓ Rendered: ${r.image.replace(root + '/', '')}${r.bpmn ? ` + ${r.bpmn.replace(root + '/', '')}` : ''}`);
if (r.fallback) {
  console.log(`  ↳ processpiper layout failed (${r.fallbackReason}); used Graphviz structural fallback`);
  console.log(`    NOTE: BPMN XML not emitted (processpiper's BPMN export runs inside its layout).`);
}

// 3. Compile to a runnable Flue workflow (threading in any locked/generated skills)
mkdirSync(join(root, 'src', 'workflows'), { recursive: true });
let skillWiring: Record<string, import('../src/compiler/emit.js').SkillWireEntry[]> | undefined;
try {
  const wiringPath = join(root, 'skills.wiring.json');
  if (existsSync(wiringPath)) {
    skillWiring = (JSON.parse(readFileSync(wiringPath, 'utf-8')) as { lanes: Record<string, import('../src/compiler/emit.js').SkillWireEntry[]> }).lanes;
  }
} catch { /* no wiring → local capabilities only */ }
const code = emitFlueWorkflow(ast, { name: 'aiops-self-healing', model: 'vllm/Capybara', ...(skillWiring ? { skillWiring } : {}) });
const wfPath = join(root, 'src', 'workflows', 'gen-aiops-self-healing.ts');
writeFileSync(wfPath, code);
console.log(`✓ Compiled: ${wfPath.replace(root + '/', '')}`);
if (skillWiring) {
  const wired = Object.values(skillWiring).flat().filter((s) => s.compatible).length;
  console.log(`  ↳ wired ${wired} skill(s) from skills.wiring.json (discovered + generated)`);
}

// 4. Report any gateway-semantic warnings
const warns = [...code.matchAll(/⚠ (.*)$/gm)].map((m) => m[1]);
if (warns.length) {
  console.log(`\n⚠ ${warns.length} gateway review warning(s):`);
  for (const w of warns) console.log(`   • ${w}`);
} else {
  console.log('\n✓ No gateway-inversion warnings');
}
