import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInstalledPackageConsumer } from './installed-package-consumer.fixture.js';
import { HEADLESS_GIT_CONSUMER, TYPES_CONSUMER } from './local-git-workspace-preparation.fixture.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const SETUP_TIMEOUT_MS = 270_000;
const ASSERTION_TIMEOUT_MS = 60_000;

let temporaryRoot: string | undefined;
let consumerRoot: string;
let result: unknown;

/**
 * Build and install the umbrella package into an isolated consumer directory.
 * @param root - Temporary directory owned by this suite.
 * @param signal - Deadline shared by setup's bounded child processes.
 */
async function prepareConsumer(root: string, signal: AbortSignal): Promise<void> {
  const installed = await prepareInstalledPackageConsumer({
    root,
    consumerName: 'headless-git-preparation-consumer',
    signal,
    buildTimeoutMs: SETUP_TIMEOUT_MS,
    packTimeoutMs: 60_000,
    installTimeoutMs: 120_000,
  });
  consumerRoot = installed.consumerRoot;
  await Promise.all([
    writeFile(join(consumerRoot, 'consumer.mjs'), HEADLESS_GIT_CONSUMER),
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
  await execFileAsync(process.execPath, ['consumer.mjs'], {
    cwd: consumerRoot,
    timeout: ASSERTION_TIMEOUT_MS,
    signal,
    maxBuffer: 10 * 1024 * 1024,
  });
  result = JSON.parse(await readFile(join(consumerRoot, 'result.json'), 'utf8'));
}

// The local Git source realizer deliberately supports POSIX process groups only.
describe.skipIf(process.platform === 'win32')('installed local Git Workspace Preparation contract', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'local-git-workspace-preparation-'));
    await prepareConsumer(temporaryRoot, AbortSignal.timeout(SETUP_TIMEOUT_MS - 5_000));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('runs Headless preparation from the installed public package against the selected Git revision', () => {
    expect(result).toEqual({
      operations: ['workspace-preparation', 'workload-invocation'],
      decision: 'accepted',
    });
  });

  it(
    'checks the public factory and Headless dependency seam through installed declarations',
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
