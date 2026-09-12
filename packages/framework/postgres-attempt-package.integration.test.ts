import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS,
  prepareInstalledPackageConsumer,
  runInstalledPackageSetupStage,
} from './installed-package-consumer.fixture.js';
import { RUNTIME_CONSUMER, TYPES_CONSUMER } from './postgres-attempt-package.fixture.js';
import { stagePackageForNpmPublish } from '../../scripts/lib/npm-publish-staging.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FRAMEWORK_BUILD_TIMEOUT_MS = 270_000;
const STORAGE_PG_BUILD_TIMEOUT_MS = 270_000;
const PACK_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const ASSERTION_TIMEOUT_MS = 30_000;
// `prepareInstalledPackageConsumer` owns framework build, pack, and its initial
// installation. The pair is then reinstalled together because npm otherwise
// prunes the first tarball while installing the second one.
const SETUP_OPERATIONS_TIMEOUT_MS =
  FRAMEWORK_BUILD_TIMEOUT_MS +
  PACK_TIMEOUT_MS +
  INSTALL_TIMEOUT_MS +
  STORAGE_PG_BUILD_TIMEOUT_MS +
  PACK_TIMEOUT_MS +
  INSTALL_TIMEOUT_MS +
  ASSERTION_TIMEOUT_MS;
const SETUP_TIMEOUT_MS = SETUP_OPERATIONS_TIMEOUT_MS + 5_000;
const STORAGE_PG_PACKAGE_DIR = join(import.meta.dirname, '../../storage/pg');

let temporaryRoot: string | undefined;
let consumerRoot: string;
let frameworkVersion: string;
let stagedStorageManifest: {
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: unknown;
};

/**
 * Build, stage, pack, and install the public framework/storage-pg pair.
 * @param root - Isolated temporary root for both package tarballs and their consumer.
 * @param signal - Cancellation signal shared by the package preparation subprocesses.
 */
async function prepareConsumer(root: string, signal: AbortSignal): Promise<void> {
  const framework = await prepareInstalledPackageConsumer({
    root,
    consumerName: 'postgres-attempt-package-consumer',
    signal,
    buildTimeoutMs: FRAMEWORK_BUILD_TIMEOUT_MS,
    packTimeoutMs: PACK_TIMEOUT_MS,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
  });
  consumerRoot = framework.consumerRoot;

  // storage-pg has no isolated output-root switch. Build its canonical output
  // once, then immediately copy the staged package to this suite's temp root.
  await runInstalledPackageSetupStage('build', () =>
    execFileAsync(process.execPath, ['--import', 'tsx', 'build.ts'], {
      cwd: STORAGE_PG_PACKAGE_DIR,
      timeout: STORAGE_PG_BUILD_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    }),
  );

  const frameworkManifest: { readonly version: string } = JSON.parse(
    await readFile(join(import.meta.dirname, 'package.json'), 'utf8'),
  );
  frameworkVersion = frameworkManifest.version;
  const stagedStorageRoot = stagePackageForNpmPublish(STORAGE_PG_PACKAGE_DIR, frameworkManifest.version, {
    '@makaio/framework': frameworkManifest.version,
  });
  const isolatedStorageRoot = join(root, 'storage-pg-package');
  await cp(stagedStorageRoot, isolatedStorageRoot, { recursive: true });
  stagedStorageManifest = JSON.parse(await readFile(join(isolatedStorageRoot, 'package.json'), 'utf8'));

  const storagePackRoot = join(root, 'storage-pg-pack');
  await mkdir(storagePackRoot);
  const { stdout } = await runInstalledPackageSetupStage('pack', () =>
    execFileAsync('npm', ['pack', '--pack-destination', storagePackRoot], {
      cwd: isolatedStorageRoot,
      timeout: PACK_TIMEOUT_MS,
      signal,
    }),
  );
  const storageTarball = join(storagePackRoot, stdout.trim());

  // Both tarballs must appear in this one invocation: npm's no-save install
  // removes packages requested by an earlier invocation but omitted here.
  await runInstalledPackageSetupStage('install', () =>
    execFileAsync('npm', [...INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS, framework.tarball, storageTarball], {
      cwd: consumerRoot,
      timeout: INSTALL_TIMEOUT_MS,
      signal,
    }),
  );
  await Promise.all([
    writeFile(join(consumerRoot, 'consumer.mjs'), RUNTIME_CONSUMER),
    writeFile(join(consumerRoot, 'consumer-types.ts'), TYPES_CONSUMER),
    writeFile(
      join(consumerRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          skipLibCheck: true,
        },
        files: ['consumer-types.ts'],
      }),
    ),
  ]);
  await runInstalledPackageSetupStage('consumer', () =>
    execFileAsync(process.execPath, ['consumer.mjs'], {
      cwd: consumerRoot,
      timeout: ASSERTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

describe('installed PostgreSQL execution-attempt package pair', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'postgres-attempt-package-'));
    await prepareConsumer(temporaryRoot, AbortSignal.timeout(SETUP_OPERATIONS_TIMEOUT_MS));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('rewrites the storage peer for publication before the isolated tarball install', () => {
    expect(stagedStorageManifest.peerDependencies?.['@makaio/framework']).toBe(`^${frameworkVersion}`);
    expect(stagedStorageManifest.devDependencies).toBeUndefined();
  });

  it(
    'type-checks the PostgreSQL factory and workflow-engine contract through installed declarations',
    async () => {
      try {
        await execFileAsync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.json'], {
          cwd: consumerRoot,
          timeout: ASSERTION_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof Error && 'stdout' in error && error.stdout) {
          throw new Error(String(error.stdout).trim(), { cause: error });
        }
        throw error;
      }
    },
    ASSERTION_TIMEOUT_MS + 5_000,
  );
});
