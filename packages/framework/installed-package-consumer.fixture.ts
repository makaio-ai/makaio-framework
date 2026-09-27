import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/**
 * Retain only progress emitted by this package's three fixed build stages.
 * Child output, error messages, arguments and environment are never forwarded.
 * @param result - Child result or failure carrying captured output.
 * @returns At most one start and completion record per build phase.
 */
function buildProgress(result: unknown): string[] {
  if (!result || typeof result !== 'object' || !('stdout' in result) || typeof result.stdout !== 'string') {
    return [];
  }
  const records = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const start = /^\[build\] (bus|core|react) — ([0-9]{1,6}) entries$/.exec(line);
    const end = /^\[build\] (bus|core|react) done in ([0-9]{1,6}\.[0-9])s$/.exec(line);
    if (start) records.set(`${start[1]}-start`, `[build] ${start[1]} — ${start[2]} entries`);
    if (end) records.set(`${end[1]}-end`, `[build] ${end[1]} done in ${end[2]}s`);
  }
  return [...records.values()];
}

/**
 * Identify setup progress without exposing child arguments or environment.
 * Wall-clock intervals correlate independent workers; elapsed times are monotonic.
 * @param stage - Fixed setup phase being executed.
 * @param execute - Existing bounded operation, with its original deadline.
 * @returns The operation's result.
 */
export async function runInstalledPackageSetupStage<T>(
  stage: 'build' | 'pack' | 'install' | 'consumer',
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const startedAtEpochMs = Date.now();
  const parallelism = availableParallelism();
  const label = `Installed package setup stage "${stage}"`;
  // Direct stderr bypasses console filtering; AI_AGENT setup may still suppress it.
  process.stderr.write(`${label} started at ${startedAtEpochMs}ms; parallelism ${parallelism}.\n`);
  try {
    const result = await execute();
    const progress = stage === 'build' ? buildProgress(result) : [];
    process.stderr.write(
      `${label} completed at ${Date.now()}ms after ${Math.round(performance.now() - startedAt)}ms; started at ${startedAtEpochMs}ms.\n${progress.length ? `${progress.join('\n')}\n` : ''}`,
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'child process failed';
    const progress = stage === 'build' ? buildProgress(error) : [];
    const child =
      error && typeof error === 'object'
        ? (error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown })
        : {};
    const stderr = typeof child.stderr === 'string' ? child.stderr : '';
    const termination = [
      typeof child.code === 'number' ? `exit ${child.code}` : undefined,
      typeof child.signal === 'string' && /^[A-Z0-9]+$/.test(child.signal) ? `signal ${child.signal}` : undefined,
      child.killed === true ? 'killed' : undefined,
      /(?:heap out of memory|reached heap limit)/i.test(stderr) ? 'v8HeapLimit=true' : undefined,
    ].filter((value): value is string => value !== undefined);
    const message = `${label} ${reason}${termination.length ? ` (${termination.join(', ')})` : ''} after ${Math.round(performance.now() - startedAt)}ms; started at ${startedAtEpochMs}ms; ended at ${Date.now()}ms; parallelism ${parallelism}.${progress.length ? `\n${progress.join('\n')}` : ''}`;
    process.stderr.write(`${message}\n`);
    throw new Error(message);
  }
}

/** npm arguments required for every isolated tarball-consumer installation. */
export const INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS = [
  'install',
  '--no-save',
  '--no-package-lock',
  '--no-audit',
  '--no-fund',
  '--prefer-offline',
  '--ignore-scripts',
  '--legacy-peer-deps',
];

declare module 'vitest' {
  /** Values the Packages project's global setup hands to its test workers. */
  export interface ProvidedContext {
    /** Immutable framework tarball built once per run; present only when an installed-package suite runs. */
    installedFrameworkTarball: string;
  }
}

/** One isolated package consumer owned by a single integration suite. */
export interface InstalledPackageConsumer {
  /** Consumer directory containing the installed tarball. */
  readonly consumerRoot: string;
  /** Tarball used for the initial installation and optional test-only dependencies. */
  readonly tarball: string;
}

