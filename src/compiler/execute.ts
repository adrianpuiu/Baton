import * as v from 'valibot';
import type { ProcessAST } from './types.js';
import { isStart, isParallel } from './types.js';

export interface ExecutionStep {
  id: string;
  label: string;
  lane: string;
  kind: string;
  text?: string;
  decision?: 'yes' | 'no';
}

export interface ExecutionResult {
  title: string;
  steps: ExecutionStep[];
}

const Decision = v.object({ answer: v.picklist(['yes', 'no']) });

/** Structured logger surface the executor emits gateway decisions + warnings through. */
export interface StepLogger {
  info: (message: string, attributes?: Record<string, unknown>) => void;
  warn?: (message: string, attributes?: Record<string, unknown>) => void;
}

/** Minimal session surface executeProcess needs. */
export interface LaneSession {
  prompt: (text: string, opts?: Record<string, unknown>) => Promise<{ text?: string; data?: unknown }>;
}

/**
 * Execute a ProcessAST live.
 *
 * Each swimlane is its own named Flue session (an independent conversation),
 * so a lane is genuinely a persistent actor with its own context.
 *   - exclusive/event gateway → ask for a yes/no decision, branch.
 *   - parallel/inclusive gateway → fan out over all branches; different lanes
 *     run concurrently, but prompts within a single lane are SERIALIZED (Flue
 *     sessions are single-operation, so same-lane prompts would otherwise throw
 *     "session is busy" and race on shared per-lane state).
 * Every prompt is an observable event (→ OpenTelemetry span).
 */
export async function executeProcess(
  ast: ProcessAST,
  openSession: (name: string) => Promise<LaneSession>,
  model: string,
  log?: StepLogger,
  opts?: { stepTimeoutMs?: number },
): Promise<ExecutionResult> {
  // Bounded execution: each model call is capped so a degenerate thinking
  // loop (a known failure mode of hybrid reasoning models) can't hang the
  // whole pipeline. Default 120s/step; override via STEP_TIMEOUT_MS.
  const stepTimeoutMs = opts?.stepTimeoutMs ?? Number(process.env.STEP_TIMEOUT_MS ?? 120_000);
  const byId = new Map(ast.elements.map((e) => [e.id, e] as const));
  const outFrom = (id: string) => ast.edges.filter((e) => e.from === id);

  // One real Flue session per lane. We cache the OPENING promise (not the
  // resolved session) so concurrent first-callers on the same lane share one
  // session instead of each opening their own.
  const sessions = new Map<string, Promise<LaneSession>>();
  const getSession = (lane: string): Promise<LaneSession> =>
    sessions.get(lane) ?? sessions.set(lane, openSession(lane)).get(lane)!;

  // Prompts on a lane are SERIALIZED via a per-lane promise chain. The chain is
  // read and updated with no await in between, so concurrent prompts queue in
  // call order; different lanes keep independent chains and still run in
  // parallel. Matches the codegen emitter (ADR-6) and stops parallel-gateway
  // branches from colliding on a shared lane session.
  const laneChains = new Map<string, Promise<unknown>>();
  const prompt = async (
    lane: string,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ text?: string; data?: unknown }> => {
    const session = await getSession(lane);
    const prev = laneChains.get(lane) ?? Promise.resolve();
    // Per-step timeout: abort a stuck model call (degenerate thinking loop)
    // instead of hanging forever. The signal is attached to this hop only.
    const signal = AbortSignal.timeout(stepTimeoutMs);
    const next = prev.then(() => session.prompt(text, { ...opts, signal }));
    // Drop the outcome from the chain so one rejected prompt can't poison (and
    // stall) the rest of the lane's queue.
    laneChains.set(lane, next.then(() => undefined, () => undefined));
    return next;
  };

  /** Detect a degenerate repetition loop in the model's text output. */
  const looksDegenerate = (s: string | undefined): boolean => {
    const t = (s ?? '').trim();
    if (t.length < 80) return false;
    // A 40-char window that appears 8+ times (non-overlapping) is almost
    // certainly a repetition loop. Robust for both short-unit loops (a phrase)
    // and long-unit loops (a whole reasoning block) that thinking models emit.
    const window = t.slice(0, 40);
    const hits = (t.match(new RegExp(window.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    return hits >= 8;
  };

  const steps: ExecutionStep[] = [];

  const visit = async (id: string, visited: Set<string>): Promise<void> => {
    if (visited.has(id)) return;
    visited.add(id);
    const el = byId.get(id);
    if (!el) return;

    if (el.category === 'event') {
      for (const e of outFrom(id)) await visit(e.to, visited);
      return;
    }

    const role = `Process "${ast.title}" — you are the "${el.lane}" swimlane. Be brief.`;

    if (el.category === 'activity') {
      let text: string | undefined;
      try {
        ({ text } = await prompt(el.lane, `${role}\n\nPerform this step and report the outcome in one sentence:\n${el.label}`, { model }));
      } catch (e) {
        text = `[step aborted: ${(e as Error).name === 'TimeoutError' ? `timed out after ${Math.round(stepTimeoutMs / 1000)}s` : (e as Error).message}]`;
        log?.warn?.('step aborted', { lane: el.lane, label: el.label, error: (e as Error).message });
      }
      if (looksDegenerate(text)) {
        text = `[degenerate model output detected — step terminated]`;
        log?.warn?.('degenerate model output', { lane: el.lane, label: el.label });
      }
      steps.push({ id: el.id, label: el.label, lane: el.lane, kind: el.variant, text: (text ?? '').slice(0, 200) });
      for (const e of outFrom(id)) await visit(e.to, visited);
      return;
    }

    // gateway
    const outs = outFrom(id);

    if (!isParallel(el) && el.variant !== 'inclusive') {
      // exclusive / event — binary decision
      let answer: 'yes' | 'no' = 'no';
      try {
        const { data } = await prompt(
          el.lane,
          `${role}\n\nDecision point: "${el.label}". Based on the process, answer yes or no.`,
          { model, result: Decision },
        );
        answer = (data as { answer: 'yes' | 'no' }).answer;
      } catch (e) {
        log?.warn?.('gateway decision aborted — defaulting to no', { lane: el.lane, label: el.label, error: (e as Error).message });
      }
      steps.push({ id: el.id, label: el.label, lane: el.lane, kind: 'gateway', decision: answer });
      log?.info('gateway decision', { lane: el.lane, label: el.label, decision: answer });
      const yes = outs.find((e) => /^y/i.test(e.label ?? '')) ?? outs[0];
      const no = outs.find((e) => e !== yes);
      if (answer === 'yes' && yes) await visit(yes.to, visited);
      else if (no) await visit(no.to, visited);
      return;
    }

    // parallel / inclusive — fan out to all branches concurrently
    steps.push({ id: el.id, label: el.label, lane: el.lane, kind: el.variant });
    await Promise.all(outs.map((o) => visit(o.to, new Set(visited))));
  };

  const start = ast.elements.find(isStart);
  if (start) await visit(start.id, new Set());
  return { title: ast.title, steps };
}
