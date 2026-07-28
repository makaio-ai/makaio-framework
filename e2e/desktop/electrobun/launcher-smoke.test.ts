/**
 * Smoke tests for the CLI launcher bundle (`dist/cli.mjs`).
 *
 * Verifies that the Bun-bundled CLI entrypoint:
 * - Exists as a built artifact.
 * - Can be executed by Bun without errors.
 * - Returns the expected version string for `--version`.
 * - Returns help text that names the program and the built-in `serve` command
 *   for `--help`.
 *
 * These tests invoke the real Electrobun build before checking the launcher.
 * They also assemble an isolated `@makaio/framework` runtime package, because
 * the launcher bundle externalizes framework imports to package subpaths.
 * That full framework + launcher build is why this lives in the desktop E2E
 * surface rather than the default unit test surface.
 *
 * Building the fixture is setup, not the thing under test. It therefore runs in
 * `beforeAll` under its own budget, and a build that overruns that budget is
 * reported as a fixture-build failure naming the step — never as a launcher
 * defect. Where the failure happened must stay readable from the CI output
 * alone; why the build overran (contended runner vs. hung build) is not
 * decidable from the timeout and is deliberately left open.
 *
 * The test uses `execFileSync` (not `execSync`) to avoid shell interpretation
 * of the bundle path and to keep argument handling explicit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', 'apps', 'electrobun');
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);
const TEST_OUTPUT_ROOT = path.join(PACKAGE_ROOT, 'dist', '.tests');
mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
const TEST_ROOT = mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'launcher-smoke-'));
const DIST_DIR = path.join(TEST_ROOT, 'electrobun');
const CLI_BUNDLE = path.join(DIST_DIR, 'cli.mjs');
const FRAMEWORK_PACKAGE_ROOT = path.join(DIST_DIR, 'node_modules', '@makaio', 'framework');
const FRAMEWORK_DIST = path.join(FRAMEWORK_PACKAGE_ROOT, 'dist');
const REQUIRED_FRAMEWORK_EXPORT = 'FrameworkContractNamespaces';
const REQUIRED_FRAMEWORK_FILES = ['contracts/index.mjs', 'utils/workspace-packages.mjs'];

/**
 * Time budgets for the fixture build steps, in milliseconds.
 *
 * `execFileSync` blocks the worker, so a Vitest hook timeout cannot interrupt a
 * running build — these child-process budgets are the only enforcement that
 * actually fires. They exist to catch a *hung* build, not to police build
 * speed: a warm developer machine assembles the framework in well under a
 * minute, while a cold, contended CI runner has been observed an order of
 * magnitude slower. Sizing them for hang detection keeps machine speed out of
 * the pass/fail decision.
 */
const FRAMEWORK_BUILD_BUDGET_MS = 600_000;
const LAUNCHER_BUILD_BUDGET_MS = 120_000;

/**
 * Hook budget, derived from the step budgets so the two cannot drift apart.
 *
 * Keeping it strictly above the sum guarantees that an overrunning build is
 * always reported by the step that overran, never as an unattributed
 * "hook timed out".
 */
const BUILD_HOOK_BUDGET_MS = FRAMEWORK_BUILD_BUDGET_MS + LAUNCHER_BUILD_BUDGET_MS + 30_000;

/**
 * Shared env for all CLI invocations.
 *
 * Provides an isolated `MAKAIO_HOME` so the CLI does not read the developer's
 * real home directory during tests. The directory need not exist — the CLI
 * handles missing home directories gracefully for read-only commands.
 */
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MAKAIO_HOME: path.join(TEST_ROOT, 'home'),
};

