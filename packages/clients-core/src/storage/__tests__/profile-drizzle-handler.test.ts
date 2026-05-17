import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  createPluginTestDb,
  type PluginTestDbContext,
  usePluginStorageTestLifecycle,
} from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { CLIENT_PROFILES_DDL } from '../../__tests__/test-ddl.js';
import {
  ClientProfileStorageNamespace,
  ClientProfileStorageSubjects,
  registerDrizzleProfileStorage,
} from '../profile-drizzle-handler.js';

/**
 * Create a profile storage database with the real Drizzle handler registered.
 * @returns Plugin storage test context.
 */
async function createTestDb(): Promise<PluginTestDbContext> {
  return createPluginTestDb({
    name: 'client-profiles',
    schemas: CLIENT_PROFILES_DDL,
    tables: ['client_profiles'],
    registerHandlers: (db) => {
      MakaioBus.registerNamespace(ClientProfileStorageNamespace);
      return registerDrizzleProfileStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
    },
  });
}

describe('profile Drizzle handler', () => {
  usePluginStorageTestLifecycle(createTestDb);

  it('stores and retrieves a profile record', async () => {
    const now = Date.now();
    await MakaioBus.request(ClientProfileStorageSubjects.set, {
      id: 'profile-1',
      clientId: 'claude-code',
      name: 'work',
      description: 'Work profile',
      configDir: '/tmp/makaio/clients/claude-code/profiles/work',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await MakaioBus.request(ClientProfileStorageSubjects.get, {
      clientId: 'claude-code',
      name: 'work',
    });

    expect(result.record).toMatchObject({
      id: 'profile-1',
      clientId: 'claude-code',
      name: 'work',
      description: 'Work profile',
      isDefault: false,
    });
  });

  it('enforces at most one default profile per client', async () => {
    const now = Date.now();
    await MakaioBus.request(ClientProfileStorageSubjects.set, {
      id: 'profile-default-1',
      clientId: 'claude-code',
      name: 'work',
      description: null,
      configDir: '/tmp/makaio/clients/claude-code/profiles/work',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      MakaioBus.request(ClientProfileStorageSubjects.set, {
        id: 'profile-default-2',
        clientId: 'claude-code',
        name: 'personal',
        description: null,
        configDir: '/tmp/makaio/clients/claude-code/profiles/personal',
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it('switches the default profile in one storage request', async () => {
    const now = Date.now();
    await MakaioBus.request(ClientProfileStorageSubjects.set, {
      id: 'profile-switch-1',
      clientId: 'claude-code',
      name: 'work',
      description: null,
      configDir: '/tmp/makaio/clients/claude-code/profiles/work',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await MakaioBus.request(ClientProfileStorageSubjects.set, {
      id: 'profile-switch-2',
      clientId: 'claude-code',
      name: 'personal',
      description: null,
      configDir: '/tmp/makaio/clients/claude-code/profiles/personal',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await MakaioBus.request(ClientProfileStorageSubjects.setDefault, {
      clientId: 'claude-code',
      name: 'personal',
    });

    expect(result.record?.name).toBe('personal');
    expect(result.record?.isDefault).toBe(true);
    const list = await MakaioBus.request(ClientProfileStorageSubjects.list, { clientId: 'claude-code' });
    expect(list.records.filter((profile) => profile.isDefault).map((profile) => profile.name)).toEqual(['personal']);
  });

  it('rejects empty storage identifiers before querying', async () => {
    await expect(MakaioBus.request(ClientProfileStorageSubjects.get, { clientId: '', name: 'work' })).rejects.toThrow();
    await expect(MakaioBus.request(ClientProfileStorageSubjects.getById, { id: '' })).rejects.toThrow();
  });
});
