/**
 * Print a dashboard summary from the local telemetry sink. No infra required.
 * Run: `npm run metrics`
 */
import { aggregateFromFile } from '../src/observability/metrics.js';

const m = aggregateFromFile();
const fmt = (n: number): string => n.toLocaleString();

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  Baton · process telemetry                          ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`runs: ${m.run.succeeded}/${m.run.total} ok${m.run.failed ? `, ${m.run.failed} failed` : ''}  ·  ${fmt(m.run.durationMs)}ms total  ·  ${fmt(m.totalTokens)} tokens  ·  $${m.totalCost.toFixed(4)}`);

if (m.lanes.length) {
  console.log('\n── per-lane operations ──────────────────────────────────────');
  console.log('  lane                          ops   p50     p95      fail  tokens');
  for (const l of m.lanes) {
    console.log(`  ${l.lane.padEnd(28)} ${String(l.operations).padStart(4)}  ${String(l.p50Ms).padStart(5)}ms ${String(l.p95Ms).padStart(5)}ms  ${String(l.failures).padStart(4)}  ${fmt(l.tokens)}`);
  }
}

if (m.gateways.length) {
  console.log('\n── gateway branch rates ─────────────────────────────────────');
  for (const g of m.gateways) {
    const yp = Math.round((g.yes / g.total) * 100);
    console.log(`  ${g.lane}/${g.label}  —  yes ${yp}% · no ${100 - yp}%  (n=${g.total})`);
  }
}

if (m.toolCalls.length) {
  console.log('\n── tool calls ────────────────────────────────────────────────');
  for (const t of m.toolCalls) {
    console.log(`  ${t.name.padEnd(28)} ${String(t.count).padStart(4)}×  ${Math.round(t.totalMs).toLocaleString()}ms${t.failures ? `  (${t.failures} fail)` : ''}`);
  }
}
if (!m.lanes.length && !m.gateways.length && !m.toolCalls.length) {
  console.log('\n  (no activity recorded yet — run a workflow to populate telemetry)');
}
console.log();
