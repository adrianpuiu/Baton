import { defineTool, type ToolParameters } from '@flue/runtime';
import { existsSync } from 'node:fs';
import { spawnCapture } from '../../utils/spawn.js';

const defaultRepo = () => process.env.SAMPLE_REPO ?? 'fixtures/sample-repo';
const tail = (s: string, n = 4): string =>
  s.replace(/\r/g, '').split('\n').filter(Boolean).slice(-n).join('\n');

/** Build the project artifact in the repository. */
export const buildTool = defineTool({
  name: 'build_artifact',
  description: 'Build the project in the repository and return the artifact location.',
  parameters: {
    type: 'object',
    properties: { repo_path: { type: 'string' } },
    required: [],
  } satisfies ToolParameters,
  async execute({ repo_path }) {
    const repo = repo_path || defaultRepo();
    if (!existsSync(repo)) return JSON.stringify({ built: false, summary: `repository not found at ${repo}` });
    const r = await spawnCapture('npm', ['run', 'build', '--silent'], { cwd: repo, timeout: 60_000 });
    if (r.timedOut) return JSON.stringify({ built: false, summary: 'build timed out after 60s' });
    if (r.code !== 0) {
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
      return JSON.stringify({ built: false, summary: tail(out) || `build failed (exit ${r.code})` });
    }
    return JSON.stringify({ built: true, artifact: 'dist/', summary: tail(r.stdout) });
  },
});
