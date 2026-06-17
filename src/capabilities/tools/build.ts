import { defineTool, type ToolParameters } from '@flue/runtime';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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
    try {
      const out = execSync('npm run build --silent', {
        cwd: repo, timeout: 60_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return JSON.stringify({ built: true, artifact: 'dist/', summary: tail(out) });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const out = [err.stdout, err.stderr].filter(Boolean).join('\n');
      return JSON.stringify({ built: false, summary: tail(out) || String(err.message) });
    }
  },
});
