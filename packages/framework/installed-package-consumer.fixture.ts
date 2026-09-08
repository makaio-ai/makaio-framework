import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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
  await execFileAsync('bun', ['build.ts'], {
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
  });
  const { stdout } = await execFileAsync('npm', ['pack', '--pack-destination', packRoot], {
    cwd: buildRoot,
    timeout: options.packTimeoutMs,
    signal: options.signal,
  });
  const tarball = join(packRoot, stdout.trim());
  await writeFile(
    join(consumerRoot, 'package.json'),
    JSON.stringify({ name: options.consumerName, private: true, type: 'module' }),
  );
  await execFileAsync('npm', [...INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS, tarball], {
    cwd: consumerRoot,
    timeout: options.installTimeoutMs,
    signal: options.signal,
  });
  return { consumerRoot, tarball };
}
