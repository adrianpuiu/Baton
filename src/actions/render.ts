import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parsePiperFlow } from '../compiler/parse.js';
import { toDot } from './graphviz.js';
import { emitBpmn } from './bpmn.js';
import { spawnCapture } from '../utils/spawn.js';

const PYTHON = process.env.PYTHON ?? 'python3';
// Resolve against process.cwd() (the project root when run via `flue run`).
// We deliberately avoid `import.meta.url`: Flue's bundler rewrites it and the
// relative path no longer points at the source tree.
const RENDER_SCRIPT = process.env.RENDER_SCRIPT ?? join(process.cwd(), 'scripts', 'render.py');

export interface RenderOptions {
  /** Emit BPMN XML alongside the image (imports into Camunda/Signavio/Appian). */
  bpmn?: boolean;
  /** Output format is inferred from the extension: .png or .svg. */
}

export interface RenderResult {
  image: string;
  bpmn?: string;
  fallback?: boolean;
  fallbackReason?: string;
}

/**
 * Render PiperFlow DSL to an image (PNG/SVG) via processpiper (Python).
 * Optionally also emit BPMN XML.
 *
 * Graceful degradation: processpiper's grid-layout engine has known limits on
 * large/wide interconnected processes (it throws `KeyError` from its internal
 * grid). When that happens we fall back to a Graphviz structural rendering of
 * the same AST — same nodes, lanes as clusters, gateways as diamonds — so the
 * pipeline never dies on a valid process. The result carries `fallback: true`
 * so callers can note the rendering mode. BPMN XML is still attempted; if the
 * grid layout failed it will also be absent (BPMN export runs inside the same
 * draw() call).
 */
export async function renderDiagram(
  dsl: string,
  outputPath: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  await mkdir(dirname(outputPath), { recursive: true });
  const ast = parsePiperFlow(dsl); // parse once; needed for semantic BPMN + fallback

  // The SEMANTIC BPMN XML is ALWAYS emitted directly from the AST. processpiper
  // is authoritative for the PICTURE only — its BPMN export is lossy: it loses
  // task types (every task becomes a plain <bpmn:task>), the data layer, and
  // Executable-conformance detail. For soundness/reliability analysis and for
  // clean import into Camunda/Signavio, the direct emitter is the source of
  // truth. This keeps the .pf → .bpmn → .pf round-trip faithful: a @user task
  // round-trips as <bpmn:userTask>, so the stall check still fires on re-import.
  // (Without this, `baton check` on our own rendered showcase .bpmn would give a
  // FALSE 'sound' because the userTask type — the stall signal — was dropped.)
  let bpmnPath: string | undefined;
  if (opts.bpmn) {
    bpmnPath = outputPath.replace(/\.(png|svg)$/i, '') + '.bpmn';
    await writeFile(bpmnPath, emitBpmn(ast, { slug: ast.title }));
  }

  // The picture: try processpiper, fall back to a Graphviz structural rendering
  // of the same AST on grid-layout failure.
  const args = [RENDER_SCRIPT, outputPath];
  try {
    const stdout = await runProcess(PYTHON, args, dsl);
    const parsed = JSON.parse(stdout || '{"ok":true,"artifacts":[]}');
    const artifacts: string[] = parsed.artifacts ?? [outputPath];
    const image = artifacts.find((a) => /\.(png|svg)$/i.test(a)) ?? outputPath;
    return bpmnPath ? { image, bpmn: bpmnPath } : { image };
  } catch (primaryErr) {
    const dot = toDot(ast);
    const fallbackPath = outputPath.replace(/\.(png|svg)$/i, '') + '-structural.png';
    try {
      await renderWithGraphviz(dot, fallbackPath);
      const result: RenderResult = {
        image: fallbackPath,
        fallback: true,
        fallbackReason: summarise(primaryErr),
      };
      if (bpmnPath) result.bpmn = bpmnPath;
      return result;
    } catch {
      // Graphviz not installed / also failed → propagate the original error.
      throw primaryErr;
    }
  }
}

function runProcess(cmd: string, args: string[], stdin: string): Promise<string> {
  return spawnCapture(cmd, args, { stdin, timeout: 60_000 }).then((r) => {
    if (r.timedOut) throw new Error(`render process '${cmd}' timed out after 60s`);
    if (r.code !== 0) throw new Error(`render.py exited ${r.code}\n${r.stderr}`);
    return r.stdout;
  });
}

function renderWithGraphviz(dot: string, outPath: string): Promise<void> {
  return spawnCapture('dot', ['-Tpng', '-o', outPath], { stdin: dot, timeout: 60_000 }).then((r) => {
    if (r.timedOut) throw new Error('graphviz (dot) timed out after 60s');
    if (r.code !== 0) throw new Error(r.stderr || `dot exited ${r.code}`);
  });
}

const summarise = (e: unknown): string => {
  const msg = (e as Error).message ?? String(e);
  const line = msg.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return (line ?? msg).slice(0, 200);
};
