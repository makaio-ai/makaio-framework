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
import type { CoreBootOptions } from '@makaio/framework/runtime-node';
import { readAllocationScopeSetting } from '@makaio/framework/services/internal/worker-provider-host-binding';
import * as publicWorkerProvider from '@makaio/framework/services/worker-provider';

const scopeSetting: NonNullable<CoreBootOptions['workerDispatch']>['scopeSetting'] = readAllocationScopeSetting({
  get: (name) => name === 'worker-host'
    ? { kind: 'config', source: 'operator configuration', config: { allocationScope: 'installation-scope' } }
    : undefined,
}, 'worker-host');

console.log(JSON.stringify({ scopeSetting, publicExports: Object.keys(publicWorkerProvider) }));
`;

it(
  'constructs a boot scope setting through the installed internal entry and keeps the public entry type-only',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-dispatch-scope-'));
    try {
      const signal = AbortSignal.timeout(OPERATIONS_TIMEOUT_MS);
      const { consumerRoot } = await prepareInstalledPackageConsumer({
        root,
        consumerName: 'worker-dispatch-scope-consumer',
        tarball: inject('installedFrameworkTarball'),
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
      expect(JSON.parse(stdout)).toEqual({
        scopeSetting: { kind: 'present', value: 'installation-scope' },
        publicExports: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  OPERATIONS_TIMEOUT_MS + 5_000,
);
