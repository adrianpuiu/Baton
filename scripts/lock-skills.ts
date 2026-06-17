/**
 * lock:skills — install the manifest's discovered skills and emit a
 * codegen-ready `skills.wiring.json`.
 *
 * Pipeline position: resolve (skills.manifest.json) → LOCK → wire (codegen).
 *
 * For each skill in the manifest: `npx skills add <source>@<skillId> -y`
 * installs it to .agents/skills/<name>/SKILL.md. We then parse each installed
 * SKILL.md's frontmatter to check Flue compatibility (needs name+description),
 * and write skills.wiring.json mapping each lane to its compatible skills with
 * import paths. Incompatible skills are recorded as recommendations, not wired.
 *
 * Run: `npm run lock:skills`   (after `npm run resolve:skills`)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, readFileSync as rf } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { laneKey } from '../src/compiler/emit.js';
import type { SkillManifest, DiscoveredSkill } from '../src/capabilities/skill-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const AGENTS_DIR = join(root, '.agents', 'skills');

interface Installed { name: string; path: string; compatible: boolean; reason?: string }

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const body = m[1];
  return {
    name: body.match(/^name:\s*(.+?)\s*$/m)?.[1],
    description: body.match(/^description:\s*(.+?)\s*$/m)?.[1],
  };
}

/**
 * Flue requires skill frontmatter to be a flat string-to-string mapping. Community
 * skills sometimes add nested objects (e.g. `metadata:`) or scalars (`version:
 * 1.0.0`) that Flue rejects at build time. This gate catches them BEFORE wiring.
 */
function flueCompatible(md: string): { ok: boolean; reason?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { ok: false, reason: 'no YAML frontmatter block' };
  const lines = m[1].replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s+/.test(line)) continue; // skip blanks + indented lines
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    if (/^-?\d+(\.\d+)?$/.test(val)) return { ok: false, reason: `'${kv[1]}' is a number, not a string` };
    if (val === 'true' || val === 'false' || val === 'null') return { ok: false, reason: `'${kv[1]}' is a ${val}, not a string` };
    if (val.startsWith('[') || val.startsWith('{')) return { ok: false, reason: `'${kv[1]}' is a collection, not a string` };
    // Empty value (like `metadata:`) followed by an indented `key: value` ⇒ nested map.
    // (Folded scalars use a `>`/`|` marker, so their value isn't empty.)
    if (val === '') {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next && /^\s+[A-Za-z0-9_.-]+:\s+\S/.test(next))
        return { ok: false, reason: `'${kv[1]}' is a nested mapping, not a string` };
    }
  }
  return { ok: true };
}

/** Scan .agents/skills/ and return each installed skill with a compat verdict. */
function scanInstalled(): Map<string, Installed> {
  const out = new Map<string, Installed>();
  if (!existsSync(AGENTS_DIR)) return out;
  for (const dir of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const mdPath = join(AGENTS_DIR, dir.name, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const md = rf(mdPath, 'utf-8');
    const fm = parseFrontmatter(md);
    const verdict = flueCompatible(md);
    out.set(dir.name, {
      name: fm.name ?? dir.name,
      path: mdPath,
      compatible: verdict.ok && !!fm.name,
      ...(!verdict.ok ? { reason: verdict.reason } : {}),
    });
  }
  return out;
}

const manifestPath = join(root, 'skills.manifest.json');
if (!existsSync(manifestPath)) {
  console.error('✗ skills.manifest.json not found. Run `npm run resolve:skills` first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SkillManifest;

// Collect unique skills across lanes (dedupe by skillId).
const unique = new Map<string, DiscoveredSkill>();
for (const lane of manifest.lanes) for (const s of lane.skills) unique.set(s.skillId, s);

console.log(`Locking ${unique.size} unique skill(s) for "${manifest.process}"…\n`);

// Install each missing skill.
for (const s of unique.values()) {
  const before = scanInstalled();
  const already = [...before.values()].some((i) => i.name === s.name || i.path.includes(`/${s.skillId}/`));
  if (already) {
    console.log(`  • ${s.name} — already installed`);
    continue;
  }
  console.log(`  • ${s.name} — installing from ${s.source} (${s.installs.toLocaleString()} installs)…`);
  const res = spawnSync('npx', ['-y', 'skills@latest', 'add', `${s.source}@${s.skillId}`, '-y'], {
    cwd: root, encoding: 'utf-8', timeout: 120_000,
  });
  if (res.status !== 0) {
    console.error(`    ✗ install failed: ${(res.stderr || res.stdout || '').slice(-300)}`);
  }
}

// Scan + compat-check what's actually installed.
const installed = scanInstalled();

// Build wiring: lane → compatible skills with import paths (relative to src/workflows/).
const importRel = (absPath: string) => '../../' + absPath.replace(root + '/', '');

const wiring: Record<string, Array<{ name: string; importPath: string; source: string; installs: number; compatible: boolean; reason?: string }>> = {};
const recommended: string[] = [];

for (const lane of manifest.lanes) {
  const lk = laneKey(lane.lane);
  wiring[lk] = [];
  for (const s of lane.skills) {
    const inst = [...installed.values()].find((i) => i.name === s.name || i.path.includes(`/${s.skillId}/`));
    if (!inst) continue;
    if (inst.compatible) {
      wiring[lk].push({ name: inst.name, importPath: importRel(inst.path), source: s.source, installs: s.installs, compatible: true });
    } else {
      recommended.push(`${lane.lane} → ${s.name} (${inst.reason})`);
      wiring[lk].push({ name: inst.name, importPath: importRel(inst.path), source: s.source, installs: s.installs, compatible: false, reason: inst.reason });
    }
  }
}

const outPath = join(root, 'skills.wiring.json');
writeFileSync(outPath, JSON.stringify({
  lockedAt: new Date().toISOString(),
  process: manifest.process,
  lanes: wiring,
}, null, 2) + '\n');

const wired = Object.values(wiring).flat().filter((s) => s.compatible).length;
console.log(`\n✓ wired ${wired} skill(s); wrote skills.wiring.json`);
if (recommended.length) console.log(`ℹ ${recommended.length} skill(s) incompatible with Flue format — recorded as recommendations, not wired:`);
for (const r of recommended) console.log(`   • ${r}`);