describe('CLI launcher smoke test', () => {
  beforeAll(() => {
    try {
      runBuildStep('framework runtime package', 'yarn', ['run', '-T', 'build:framework'], {
        budgetMs: FRAMEWORK_BUILD_BUDGET_MS,
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, MAKAIO_FRAMEWORK_BUILD_PACKAGE_ROOT: FRAMEWORK_PACKAGE_ROOT },
      });
      runBuildStep('electrobun launcher bundle', 'bun', ['run', 'build.ts'], {
        budgetMs: LAUNCHER_BUILD_BUDGET_MS,
        cwd: PACKAGE_ROOT,
        env: { ...process.env, MAKAIO_ELECTROBUN_BUILD_OUTDIR: DIST_DIR },
      });
      assertFrameworkRuntimeOutput();
    } catch (error) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
      throw error;
    }
  }, BUILD_HOOK_BUDGET_MS);

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('dist/cli.mjs exists after build', () => {
    expect(existsSync(CLI_BUNDLE)).toBe(true);
  });

  it('bun can execute --version', () => {
    const result = execFileSync('bun', [CLI_BUNDLE, '--version'], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: TEST_ENV,
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('bun can execute --help', () => {
    const result = execFileSync('bun', [CLI_BUNDLE, '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: TEST_ENV,
    }).trim();
    expect(result).toContain('makaio');
    expect(result).toContain('serve');
  });
});

/** Execution parameters for a single fixture build step. */
interface BuildStepOptions {
  /** Time budget for the step, in milliseconds. */
  budgetMs: number;
  /** Working directory for the spawned build. */
  cwd: string;
  /** Environment for the spawned build. */
  env: NodeJS.ProcessEnv;
}

/**
 * Run one fixture build step under an explicit time budget.
 *
 * Node reports an exhausted budget as a bare `spawnSync <command> ETIMEDOUT`,
 * which in CI reads as though the launcher smoke test itself failed. Rethrowing
 * with the step name and budget keeps "the fixture build did not finish"
 * distinguishable from "the launcher is broken", so a green rerun is no longer
 * the only way to tell the two apart. The timeout alone cannot say *why* the
 * build overran — a contended runner and a hung build regression raise the
 * identical error — so the message states where the failure happened, not its
 * cause.
 * @param step - Human-readable name of the build step.
 * @param command - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param options - Working directory, environment, and time budget.
 */
function runBuildStep(step: string, command: string, args: string[], options: BuildStepOptions): void {
  try {
    execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      timeout: options.budgetMs,
    });
  } catch (error) {
    throw describeBuildStepFailure(step, command, options.budgetMs, error);
  }
}

/**
 * Attribute a failed build step to the fixture build rather than the launcher.
 * @param step - Human-readable name of the build step.
 * @param command - Executable that was run.
 * @param budgetMs - Time budget the step was given, in milliseconds.
 * @param cause - Original error thrown by the spawn.
 * @returns Error naming the step, with the original error preserved as cause.
 */
function describeBuildStepFailure(step: string, command: string, budgetMs: number, cause: unknown): Error {
  const prefix = `Launcher smoke fixture build step "${step}" (${command})`;
  if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    // Deliberately no cause attribution: a contended runner and a deterministic
    // build hang both surface as the same ETIMEDOUT, so the message only claims
    // what the timeout proves — the build step overran and the launcher
    // assertions never ran.
    return new Error(
      `${prefix} exceeded its ${budgetMs / 1000}s budget, so the launcher assertions never ran. ` +
        'The timeout does not identify a cause: the build may have been slow on a contended machine ' +
        'or hung on a build regression. Check the inherited build output above before rerunning.',
      { cause },
    );
  }
  return new Error(`${prefix} failed before the launcher assertions ran.`, { cause });
}

/**
 * Verify that assembled framework output contains the runtime surface needed by
 * the launcher bundle.
 */
function assertFrameworkRuntimeOutput(): void {
  if (!frameworkOutputExports(FRAMEWORK_DIST, REQUIRED_FRAMEWORK_EXPORT)) {
    throw new Error(`Framework dist does not export ${REQUIRED_FRAMEWORK_EXPORT}.`);
  }
  for (const filePath of REQUIRED_FRAMEWORK_FILES) {
    if (!existsSync(path.join(FRAMEWORK_DIST, filePath))) {
      throw new Error(`Framework dist is missing required runtime file: ${filePath}`);
    }
  }
}

