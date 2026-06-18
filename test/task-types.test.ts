/**
 * Task-type tests — BPMN Task sub-types mapped to the capability model.
 *
 * Tier B of the full-BPMN roadmap. BPMN doesn't have one "task" — it has
 * Service, User, Business-Rule, Send, Receive, Manual, and Script tasks, each
 * with distinct execution semantics. These tests pin the declarative mapping:
 * the @marker in PiperFlow → taskType on the AST → the correct BPMN tag in the
 * emitted XML → the right executor hint in the generated Flue workflow.
 *
 * Run:  node --import tsx --test test/task-types.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiperFlow, ParseError } from '../src/compiler/parse.js';
import { emitBpmn } from '../src/actions/bpmn.js';
import { emitFlueWorkflow } from '../src/compiler/emit.js';

/** A minimal process with one task of the given marker form. */
function withTask(marker: string): string {
  const decl = marker ? `[@${marker} Some Step] as step` : `[Some Step] as step`;
  return `title: t
lane: A
(start) as s
${decl}
(end) as e
s -> step -> e`;
}

function count(xml: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return (xml.match(new RegExp(re.source, flags)) ?? []).length;
}

// ---------------------------------------------------------------------------
// Parser: each marker → the right taskType (variant stays 'task').
// ---------------------------------------------------------------------------

test('parser: a plain task has variant "task" and no taskType', () => {
  const ast = parsePiperFlow(withTask(''));
  const step = ast.elements.find((e) => e.id === 'step')!;
  assert.equal(step.variant, 'task');
  assert.equal(step.taskType, undefined);
});

test('parser: @subprocess stays a separate axis (variant "subprocess", no taskType)', () => {
  const ast = parsePiperFlow(`title: t
lane: A
(start) as s
[@subprocess Do Thing] as sub
(end) as e
s -> sub -> e`);
  const sub = ast.elements.find((e) => e.id === 'sub')!;
  assert.equal(sub.variant, 'subprocess');
  assert.equal(sub.taskType, undefined);
});

test('parser: maps every task sub-type marker to its taskType', () => {
  const cases: [string, string][] = [
    ['service', 'service'],
    ['user', 'user'],
    ['business-rule', 'businessRule'],
    ['rule', 'businessRule'],
    ['send', 'send'],
    ['receive', 'receive'],
    ['manual', 'manual'],
    ['script', 'script'],
  ];
  for (const [marker, expected] of cases) {
    const ast = parsePiperFlow(withTask(marker));
    const step = ast.elements.find((e) => e.id === 'step')!;
    assert.equal(step.variant, 'task', `${marker}: variant stays task`);
    assert.equal(step.taskType, expected, `${marker} → ${expected}`);
  }
});

test('parser: rejects an unknown activity marker (precise, feeds self-healing)', () => {
  assert.throws(
    () => parsePiperFlow(withTask('bogus')),
    (err: unknown) => err instanceof ParseError && /bogus/.test((err as Error).message),
  );
});

// ---------------------------------------------------------------------------
// BPMN emitter: taskType → the correct OMG BPMN tag.
// ---------------------------------------------------------------------------

test('emit: each taskType maps to its BPMN tag', () => {
  const cases: [string, string][] = [
    ['', 'task'],
    ['service', 'serviceTask'],
    ['user', 'userTask'],
    ['business-rule', 'businessRuleTask'],
    ['send', 'sendTask'],
    ['receive', 'receiveTask'],
    ['manual', 'manualTask'],
    ['script', 'scriptTask'],
  ];
  for (const [marker, tag] of cases) {
    const xml = emitBpmn(parsePiperFlow(withTask(marker)), { slug: 't' });
    assert.equal(count(xml, new RegExp(`<bpmn:${tag}\\b`)), 1, `${marker || 'plain'} → ${tag}`);
  }
});

test('emit: the full taxonomy round-trips into distinct BPMN tags', () => {
  const dsl = `title: all tasks
lane: Eng
(start) as s
[plain] as plain
[@service svc] as svc
[@user usr] as usr
[@business-rule br] as br
[@send snd] as snd
[@receive rcv] as rcv
[@script scr] as scr
[@manual man] as man
(end) as e
s->plain->svc->usr->br->snd->rcv->scr->man->e`;
  const xml = emitBpmn(parsePiperFlow(dsl), { slug: 'all' });
  // Exactly one of each task tag — the taxonomy is preserved, not collapsed.
  for (const tag of ['task', 'serviceTask', 'userTask', 'businessRuleTask', 'sendTask', 'receiveTask', 'scriptTask', 'manualTask']) {
    assert.equal(count(xml, new RegExp(`<bpmn:${tag}\\b`)), 1, `one ${tag}`);
  }
});

// ---------------------------------------------------------------------------
// Flue codegen: task semantics visible in generated code; manual is a no-op.
// ---------------------------------------------------------------------------

test('codegen: each typed task carries a semantic hint comment', () => {
  const dsl = `title: cg
lane: Eng
(start) as s
[@service deploy] as deploy
[@user review] as review
[@business-rule risk] as risk
[@send notify] as notify
[@receive payment] as payment
[@script compute] as compute
(end) as e
s->deploy->review->risk->notify->payment->compute->e`;
  const code = emitFlueWorkflow(parsePiperFlow(dsl), { name: 'cg', model: 'vllm/x' });
  assert.match(code, /service task — invoke a deterministic tool/);
  assert.match(code, /user task — human-in-the-loop/);
  assert.match(code, /business-rule task — evaluate a rule/);
  assert.match(code, /send task — emit a message/);
  assert.match(code, /receive task — await an inbound message/);
  assert.match(code, /script task — deterministic inline code/);
});

test('codegen: a manual task is a no-op (no session.task — the human does it offline)', () => {
  const dsl = `title: cg
lane: Eng
(start) as s
[@manual Approve Expense] as approve
(end) as e
s -> approve -> e`;
  const code = emitFlueWorkflow(parsePiperFlow(dsl), { name: 'cg', model: 'vllm/x' });
  assert.match(code, /manual task — performed by a human outside the system/);
  // The defining property of a BPMN manual task: it is NOT automated, so it
  // must not produce a session.task() delegation.
  assert.doesNotMatch(code, /session\.task\("Approve Expense"/);
});
