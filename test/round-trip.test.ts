/**
 * Round-trip fidelity test: task types (the stall-vulnerability signal) must
 * survive the .pf → .bpmn → re-import cycle.
 *
 * Why this exists (the bug it locks out): processpiper's BPMN export is lossy —
 * it emits every task as a plain <bpmn:task> and stuffs the type into the name
 * ("@user ..."). If the rendered .bpmn came from processpiper, re-importing it
 * dropped the userTask type, and the stall check then gave a FALSE 'sound' on
 * our own showcase artifact — the exact wedge undermined. The fix: the semantic
 * .bpmn ALWAYS comes from the direct AST emitter (which preserves task types).
 * This test proves the round-trip is faithful, so the wedge holds on Baton's
 * own demo artifacts, not just on real Camunda exports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiperFlow } from '../src/compiler/parse.js';
import { emitBpmn } from '../src/actions/bpmn.js';
import { importBpmn } from '../src/compiler/bpmn-import.js';
import { checkReliability } from '../src/compiler/soundness.js';

// A minimal process with a @user (approval) task and a @service task.
const PF = `title: Round Trip
lane: Ops
    (start) as s
    [@user Approve] as approve
    [@service Execute] as execute
    (end) as e
s -> approve -> execute -> e`;

test('round-trip: @user task type survives .pf → .bpmn → re-import', () => {
  const ast = parsePiperFlow(PF);
  const xml = emitBpmn(ast, { slug: 'round-trip' });
  const reimported = importBpmn(xml);

  const approve = reimported.elements.find((e) => e.label.toLowerCase().includes('approve'));
  assert.ok(approve, 'approve task should survive round-trip');
  assert.equal(approve!.taskType, 'user', '@user MUST round-trip as taskType "user"');
});

test('round-trip: @service task type also survives', () => {
  const ast = parsePiperFlow(PF);
  const reimported = importBpmn(emitBpmn(ast, { slug: 'round-trip' }));
  const execute = reimported.elements.find((e) => e.label.toLowerCase().includes('execute'));
  assert.ok(execute);
  assert.equal(execute!.taskType, 'service');
});

test('round-trip: the @user approval STILL trips the stall check after re-import', () => {
  // This is the wedge-protection assertion: a stallable approval must be caught
  // even after going through BPMN, not just on the original .pf.
  const ast = parsePiperFlow(PF);
  const reimported = importBpmn(emitBpmn(ast, { slug: 'round-trip' }));
  const issues = checkReliability(reimported);
  const stall = issues.find((i) => i.kind === 'stall-vulnerable');
  assert.ok(stall, 'the @user approval must still be flagged stall-vulnerable after BPMN round-trip');
});

test('round-trip: emitted BPMN uses the typed tag, not a plain <task>', () => {
  // Belt-and-suspenders: assert the direct emitter writes <bpmn:userTask>, which
  // is what real BPMS exports (Camunda/Signavio) also write — so the importer's
  // stall detection is identical for Baton artifacts and third-party exports.
  const ast = parsePiperFlow(PF);
  const xml = emitBpmn(ast, { slug: 'round-trip' });
  assert.match(xml, /<bpmn:userTask[^>]*name="Approve"/);
  assert.match(xml, /<bpmn:serviceTask[^>]*name="Execute"/);
  assert.doesNotMatch(xml, /<bpmn:task\s/); // no lossy plain-task tags
});
