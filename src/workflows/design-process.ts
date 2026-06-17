import { createAgent, type FlueContext } from '@flue/runtime';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePiperFlow } from '../compiler/parse.js';
import { emitFlueWorkflow, type SkillWireEntry } from '../compiler/emit.js';
import { executeProcess } from '../compiler/execute.js';
import { DSL_SPEC } from '../compiler/dsl-spec.js';
import { renderDiagram } from '../actions/render.js';
import { resolveSkills } from '../capabilities/skill-resolver.js';

const MODEL = `vllm/${process.env.VLLM_MODEL ?? 'Capybara'}`;

/**
 * design-process
 *
 * Input  : payload.prompt — a natural-language description of a business process.
 * Output : the PiperFlow DSL, a rendered PNG, a compiled Flue workflow file,
 *          and a live execution trace.
 *
 * Pipeline:
 *   1. vLLM agent authors the PiperFlow DSL (the DSL is the contract).
 *   2. Parser validates it into an AST (catches model hallucinations).
 *   3. Renderer draws the diagram.
 *   4. Compiler emits a human-readable Flue workflow module.
 *   5. Executor runs the same process live, one agent per swimlane.
 */
export async function run({ init, payload, env, log }: FlueContext<{ prompt?: string }>) {
  const prompt = payload?.prompt ?? env?.PROMPT;
  if (!prompt) throw new Error('payload.prompt is required');

  // 1–3. Author → parse → render, with a SELF-HEALING retry loop.
  // Model output is occasionally imperfect (orphan elements, inverted gateways).
  // Instead of dying hard, we feed the precise validation error back and regenerate.
  const agent = createAgent(() => ({ model: MODEL }));
  const harness = await init(agent);
  const session = await harness.session();

  const MAX_REPAIR_ATTEMPTS = 3;
  let dsl = '';
  let ast = null as ReturnType<typeof parsePiperFlow> | null;
  let diagram = '';
  let bpmn: string | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const repair = lastError
      ? `\n\n# Your previous output was rejected. FIX the problem and regenerate the FULL corrected PiperFlow (no explanation).\nProblem: ${lastError.slice(0, 600)}`
      : '';
    const { text: raw } = await session.prompt(
      `${DSL_SPEC}${repair}\n\n# Task\nProduce ONE valid PiperFlow document for the process below. Output ONLY the PiperFlow text.\n\n## Process\n${prompt}`,
    );
    dsl = extractDsl(raw);
    try {
      ast = parsePiperFlow(dsl); // catches orphans, dangling refs, missing start — fast + precise
      await mkdir('diagrams', { recursive: true });
      const slug0 = ast.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'process';
      const r = await renderDiagram(dsl, join('diagrams', `${slug0}.png`), { bpmn: true }); // processpiper's own check
      diagram = r.image; bpmn = r.bpmn;
      lastError = undefined;
      if (attempt > 1) log?.info('process regenerated after repair', { attempts: attempt });
      break;
    } catch (e) {
      lastError = summariseError((e as Error).message);
      if (attempt === MAX_REPAIR_ATTEMPTS) {
        throw new Error(`Could not produce a valid process after ${MAX_REPAIR_ATTEMPTS} attempts. Last error:\n${lastError}`);
      }
      log?.warn('regenerating process (validation failed)', { attempt, error: lastError.slice(0, 300) });
    }
  }

  // After the loop these are all defined (or we threw).
  const finalAst = ast!;
  const slug = finalAst.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'process';

  // 4. Compile to a runnable Flue workflow (flat in src/workflows/ so `flue run` discovers it).
  await mkdir(join('src', 'workflows'), { recursive: true });
  const workflowPath = join('src', 'workflows', `gen-${slug}.ts`);

  // Optional: resolve open-ecosystem skills (online) → reviewable manifest.
  let skillManifest: ReturnType<typeof resolveSkills> extends Promise<infer T> ? T | undefined : never = undefined;
  if (env?.SKILLS_RESOLVE === '1') {
    skillManifest = await resolveSkills(finalAst);
    await writeFile('skills.manifest.json', JSON.stringify(skillManifest, null, 2) + '\n');
  }

  // Optional: if a `lock:skills` run produced skills.wiring.json, thread it into codegen.
  let skillWiring: Record<string, SkillWireEntry[]> | undefined;
  try {
    if ((await stat('skills.wiring.json')).isFile()) {
      skillWiring = (JSON.parse(await readFile('skills.wiring.json', 'utf-8')) as { lanes: Record<string, SkillWireEntry[]> }).lanes;
    }
  } catch {
    // no wiring file → lanes use local capabilities only (graceful)
  }

  await writeFile(workflowPath, emitFlueWorkflow(finalAst, { name: slug, model: MODEL, ...(skillWiring ? { skillWiring } : {}) }));

  // 5. Execute live, one named session per lane. ctx.log → telemetry sink (gateway decisions).
  const execution = await executeProcess(finalAst, (name) => harness.session(name) as Promise<never>, MODEL, log);

  return { title: finalAst.title, dsl, diagram, bpmn, workflow: workflowPath, execution, ...(skillManifest ? { skillsManifest: 'skills.manifest.json' } : {}) };
}

/**
 * The model often wraps its PiperFlow output in prose and/or ``` fences.
 * Extract just the contiguous DSL: prefer a fenced block, start at `title:`,
 * and trim anything after the last structural/edge line. Tolerates both
 * preamble reasoning and trailing chatter.
 */
function extractDsl(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```[a-zA-Z]*\s*\n([\s\S]*?)\n```/);
  if (fence) s = fence[1];

  const titleIdx = s.search(/^title:\s/m);
  if (titleIdx > 0) s = s.slice(titleIdx);

  const lines = s.split('\n');
  let lastUseful = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('#')) continue;
    const isDsl =
      /^(title|colourtheme|colortheme|footer|pool|lane):/i.test(l) ||
      /^\s*\((start|end)\)\s+as\s/.test(lines[i]) ||
      /^\s*\[[^\]]+\]\s+as\s/.test(lines[i]) ||
      /^\s*<[^>]+>\s+as\s/.test(lines[i]) ||
      /^[A-Za-z_]\w*(?:\s*->\s*[A-Za-z_]\w*)+/.test(l);
    if (isDsl) lastUseful = i;
  }
  if (lastUseful >= 0) lines.splice(lastUseful + 1);
  return lines.join('\n').trim() + '\n';
}

/** Reduce a noisy render/parse error to the actionable line for the retry prompt. */
function summariseError(msg: string): string {
  // Prefer the final exception message line; drop Python traceback frames.
  const lines = msg.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const key = lines.reverse().find((l) => /^[A-Z]\w*Error:/.test(l) || l.includes('must') || l.includes('not connected'));
  return key ?? msg.slice(-400);
}
