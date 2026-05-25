import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute, relative as relativePath } from 'node:path';
import { resolveTemplate, type WorkflowExpressionContext } from '@makaio/expression';

/**
 * Generate a unique ID with a given prefix.
 * @param prefix - The prefix for the ID
 * @returns A unique identifier string
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sleep for a specified duration.
 * @param ms - Duration in milliseconds
 * @returns A promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the working directory for a shell step and validate it is within
 * the workspace root. Returns the resolved path or `null` when the path is
 * outside the root (the caller should treat `null` as a step failure).
 * @param cwdTemplate - Raw cwd template string from the step definition (optional)
 * @param workspaceRoot - Absolute workspace root used as the containment boundary
 * @param expressionContext - Context for template interpolation
 * @returns Resolved absolute cwd path, or `null` if outside the workspace root
 */
export function resolveShellCwd(
  cwdTemplate: string | undefined,
  workspaceRoot: string,
  expressionContext: WorkflowExpressionContext,
): string | null {
  const rawCwd = cwdTemplate ? resolveTemplate(cwdTemplate, expressionContext) : workspaceRoot;
  const resolvedRootPath = resolvePath(workspaceRoot);
  const resolvedCwdPath = resolvePath(isAbsolute(rawCwd) ? rawCwd : resolvePath(workspaceRoot, rawCwd));
  let resolvedRoot: string;
  let resolvedCwd: string;
  try {
    // Use real paths so symlink traversal cannot bypass workspace containment.
    resolvedRoot = realpathSync(resolvedRootPath);
    resolvedCwd = realpathSync(resolvedCwdPath);
  } catch {
    return null;
  }
  const rootForComparison = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const cwdForComparison = process.platform === 'win32' ? resolvedCwd.toLowerCase() : resolvedCwd;
  const relative = relativePath(rootForComparison, cwdForComparison);
  const isWithin = relative === '' || (!relative.startsWith('..') && !isAbsolute(relative));

  return isWithin ? resolvedCwd : null;
}

/**
 * Type guard for execFile error objects.
 * @param err - Unknown error from catch block
 * @returns True if error has execFile-specific properties
 */
function isExecFileError(err: unknown): err is Error & {
  killed?: boolean;
  signal?: string;
  code?: number | string;
  stdout?: string;
  stderr?: string;
  aborted?: boolean;
} {
  return err instanceof Error && ('code' in err || 'killed' in err);
}

/**
 * Resolve the executable token from a command array.
 * @param command - Process command array.
 * @returns Executable token, or null when the command is empty.
 */
function resolveExecutable(command: string[]): string | null {
  const binary = command[0];
  return binary === undefined || binary.trim() === '' ? null : binary;
}

/**
 * Options for spawning an external process.
 */
export interface SpawnProcessOptions {
  /** Executable to run. */
  command: string[];
  /** Absolute working directory for the child process. */
  cwd: string;
  /** Environment variables merged on top of `process.env`. */
  env: Record<string, string>;
  /** Milliseconds before SIGTERM is sent; SIGKILL follows after 5 s. */
  timeoutMs: number;
  /**
   * Optional abort signal. When signalled, sends SIGTERM to the child
   * process immediately, followed by SIGKILL after 5 s if still running.
   */
  signal?: AbortSignal;
}

/**
 * Spawn an external process via `execFile` and apply a two-stage kill on
 * timeout. Optionally accepts an `AbortSignal` to support external cancellation.
 * @param options - Process spawn options
 * @returns Resolved stdout/stderr on success; rejects with the exec error otherwise
 */
export function spawnProcess(options: SpawnProcessOptions): Promise<{ stdout: string; stderr: string }> {
  const { command, cwd, env, timeoutMs, signal } = options;
  const binary = resolveExecutable(command);
  if (binary === null) {
    return Promise.reject(new Error('Shell step command is empty'));
  }
  const args = command.slice(1);

  return new Promise((resolve, reject) => {
    let graceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;

    const child = execFile(
      binary,
      args,
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: 0, // Timeout is managed manually below
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr, aborted }));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );

    const escalateKill = (): void => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      graceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
    };

    const killTimer = setTimeout(() => {
      escalateKill();
    }, timeoutMs);

    child.on('close', () => {
      clearTimeout(killTimer);
      if (graceKillTimer !== null) {
        clearTimeout(graceKillTimer);
      }
    });

    if (signal) {
      const onAbort = (): void => {
        aborted = true;
        escalateKill();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => signal.removeEventListener('abort', onAbort));
      }
    }
  });
}

/**
 * Result of running a shell step process.
 * Discriminated on `status` for type-safe handling in the executor.
 */
export type ShellStepOutcome = { status: 'completed'; stdout: string } | { status: 'failed'; error: string };

/**
 * Input options for `runShellStep`.
 */
export interface RunShellStepOptions {
  /** Shell step definition fields needed for execution. */
  step: { command: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number };
  /** Absolute workspace root used as the shell containment boundary. */
  workspaceRoot: string;
  /** Context for template interpolation. */
  expressionContext: WorkflowExpressionContext;
  /**
   * Optional abort signal. Forwarded to the spawned process to support
   * workflow-level cancellation.
   */
  signal?: AbortSignal;
}

/**
 * Resolve shell step inputs and run the external process.
 *
 * Handles cwd resolution/validation, template interpolation for command
 * args and env vars, and process execution with timeout. Does NOT touch
 * the bus — all event emission and state persistence is the caller's
 * responsibility.
 * @param options - Shell step run options
 * @returns Outcome indicating success (with stdout) or failure (with error message)
 */
export async function runShellStep(options: RunShellStepOptions): Promise<ShellStepOutcome> {
  const { step, workspaceRoot, expressionContext, signal } = options;

  const resolvedCwd = resolveShellCwd(step.cwd, workspaceRoot, expressionContext);
  if (resolvedCwd === null) {
    return {
      status: 'failed',
      error: `Shell step cwd '${step.cwd}' is outside workspace root '${workspaceRoot}'`,
    };
  }

  const resolvedCommand = step.command.map((token) => resolveTemplate(token, expressionContext));
  if (resolveExecutable(resolvedCommand) === null) {
    return { status: 'failed', error: 'Shell step command is empty' };
  }
  const resolvedEnv = Object.fromEntries(
    Object.entries(step.env ?? {}).map(([k, v]) => [k, resolveTemplate(v, expressionContext)]),
  );
  const timeoutMs = step.timeoutMs ?? 300_000;

  try {
    const { stdout } = await spawnProcess({
      command: resolvedCommand,
      cwd: resolvedCwd,
      env: resolvedEnv,
      timeoutMs,
      signal,
    });
    return { status: 'completed', stdout };
  } catch (error) {
    if (!isExecFileError(error)) {
      return { status: 'failed', error: String(error) };
    }
    const isCancelled = error.aborted === true;
    const isTimeout = !isCancelled && (error.killed === true || error.signal != null);
    const errorMessage = isCancelled
      ? 'Command cancelled'
      : isTimeout
        ? `Command timed out after ${timeoutMs}ms`
        : error.stderr?.trim() || error.stdout?.trim() || error.message;
    return { status: 'failed', error: errorMessage };
  }
}
