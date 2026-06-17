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

/** Structured logger surface the executor emits gateway decisions through. */
export interface StepLogger {
  info: (message: string, attributes?: Record<string, unknown>) => void;
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
 *   - parallel/inclusive gateway → Promise.all over all outgoing branches.
 * Every prompt is an observable event (→ OpenTelemetry span).
 */
export async function executeProcess(
  ast: ProcessAST,
  openSession: (name: string) => Promise<LaneSession>,
  model: string,
  log?: StepLogger,
): Promise<ExecutionResult> {
  const byId = new Map(ast.elements.map((e) => [e.id, e] as const));
  const outFrom = (id: string) => ast.edges.filter((e) => e.from === id);

  const laneSessions = new Map<string, LaneSession>();
  const getSession = async (lane: string): Promise<LaneSession> => {
    if (!laneSessions.has(lane)) laneSessions.set(lane, await openSession(lane));
    return laneSessions.get(lane)!;
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

    const session = await getSession(el.lane);
    const role = `Process "${ast.title}" — you are the "${el.lane}" swimlane. Be brief.`;

    if (el.category === 'activity') {
      const { text } = await session.prompt(`${role}\n\nPerform this step and report the outcome in one sentence:\n${el.label}`, { model });
      steps.push({ id: el.id, label: el.label, lane: el.lane, kind: el.variant, text: (text ?? '').slice(0, 200) });
      for (const e of outFrom(id)) await visit(e.to, visited);
      return;
    }

    // gateway
    const outs = outFrom(id);

    if (!isParallel(el) && el.variant !== 'inclusive') {
      // exclusive / event — binary decision
      const { data } = await session.prompt(
        `${role}\n\nDecision point: "${el.label}". Based on the process, answer yes or no.`,
        { model, result: Decision },
      );
      const answer = (data as { answer: 'yes' | 'no' }).answer;
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
