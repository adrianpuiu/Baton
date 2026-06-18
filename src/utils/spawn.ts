import { spawn } from 'node:child_process';

export interface SpawnCaptureResult {
  /** Process exit code, or -1 when killed/interrupted before a normal exit. */
  code: number;
  stdout: string;
  stderr: string;
  /** True when the child was SIGKILLed for exceeding `timeout`. */
  timedOut: boolean;
}

export interface SpawnCaptureOptions {
  cwd?: string;
  /** Hard kill deadline in ms (default 60s). The child is SIGKILLed on expiry. */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** Bytes written to the child's stdin before it is closed. */
  stdin?: string;
}

/**
 * Spawn a child process, capture stdout/stderr, and ALWAYS reap it on timeout.
 *
 * Resolves with the result for EVERY exit code — including non-zero and timeout
 * — so callers decide success/failure in-band. Rejects ONLY when the process
 * fails to spawn at all (e.g. ENOENT). The timeout SIGKILLs the child so a
 * hanging command can never pin the event loop or leak the process plus its
 * three stdio pipes (the defect this helper exists to prevent).
 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: SpawnCaptureOptions = {},
): Promise<SpawnCaptureResult> {
  const { cwd, env, stdin, timeout = 60_000 } = opts;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: SpawnCaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      finish({ code: -1, stdout, stderr, timedOut: true });
    }, timeout);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }));

    proc.stdin.end(stdin ?? '');
  });
}
