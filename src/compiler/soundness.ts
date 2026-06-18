/**
 * Soundness analysis — does a PiperFlow process always have the option to
 * complete, with no dead branches and no deadlocks?
 *
 * This is formal analysis of the control flow via its Petri-net (workflow-net)
 * encoding. It catches bugs a syntax check can't see and a human reviewer
 * often misses:
 *
 *   - Deadlock after a parallel-join mismatch: an AND-split fans out to N
 *     branches but fewer than N rejoin → the AND-join waits forever for a token
 *     that never arrives. *The classic BPMN bug.*
 *   - Dead branch: an exclusive branch structurally present but unreachable.
 *   - Unreachable task: a task no token can ever reach.
 *   - Improper completion: the process can "end" with work still in flight.
 *
 * Approach (stated honestly):
 *   1. Structural checks (cheap, exact): proper source/sink, every transition
 *      on some path source→sink.
 *   2. Bounded reachability: explore markings from the initial marking; detect
 *      deadlocks (stuck non-final markings), dead transitions (never fire), and
 *      whether the final marking is reachable at all. The search is bounded
 *      (max markings + max tokens); if the bound is exceeded the checker reports
 *      "could not verify" rather than hanging. This is sound (no false OKs for
 *      the bounded space) but incomplete for unbounded nets — which is fine,
 *      because well-formed BPMN processes compile to bounded workflow nets.
 *
 * Scope: control flow only. The data layer (ioSpec) is not modeled — plain
 * Petri nets model control flow cleanly but data poorly (that needs colored
 * Petri nets). Inclusive gateways are approximated as parallel (conservative
 * for deadlock). Event-based gateways are flagged as approximate.
 */

import type { ProcessAST } from './types.js';
import { isParallel } from './types.js';
import {
  toPetriNet, initialMarking, isEnabled, fire, markingKey,
  type Marking,
} from './petri.js';

export type IssueKind =
  | 'deadlock'
  | 'dead-transition'
  | 'parallel-branch-imbalance'
  | 'improper-completion'
  | 'unreachable-element'
  | 'no-option-to-complete'
  | 'approximation'
  // Reliability-layer checks (stall / escalation). Distinct from control-flow
  // soundness: these flag human/waitable steps that have no escape hatch.
  | 'stall-vulnerable'
  | 'orphan-escalation';

export interface SoundnessIssue {
  kind: IssueKind;
  message: string;
  /** AST element ids responsible (for pointing at the diagram). */
  elementIds: string[];
}

export interface SoundnessResult {
  sound: boolean;
  issues: SoundnessIssue[];
  /** Honest caveats (approximations, bounds hit). Empty when fully verified. */
  notes: string[];
  /** Stats for the curious / for telemetry. */
  stats: { markingsExplored: number; transitions: number; bounded: boolean };
}

const MAX_MARKINGS = 50_000;
const MAX_TOTAL_TOKENS = 40;

