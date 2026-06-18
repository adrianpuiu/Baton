import { defineTool, type ToolParameters } from '@flue/runtime';
import { existsSync } from 'node:fs';
import { spawnCapture } from '../../utils/spawn.js';

const defaultRepo = () => process.env.SAMPLE_REPO ?? 'fixtures/sample-repo';

const tail = (s: string, n = 6): string =>
  s.replace(/\r/g, '').split('\n').filter(Boolean).slice(-n).join('\n');

/**
 * Actually run the test suite in the target repository and report pass/fail.
 * This is the difference between a CI lane that *guesses* and one that *does*.
 */
export const runTestsTool = defineTool({
  name: 'run_tests',
  description:
    'Run the test suite in the repository and report whether it passed, with a short summary of the output.',
  parameters: {
    type: 'object',
    properties: {
      repo_path: { type: 'string', description: 'Repository path (defaults to the configured sample repo).' },
    },
    required: [],
  } satisfies ToolParameters,
  async execute({ repo_path }) {
    const repo = repo_path || defaultRepo();
    if (!existsSync(repo)) return JSON.stringify({ passed: false, summary: `repository not found at ${repo}` });
    const r = await spawnCapture('npm', ['test', '--silent'], {
      cwd: repo, timeout: 60_000, env: { ...process.env, CI: 'true' },
    });
    if (r.timedOut) return JSON.stringify({ passed: false, summary: 'tests timed out after 60s' });
    if (r.code !== 0) {
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
      return JSON.stringify({ passed: false, summary: tail(out) || `tests failed (exit ${r.code})` });
    }
    return JSON.stringify({ passed: true, summary: tail(r.stdout) });
  },
});
