/**
 * Render tests — diagram + BPMN emission.
 *
 * Rendering has two backends: processpiper (Python, primary) and a Graphviz
 * structural fallback. CI installs Graphviz but not processpiper, so this file
 * actually exercises the documented graceful-degradation path there. On a host
 * with neither backend installed, the test SKIPS rather than failing — a
 * rendering test can't run without something to render with, and a skip is an
 * honest signal where a false failure would just be noise.
 *
 * Run:  node --import tsx --test test/render.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDiagram } from '../src/actions/render.js';

/** True if `cmd args...` exits 0 — used to detect an installed render backend. */
function available(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function hasBackend(): boolean {
  const py = process.env.PYTHON ?? 'python3';
  return available('dot', ['-V']) || available(py, ['-c', 'import processpiper']);
}

const SAMPLE = `title: render test
lane: Engineering
(start) as s
[Build artifact] as build
(end) as e
s -> build -> e`;

test('render: produces a non-empty image file', async (t) => {
  if (!hasBackend()) {
    t.skip('no render backend installed (install graphviz or processpiper)');
    return;
  }
  const out = join(tmpdir(), `baton-render-${process.pid}.png`);
  try {
    const res = await renderDiagram(SAMPLE, out, { bpmn: true });
    assert.ok(existsSync(res.image), `image exists at ${res.image}`);
    assert.ok(statSync(res.image).size > 0, 'image is non-empty');
  } finally {
    rmSync(out, { force: true });
  }
});

test('render: round-trips through the parser without throwing on valid DSL', async (t) => {
  if (!hasBackend()) {
    t.skip('no render backend installed');
    return;
  }
  const out = join(tmpdir(), `baton-roundtrip-${process.pid}.png`);
  try {
    // The point here is that a valid process renders cleanly via EITHER path;
    // the exact backend is an implementation detail we don't assert on.
    await assert.doesNotReject(renderDiagram(SAMPLE, out));
  } finally {
    rmSync(out, { force: true });
  }
});
