import type { ProcessAST } from '../compiler/types.js';

/** A quality-gated skill discovered from the open ecosystem (skills.sh). */
export interface DiscoveredSkill {
  id: string; // owner/repo/skill
  name: string;
  source: string; // owner/repo
  skillId: string; // last path segment — the `@<skillId>` for `npx skills add`
  installs: number;
  addCommand: string; // npx skills add owner/repo@skill
  url: string;
  knownSource: boolean;
}

/** A locked, codegen-ready skill entry (output of the `lock:skills` step). */
export interface SkillWireEntry {
  name: string; // install dir name under .agents/skills/
  importPath: string; // relative to src/workflows/ where generated files live
  source: string;
  installs: number;
  compatible: boolean; // did its SKILL.md parse as Flue format?
  reason?: string; // why incompatible (frontmatter missing, etc.)
}

export interface LaneResolution {
  lane: string;
  pool?: string;
  query: string;
  totalCandidates: number;
  skills: DiscoveredSkill[]; // already quality-gated
}

export interface SkillManifest {
  process: string;
  resolvedAt: string;
  online: boolean;
  minInstalls: number;
  lanes: LaneResolution[];
}

export interface ResolveOptions {
  minInstalls?: number;
  maxPerLane?: number;
  apiBase?: string;
  /** Set false to skip the network (manifest comes back empty, online=false). */
  online?: boolean;
}

// Sources whose skills we trust more (find-skills' own guidance).
const KNOWN_SOURCES = [
  'vercel-labs', 'anthropics', 'anthropic', 'microsoft', 'google',
  'aws', 'cloudflare', 'addyosmani',
];

// Words that add noise to a search query ("CI System" → "CI").
const FILLER = /\b(system|systems|team|teams|lane|process|the|service|services|department|dept|group|management)\b/gi;

interface ApiSkill {
  id: string;
  name: string;
  installs: number;
  source?: string;
}

function deriveQuery(laneName: string, tasks: string[]): string {
  const role = laneName.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  const firstTask = (tasks[0] ?? '').replace(FILLER, ' ').replace(/[?]/g, '').trim();
  const words: string[] = [];
  for (const w of `${role} ${firstTask}`.split(/\s+/)) {
    if (w && !words.some((x) => x.toLowerCase() === w.toLowerCase())) words.push(w);
  }
  return words.slice(0, 4).join(' ');
}

async function searchApi(apiBase: string, query: string): Promise<ApiSkill[]> {
  try {
    const res = await fetch(`${apiBase}/api/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { skills?: ApiSkill[] };
    return data.skills ?? [];
  } catch {
    return []; // offline / timeout / error → empty (graceful)
  }
}

function toDiscovered(s: ApiSkill): DiscoveredSkill {
  const parts = s.id.split('/');
  const source = s.source ?? parts.slice(0, 2).join('/');
  const skillId = parts.slice(2).join('/') || s.name;
  return {
    id: s.id,
    name: s.name,
    skillId,
    source,
    installs: s.installs,
    addCommand: `npx skills add ${source}@${skillId}`,
    url: `https://skills.sh/${s.id}`,
    knownSource: KNOWN_SOURCES.some((k) => source.toLowerCase().startsWith(k)),
  };
}

function select(skills: DiscoveredSkill[], minInstalls: number, max: number): DiscoveredSkill[] {
  return skills
    .sort((a, b) => Number(b.knownSource) - Number(a.knownSource) || b.installs - a.installs)
    .filter((s) => s.installs >= minInstalls)
    .slice(0, max);
}

/**
 * Resolve open-ecosystem skills for each swimlane in a process.
 *
 * Discovery is online (skills.sh semantic search) but the OUTPUT is a reviewable
 * manifest. Wire it into generated lane profiles, or run `npx skills add` from
 * each entry to lock the skill files into the repo so runtime stays offline.
 *
 * Never throws: network/offline failures yield an empty, `online:false` manifest.
 */
export async function resolveSkills(ast: ProcessAST, opts: ResolveOptions = {}): Promise<SkillManifest> {
  // Treat an unset / empty / non-numeric SKILLS_MIN_INSTALLS as the default so
  // a typo'd or empty env var can't silently bypass the gate (empty → 0 admits
  // zero-install skills) or kill it (NaN → every skill rejected).
  const envMin = process.env.SKILLS_MIN_INSTALLS;
  const parsedMin = envMin === undefined || envMin.trim() === '' ? 500 : Number(envMin);
  const minInstalls = opts.minInstalls ?? (Number.isFinite(parsedMin) && parsedMin >= 0 ? parsedMin : 500);
  const maxPerLane = opts.maxPerLane ?? 2;
  const apiBase = opts.apiBase ?? process.env.SKILLS_API ?? 'https://skills.sh';
  const wantOnline = opts.online ?? true;

  const lanes: LaneResolution[] = [];
  let anyFound = false;

  for (const lane of ast.lanes) {
    const tasks = ast.elements
      .filter((e) => e.lane === lane.name && e.category === 'activity')
      .map((e) => e.label);
    const query = deriveQuery(lane.name, tasks);

    const found = wantOnline ? await searchApi(apiBase, query) : [];
    if (found.length) anyFound = true;
    const selected = select(found.map(toDiscovered), minInstalls, maxPerLane);

    lanes.push({
      lane: lane.name,
      ...(lane.pool ? { pool: lane.pool } : {}),
      query,
      totalCandidates: found.length,
      skills: selected,
    });
  }

  return {
    process: ast.title,
    resolvedAt: new Date().toISOString(),
    online: wantOnline && anyFound,
    minInstalls,
    lanes,
  };
}
