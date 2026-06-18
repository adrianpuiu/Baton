/**
 * OpenTelemetry export — the headline observability path.
 *
 * Flue's `@flue/opentelemetry` converts the observe() event stream into OTel
 * spans (flue.workflow, flue.operation, flue.tool, chat <model>, flue.task).
 * This module configures a Node SDK + OTLP HTTP exporter and registers the
 * observer — but ONLY when OTEL_EXPORTER_OTLP_ENDPOINT is set, so the local
 * JSONL sink is always on and the heavy stack is opt-in.
 *
 * Bring up the backend with `docker compose up` (Grafana + Tempo + collector),
 * then run a workflow with OTEL_EXPORTER_OTLP_ENDPOINT set to see traces.
 */
import type { FlueContext } from '@flue/runtime';

let registered = false;

export async function maybeRegisterOpenTelemetry(): Promise<void> {
  if (registered) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // opt-in: nothing to do without a collector endpoint

  const [{ createOpenTelemetryObserver }] = await Promise.all([
    import('@flue/opentelemetry'),
  ]);
  const { observe } = await import('@flue/runtime');
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { Resource } = await import('@opentelemetry/resources');
  const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions');

  // Let the SDK own the exporter directly. Constructing a BatchSpanProcessor
  // ourselves triggers a dual-copy sdk-trace-base type clash across the OTel
  // package graph; NodeSDK wires the processor internally from traceExporter.
  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'baton',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  });
  sdk.start();
  observe(createOpenTelemetryObserver());
  registered = true;

  // Flush on shutdown so spans reach the collector, THEN exit. Node keeps the
  // process alive once a SIGTERM listener is attached, so without process.exit
  // the server hangs and the exporter's HTTP keep-alive sockets leak.
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0)));
}

// Hint to typecheckers that FlueContext is referenced for doc context.
export type { FlueContext };
