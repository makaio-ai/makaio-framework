import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { TEMP_DIRECTORY_PREFIX } from '../../virtual-program-materializer.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Fixtures shared by the CodeExecution provider tests: a scratch workspace that
// redirects `os.tmpdir()` so "the materialized program root was removed" can be
// asserted exactly, a path watcher that observes real progress instead of
// sleeping, and the program a test submits when it needs an execution that only
// ends by termination.
//
// Nothing here stands in for a component under test. The programs are real
// TypeScript sources the provider transpiles and runs.

/** Polling interval used while waiting for an executing handler to announce itself. */
const PATH_POLL_INTERVAL_MS = 10;

/** Environment variables Node consults when resolving its temporary directory. */
const TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;

type TemporaryDirectoryEnvironmentKey = (typeof TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS)[number];
type TemporaryDirectoryEnvironment = Readonly<Record<TemporaryDirectoryEnvironmentKey, string | undefined>>;

/**
 * Snapshot the temporary-directory environment exactly, including absent keys.
 * @returns The values to restore after a scratch workspace finishes.
 */
function snapshotTemporaryDirectoryEnvironment(): TemporaryDirectoryEnvironment {
  return {
    TMPDIR: process.env['TMPDIR'],
    TEMP: process.env['TEMP'],
    TMP: process.env['TMP'],
  };
}

/**
 * Restore a temporary-directory environment snapshot exactly.
 * @param environment - Values captured before redirecting the temporary directory.
 */
function restoreTemporaryDirectoryEnvironment(environment: TemporaryDirectoryEnvironment): void {
  for (const key of TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Redirect every temporary-directory environment variable to one base.
 * @param temporaryBase - Directory that Node must use for temporary files.
 */
function redirectTemporaryDirectoryEnvironment(temporaryBase: string): void {
  for (const key of TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS) {
    process.env[key] = temporaryBase;
  }
}

/**
 * Scratch workspace with a redirected temporary-directory environment.
 *
 * While the workspace is alive `os.tmpdir()` resolves inside it, so every
 * program root the provider materializes lands somewhere the test owns
 * exclusively and leftovers can be enumerated exactly rather than raced against
 * every other temporary directory on the machine.
 */
export interface CodeExecutionScratch {
  /** Absolute root of the workspace; holds the temporary base and test files. */
  readonly root: string;
  /** Directory `os.tmpdir()` resolves to while this workspace is alive. */
  readonly temporaryBase: string;
  /**
   * Absolute path of a uniquely named file inside the workspace.
   *
   * The path is not created — executing programs create it, and tests wait for
   * it through {@link waitForPath}.
   * @param prefix - Human-readable prefix identifying what the file signals.
   * @returns Absolute path inside the workspace root.
   */
  path(prefix: string): string;
  /**
   * List the materialized program roots still present in the temporary base.
   * @returns Sorted names of leftover program roots.
   */
  listProgramRoots(): Promise<string[]>;
  /**
   * Restore the previous `TMPDIR`, `TEMP`, and `TMP` values and remove the workspace.
   * @returns Promise that resolves once the workspace is gone.
   */
  dispose(): Promise<void>;
}

/**
 * Create a scratch workspace and redirect `os.tmpdir()` into it.
 * @returns The workspace, its redirected temporary base, and its teardown.
 * @throws {@link Error} When the platform does not honour the temporary-directory
 * environment variables, which would silently weaken every leftover-program-root
 * assertion built on the redirect.
 */
export async function createCodeExecutionScratch(): Promise<CodeExecutionScratch> {
  const previousTemporaryDirectoryEnvironment = snapshotTemporaryDirectoryEnvironment();
  const root = await mkdtemp(join(tmpdir(), 'makaio-ce-scratch-'));
  const temporaryBase = join(root, 'tmp');
  await mkdir(temporaryBase, { recursive: true });
  redirectTemporaryDirectoryEnvironment(temporaryBase);

  if (tmpdir() !== temporaryBase) {
    restoreTemporaryDirectoryEnvironment(previousTemporaryDirectoryEnvironment);
    await rm(root, { recursive: true, force: true });
    throw new Error(
      'This platform does not honour its temporary-directory environment variables, so program-root assertions would prove nothing.',
    );
  }

  return {
    root,
    temporaryBase,
    path: (prefix) => {
      const path = join(root, `${prefix}-${randomUUID()}`);
      const relativePath = relative(root, path);
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('A scratch path prefix must not escape the workspace root.');
      }
      return path;
    },
    listProgramRoots: async () => {
      const entries = await readdir(temporaryBase);
      return entries.filter((entry) => entry.startsWith(TEMP_DIRECTORY_PREFIX)).sort();
    },
    dispose: async () => {
      restoreTemporaryDirectoryEnvironment(previousTemporaryDirectoryEnvironment);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Poll until a condition holds, so tests observe real progress instead of sleeping.
 * @param isSatisfied - Condition re-evaluated until it holds or the budget elapses.
 * @param timeoutMs - How long to keep polling before giving up.
 * @param description - What was being waited for, named in the failure message.
 * @throws {@link Error} When the condition did not hold within the budget.
 */
export async function waitUntil(
  isSatisfied: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isSatisfied()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, PATH_POLL_INTERVAL_MS));
  }
}

/**
 * Wait until a path exists, so tests observe real progress instead of sleeping.
 * @param path - Absolute path the executing handler creates.
 * @param timeoutMs - How long to keep waiting before giving up.
 * @throws {@link Error} When the path did not appear within the budget.
 */
export function waitForPath(path: string, timeoutMs: number): Promise<void> {
  return waitUntil(
    async () => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs,
    'the handler to start',
  );
}

/**
 * Program whose handler announces that it started and then never returns.
 *
 * Only terminating the worker thread ends this execution, which is what makes
 * it usable as evidence that an abort or a disposal actually tore the worker
 * down rather than merely stopping to wait for it.
 */
export const NEVER_RETURNING_PROGRAM: Readonly<Record<string, string>> = {
  'entry.ts': [
    "import { writeFileSync } from 'node:fs';",
    'interface Input { readonly startedPath: string }',
    'export const handler = (input: Input): never => {',
    "  writeFileSync(input.startedPath, 'started');",
    '  for (;;) {',
    '    // Busy loop: only worker termination ends this execution.',
    '  }',
    '};',
  ].join('\n'),
};