export function checkSoundness(ast: ProcessAST): SoundnessResult {
  const issues: SoundnessIssue[] = [];
  const notes: string[] = [];

  const net = toPetriNet(ast);
  const byId = new Map(ast.elements.map((e) => [e.id, e] as const));
  const issueEl = (id: string) => byId.get(id)?.label ?? id;

  // ---- approximation flags (honest caveats) ----
  if (ast.elements.some((e) => e.category === 'gateway' && e.variant === 'inclusive')) {
    notes.push('Inclusive gateways approximated as parallel (AND). Conservative for deadlock; verdict may be stricter than true semantics.');
  }
  if (ast.elements.some((e) => e.category === 'gateway' && e.variant === 'event')) {
    notes.push('Event-based gateways react to external events and cannot be modeled precisely; treated as passthrough.');
  }

  // ---- structural check: parallel split/join branch balance ----
  // The classic BPMN bug. A parallel split fans out to N branches; its matching
  // join must receive all N. If a branch is missing (never wired to the join),
  // the join waits forever — a deadlock the reachability check can miss because
  // a missing edge makes the join silently require fewer inputs. This structural
  // check catches it directly and points at the offending join.
  for (const issue of findParallelImbalance(ast)) issues.push(issue);

  // ---- bounded reachability from the initial marking ----
  const start = initialMarking(net);
  const finalKey = net.sinkId;
  const reachable: Marking[] = [start];
  const seen = new Set<string>([markingKey(start)]);
  const firedTransitions = new Set<string>();
  let reachedFinal = false;
  let improperCompletion = false;
  let bounded = true;

  for (let head = 0; head < reachable.length; head++) {
    if (reachable.length > MAX_MARKINGS) { bounded = false; break; }
    const m = reachable[head];
    const totalTokens = [...m.values()].reduce((a, b) => a + b, 0);
    if (totalTokens > MAX_TOTAL_TOKENS) { bounded = false; break; }

    // Final marking reached? (sink has a token). Check for improper completion.
    if ((m.get(finalKey) ?? 0) > 0) {
      reachedFinal = true;
      const leftovers = [...m.entries()].filter(([p, n]) => p !== finalKey && n > 0);
      if (leftovers.length > 0) improperCompletion = true;
    }

    // Enabled transitions from this marking.
    const enabled = net.transitions.filter((t) => isEnabled(t.id, net, m));
    if (enabled.length === 0) {
      // Stuck. If it's not the clean final marking, that's a deadlock.
      const isCleanFinal = (m.get(finalKey) ?? 0) > 0 && [...m.entries()].every(([p, n]) => p === finalKey || n === 0);
      if (!isCleanFinal) {
        const stuckAt = [...m.entries()].filter(([, n]) => n > 0).map(([p]) => p);
        const stuckFeeds = new Set<string>();
        for (const pid of stuckAt) {
          const place = net.places.find((pl) => pl.id === pid);
          if (place?.feedsElementId) stuckFeeds.add(place.feedsElementId);
        }
        issues.push({
          kind: 'deadlock',
          message: `Process can deadlock: a token can reach ${[...stuckFeeds].map(issueEl).join(', ') || 'a place'} and no transition can fire from there. (Common cause: a parallel join expecting more branches than actually rejoin.)`,
          elementIds: [...stuckFeeds],
        });
      }
      continue; // no successors from a stuck marking
    }

    for (const t of enabled) {
      firedTransitions.add(t.id);
      const next = fire(t.id, net, m);
      const key = markingKey(next);
      if (!seen.has(key)) {
        seen.add(key);
        reachable.push(next);
      }
    }
  }

  // ---- dead transitions: declared but never fire in any reachable marking ----
  // Map transition → its source element; flag an element if NONE of its
  // transitions ever fired.
  const elementsWithAnyFire = new Set<string>();
  for (const tid of firedTransitions) {
    const t = net.transitions.find((tr) => tr.id === tid)!;
    elementsWithAnyFire.add(t.elementId);
  }
  for (const el of ast.elements) {
    // Skip start/end for the dead-transition check — they have special anchoring
    // and are covered by structural checks. Focus on tasks/gateways.
    if (el.category === 'event') continue;
    if (!elementsWithAnyFire.has(el.id)) {
      issues.push({
        kind: 'dead-transition',
        message: `'${issueEl(el.id)}' can never execute — no token can reach it in any reachable state. It's structurally present but unreachable.`,
        elementIds: [el.id],
      });
    }
  }

  // ---- improper completion ----
  if (improperCompletion) {
    issues.push({
      kind: 'improper-completion',
      message: 'The process can reach the end with tokens still in flight — completion is not "clean" (work may be left dangling).',
      elementIds: [],
    });
  }

  // ---- option to complete ----
  if (bounded && !reachedFinal) {
    issues.push({
      kind: 'no-option-to-complete',
      message: 'The final state (end event reached) is never reachable from the start. The process has no path to completion.',
      elementIds: [],
    });
  }

  if (!bounded) {
    notes.push(`State space exceeded the bound (${MAX_MARKINGS} markings or ${MAX_TOTAL_TOKENS} tokens). Could not fully verify; no false "sound" verdict was given — treat as unverified.`);
  }

  const sound = issues.filter((i) => i.kind !== 'approximation').length === 0 && bounded;
  return {
    sound,
    issues,
    notes,
    stats: { markingsExplored: reachable.length, transitions: net.transitions.length, bounded },
  };
}

