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
  const runs = events.filter((e) => e.type === 'run_end');
  const runDur = runs.reduce((a, e) => a + (e.durationMs ?? 0), 0);

  // per-lane operation latency + tokens/cost from model turns
  const laneOps = new Map<string, number[]>();
  const laneFails = new Map<string, number>();
  const laneTokens = new Map<string, number>();
  const laneCost = new Map<string, number>();

  for (const e of events) {
    const lane = String(e.session ?? e.harness ?? 'unknown');
    if (e.type === 'operation' && typeof e.durationMs === 'number') {
      (laneOps.get(lane) ?? laneOps.set(lane, []).get(lane)!).push(e.durationMs);
      if (e.isError) laneFails.set(lane, (laneFails.get(lane) ?? 0) + 1);
    }
    if (e.type === 'turn' && e.usage) {
      laneTokens.set(lane, (laneTokens.get(lane) ?? 0) + (e.usage.totalTokens ?? 0));
      laneCost.set(lane, (laneCost.get(lane) ?? 0) + (e.usage.cost?.total ?? 0));
    }
  }

  const lanes: LaneMetrics[] = [...laneOps.keys()].map((lane) => {
    const d = [...(laneOps.get(lane) ?? [])].sort((a, b) => a - b);
    return {
      lane, operations: d.length, p50Ms: percentile(d, 50), p95Ms: percentile(d, 95),
      failures: laneFails.get(lane) ?? 0, tokens: laneTokens.get(lane) ?? 0,
      cost: Math.round((laneCost.get(lane) ?? 0) * 1e6) / 1e6,
    };
  }).sort((a, b) => b.operations - a.operations);

  // gateway branch rates — emitted by the executor via ctx.log
  const gateways: GatewayMetrics[] = [];
  for (const e of events) {
    if (e.type === 'log' && e.message === 'gateway decision' && e.attributes) {
      const a = e.attributes as Record<string, unknown>;
      const key = `${String(a.lane)}/${String(a.label)}`;
      const g = gateways.find((x) => `${x.lane}/${x.label}` === key) ?? gateways[gateways.push({ lane: String(a.lane), label: String(a.label), total: 0, yes: 0, no: 0 }) - 1];
      g.total++;
      if (a.decision === 'yes') g.yes++;
      else if (a.decision === 'no') g.no++;
    }
  }

  // tool calls
  const toolMap = new Map<string, { count: number; failures: number; totalMs: number }>();
  for (const e of events) {
    if (e.type !== 'tool') continue;
    const name = (e as FlueEventRecord & { toolName?: string }).toolName ?? 'unknown';
    const t = toolMap.get(name) ?? toolMap.set(name, { count: 0, failures: 0, totalMs: 0 }).get(name)!;
    t.count++; t.totalMs += e.durationMs ?? 0;
    if (e.isError) t.failures++;
  }
  const toolCalls = [...toolMap.entries()].map(([name, v]) => ({ name, ...v, totalMs: Math.round(v.totalMs) }))
    .sort((a, b) => b.count - a.count);

  const totalTokens = events.filter((e) => e.type === 'turn').reduce((a, e) => a + (e.usage?.totalTokens ?? 0), 0);
  const totalCost = Math.round(events.filter((e) => e.type === 'turn').reduce((a, e) => a + (e.usage?.cost?.total ?? 0), 0) * 1e6) / 1e6;

  return {
    run: { id: runs.at(-1)?.runId, total: runs.length, succeeded: runs.filter((r) => !r.isError).length, failed: runs.filter((r) => r.isError).length, durationMs: Math.round(runDur) },
    lanes, gateways, toolCalls, totalTokens, totalCost,
    at: new Date().toISOString(),
  };
}

/** Read + aggregate the local sink file in one call. */
export function aggregateFromFile(path = join(process.cwd(), 'telemetry', 'events.jsonl')): Metrics {
  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { /* empty sink → empty metrics */ }
  const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as FlueEventRecord; } catch { return null; } }).filter(Boolean) as FlueEventRecord[];
  return aggregateMetrics(events);
}
