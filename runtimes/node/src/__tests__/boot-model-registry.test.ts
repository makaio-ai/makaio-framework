import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBootModelRegistryFetcher,
  MAKAIO_MODEL_REGISTRY_SOURCES_ENV,
  resolveBundledSeedPaths,
} from '../boot-model-registry.js';

/**
 * Minimal valid registry YAML fixture.
 * @param modelName - Canonical model name to include in the fixture.
 * @returns Registry YAML for one lab and provider.
 */
function registryYaml(modelName = 'test-model'): string {
  return `\
$schema: makaio/model-registry/v2
updatedAt: "2026-01-30T12:00:00.000Z"
labs:
  test:
    name: Test Lab
    models:
      - name: ${modelName}
        contextWindowSize: 8000
        labId: test
providers:
  test:
    name: Test Provider
    models:
      ${modelName}: {}
`;
}

describe('boot model registry sources', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'boot-model-registry-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses optional environment sources before framework defaults', async () => {
    const seedPath = path.join(tmpDir, 'env-registry.yaml');
    await fs.promises.writeFile(seedPath, registryYaml(), 'utf-8');

    const fetcher = createBootModelRegistryFetcher({
      makaioHome: path.join(tmpDir, 'home'),
      srcDir: path.join(tmpDir, 'missing-src'),
      env: { [MAKAIO_MODEL_REGISTRY_SOURCES_ENV]: JSON.stringify([seedPath, seedPath]) },
    });

    const registry = await fetcher.fetch();

    expect(registry.labs.test?.models[0]?.name).toBe('test-model');
  });

  it('uses host-provided priority seed paths before framework defaults', async () => {
    const seedPath = path.join(tmpDir, 'packaged-resource', 'model-registry.yaml');
    await fs.promises.mkdir(path.dirname(seedPath), { recursive: true });
    await fs.promises.writeFile(seedPath, registryYaml(), 'utf-8');

    const fetcher = createBootModelRegistryFetcher({
      makaioHome: path.join(tmpDir, 'home'),
      srcDir: path.join(tmpDir, 'missing-src'),
      seedPaths: [seedPath],
      env: {},
    });

    const registry = await fetcher.fetch();

    expect(registry.labs.test?.models[0]?.name).toBe('test-model');
  });

  it('prefers the CDN source over host-provided fallback seed paths', async () => {
    const seedPath = path.join(tmpDir, 'packaged-resource', 'model-registry.yaml');
    await fs.promises.mkdir(path.dirname(seedPath), { recursive: true });
    await fs.promises.writeFile(seedPath, registryYaml('fallback-model'), 'utf-8');

    await withRegistryServer({ status: 200, body: registryYaml('cdn-model') }, async (cdnRegistryUrl) => {
      const fetcher = createBootModelRegistryFetcher({
        makaioHome: path.join(tmpDir, 'home'),
        srcDir: path.join(tmpDir, 'missing-src'),
        cdnRegistryUrl,
        fallbackSeedPaths: [seedPath],
        env: {},
        cwd: tmpDir,
      });

      const registry = await fetcher.fetch();

      expect(registry.labs.test?.models[0]?.name).toBe('cdn-model');
    });
  });

  it('uses host-provided fallback seed paths when the CDN source fails', async () => {
    const seedPath = path.join(tmpDir, 'packaged-resource', 'model-registry.yaml');
    await fs.promises.mkdir(path.dirname(seedPath), { recursive: true });
    await fs.promises.writeFile(seedPath, registryYaml('fallback-model'), 'utf-8');

    await withRegistryServer({ status: 500, body: 'unavailable' }, async (cdnRegistryUrl) => {
      const fetcher = createBootModelRegistryFetcher({
        makaioHome: path.join(tmpDir, 'home'),
        srcDir: path.join(tmpDir, 'missing-src'),
        cdnRegistryUrl,
        fallbackSeedPaths: [seedPath],
        env: {},
        cwd: tmpDir,
      });

      const registry = await fetcher.fetch();

      expect(registry.labs.test?.models[0]?.name).toBe('fallback-model');
    });
  });

  it('resolves boot-relative seed silently when no workspace root exists', () => {
    const srcDir = path.join(tmpDir, 'dist');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const cwd = path.join(tmpDir, 'repo');
      expect(resolveBundledSeedPaths(srcDir, cwd)).toEqual([
        path.resolve(cwd, 'static/model-registry.yaml'),
        path.resolve(srcDir, 'static/model-registry.yaml'),
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves the framework-owned workspace seed before the bundled fallback', async () => {
    const workspaceRoot = path.join(tmpDir, 'workspace');
    const frameworkRoot = path.join(workspaceRoot, 'framework');
    const srcDir = path.join(frameworkRoot, 'runtimes', 'node', 'src');
    const cwd = path.join(tmpDir, 'consumer');
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['framework/*'] }),
      'utf-8',
    );
    await fs.promises.writeFile(
      path.join(frameworkRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['runtimes/*'] }),
      'utf-8',
    );

    expect(resolveBundledSeedPaths(srcDir, cwd)).toEqual([
      path.resolve(cwd, 'static/model-registry.yaml'),
      path.resolve(frameworkRoot, 'static/model-registry.yaml'),
      path.resolve(srcDir, 'static/model-registry.yaml'),
    ]);
  });
});

/**
 * Run a test callback against a local YAML registry HTTP server.
 * @param response - HTTP status and body served for every request.
 * @param run - Test callback receiving the server URL.
 */
async function withRegistryServer(
  response: { readonly status: number; readonly body: string },
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((_request, result) => {
    result.writeHead(response.status, { 'content-type': 'application/yaml' });
    result.end(response.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/model-registry.yaml`);
  } finally {
    await closeServer(server);
  }
}

/**
 * Close an HTTP server and await the close callback.
 * @param server - Server to close.
 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
