import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SINK = process.env.TELEMETRY_SINK ?? join(process.cwd(), 'telemetry', 'events.jsonl');
const MAX_ATTR_BYTES = Number(process.env.TELEMETRY_MAX_ATTR_BYTES ?? 4096);
// Roll the active sink over to a single archive once it crosses this size, so a
// long-lived server can't grow the file without bound (and neither /metrics nor
// the dashboard re-materialise an ever-growing history on every read).
const MAX_BYTES = Number(process.env.TELEMETRY_MAX_BYTES ?? 50 * 1024 * 1024);

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
 *
 * Writes are serialised through a single in-flight promise so concurrent events
 * from parallel branches land in order and a burst can't fan out unbounded fs
 * work; a write failure is logged (not thrown) so telemetry never breaks a run.
 * The file is rotated past MAX_BYTES so neither disk nor the dashboard read
 * grow without bound.
 */
const NOISY = new Set(['text_delta', 'thinking_delta', 'turn_request']);

// One chained write at a time: preserves event order, bounds in-flight fs work,
// and swallows a rejection so it can never surface as an unhandled rejection.
let chain: Promise<void> = Promise.resolve();
const enqueue = (fn: () => Promise<void>): void => {
  chain = chain
    .then(fn)
    .catch((err) => console.error('telemetry sink write failed', err));
};

async function rotateIfLarge(): Promise<void> {
  try {
    if ((await stat(SINK)).size < MAX_BYTES) return;
  } catch {
    return; // file not created yet — nothing to rotate
  }
  try {
    // Roll the active file aside (overwriting the previous archive); the next
    // append starts fresh. Aggregation reads the active file, so the dashboard
    // covers the current rotation window.
    await rename(SINK, `${SINK}.1`);
  } catch {
    /* non-fatal: best-effort rotation */
  }
}

export function jsonlSink(event: Record<string, unknown>): void {
  if (NOISY.has(event.type as string)) return;
  const rec = { ...event, attributes: clip(event.attributes) };
  const line = JSON.stringify(rec) + '\n';
  enqueue(async () => {
    await ensureDir();
    await rotateIfLarge();
    await appendFile(SINK, line);
  });
}
