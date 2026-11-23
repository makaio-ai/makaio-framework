import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootMakaioRuntimeCore, ExplicitDescriptorDiscovery, type MakaioRuntime } from '@makaio/runtime-node';
import { expect, it, vi } from 'vitest';

it('attributes every manifest namespace in the framework boot catalog to its extension', {
  timeout: 30_000,
}, async () => {
  const makaioHome = await mkdtemp(join(tmpdir(), 'makaio-namespace-owners-'));
  let runtime: MakaioRuntime | undefined;
  try {
    for (const key of ['MAKAIO_SKIP_EXTENSIONS', 'MAKAIO_DATABASE_URL', 'MAKAIO_DATABASE_PATH']) {
      vi.stubEnv(key, undefined);
    }
    runtime = await bootMakaioRuntimeCore({ async connect() {}, async disconnect() {} }, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
      makaioHome,
    });

    const { coordinator } = runtime;
    const { ownerOf } = coordinator.namespaceOwners();
    const claims = coordinator
      .list()
      .flatMap(({ name }) =>
        (coordinator.getExtension(name)?.namespaces ?? []).map(({ name: domain }) => ({ domain, name })),
      );
    expect(claims.length).toBeGreaterThan(0);
    for (const { domain, name } of claims) {
      expect(ownerOf(domain), domain).toEqual({ kind: 'extension', extension: name });
    }
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      vi.unstubAllEnvs();
      await rm(makaioHome, { recursive: true, force: true });
    }
  }
});
