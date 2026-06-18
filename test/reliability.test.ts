/**
 * Reliability-layer tests: stall-vulnerability + orphan-escalation.
 *
 * These prove the "escalation" half of the product works — the differentiated
 * analysis no BPMS does statically. Two cases each:
 *   - a stalled approval (userTask with no timer/escalation) → flagged
 *   - the same task WITH a rescuing timer boundary → NOT flagged
 *   - an escalation boundary referencing an undefined escalation → orphan flagged
 *
 * Built on hand-crafted BPMN (boundary events only come from BPMN import —
 * PiperFlow DSL doesn't author them yet) so the test exercises the real import
 * path that Camunda/Signavio exports would hit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBpmn } from '../src/compiler/bpmn-import.js';
import { checkReliability, checkSoundness } from '../src/compiler/soundness.js';

/** Build a minimal BPMN process XML with a single userTask. */
function bpmnWith(opts: {
  taskId?: string;
  taskType?: 'userTask' | 'serviceTask' | 'manualTask' | 'receiveTask' | 'task';
  boundary?: { type: string; interrupting?: boolean; escalationRef?: string; attachedTo?: string }[];
  escalationDefs?: { id: string; code?: string }[];
}): string {
  const taskId = opts.taskId ?? 'approve';
  const taskType = opts.taskType ?? 'userTask';
  const boundaries = (opts.boundary ?? []).map((b, i) => {
    const cid = b.attachedTo ?? taskId;
    const cancel = b.interrupting === false ? ' cancelActivity="false"' : '';
    const def =
      b.type === 'timer' ? '<bpmn:timerEventDefinition><bpmn:timeDuration>PT2D</bpmn:timeDuration></bpmn:timerEventDefinition>' :
      b.type === 'escalation' ? `<bpmn:escalationEventDefinition escalationRef="${b.escalationRef ?? 'esc1'}"/>` :
      b.type === 'message' ? '<bpmn:messageEventDefinition/>' :
      '<bpmn:signalEventDefinition/>';
    return `<bpmn:boundaryEvent id="b${i}" attachedToRef="${cid}"${cancel}>${def}</bpmn:boundaryEvent>`;
  }).join('');
  const escalationDefs = (opts.escalationDefs ?? []).map((e) =>
    `<bpmn:escalation id="${e.id}"${e.code ? ` escalationCode="${e.code}"` : ''}/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://baton">
  ${escalationDefs}
  <bpmn:process id="proc" name="Test Process" isExecutable="false">
    <bpmn:startEvent id="start" name="Start"/>
    <bpmn:${taskType} id="${taskId}" name="Do the task"/>
    <bpmn:endEvent id="end" name="End"/>
    ${boundaries}
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="${taskId}"/>
    <bpmn:sequenceFlow id="f2" sourceRef="${taskId}" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`;
}

test('reliability: a userTask with NO boundary is stall-vulnerable', () => {
  const ast = importBpmn(bpmnWith({ taskType: 'userTask' }));
  const issues = checkReliability(ast);
  const stall = issues.find((i) => i.kind === 'stall-vulnerable');
  assert.ok(stall, 'expected a stall-vulnerable defect');
  assert.match(stall!.message, /Do the task/);
  assert.deepEqual(stall!.elementIds, ['approve']);
});

test('reliability: a userTask WITH an interrupting timer boundary is rescued', () => {
  const ast = importBpmn(bpmnWith({ taskType: 'userTask', boundary: [{ type: 'timer' }] }));
  const issues = checkReliability(ast);
  assert.equal(issues.filter((i) => i.kind === 'stall-vulnerable').length, 0, 'timer boundary should rescue the task');
});

test('reliability: an interrupting escalation boundary also rescues', () => {
  const ast = importBpmn(bpmnWith({
    taskType: 'userTask',
    boundary: [{ type: 'escalation', escalationRef: 'esc1' }],
    escalationDefs: [{ id: 'esc1', code: 'SLA-BREACH' }],
  }));
  const issues = checkReliability(ast);
  assert.equal(issues.filter((i) => i.kind === 'stall-vulnerable').length, 0, 'escalation boundary should rescue the task');
});

test('reliability: a NON-interrupting timer does NOT rescue (it only adds work)', () => {
  const ast = importBpmn(bpmnWith({ taskType: 'userTask', boundary: [{ type: 'timer', interrupting: false }] }));
  const issues = checkReliability(ast);
  const stall = issues.find((i) => i.kind === 'stall-vulnerable');
  assert.ok(stall, 'non-interrupting timer should NOT rescue the task — original wait can still stall');
});

test('reliability: a serviceTask (automated) is never stall-vulnerable', () => {
  const ast = importBpmn(bpmnWith({ taskType: 'serviceTask' }));
  const issues = checkReliability(ast);
  assert.equal(issues.filter((i) => i.kind === 'stall-vulnerable').length, 0, 'service tasks cannot stall');
});

test('reliability: a receiveTask (waiting for a message) IS stall-vulnerable without a boundary', () => {
  const ast = importBpmn(bpmnWith({ taskType: 'receiveTask' }));
  const issues = checkReliability(ast);
  assert.ok(issues.find((i) => i.kind === 'stall-vulnerable'), 'receive tasks wait for external messages — stallable');
});

test('reliability: orphan escalation — boundary refs undefined escalation → flagged', () => {
  const ast = importBpmn(bpmnWith({
    taskType: 'userTask',
    boundary: [{ type: 'escalation', escalationRef: 'ghost' }],
    escalationDefs: [{ id: 'esc1', code: 'REAL' }], // 'ghost' is not defined
  }));
  const issues = checkReliability(ast);
  const orphan = issues.find((i) => i.kind === 'orphan-escalation');
  assert.ok(orphan, 'escalation referencing an undefined escalation should be flagged as orphan');
  assert.match(orphan!.message, /ghost/);
});

test('reliability: a sound control-flow process with a stall still reports as unsound via the merged CLI view', () => {
  // This mirrors what the CLI does: merge soundness + reliability. A process
  // that is control-flow sound but has a stall-vulnerable approval is, for
  // deployment purposes, unsound.
  const ast = importBpmn(bpmnWith({ taskType: 'userTask' }));
  const soundness = checkSoundness(ast);
  const reliability = checkReliability(ast);
  const mergedSound = soundness.sound && reliability.length === 0;
  assert.equal(mergedSound, false, 'stall-vulnerable task should make the merged verdict unsound');
});

test('reliability: boundary events are attached to the host element in the AST', () => {
  const ast = importBpmn(bpmnWith({
    taskType: 'userTask',
    boundary: [{ type: 'timer' }],
  }));
  const task = ast.elements.find((e) => e.id === 'approve');
  assert.ok(task?.boundaryEvents, 'host element should carry its boundary events');
  assert.equal(task!.boundaryEvents!.length, 1);
  assert.equal(task!.boundaryEvents![0].type, 'timer');
  assert.equal(task!.boundaryEvents![0].interrupting, true);
  assert.equal(task!.boundaryEvents![0].attachedTo, 'approve');
});
