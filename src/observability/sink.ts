import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SINK = process.env.TELEMETRY_SINK ?? join(process.cwd(), 'telemetry', 'events.jsonl');
const MAX_ATTR_BYTES = Number(process.env.TELEMETRY_MAX_ATTR_BYTES ?? 4096);

let ready: Promise<void> | null = null;
const ensureDir = (): Promise<void> => (ready ??= mkdir(dirname(SINK), { recursive: true }).then(() => undefined));

const clip = (s: unknown): unknown => {
  const j = JSON.stringify(s);
  return j && j.length > MAX_ATTR_BYTES ? `${j.slice(0, MAX_ATTR_BYTES)}…(${j.length}b)` : s;
};

/**
 * Local, zero-infra telemetry sink: append every Flue runtime event as one JSON
 * line per event to `telemetry/events.jsonl`. This is the "consume observe()
 * directly" path the observability docs offer — no collector, no backend, works
 * on the self-hosted vLLM box. Pair with `aggregateMetrics()` for a dashboard,
 * or layer `@flue/opentelemetry` on top for export to Grafana/Tempo.
 *
 * Drops streaming deltas (text_delta/thinking_delta) by default to keep the sink
 * cheap; everything else is recorded. Treat events as read-only.
 */
const NOISY = new Set(['text_delta', 'thinking_delta', 'turn_request']);

export function jsonlSink(event: Record<string, unknown>): void {
  if (NOISY.has(event.type as string)) return;
  const rec = { ...event, attributes: clip(event.attributes) };
  void ensureDir().then(() => appendFile(SINK, JSON.stringify(rec) + '\n'));
}
