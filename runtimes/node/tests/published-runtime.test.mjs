// Run with Node after building and staging the release packages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Use the temporary runtime home's SQLite database regardless of the invoking shell.
delete process.env.MAKAIO_DATABASE_PATH;
delete process.env.MAKAIO_DATABASE_URL;

const run = promisify(execFile);
const runtimeModules = join(import.meta.dirname, '../node_modules');
let consumerRoot;
let resolveEntry;

before(async () => {
  // Extract both release tarballs into one consumer. The workspace supplies third-party dependencies.
  consumerRoot = await mkdtemp(join(runtimeModules, '.published-runtime-test-'));
  const frameworkRoot = dirname(createRequire(import.meta.url).resolve('@makaio/framework/package.json'));
  for (const packageRoot of [frameworkRoot, join(runtimeModules, '.makaio-publish')]) {
    const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', consumerRoot], {
      cwd: packageRoot,
    });
    const [{ filename, name }] = JSON.parse(stdout);
    const target = join(consumerRoot, 'node_modules', name);
    await mkdir(target, { recursive: true });
    await run('tar', ['-xzf', join(consumerRoot, filename), '--strip-components', '1', '-C', target]);
  }
  resolveEntry = createRequire(join(consumerRoot, 'package.json')).resolve;
});

after(async () => {
  if (consumerRoot !== undefined) await rm(consumerRoot, { recursive: true, force: true });
});

/**
 * Load an entry through the staged package's export map and peer resolution.
 * @param {string} specifier - Package entry to load.
 * @returns {Promise<object>} The published entry namespace.
 */
async function loadPublishedEntry(specifier) {
  return import(pathToFileURL(resolveEntry(specifier)).href);
}

test('worker provider composition controls are available through the internal framework entry', async () => {
  const publicEntry = '@makaio/framework/services/worker-provider';
  assert.deepEqual(Object.keys(await loadPublishedEntry(publicEntry)), []);
  const internal = await loadPublishedEntry('@makaio/framework/services/internal/worker-provider-host-binding');
  assert.equal(typeof internal.WorkerProviderRegistry, 'function');
  assert.equal(typeof internal.createWorkerDispatch, 'function');
  await assert.rejects(loadPublishedEntry(`${publicEntry}/host-binding`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('the published runtime aborts boot on a collision from its own discovery', async () => {
  const { bootMakaioRuntime, ExtensionNameCollisionError, FilesystemDescriptorDiscovery } =
    await loadPublishedEntry('@makaio/runtime-node');
  const discoveryEntry = await loadPublishedEntry('@makaio/runtime-node/extension-discovery');
  assert.equal(discoveryEntry.ExtensionNameCollisionError, ExtensionNameCollisionError);
  assert.equal(discoveryEntry.FilesystemDescriptorDiscovery, FilesystemDescriptorDiscovery);

  const root = await mkdtemp(join(tmpdir(), 'makaio-runtime-collision-'));
  const httpServer = createServer();
  try {
    for (const name of ['first-copy', 'second-copy']) {
      const directory = join(root, 'node_modules', name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'descriptor.json'),
        JSON.stringify({
          name: 'shared-ext',
          displayName: 'Shared Extension',
          version: '1.0.0',
          makaio: { framework: '>=1.0.0' },
          entrypoints: { server: true },
        }),
      );
    }

    const discovery = new FilesystemDescriptorDiscovery(root);
    await assert.rejects(discovery.discover(), ExtensionNameCollisionError);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const boot = bootMakaioRuntime({
      httpServer,
      makaioHome: join(root, 'home'),
      centralMigrationsDir: join(dirname(resolveEntry('@makaio/framework/package.json')), 'dist', 'drizzle'),
      frameworkVersion: '1.0.0',
      discovery,
    });
    await assert.rejects(
      boot.then(async (runtime) => runtime.shutdown()),
      ExtensionNameCollisionError,
    );
  } finally {
    httpServer.close();
    await rm(root, { recursive: true, force: true });
  }
});
