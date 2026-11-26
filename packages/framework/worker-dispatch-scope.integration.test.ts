import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, inject, it } from 'vitest';
import {
  prepareInstalledPackageConsumer,
  runInstalledPackageSetupStage,
} from './installed-package-consumer.fixture.js';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 120_000;
const COMPILE_TIMEOUT_MS = 180_000;
const RUNTIME_TIMEOUT_MS = 60_000;
const OPERATIONS_TIMEOUT_MS = INSTALL_TIMEOUT_MS + COMPILE_TIMEOUT_MS + RUNTIME_TIMEOUT_MS;

const CONSUMER = `
import {
  OrderedWorkerBootstrapAuthSchema,
  WorkflowWorkerLaunchConfigSchema,
  type OrderedWorkerBootstrapAuth,
  type WorkflowWorkerLaunchConfig,
} from '@makaio/framework/contracts';
import { bootMakaioRuntime, type BootMakaioRuntimeOptions, type CoreBootOptions, type WorkerRunStatusReader } from '@makaio/framework/runtime-node';
import { serveBunWorkerExchangeTest, type BunBootMakaioRuntimeOptions } from '@makaio/framework/runtime-bun';
import { runWorkflowInWorker, type WorkerConnectorContext } from '@makaio/framework/runtime-node/workflow-worker/worker-entry';
import { readAllocationScopeSetting } from '@makaio/framework/services/internal/worker-provider-host-binding';
import { digestWorkerBootstrapToken, type WorkerCredentialDigest } from '@makaio/framework/services/worker-provider';

// Verify the public connector accepts the same typed status reader exposed by the runtime.
function connectOrdered(context: WorkerConnectorContext, readRunStatus: WorkerRunStatusReader) {
  return context.createConnection(undefined, undefined, readRunStatus);
}

// Both native boot entry points share the same optional test policy.
const nodeBoot: Pick<BootMakaioRuntimeOptions, 'workerExchangeTest'> = {
  workerExchangeTest: {
    maxPendingExchanges: 2,
    async verifyProof() { return undefined; },
    async withRunPromotion(_database, _run, signal) { signal.throwIfAborted(); },
  },
};
const bunBoot: Pick<BunBootMakaioRuntimeOptions, 'workerExchangeTest'> = nodeBoot;

const scopeSetting: NonNullable<CoreBootOptions['workerDispatch']>['scopeSetting'] = readAllocationScopeSetting({
  get: (name) => name === 'worker-host'
    ? { kind: 'config', source: 'operator configuration', config: { allocationScope: 'installation-scope' } }
    : undefined,
}, 'worker-host');

const auth: OrderedWorkerBootstrapAuth = OrderedWorkerBootstrapAuthSchema.parse({
  kind: 'exchange',
  jobRunId: 'test-run',
  oneTimeToken: 'test-token',
  bootstrapDeadlineAt: '2030-01-01T00:00:00Z',
  replayDeadlineAt: '2030-01-01T00:01:00Z',
  proof: null,
});
const config: WorkflowWorkerLaunchConfig = WorkflowWorkerLaunchConfigSchema.parse({
  source: { kind: 'definition', workflowId: 'test-workflow' },
  workflowId: 'test-workflow',
  executionId: 'test-run',
  coordinatorSessionId: 'test-session',
  cancelSubject: 'workflow.test-run.cancel',
  orderedBusAuth: auth,
});
const digest: WorkerCredentialDigest = digestWorkerBootstrapToken('example input');
console.log(JSON.stringify({
  scopeSetting,
  bunTestListener: typeof serveBunWorkerExchangeTest,
  bootTestPolicy: typeof bootMakaioRuntime === 'function' && bunBoot.workerExchangeTest?.maxPendingExchanges,
  digestMatches: digest === 'worker-bootstrap-v1:e065986136506eb4daabc992e5f19bb0df27afe327fcb74b4aab82b169e563f4',
  workerEntryLoaded: typeof runWorkflowInWorker === 'function',
  orderedAuthParsed: config.orderedBusAuth?.kind === 'exchange',
}));
`;

it(
  'loads installed worker and host entries and verifies their public contracts',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-dispatch-scope-'));
    try {
      const signal = AbortSignal.timeout(OPERATIONS_TIMEOUT_MS);
      const { consumerRoot } = await prepareInstalledPackageConsumer({
        root,
        consumerName: 'worker-dispatch-scope-consumer',
        tarball: inject('installedFrameworkTarball'),
        optionalPeers: ['@modelcontextprotocol/sdk@^1.29.0'],
        signal,
        installTimeoutMs: INSTALL_TIMEOUT_MS,
      });
      await writeFile(join(consumerRoot, 'consumer.mts'), CONSUMER);
      await writeFile(
        join(consumerRoot, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'NodeNext', strict: true, skipLibCheck: true, types: [] },
          files: ['consumer.mts'],
        }),
      );
      const requireFromHere = createRequire(import.meta.url);
      const compiler = resolve(requireFromHere.resolve('typescript/package.json'), '..', 'bin', 'tsc');
      await execFileAsync(process.execPath, [compiler, '-p', 'tsconfig.json'], {
        cwd: consumerRoot,
        signal,
        timeout: COMPILE_TIMEOUT_MS,
      });
      const { stdout } = await runInstalledPackageSetupStage('consumer', () =>
        execFileAsync(process.execPath, ['consumer.mjs'], { cwd: consumerRoot, signal, timeout: RUNTIME_TIMEOUT_MS }),
      );
      const { stdout: bunBootExport } = await runInstalledPackageSetupStage('consumer', () =>
        execFileAsync(
          'bun',
          [
            '--eval',
            "import { bootMakaioRuntime, serveBunWorkerExchangeTest } from '@makaio/framework/runtime-bun'; console.log(typeof bootMakaioRuntime, typeof serveBunWorkerExchangeTest);",
          ],
          { cwd: consumerRoot, signal, timeout: RUNTIME_TIMEOUT_MS },
        ),
      );
      expect(bunBootExport.trim()).toBe('function function');
      expect(JSON.parse(stdout)).toEqual({
        scopeSetting: { kind: 'present', value: 'installation-scope' },
        bootTestPolicy: 2,
        bunTestListener: 'function',
        digestMatches: true,
        workerEntryLoaded: true,
        orderedAuthParsed: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  OPERATIONS_TIMEOUT_MS + 5_000,
);
