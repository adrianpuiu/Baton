/**
 * Data-layer tests — PiperFlow data objects + activity I/O → Executable BPMN.
 *
 * These guard the Executable-conformance guarantee: a process that declares a
 * data layer emits BPMN with itemDefinitions, dataObjects, per-activity
 * ioSpecification (inputSet/outputSet), and dataInput/OutputAssociations —
 * with zero dangling references. This is the line between a diagram that
 * "runs" (Descriptive) and one that "executes" with real data flow.
 *
 * Run:  node --import tsx --test test/data-layer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiperFlow, ParseError } from '../src/compiler/parse.js';
import { emitBpmn } from '../src/actions/bpmn.js';
import { dataAssociations } from '../src/compiler/types.js';

const DATA_DSL = `title: Order Fulfilment with Data
lane: Sales
    (start) as start
    [Validate Order] as validate { in: order; out: validated_order }
    <Approved?> as approve
    [Charge Card] as charge { in: validated_order; out: receipt }
    (end) as end
data: order : Order
data: validated_order : Order
data: receipt : Receipt

start -> validate -> approve
approve -> charge: Yes
approve -> end: No
charge -> end`;

/** Count occurrences of a BPMN tag in the emitted XML (g-flag safe). */
function count(xml: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return (xml.match(new RegExp(re.source, flags)) ?? []).length;
}

// ---------------------------------------------------------------------------
// Parser: data objects + ioSpec are captured from the DSL.
// ---------------------------------------------------------------------------

test('parser: captures typed data objects', () => {
  const ast = parsePiperFlow(DATA_DSL);
  assert.equal(ast.dataObjects.length, 3);
  assert.deepEqual(ast.dataObjects.find((d) => d.id === 'order'), { id: 'order', type: 'Order' });
  assert.deepEqual(ast.dataObjects.find((d) => d.id === 'receipt'), { id: 'receipt', type: 'Receipt' });
});

test('parser: captures activity ioSpec from the { in/out } block', () => {
  const ast = parsePiperFlow(DATA_DSL);
  assert.deepEqual(
    ast.elements.find((e) => e.id === 'validate')?.ioSpec,
    { inputs: ['order'], outputs: ['validated_order'] },
  );
  // Activities without an I/O block have no ioSpec.
  assert.equal(ast.elements.find((e) => e.id === 'approve')?.ioSpec, undefined);
});

test('parser: untyped data objects are valid (type optional)', () => {
  const dsl = `title: x
lane: A
(start) as s
[work] as work { in: payload }
(end) as e
data: payload
s -> work -> e`;
  const ast = parsePiperFlow(dsl);
  assert.equal(ast.dataObjects.length, 1);
  assert.equal(ast.dataObjects[0].type, undefined);
});

test('parser: dataAssociations() derives input/output associations', () => {
  const ast = parsePiperFlow(DATA_DSL);
  const assoc = dataAssociations(ast);
  assert.equal(assoc.filter((a) => a.direction === 'input').length, 2);
  assert.equal(assoc.filter((a) => a.direction === 'output').length, 2);
  assert.ok(
    assoc.some((a) => a.activityId === 'validate' && a.direction === 'output' && a.dataObject === 'validated_order'),
  );
});

// ---------------------------------------------------------------------------
// Parser validation: bad I/O references are rejected precisely.
// ---------------------------------------------------------------------------

test('parser: rejects an I/O reference to an undeclared data object', () => {
  const dsl = `title: x
lane: A
(start) as s
[work] as work { in: ghost }
(end) as e
s -> work -> e`;
  // 'ghost' is never declared with data: → must be rejected, and the message
  // must name it so the self-healing loop can act.
  assert.throws(
    () => parsePiperFlow(dsl),
    (err: unknown) => err instanceof ParseError && /ghost/.test((err as Error).message),
  );
});

// ---------------------------------------------------------------------------
// BPMN emitter: Executable-conformance structure is emitted, intact.
// ---------------------------------------------------------------------------

test('emit: a data-layer process is marked isExecutable="true"', () => {
  const xml = emitBpmn(parsePiperFlow(DATA_DSL), { slug: 'order' });
  assert.match(xml, /<bpmn:process\b[^>]*isExecutable="true"/);
});

test('emit: a process WITHOUT data stays isExecutable="false" (honest)', () => {
  const dsl = `title: plain
lane: A
(start) as s
[work] as work
(end) as e
s -> work -> e`;
  const xml = emitBpmn(parsePiperFlow(dsl), { slug: 'plain' });
  assert.match(xml, /isExecutable="false"/);
});

test('emit: itemDefinitions emitted — one per distinct type', () => {
  const xml = emitBpmn(parsePiperFlow(DATA_DSL), { slug: 'order' });
  assert.equal(count(xml, /<bpmn:itemDefinition\b/), 2, 'Order + Receipt');
  assert.match(xml, /itemKind="Information"/);
});

test('emit: dataObjects emitted at process level (one per declared object)', () => {
  const xml = emitBpmn(parsePiperFlow(DATA_DSL), { slug: 'order' });
  assert.equal(count(xml, /<bpmn:dataObject\b/), 3);
});

test('emit: each ioSpec activity gets ioSpecification + inputSet/outputSet + associations', () => {
  const xml = emitBpmn(parsePiperFlow(DATA_DSL), { slug: 'order' });
  assert.equal(count(xml, /<bpmn:ioSpecification>/), 2, 'one per ioSpec activity');
  assert.equal(count(xml, /<bpmn:dataInput\b/), 2);
  assert.equal(count(xml, /<bpmn:dataOutput\b/), 2);
  assert.equal(count(xml, /<bpmn:inputSet>/), 2);
  assert.equal(count(xml, /<bpmn:outputSet>/), 2);
  assert.equal(count(xml, /<bpmn:dataInputAssociation>/), 2);
  assert.equal(count(xml, /<bpmn:dataOutputAssociation>/), 2);
});

test('emit: zero dangling references across all data associations', () => {
  const xml = emitBpmn(parsePiperFlow(DATA_DSL), { slug: 'order' });
  // Every declared id becomes 'id="<value>"' — slice off the id=" prefix and ".
  const allIds = new Set([...xml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = (xml.match(/<(?:bpmn:sourceRef|bpmn:targetRef)>([^<]+)<\/(?:bpmn:sourceRef|bpmn:targetRef)>/g) ?? [])
    .map((m) => m.replace(/<\/?bpmn:(?:sourceRef|targetRef)>/g, ''));
  const broken = refs.filter((r) => !allIds.has(r));
  assert.equal(broken.length, 0, `dangling refs: ${broken.join(', ')}`);
});

test('emit: data objects get DI shapes (locatable for importers)', () => {
  const xml = emitBpmn(parsePiperFlow(DATA_DSL), { slug: 'order' });
  assert.equal(count(xml, /bpmnElement="data_/), 3);
});
