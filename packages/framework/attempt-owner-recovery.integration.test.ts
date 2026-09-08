import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFORMANCE_CONSUMER, RECOVERY_CONSUMER, TYPES_CONSUMER } from './attempt-owner-recovery.fixture.js';
import {
  INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS,
  prepareInstalledPackageConsumer,
} from './installed-package-consumer.fixture.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const BUILD_TIMEOUT_MS = 270_000;
const PACK_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const ASSERTION_TIMEOUT_MS = 30_000;
const CONFORMANCE_TIMEOUT_MS = 60_000;
// Setup owns six sequential child operations. Its aggregate deadline must not
// spend a later operation's allowance on the earlier declaration-bearing build.
// Each child retains its own hard timeout; the hook adds only cleanup headroom.
const SETUP_OPERATIONS_TIMEOUT_MS =
  BUILD_TIMEOUT_MS + PACK_TIMEOUT_MS + INSTALL_TIMEOUT_MS + 2 * ASSERTION_TIMEOUT_MS + INSTALL_TIMEOUT_MS;
const SETUP_TIMEOUT_MS = SETUP_OPERATIONS_TIMEOUT_MS + 5_000;

let temporaryRoot: string | undefined;
let consumerRoot: string;
let recovered: unknown;

/**
 * Install the real distribution before adding Vitest, so reference imports
 * cannot accidentally depend on the callable suite's optional test runner.
 * @param root - Temporary directory owned by this suite.
 * @param signal - Deadline shared by setup's bounded child processes.
 */
async function prepareConsumer(root: string, signal: AbortSignal): Promise<void> {
  const installed = await prepareInstalledPackageConsumer({
    root,
    consumerName: 'attempt-recovery-consumer',
    signal,
    buildTimeoutMs: BUILD_TIMEOUT_MS,
    packTimeoutMs: PACK_TIMEOUT_MS,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
  });
  consumerRoot = installed.consumerRoot;
  await writeFile(join(consumerRoot, 'recovery.mjs'), RECOVERY_CONSUMER);
  // Separate processes prove committed evidence survives a complete stop, not
  // merely replacement of an Authority while its old database handle survives.
  await execFileAsync(process.execPath, ['recovery.mjs', 'commit'], {
    cwd: consumerRoot,
    timeout: ASSERTION_TIMEOUT_MS,
    signal,
  });
  const recovery = await execFileAsync(process.execPath, ['recovery.mjs', 'recover'], {
    cwd: consumerRoot,
    timeout: ASSERTION_TIMEOUT_MS,
    signal,
  });
  recovered = JSON.parse(recovery.stdout);
  const vitestManifest: { version: string } = JSON.parse(
    await readFile(require.resolve('vitest/package.json'), 'utf8'),
  );
  // Include both packages: npm's no-save install prunes extraneous packages
  // from an earlier invocation if they are not requested again.
  await execFileAsync(
    'npm',
    [...INSTALLED_PACKAGE_CONSUMER_INSTALL_ARGUMENTS, installed.tarball, `vitest@${vitestManifest.version}`],
    {
      cwd: consumerRoot,
      timeout: INSTALL_TIMEOUT_MS,
      signal,
    },
  );
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'attempt-owner-recovery-'));
  await prepareConsumer(temporaryRoot, AbortSignal.timeout(SETUP_OPERATIONS_TIMEOUT_MS));
  await Promise.all([
    writeFile(join(consumerRoot, 'conformance.test.mjs'), CONFORMANCE_CONSUMER),
    writeFile(join(consumerRoot, 'consumer-types.ts'), TYPES_CONSUMER),
    writeFile(
      join(consumerRoot, 'vitest.config.mjs'),
      "export default { test: { include: ['conformance.test.mjs'], maxWorkers: 1, passWithNoTests: false } };\n",
    ),
    writeFile(
      join(consumerRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          // Check this consumer's use of installed declarations. Optional peers'
          // internal declaration diagnostics are not this integration boundary.
          skipLibCheck: true,
        },
        files: ['consumer-types.ts'],
      }),
    ),
  ]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe('installed attempt owner recovery contract', () => {
  it('recovers a canonical SQLite outcome across process exit without Vitest or Worker resubmission', () => {
    expect(recovered).toEqual({
      replay: 'replayed',
      settlement: 'outcome',
      result: { text: '{\n  "counter": 0\n}', outcome: 0 },
    });
  });

  it(
    'runs the callable conformance suite from the installed package in its own Vitest consumer',
    async () => {
      // Exit success proves the installed suite ran successfully; reporter
      // presentation varies with the terminal and is not a package contract.
      await execFileAsync(
        process.execPath,
        ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.mjs'],
        {
          cwd: consumerRoot,
          timeout: CONFORMANCE_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    },
    CONFORMANCE_TIMEOUT_MS + 5_000,
  );

  it(
    'checks required owner methods and generic outcomes through installed declaration entrypoints',
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
