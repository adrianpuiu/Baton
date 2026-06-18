import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One line per Flue event from the local sink. */
export interface FlueEventRecord {
  type: string;
  timestamp: string;
  runId?: string;
  session?: string;
  operationKind?: string;
  durationMs?: number;
  isError?: boolean;
  error?: unknown;
  level?: string;
  message?: string;
  attributes?: Record<string, unknown>;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: { total?: number } };
  [k: string]: unknown;
}

export interface LaneMetrics {
  lane: string;
  operations: number;
  p50Ms: number;
  p95Ms: number;
  failures: number;
  tokens: number;
  cost: number;
}

export interface GatewayMetrics {
  lane: string;
  label: string;
  total: number;
  yes: number;
  no: number;
}

export interface Metrics {
  run: { id?: string; total: number; succeeded: number; failed: number; durationMs: number };
  lanes: LaneMetrics[];
  gateways: GatewayMetrics[];
  toolCalls: { name: string; count: number; failures: number; totalMs: number }[];
  totalTokens: number;
  totalCost: number;
  at: string;
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
};

/**
 * Aggregate the local JSONL event sink into dashboard metrics:
 *   - per-lane operation latency (p50/p95), failures, tokens, cost
 *   - gateway branch rates (yes/no %) — from ctx.log "gateway decision" events
 *   - tool-call counts/failures
 *
 * "Sum model-turn leaf values rather than operation roll-ups; nested durations
 * can overlap" (observability docs) — so token/cost totals come from `turn`
 * events only, not operation roll-ups.
 */
export function aggregateMetrics(events: FlueEventRecord[]): Metrics {
  // Single pass over events: per-lane operations/tokens/cost, gateway rates,
  // tool calls, run tallies, and totals — no redundant filter/reduce passes.
  const laneOps = new Map<string, number[]>();
  const laneFails = new Map<string, number>();
  const laneTokens = new Map<string, number>();
  const laneCost = new Map<string, number>();
  const gwMap = new Map<string, GatewayMetrics>();
  const toolMap = new Map<string, { count: number; failures: number; totalMs: number }>();

  let runTotal = 0;
  let runSucceeded = 0;
  let runFailed = 0;
  let runDur = 0;
  let lastRunId: string | undefined;
  let totalTokens = 0;
  let totalCost = 0;

  for (const e of events) {
    if (e.type === 'run_end') {
      runTotal++;
      runDur += e.durationMs ?? 0;
      if (e.isError) runFailed++;
      else runSucceeded++;
      lastRunId = e.runId;
    }

    // per-lane operation latency + tokens/cost from model turns
    const lane = String(e.session ?? e.harness ?? 'unknown');
    if (e.type === 'operation' && typeof e.durationMs === 'number') {
      (laneOps.get(lane) ?? laneOps.set(lane, []).get(lane)!).push(e.durationMs);
      if (e.isError) laneFails.set(lane, (laneFails.get(lane) ?? 0) + 1);
    }
    if (e.type === 'turn' && e.usage) {
      const t = e.usage.totalTokens ?? 0;
      const c = e.usage.cost?.total ?? 0;
      totalTokens += t;
      totalCost += c;
      laneTokens.set(lane, (laneTokens.get(lane) ?? 0) + t);
      laneCost.set(lane, (laneCost.get(lane) ?? 0) + c);
    }

    // gateway branch rates — emitted by the executor via ctx.log
    if (e.type === 'log' && e.message === 'gateway decision' && e.attributes) {
      const a = e.attributes as Record<string, unknown>;
      const key = `${String(a.lane)}/${String(a.label)}`;
      const g = gwMap.get(key);
      if (g) {
        g.total++;
        if (a.decision === 'yes') g.yes++;
        else if (a.decision === 'no') g.no++;
      } else {
        gwMap.set(key, {
          lane: String(a.lane), label: String(a.label), total: 1,
          yes: a.decision === 'yes' ? 1 : 0, no: a.decision === 'no' ? 1 : 0,
        });
      }
    }

    // tool calls
    if (e.type === 'tool') {
      const name = (e as FlueEventRecord & { toolName?: string }).toolName ?? 'unknown';
      const t = toolMap.get(name) ?? toolMap.set(name, { count: 0, failures: 0, totalMs: 0 }).get(name)!;
      t.count++;
      t.totalMs += e.durationMs ?? 0;
      if (e.isError) t.failures++;
    }
  }

  // Per-lane breakdown keyed by the UNION of ops/tokens/cost, so a lane that
  // only logged model turns (no operation events) still appears with its tokens
  // and cost instead of being silently dropped.
  const lanes: LaneMetrics[] = [...new Set<string>([...laneOps.keys(), ...laneTokens.keys(), ...laneCost.keys()])]
    .map((lane) => {
      const d = [...(laneOps.get(lane) ?? [])].sort((a, b) => a - b);
      return {
        lane, operations: d.length, p50Ms: percentile(d, 50), p95Ms: percentile(d, 95),
        failures: laneFails.get(lane) ?? 0, tokens: laneTokens.get(lane) ?? 0,
        cost: Math.round((laneCost.get(lane) ?? 0) * 1e6) / 1e6,
      };
    })
    .sort((a, b) => b.operations - a.operations);

  const toolCalls = [...toolMap.entries()]
    .map(([name, v]) => ({ name, ...v, totalMs: Math.round(v.totalMs) }))
    .sort((a, b) => b.count - a.count);

  return {
    run: { id: lastRunId, total: runTotal, succeeded: runSucceeded, failed: runFailed, durationMs: Math.round(runDur) },
    lanes, gateways: [...gwMap.values()], toolCalls, totalTokens,
    totalCost: Math.round(totalCost * 1e6) / 1e6,
    at: new Date().toISOString(),
  };
}

/** Read + aggregate the local sink file in one call. */
export function aggregateFromFile(path = join(process.cwd(), 'telemetry', 'events.jsonl')): Metrics {
  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { /* empty sink → empty metrics */ }
  // Single pass, no extra null-array: the old `.filter().map().filter()` chain
  // allocated a second full copy. The active file is size-bounded by the sink's
  // rotation, so this read stays bounded too.
  const events: FlueEventRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line) as FlueEventRecord); } catch { /* skip malformed line */ }
  }
  return aggregateMetrics(events);
}