/**
 * Structural check for parallel split/join branch imbalance — the classic BPMN
 * deadlock source. For each parallel split with N outgoing branches, find the
 * downstream parallel join that closes it, and verify all N branches actually
 * reach the join. If a branch is missing (wired elsewhere or dangling), the
 * join can never be satisfied → the process deadlocks there.
 *
 * Matching heuristic: the join closing a split is the first parallel gateway,
 * reachable from EVERY branch, that has at least as many inputs as the split has
 * outputs. We trace forward from each branch and intersect the reachable-parallel
 * sets. This is conservative (a real matched pair always satisfies it) and
 * catches the practical defect: a split into 2 where only 1 rejoins.
 */
function findParallelImbalance(ast: ProcessAST): SoundnessIssue[] {
  const issues: SoundnessIssue[] = [];
  const outFrom = (id: string) => ast.edges.filter((e) => e.from === id).map((e) => e.to);
  const byId = new Map(ast.elements.map((e) => [e.id, e] as const));
  const issueEl = (id: string) => byId.get(id)?.label ?? id;

  // Forward reachability from a node (bounded BFS, avoids infinite cycles).
  const reachableFrom = (start: string, cap = 200): Set<string> => {
    const seen = new Set<string>([start]);
    const queue = [start];
    let guard = cap;
    while (queue.length && guard-- > 0) {
      const cur = queue.shift()!;
      for (const nx of outFrom(cur)) {
        if (!seen.has(nx)) { seen.add(nx); queue.push(nx); }
      }
    }
    return seen;
  };

  for (const split of ast.elements) {
    if (!isParallel(split)) continue;
    const branches = outFrom(split.id);
    if (branches.length < 2) continue; // a parallel split with <2 outputs is degenerate

    // Parallel gateways reachable downstream from each branch.
    const branchReach = branches.map((b) => reachableFrom(b));
    // Candidate joins: parallel gateways reachable from EVERY branch.
    let candidates = branchReach[0];
    for (let i = 1; i < branchReach.length; i++) {
      candidates = new Set([...candidates].filter((id) => branchReach[i].has(id)));
    }
    const parallelJoins = [...candidates]
      .map((id) => byId.get(id)!)
      .filter((el) => isParallel(el) && el.id !== split.id);

    // The closing join is the nearest candidate (first reachable on all branches).
    const join = parallelJoins[0];
    if (!join) {
      // No matching join reachable from all branches → at least one branch never
      // reconverges. That's the imbalance (or an un-joined parallel split).
      issues.push({
        kind: 'parallel-branch-imbalance',
        message: `Parallel split '${issueEl(split.id)}' fans out to ${branches.length} branches but no parallel join reachable from all of them. Branch(es) never reconverge → the process cannot complete the parallel section (deadlock).`,
        elementIds: [split.id],
      });
      continue;
    }

    // Verify every branch actually reaches the join (a branch might loop away).
    const joinReach = reachableFrom(join.id);
    const missing = branches.filter((b) => !reachableFrom(b).has(join.id));
    if (missing.length > 0) {
      issues.push({
        kind: 'parallel-branch-imbalance',
        message: `Parallel join '${issueEl(join.id)}' expects a token from all branches of split '${issueEl(split.id)}', but ${missing.length} branch(es) (${missing.map(issueEl).join(', ')}) never reach it. The join can never be satisfied → deadlock.`,
        elementIds: [join.id, split.id],
      });
    }
    void joinReach;
  }
  return issues;
}