/**
 * Check whether assembled framework output contains a runtime export.
 * @param outputRoot - Candidate framework output root (`lib` or `dist`).
 * @param exportName - Runtime export name required by the launcher bundle.
 * @returns True when the output's contracts entrypoint exports the name.
 */
function frameworkOutputExports(outputRoot: string, exportName: string): boolean {
  const entrypoint = path.join(outputRoot, 'contracts', 'index.mjs');
  if (!existsSync(entrypoint)) return false;
  return sourceExportsName(readFileSync(entrypoint, 'utf8'), exportName);
}

/**
 * Escape a string for use inside a regular expression.
 * @param value - Literal string to escape.
 * @returns Regex-safe version of the value.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether source text actually exports a given name.
 * @param source - JavaScript module source to inspect.
 * @param exportName - Exported name to find.
 * @returns True when the source declares or re-exports `exportName`.
 */
function sourceExportsName(source: string, exportName: string): boolean {
  const escapedExportName = escapeRegExp(exportName);
  if (new RegExp(`\\bexport\\s+(?:const|let|var|function|class)\\s+${escapedExportName}\\b`).test(source)) {
    return true;
  }
  if (new RegExp(`\\bexport\\s+default\\s+${escapedExportName}\\b`).test(source)) {
    return true;
  }

  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const exportList = match[1] ?? '';
    for (const specifier of exportList.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const exportedName = parts.length > 1 ? parts.at(-1)?.trim() : parts[0]?.trim();
      if (exportedName === exportName) return true;
    }
  }

  return false;
}

describe('fixture build step failure attribution', () => {
  /**
   * Run a real probe process through {@link runBuildStep} and capture its error.
   * @param step - Step name to attribute the failure to.
   * @param source - Source passed to `node -e` for the probe process.
   * @param budgetMs - Budget granted to the probe.
   * @returns The error thrown by the build step.
   */
  function captureStepFailure(step: string, source: string, budgetMs: number): Error {
    try {
      runBuildStep(step, process.execPath, ['-e', source], { budgetMs, cwd: WORKSPACE_ROOT, env: process.env });
    } catch (error) {
      return error as Error;
    }
    throw new Error(`Build step "${step}" was expected to fail but succeeded.`);
  }

  it('reports a step that outruns its budget without attributing a cause', () => {
    // A real spawn against a real budget: the probe never exits in time, so
    // Node raises the same ETIMEDOUT the framework build raises under load.
    const error = captureStepFailure('budget probe', 'setTimeout(() => undefined, 30000)', 1_000);

    expect(error.message).toContain('build step "budget probe"');
    expect(error.message).toContain('exceeded its 1s budget');
    // A hung build and a contended runner raise the identical ETIMEDOUT, so
    // the message must locate the failure (build step, before the launcher
    // assertions) without deciding between those causes.
    expect(error.message).toContain('launcher assertions never ran');
    expect(error.message).toContain('does not identify a cause');
    expect((error.cause as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
  });

  it('reports a step that fails outright without blaming the budget', () => {
    const error = captureStepFailure('failure probe', 'process.exit(3)', 60_000);

    expect(error.message).toContain('build step "failure probe"');
    expect(error.message).toContain('failed before the launcher assertions ran');
    expect(error.message).not.toContain('budget');
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('framework output export detection', () => {
  it('matches real ES export syntax only', () => {
    expect(sourceExportsName('export const FrameworkContractNamespaces = [];', REQUIRED_FRAMEWORK_EXPORT)).toBe(true);
    expect(
      sourceExportsName('const Fa = []; export { Fa as FrameworkContractNamespaces };', REQUIRED_FRAMEWORK_EXPORT),
    ).toBe(true);
    expect(sourceExportsName('const FrameworkContractNamespaces = [];', REQUIRED_FRAMEWORK_EXPORT)).toBe(false);
    expect(sourceExportsName('export { FrameworkContractNamespaces as OtherName };', REQUIRED_FRAMEWORK_EXPORT)).toBe(
      false,
    );
  });
});
