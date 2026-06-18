/**
 * Direct AST → BPMN emitter tests.
 *
 * These guard the guarantee that large processes no longer lose BPMN when the
 * processpiper grid-layout engine gives up and the renderer falls back to
 * Graphviz. The emitter must produce valid, importable OMG BPMN 2.0 XML from
 * ANY ProcessAST — including the 5-pool / 12-lane AIOps showcase that broke
 * processpiper. We assert structure, element-type mapping, and referential
 * integrity (no dangling sourceRef/targetRef).
 *
 * Run:  node --import tsx --test test/bpmn.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitBpmn } from '../src/actions/bpmn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** Count occurrences of a BPMN tag in the emitted XML. */
function count(xml: string, re: RegExp): number {
  // Ensure global matching — String.match without the g flag returns only the
  // first match, which would make every count read 1.
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return (xml.match(new RegExp(re.source, flags)) ?? []).length;
}

test('emit: well-formed BPMN envelope (definitions/process/diagram all present)', () => {
  const ast = parsePiperFlow(readFileSync(join(root, 'src/samples/onboarding.pf'), 'utf8'));
  const xml = emitBpmn(ast, { slug: 'onboarding' });

  assert.ok(xml.startsWith('<?xml'), 'XML declaration present');
  assert.match(xml, /<bpmn:definitions\b/);
  assert.match(xml, /<\/bpmn:definitions>\s*$/);
  assert.match(xml, /<bpmn:process\b[^>]*\bid="process_onboarding"/);
  assert.match(xml, /<bpmndi:BPMNDiagram\b/);
  assert.match(xml, /targetNamespace="http:\/\/baton\/processes"/);
});

test('emit: OMG namespaces declared (imports into Camunda/Signavio/Appian)', () => {
  const xml = emitBpmn(parsePiperFlow(readFileSync(join(root, 'src/samples/onboarding.pf'), 'utf8')), { slug: 'x' });
  // The four namespaces an importer needs to resolve the model + diagram.
  assert.match(xml, /xmlns:bpmn="http:\/\/www\.omg\.org\/spec\/BPMN\/20100524\/MODEL"/);
  assert.match(xml, /xmlns:bpmndi="http:\/\/www\.omg\.org\/spec\/BPMN\/20100524\/DI"/);
  assert.match(xml, /xmlns:dc="http:\/\/www\.omg\.org\/spec\/DD\/20100524\/DC"/);
  assert.match(xml, /xmlns:di="http:\/\/www\.omg\.org\/spec\/DD\/20100524\/DI"/);
});

test('emit: each element variant maps to its correct BPMN tag', () => {
  // A process exercising one of every shape the taxonomy supports.
  const dsl = `title: taxonomy
lane: Eng
(start) as s
[task] as task1
<exclusive gw> as gw1
<@parallel par> as gw2
<@inclusive inc> as gw3
<@event ev> as gw4
(@timer Tm) as tm
(@message Msg) as msg
[@subprocess Sub] as sub
(end) as e
s -> task1 -> gw1 -> gw2 -> gw3 -> gw4 -> tm -> msg -> sub -> e`;
  const xml = emitBpmn(parsePiperFlow(dsl), { slug: 'taxonomy' });

  assert.equal(count(xml, /<bpmn:startEvent\b/), 1);
  assert.equal(count(xml, /<bpmn:endEvent\b/), 1);
  assert.equal(count(xml, /<bpmn:task\b/), 1);
  assert.equal(count(xml, /<bpmn:subProcess\b/), 1);
  assert.equal(count(xml, /<bpmn:exclusiveGateway\b/), 1);
  assert.equal(count(xml, /<bpmn:parallelGateway\b/), 1);
  assert.equal(count(xml, /<bpmn:inclusiveGateway\b/), 1);
  assert.equal(count(xml, /<bpmn:eventBasedGateway\b/), 1);
  // Catch events carry their typed event definition.
  assert.equal(count(xml, /<bpmn:timerEventDefinition/), 1);
  assert.equal(count(xml, /<bpmn:messageEventDefinition/), 1);
});

test('emit: every sequence flow references real node ids (no dangling refs)', () => {
  const ast = parsePiperFlow(readFileSync(join(root, 'src/samples/order-fulfilment.pf'), 'utf8'));
  const xml = emitBpmn(ast, { slug: 'order' });

  const nodeIds = new Set((xml.match(/\bid="(node_[^"]+)"/g) ?? []).map((m) => m.match(/node_[^"]+/)![0]));
  const srcs = (xml.match(/sourceRef="(node_[^"]+)"/g) ?? []).map((m) => m.match(/node_[^"]+/)![0]);
  const tgts = (xml.match(/targetRef="(node_[^"]+)"/g) ?? []).map((m) => m.match(/node_[^"]+/)![0]);

  assert.ok(nodeIds.size > 0, 'has nodes');
  for (const s of srcs) assert.ok(nodeIds.has(s), `dangling sourceRef: ${s}`);
  for (const t of tgts) assert.ok(nodeIds.has(t), `dangling targetRef: ${t}`);
  // one sequence flow per AST edge
  assert.equal(count(xml, /<bpmn:sequenceFlow\b/), ast.edges.length);
});

test('emit: THE SHOWCASE CASE — AIOps (5 pools, 12 lanes) produces complete BPMN', () => {
  // This is the process that breaks processpiper's grid layout and previously
  // lost BPMN entirely. The emitter must handle it without special-casing.
  const ast = parsePiperFlow(readFileSync(join(root, 'src/samples/aiops-self-healing.pf'), 'utf8'));
  const xml = emitBpmn(ast, { slug: 'aiops' });

  // Structure mirrors the source AST.
  const pools = [...new Set(ast.lanes.map((l) => l.pool).filter(Boolean))];
  assert.equal(count(xml, /<bpmn:participant\b/), pools.length, 'one participant per pool');
  assert.equal(count(xml, /<bpmn:lane id/), ast.lanes.length, 'one lane per declared lane');
  assert.equal(count(xml, /<bpmn:sequenceFlow\b/), ast.edges.length, 'one flow per edge');

  // DI present for every node + every flow (the layout that can't fail).
  const nodeTags = ast.elements.length;
  assert.ok(count(xml, /<bpmndi:BPMNShape\b/) >= nodeTags, 'a DI shape per node (plus lane/participant bands)');
  assert.equal(count(xml, /<bpmndi:BPMNEdge\b/), ast.edges.length, 'a DI edge per flow');

  // Must be well-formed (balanced root + process).
  assert.equal(count(xml, /<bpmn:definitions\b/), 1);
  assert.equal(count(xml, /<\/bpmn:definitions>/), 1);
  assert.equal(count(xml, /<bpmn:process\b/), 1);
  assert.equal(count(xml, /<\/bpmn:process>/), 1);
});

test('emit: special characters in labels are XML-escaped', () => {
  const dsl = `title: x & y <z>
lane: A
(start) as s
[Purchase "widgets" & gadgets] as t
(end) as e
s -> t -> e`;
  const xml = emitBpmn(parsePiperFlow(dsl), { slug: 'esc' });
  // The raw &, <, > must never appear unescaped inside an attribute value.
  assert.doesNotMatch(xml, /name="[^"]*[&]"/, 'unescaped & in attribute');
  assert.match(xml, /&amp;/, '& escaped');
  assert.match(xml, /&quot;/, '" escaped');
});
