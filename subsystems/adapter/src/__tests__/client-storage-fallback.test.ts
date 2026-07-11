import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { VersionRangeSchema } from '@makaio/contracts';
import { ClientDefinitionSchema } from '@makaio/contracts/client';
import { ExtensionSubjects } from '@makaio/kernel';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';
import { registerClientStorageFallbackHandlers } from '../client-storage-fallback.js';

const CLIENT_DEFINITION = ClientDefinitionSchema.parse({
  id: 'claude-code',
  name: 'Claude Code',
  version: '1.0.0' as const,
  binary: { name: 'claude', supportedVersions: '>=1.0.0' },
  nativeTools: [],
  defaultApprovalPolicy: 'always-ask' as const,
  authMethods: [{ id: 'native', mode: 'inferred' as const, label: 'Native login' }],
  defaultAuth: { providerDefinitionId: 'anthropic-oauth', methodId: 'native' },
});

describe('client storage fallback', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanups.push(
      MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
        ctx.setResult({
          providers: [],
          clients: [{ packageName: '@makaio/client-claude-code', definition: CLIENT_DEFINITION }],
        });
      }),
      registerClientStorageFallbackHandlers(MakaioBus, () => [
        { clients: [{ id: 'claude-code', version: VersionRangeSchema.parse('*') }] },
      ]),
    );
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    MakaioBus.__resetHandlers?.();
  });

  it('serves referenced client definitions in framework-only runtimes', async () => {
    const { client } = await MakaioBus.request(ClientStorageSubjects.get, { id: 'claude-code' });

    expect(client).toMatchObject({
      id: 'claude-code',
      packageName: '@makaio/client-claude-code',
      authMethods: CLIENT_DEFINITION.authMethods,
      defaultAuth: CLIENT_DEFINITION.defaultAuth,
      enabled: true,
    });
    expect(client).not.toHaveProperty('env');
    expect(client).not.toHaveProperty('credentials');
    expect(client).not.toHaveProperty('cwd');
  });

  it('supports list and binary-name reads while excluding unreferenced clients', async () => {
    await expect(MakaioBus.request(ClientStorageSubjects.list, {})).resolves.toMatchObject({
      clients: [expect.objectContaining({ id: 'claude-code' })],
    });
    await expect(
      MakaioBus.request(ClientStorageSubjects.listByBinaryName, { binaryName: 'claude' }),
    ).resolves.toMatchObject({ clients: [expect.objectContaining({ id: 'claude-code' })] });
    await expect(MakaioBus.request(ClientStorageSubjects.get, { id: 'codex' })).resolves.toEqual({ client: null });
  });
});
