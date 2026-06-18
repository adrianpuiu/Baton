/**
 * Runtime setup: register the local vLLM server as a first-class Flue provider.
 *
 * vLLM exposes an OpenAI-compatible API on :8000. Flue's `registerProvider`
 * lets us teach it about any OpenAI-compatible endpoint, then reference models
 * as `vllm/<model-id>` everywhere (agents, per-call overrides, etc).
 *
 * This is the equivalent of the Appian-REST-API move: we're wrapping a service
 * we don't control with a clean, typed integration instead of ad-hoc fetches.
 */
import { registerProvider, observe } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { jsonlSink } from './observability/sink.js';
import { maybeRegisterOpenTelemetry } from './observability/opentelemetry.js';

await maybeRegisterOpenTelemetry();

registerProvider('vllm', {
  api: 'openai-completions',
  baseUrl: process.env.VLLM_BASE_URL ?? 'http://localhost:8000/v1',
  // vLLM ignores the key, but the OpenAI client requires *something* non-empty.
  apiKey: process.env.VLLM_API_KEY ?? 'vllm',
});

// Local, zero-infra telemetry: every runtime event → telemetry/events.jsonl.
// Layer `createOpenTelemetryObserver()` (see observability/opentelemetry.ts) on
// top to also export traces to Grafana/Tempo via the OTel collector.
observe((event) => jsonlSink(event as Record<string, unknown>));

const app = new Hono();

// Tiny request log — later this becomes an OpenTelemetry span (see README).
app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  console.log(`app: ${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - started}ms)`);
});

// A summary endpoint over the local telemetry sink — the dashboard data source.
import { aggregateFromFile } from './observability/metrics.js';
app.get('/metrics', (c) => c.json(aggregateFromFile()));

app.route('/', flue());

export default app;
