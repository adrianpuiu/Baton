/**
 * Smoke test for the render pipeline — NO model required.
 * Parses the sample DSL and draws a PNG. Run: `npm run test:render`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { renderDiagram } from '../src/actions/render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const dsl = readFileSync(join(root, 'src', 'samples', 'order-fulfilment.pf'), 'utf8');
const ast = parsePiperFlow(dsl);
console.log(`✓ Parsed: "${ast.title}" — ${ast.elements.length} elements, ${ast.edges.length} edges, ${ast.lanes.length} lanes`);

const out = await renderDiagram(dsl, join(root, 'diagrams', 'order-fulfilment.png'), { bpmn: true });
console.log(`✓ Diagram written: ${out.image}`);
out.bpmn && console.log(`✓ BPMN XML written: ${out.bpmn}`);
