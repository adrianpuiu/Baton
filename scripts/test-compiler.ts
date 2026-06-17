/**
 * Compiler smoke test on the rich sample — verifies parallel gateways compile
 * to Promise.all and the new element grammar parses cleanly. No model needed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitFlueWorkflow } from '../src/compiler/emit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const dsl = readFileSync(join(root, 'src', 'samples', 'order-fulfilment.pf'), 'utf8');
const ast = parsePiperFlow(dsl);
const code = emitFlueWorkflow(ast, { name: 'order-fulfilment', model: 'vllm/Capybara' });

console.log(`✓ Parsed: ${ast.elements.length} elements, ${ast.edges.length} edges, ${ast.lanes.length} lanes`);
console.log(`  categories: ${[...new Set(ast.elements.map((e) => e.category))].join(', ')}`);
console.log(`  gateway variants: ${ast.elements.filter((e) => e.category === 'gateway').map((e) => e.variant).join(', ')}`);
console.log(`  activity variants: ${ast.elements.filter((e) => e.category === 'activity').map((e) => e.variant).join(', ')}`);
console.log(`  event variants: ${ast.elements.filter((e) => e.category === 'event').map((e) => e.variant).join(', ')}`);
console.log(`✓ Parallel gateway → Promise.all: ${/Promise\.all/.test(code)}`);
console.log(`✓ Subprocess noted: ${/subprocess/.test(code)}`);
console.log(`✓ Message event emitted: ${/event: message/.test(code)}`);
