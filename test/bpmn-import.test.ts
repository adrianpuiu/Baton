/**
 * BPMN importer tests — the loop-opening build.
 *
 * These guard the thing that turns Baton from a closed-loop authoring tool into
 * an open intake tool: importing arbitrary BPMN 2.0 XML (Camunda / Signavio /
 * Appian exports) and feeding it to the soundness checker. The defining proof
 * is the round-trip (emit → import → verdict preserved) and the intake of raw,
 * hand-written BPMN with no PiperFlow involvement at all.
 *
 * Run:  node --import tsx --test test/bpmn-import.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitBpmn } from '../src/actions/bpmn.js';
import { importBpmn, BpmnImportError } from '../src/compiler/bpmn-import.js';
import { checkSoundness } from '../src/compiler/soundness.js';

const BALANCED = `title: Balanced Parallel
lane: Eng
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
<@parallel join> as join
(end) as e
s -> split
split -> l -> join
split -> r -> join
join -> e`;

// ---------------------------------------------------------------------------
// Intake of raw BPMN (no PiperFlow) — the real-world case.
// ---------------------------------------------------------------------------

test('import: ingests a minimal raw BPMN process into a usable AST', () => {
  const xml = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="p" name="My Process">
    <bpmn:startEvent id="s"/>
    <bpmn:task id="t" name="Build"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;
  const ast = importBpmn(xml);
  assert.equal(ast.title, 'My Process');
  assert.equal(ast.elements.length, 3);
  assert.equal(ast.edges.length, 2);
  assert.equal(ast.elements.find((e) => e.id === 't')?.label, 'Build');
  assert.equal(ast.elements.find((e) => e.id === 't')?.category, 'activity');
});

test('import: maps BPMN task sub-types to taskType', () => {
  const xml = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="p">
    <bpmn:startEvent id="s"/>
    <bpmn:serviceTask id="svc" name="Deploy"/>
    <bpmn:userTask id="usr" name="Review"/>
    <bpmn:manualTask id="man" name="Sign"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="svc"/>
    <bpmn:sequenceFlow id="f2" sourceRef="svc" targetRef="usr"/>
    <bpmn:sequenceFlow id="f3" sourceRef="usr" targetRef="man"/>
    <bpmn:sequenceFlow id="f4" sourceRef="man" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;
  const ast = importBpmn(xml);
  assert.equal(ast.elements.find((e) => e.id === 'svc')?.taskType, 'service');
  assert.equal(ast.elements.find((e) => e.id === 'usr')?.taskType, 'user');
  assert.equal(ast.elements.find((e) => e.id === 'man')?.taskType, 'manual');
});

test('import: reconstructs pools + lanes from collaboration/participant/flowNodeRef', () => {
  const xml = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:collaboration id="c">
    <bpmn:participant id="pt" name="Sales" processRef="p"/>
  </bpmn:collaboration>
  <bpmn:process id="p">
    <bpmn:laneSet id="ls"><bpmn:lane id="l" name="Rep">
      <bpmn:flowNodeRef>s</bpmn:flowNodeRef><bpmn:flowNodeRef>t</bpmn:flowNodeRef><bpmn:flowNodeRef>e</bpmn:flowNodeRef>
    </bpmn:lane></bpmn:laneSet>
    <bpmn:startEvent id="s"/>
    <bpmn:task id="t"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;
  const ast = importBpmn(xml);
  assert.equal(ast.lanes[0].name, 'Rep');
  assert.equal(ast.lanes[0].pool, 'Sales');
  assert.equal(ast.elements.find((e) => e.id === 't')?.lane, 'Rep');
  assert.equal(ast.elements.find((e) => e.id === 't')?.pool, 'Sales');
});

test('import: rejects non-BPMN input with a clear error', () => {
  assert.throws(
    () => importBpmn('<html><body>not bpmn</body></html>'),
    (err: unknown) => err instanceof BpmnImportError,
  );
});

// ---------------------------------------------------------------------------
// THE defining test: emit → import round-trip preserves the soundness verdict.
// ---------------------------------------------------------------------------

test('round-trip: emit BPMN → import → verdict matches the original PiperFlow', () => {
  const original = parsePiperFlow(BALANCED);
  const originalVerdict = checkSoundness(original).sound;

  const xml = emitBpmn(original, { slug: 'balanced' });
  const reimported = importBpmn(xml);
  const roundTripVerdict = checkSoundness(reimported).sound;

  // Structure is preserved (up to the importer's lane synthesis).
  assert.equal(reimported.elements.length, original.elements.length);
  assert.equal(reimported.edges.length, original.edges.length);
  assert.equal(roundTripVerdict, originalVerdict, 'verdict must survive the round-trip');
  assert.equal(roundTripVerdict, true);
});

test('round-trip: an UNSOUND process stays unsound after emit → import', () => {
  const brokenPf = `title: Broken
lane: A
(start) as s
<@parallel split> as split
[Left] as l
[Right] as r
<@parallel join> as join
(end) as e
s -> split
split -> l -> join
split -> r
join -> e`;
  const xml = emitBpmn(parsePiperFlow(brokenPf), { slug: 'broken' });
  const reimported = importBpmn(xml);
  const result = checkSoundness(reimported);
  assert.equal(result.sound, false, 'defect must survive the round-trip');
  assert.ok(result.issues.some((i) => i.kind === 'parallel-branch-imbalance'));
});

// ---------------------------------------------------------------------------
// The end-to-end user story: hand-written broken BPMN flagged on intake.
// ---------------------------------------------------------------------------

test('intake: a hand-written broken BPMN export is flagged unsound', () => {
  const xml = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="p" name="Broken Export">
    <bpmn:startEvent id="s"/>
    <bpmn:parallelGateway id="split"/>
    <bpmn:task id="left"/>
    <bpmn:task id="right"/>
    <bpmn:parallelGateway id="join"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="split"/>
    <bpmn:sequenceFlow id="f2" sourceRef="split" targetRef="left"/>
    <bpmn:sequenceFlow id="f3" sourceRef="split" targetRef="right"/>
    <bpmn:sequenceFlow id="f4" sourceRef="left" targetRef="join"/>
    <bpmn:sequenceFlow id="f5" sourceRef="join" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;
  const result = checkSoundness(importBpmn(xml));
  assert.equal(result.sound, false);
  assert.ok(
    result.issues.some((i) => i.kind === 'parallel-branch-imbalance'),
    'the missing-branch defect is found on raw BPMN intake',
  );
});