/** Options for the single declaration-bearing framework build of a test run. */
export interface BuildInstalledFrameworkTarballOptions {
  /** Temporary root whose lifecycle is owned by the global setup. */
  readonly root: string;
  /** Deadline shared by the build and pack commands. */
  readonly signal: AbortSignal;
  /** Maximum duration of the declaration-bearing umbrella build. */
  readonly buildTimeoutMs: number;
  /** Maximum duration of npm pack. */
  readonly packTimeoutMs: number;
}

/**
 * Build and pack the declaration-bearing framework umbrella package.
 * @param options - Owned root and bounded build/pack commands.
 * @returns Absolute path of the packed tarball.
 */
export async function buildInstalledFrameworkTarball(options: BuildInstalledFrameworkTarballOptions): Promise<string> {
  const buildRoot = join(options.root, 'package');
  const packRoot = join(options.root, 'pack');
  await mkdir(packRoot);
  // tsdown and rolldown-plugin-dts support Node; Bun can leave eager DTS builds pending at the bus stage.
  // The declaration-heavy core stage exceeds Node's default 4 GiB V8 heap.
  await runInstalledPackageSetupStage('build', () =>
    execFileAsync(process.execPath, ['--max-old-space-size=8192', '--import', 'tsx', 'build.ts'], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        MAKAIO_FRAMEWORK_BUILD_PACKAGE_ROOT: buildRoot,
        MAKAIO_FRAMEWORK_BUILD_SKIP_DTS: '0',
        MAKAIO_FRAMEWORK_BUILD_TSGO_DTS: '0',
      },
      timeout: options.buildTimeoutMs,
      signal: options.signal,
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  const { stdout } = await runInstalledPackageSetupStage('pack', () =>
    execFileAsync('npm', ['pack', '--pack-destination', packRoot], {
      cwd: buildRoot,
      timeout: options.packTimeoutMs,
      signal: options.signal,
    }),
  );
  return join(packRoot, stdout.trim());
}

/** Options for one independently owned installed-package proof. */
export interface PrepareInstalledPackageConsumerOptions {
  /** Temporary root whose lifecycle is owned by the calling test suite. */
  readonly root: string;
  /** Private package name written into the isolated consumer manifest. */
  readonly consumerName: string;
  /** Shared tarball injected from the global setup (`inject('installedFrameworkTarball')`). */
  readonly tarball: string | undefined;
  /** Deadline shared by the suite's initial installation. */
  readonly signal: AbortSignal;
  /** Maximum duration of the initial tarball installation. */
  readonly installTimeoutMs: number;
}

/**
 * Install the run's shared framework tarball into one suite's own consumer.
 *
 * The Packages project's global setup builds and packs the framework once per
 * run; the resulting tarball is immutable and shared read-only by every
 * installed-package suite. The isolation boundary is the per-suite npm
 * installation into a consumer root under the caller's own temporary
 * directory: suites never share an installed `node_modules`, consumer files,
 * or cleanup lifetimes.
 * @param options - Suite-owned root, package identity, shared tarball, and bounded install.
 * @returns Installed consumer root and the exact tarball it received.
 */
export async function prepareInstalledPackageConsumer(
  options: PrepareInstalledPackageConsumerOptions,
): Promise<InstalledPackageConsumer> {
  const { tarball } = options;
  if (!tarball) {
    throw new Error(
      'No framework tarball was provided. Add this suite to INSTALLED_PACKAGE_SUITES in installed-package-tarball.global-setup.ts.',
    );
  }
  const consumerRoot = join(options.root, 'consumer');
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, 'package.json'),
    JSON.stringify({ name: options.consumerName, private: true, type: 'module' }),
  );
  await runInstalledPackageSetupStage('install', () =>
    execFileAsync('npm', [...INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS, tarball], {
      cwd: consumerRoot,
      timeout: options.installTimeoutMs,
      signal: options.signal,
    }),
  );
  return { consumerRoot, tarball };
}
