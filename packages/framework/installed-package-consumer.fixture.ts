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
    const message = `${label} ${reason} after ${Math.round(performance.now() - startedAt)}ms; started at ${startedAtEpochMs}ms; ended at ${Date.now()}ms; parallelism ${parallelism}.${progress.length ? `\n${progress.join('\n')}` : ''}`;
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

/** One isolated package consumer built by a single integration suite. */
export interface InstalledPackageConsumer {
  /** Consumer directory containing the installed tarball. */
  readonly consumerRoot: string;
  /** Tarball used for the initial installation and optional test-only dependencies. */
  readonly tarball: string;
}

/** Options for one independently owned installed-package proof. */
export interface PrepareInstalledPackageConsumerOptions {
  /** Temporary root whose lifecycle is owned by the calling test suite. */
  readonly root: string;
  /** Private package name written into the isolated consumer manifest. */
  readonly consumerName: string;
  /** Deadline shared by the suite's build, pack, and initial installation. */
  readonly signal: AbortSignal;
  /** Maximum duration of the declaration-bearing umbrella build. */
  readonly buildTimeoutMs: number;
  /** Maximum duration of npm pack. */
  readonly packTimeoutMs: number;
  /** Maximum duration of the initial tarball installation. */
  readonly installTimeoutMs: number;
}

/**
 * Build and install a declaration-bearing framework tarball for one suite.
 *
 * Each caller supplies an independently owned temporary root. Keeping the
 * artifacts separate avoids sharing partially built output or cleanup
 * lifetimes between concurrent package proofs; the deliberate repeated build
 * is the isolation boundary, not a cache opportunity.
 * @param options - Suite-owned root, package identity, and bounded commands.
 * @returns Installed consumer root and the exact tarball it received.
 */
export async function prepareInstalledPackageConsumer(
  options: PrepareInstalledPackageConsumerOptions,
): Promise<InstalledPackageConsumer> {
  const buildRoot = join(options.root, 'package');
  const packRoot = join(options.root, 'pack');
  const consumerRoot = join(options.root, 'consumer');
  await Promise.all([mkdir(packRoot), mkdir(consumerRoot)]);
  await runInstalledPackageSetupStage('build', () =>
    execFileAsync('bun', ['build.ts'], {
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
  const tarball = join(packRoot, stdout.trim());
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
