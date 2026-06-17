/**
 * Offline build for the Employee Onboarding showcase:
 * parse → render (PNG + BPMN) → compile (runnable Flue workflow).
 * Showcases a parallel gateway (day-one provisioning fan-out) + tool integration.
 * Run: `npm run onboard:build`
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitFlueWorkflow } from '../src/compiler/emit.js';
import type { SkillWireEntry } from '../src/compiler/emit.js';
import { renderDiagram } from '../src/actions/render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dsl = readFileSync(join(root, 'src', 'samples', 'onboarding.pf'), 'utf8');

const ast = parsePiperFlow(dsl);
console.log(`✓ Parsed "${ast.title}"`);
console.log(`  ${ast.lanes.length} lanes across ${new Set(ast.lanes.map((l) => l.pool)).size} pools · ${ast.elements.length} elements · ${ast.edges.length} edges`);
const gateways = ast.elements.filter((e) => e.category === 'gateway');
console.log(`  ${gateways.length} gateways: ${gateways.map((g) => `${g.variant}:${g.label}`).join(' | ')}`);

mkdirSync(join(root, 'diagrams'), { recursive: true });
const r = await renderDiagram(dsl, join(root, 'diagrams', 'onboarding.png'), { bpmn: true });
console.log(`✓ Rendered: ${r.image.replace(root + '/', '')}${r.bpmn ? ` + ${r.bpmn.replace(root + '/', '')}` : ''}`);
if (r.fallback) console.log(`  ↳ processpiper layout failed (${r.fallbackReason}); used Graphviz structural fallback`);

mkdirSync(join(root, 'src', 'workflows'), { recursive: true });
let skillWiring: Record<string, SkillWireEntry[]> | undefined;
try {
  const wiringPath = join(root, 'skills.wiring.json');
  if (existsSync(wiringPath)) skillWiring = (JSON.parse(readFileSync(wiringPath, 'utf-8')) as { lanes: Record<string, SkillWireEntry[]> }).lanes;
} catch { /* no wiring → local capabilities only */ }
const code = emitFlueWorkflow(ast, { name: 'onboarding', model: 'vllm/Capybara', ...(skillWiring ? { skillWiring } : {}) });
const wfPath = join(root, 'src', 'workflows', 'gen-onboarding.ts');
writeFileSync(wfPath, code);
console.log(`✓ Compiled: ${wfPath.replace(root + '/', '')}`);

const warns = [...code.matchAll(/⚠ (.*)$/gm)].map((m) => m[1]);
console.log(warns.length ? `\n⚠ ${warns.length} gateway review warning(s):\n${warns.map((w) => `   • ${w}`).join('\n')}` : '\n✓ No gateway-inversion warnings');
