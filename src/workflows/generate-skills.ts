import { createAgent, type FlueContext } from '@flue/runtime';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { laneKey } from '../compiler/emit.js';
import type { SkillManifest } from '../capabilities/skill-resolver.js';
import type { SkillWireEntry } from '../compiler/emit.js';

const MODEL = `vllm/${process.env.VLLM_MODEL ?? 'Capybara'}`;

/**
 * The synthesis constraint baked into every generation prompt. Keeps the model
 * inside Flue's strict frontmatter contract (flat string-to-string) so a
 * generated skill can never break the build the way some community skills do.
 */
const SKILL_FORMAT_CONTRACT = `Output EXACTLY one SKILL.md file, nothing else.

It MUST start with YAML frontmatter containing ONLY these two fields, both strings:
---
name: <lowercase-kebab-or-snake-name>
description: <one sentence: what the skill does and when to use it>
---

After the closing ---, write the skill body in Markdown:
- A short overview of the expertise this skill provides.
- A "When to use" section.
- The methodology / steps / heuristics, as concrete numbered steps or rules.
- Keep it tight and operational (200-500 words). No fluff, no preamble.

Do NOT include any other frontmatter fields (no version, no metadata, no tags,
no nested objects). Do NOT wrap the output in code fences.`;

/** Parse frontmatter; return whether it's Flue-compatible (flat string-to-string). */
function flueCompatible(md: string): { ok: boolean; reason?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { ok: false, reason: 'no YAML frontmatter block' };
  const lines = m[1].replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s+/.test(line)) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    if (/^-?\d+(\.\d+)?$/.test(val)) return { ok: false, reason: `'${kv[1]}' is a number` };
    if (['true', 'false', 'null'].includes(val)) return { ok: false, reason: `'${kv[1]}' is ${val}` };
    if (val.startsWith('[') || val.startsWith('{')) return { ok: false, reason: `'${kv[1]}' is a collection` };
    if (val === '') {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next && /^\s+[A-Za-z0-9_.-]+:\s+\S/.test(next)) return { ok: false, reason: `'${kv[1]}' is a nested mapping` };
    }
  }
  return { ok: true };
}

/** Reduce a synthesized SKILL.md to a guaranteed-Flue-compatible form (name+description only). */
function normalize(md: string, fallbackName: string): string {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return `---\nname: ${fallbackName}\ndescription: Generated skill for ${fallbackName}.\n---\n\n${md.trim()}\n`;
  const body = m[2].trim();
  const fm = m[1].replace(/\r/g, '');
  const name = fm.match(/^name:\s*(.+?)\s*$/m)?.[1] ?? fallbackName;
  const desc = fm.match(/^description:\s*(.+?)(?:\s*$)/m)?.[1] ?? `Generated skill for ${fallbackName}.`;
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;
}

const extractSkill = (raw: string): string => {
  const fenced = raw.trim().match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1] : raw).trim() + '\n';
};

/**
 * generate-skills workflow
 *
 * Synthesize a Flue skill for each lane that discovery (resolve:skills) left
 * empty, guided by skill-creator's methodology, then merge them into
 * skills.wiring.json so codegen wires them onto lane profiles.
 *
 * Pipeline position: resolve:skills → GENERATE-SKILLS → lock:skills/wire.
 * Inputs via payload: none (reads skills.manifest.json from cwd).
 */
export async function run({ init, log }: FlueContext<Record<string, unknown>>) {
  const root = process.cwd();
  const manifestPath = join(root, 'skills.manifest.json');
  const agentsDir = join(root, '.agents', 'skills');
  const creatorPath = join(agentsDir, 'skill-creator', 'SKILL.md');

  if (!existsSync(manifestPath)) throw new Error('skills.manifest.json not found. Run `npm run resolve:skills` first.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SkillManifest;

  const gaps = manifest.lanes.filter((l) => l.skills.length === 0).map((l) => l.lane);
  if (!gaps.length) {
    log?.info('no skill gaps — every lane already has a discovered skill');
    return { synthesized: 0, gaps: [] };
  }
  log?.info('synthesizing skills for gap lanes', { gaps });

  const creatorMd = existsSync(creatorPath) ? await readFile(creatorPath, 'utf-8') : '';
  const agent = createAgent(() => ({
    model: MODEL,
    instructions: 'You author concise, operational agent skills as Markdown SKILL.md files.',
  }));
  const harness = await init(agent);
  const session = await harness.session();

  await mkdir(agentsDir, { recursive: true });
  const results: Array<{ lane: string; name: string; path: string; compatible: boolean; reason?: string }> = [];

  for (const lane of gaps) {
    const key = laneKey(lane);
    const query = manifest.lanes.find((l) => l.lane === lane)?.query ?? lane;
    const { text } = await session.prompt(
      [
        creatorMd ? `# Reference methodology (skill-creator)\nFollow this drafting approach for writing a good skill:\n\n${creatorMd.slice(0, 3000)}` : '',
        `\n# Task\nWrite a skill that equips an agent acting as the "${lane}" swimlane in the "${manifest.process}" business process.\nReference query for this lane: "${query}".`,
        `\nThe skill should encode real, reusable operational expertise for this role — concrete methodology, decision heuristics, and step-by-step procedures an agent can follow.`,
        `\n${SKILL_FORMAT_CONTRACT}`,
      ].join('\n'),
    );

    const md = normalize(extractSkill(text), `${key}-generated`);
    const verdict = flueCompatible(md);
    const name = md.match(/^name:\s*(.+?)\s*$/m)?.[1] ?? `${key}-generated`;
    const dir = join(agentsDir, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    await writeFile(path, md);
    results.push({ lane, name, path, compatible: verdict.ok, ...(!verdict.ok ? { reason: verdict.reason } : {}) });
    log?.info('synthesized skill', { lane, name, compatible: verdict.ok });
  }

  // Merge into skills.wiring.json so codegen wires them automatically.
  const wiringPath = join(root, 'skills.wiring.json');
  const wiring = existsSync(wiringPath)
    ? (JSON.parse(await readFile(wiringPath, 'utf-8')) as { lanes: Record<string, SkillWireEntry[]> })
    : { lanes: {} };
  const importRel = (absPath: string) => '../../' + absPath.replace(root + '/', '');
  for (const r of results) {
    if (!r.compatible) continue;
    const lk = laneKey(r.lane);
    wiring.lanes[lk] = wiring.lanes[lk] ?? [];
    if (!wiring.lanes[lk].some((e) => e.name === r.name)) {
      wiring.lanes[lk].push({ name: r.name, importPath: importRel(r.path), source: 'generated', installs: 0, compatible: true });
    }
  }
  await writeFile(wiringPath, JSON.stringify({ ...wiring, generatedAt: new Date().toISOString(), process: manifest.process }, null, 2) + '\n');

  const wired = results.filter((r) => r.compatible).length;
  log?.info('synthesis complete', { synthesized: wired, gaps: gaps.length });
  return { synthesized: wired, gaps, results };
}
