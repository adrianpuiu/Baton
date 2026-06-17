/**
 * generate:skills — synthesize a Flue skill for each lane discovery left empty.
 *
 * Thin wrapper around the `generate-skills` Flue workflow. Synthesis needs the
 * model, so it runs through `flue run` (which provides the harness context the
 * workflow uses, and emits telemetry via observe()).
 *
 * Pipeline: resolve:skills → GENERATE:skills → lock:skills/wire
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('npx', ['flue', 'run', 'generate-skills', '--target', 'node'], {
  stdio: 'inherit',
  env: { ...process.env },
});
process.exit(res.status ?? 1);