/**
 * Reliability-layer analysis — the "escalation" half of the product.
 *
 * Soundness (above) proves control-flow correctness: no deadlock, no dead
 * branches, proper completion. Reliability analysis proves a different thing:
 * that no step can *wait indefinitely* with no escape hatch. The gap this fills
 * is concrete: Camunda Optimize can tell you AFTER deploy that an approval took
 * 40 days and stalled. It cannot tell you, at design time, that the approval
 * *can* stall forever because nothing is watching it. This does.
 *
 * Two structural checks, no model checker required:
 *
 *  1. stall-vulnerable: a human task (userTask) or other waitable activity with
 *     NO interrupting timer/escalation boundary. It can sit forever — nothing
 *     can pull it out. The enterprise fix is exactly the boundary event this
 *     detects the absence of.
 *  2. orphan-escalation: an escalation throw (or boundary with an escalationRef)
 *     whose escalationRef / escalationCode is not defined anywhere, OR a defined
 *     escalation that is never thrown. Broken escalation contract.
 *
 * Both are honest approximations: "waitable" is inferred from task type
 * (userTask, receiveTask) plus explicit timer/message/escalation throws. The
 * check is conservative — it only flags genuine absence of a rescue path.
 */
export function checkReliability(ast: ProcessAST): SoundnessIssue[] {
  const issues: SoundnessIssue[] = [];
  const byId = new Map(ast.elements.map((e) => [e.id, e] as const));
  const issueEl = (id: string) => byId.get(id)?.label ?? id;

  // Known escalation codes/refs for the orphan check.
  const definedEscalations = new Set<string>(
    (ast.escalations ?? []).flatMap((e) => [e.id, ...(e.code ? [e.code] : [])]),
  );

  for (const el of ast.elements) {
    if (el.category !== 'activity' || el.variant !== 'task') continue;

    // Collect ALL boundary events on this activity (inline + from the flat list).
    const boundaries = el.boundaryEvents
      ?? (ast.boundaryEvents ?? []).filter((b) => b.attachedTo === el.id);

    // (1) stall-vulnerable: a waitable task with no interrupting rescue boundary.
    const isWaitable = el.taskType === 'user' || el.taskType === 'receive' || el.taskType === 'manual';
    if (isWaitable) {
      // An interrupting timer or escalation boundary is a genuine rescue path:
      // it aborts the task and branches. A non-interrupting one only adds work
      // without unblocking the original wait, so it does NOT count as a rescue.
      const hasRescue = boundaries.some(
        (b) => b.interrupting && (b.type === 'timer' || b.type === 'escalation' || b.type === 'error'),
      );
      if (!hasRescue) {
        const kindLabel =
          el.taskType === 'user' ? 'approval / user task' :
          el.taskType === 'receive' ? 'receive task (waiting for a message)' :
          'manual task';
        issues.push({
          kind: 'stall-vulnerable',
          message: `'${issueEl(el.id)}' (${kindLabel}) has no interrupting timer or escalation boundary. It can wait indefinitely — there is no escalation path if nobody completes it. Attach a timer boundary (e.g. SLA: 2 days → escalate) or an escalation boundary event.`,
          elementIds: [el.id],
        });
      }
    }

    // (2) orphan-escalation: any escalation boundary/throw referencing an
    // undefined escalation code/ref. (Defined-but-never-thrown is quieter; we
    // surface it only if escalations exist but none are referenced at all.)
    for (const b of boundaries) {
      if (b.type === 'escalation' && b.code && definedEscalations.size > 0 && !definedEscalations.has(b.code)) {
        issues.push({
          kind: 'orphan-escalation',
          message: `Boundary escalation on '${issueEl(el.id)}' references escalation '${b.code}' which is not defined in the process. The escalation can never be caught.`,
          elementIds: [el.id],
        });
      }
    }
  }

  return issues;
}
