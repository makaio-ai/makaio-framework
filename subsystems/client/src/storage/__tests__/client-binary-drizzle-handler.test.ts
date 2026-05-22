import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  createPluginTestDb,
  usePluginStorageTestLifecycle,
  type PluginTestDbContext,
} from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import {
  registerDrizzleClientBinaryStorage,
  ClientBinaryStorageSubjects,
  selectVersionsByClientId,
  selectStateByClientId,
} from '../client-binary-drizzle-handler.js';
import { CLIENT_BINARY_DDL } from '../../__tests__/test-ddl.js';

// ---------------------------------------------------------------------------
// Test database factory
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<PluginTestDbContext> {
  return createPluginTestDb({
    name: 'client-binary',
    schemas: CLIENT_BINARY_DDL,
    tables: ['client_binary_versions', 'client_binary_state'],
    registerHandlers: (db) => registerDrizzleClientBinaryStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus)),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('client binary Drizzle handler', () => {
  const ctx = usePluginStorageTestLifecycle(createTestDb);

  // -------------------------------------------------------------------------
  // insertVersion
  // -------------------------------------------------------------------------

  describe('insertVersion', () => {
    it('inserts a version record', async () => {
      const now = Date.now();
      const id = 'bbbbbbbb-0000-4000-8000-000000000001';

      const { success } = await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id,
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });

      expect(success).toBe(true);

      const versions = await selectVersionsByClientId(ctx.dbContext.db, 'claude-code');
      expect(versions).toHaveLength(1);
      expect(versions[0].id).toBe(id);
      expect(versions[0].version).toBe('1.0.0');
      expect(versions[0].installPath).toBe('/opt/makaio/claude-code/1.0.0');
      expect(versions[0].installedAt).toBe(now);
    });

    it('stores multiple installed versions for the same client independently', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now - 2000,
        createdAt: now - 2000,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000003',
        clientId: 'claude-code',
        version: '1.1.0',
        installPath: '/opt/makaio/claude-code/1.1.0',
        installedAt: now,
        createdAt: now,
      });

      const versions = await selectVersionsByClientId(ctx.dbContext.db, 'claude-code');
      expect(versions).toHaveLength(2);

      const versionStrings = versions.map((v) => v.version).sort();
      expect(versionStrings).toEqual(['1.0.0', '1.1.0']);
    });

    it('does not create duplicate rows for the same client+version pair (idempotent)', async () => {
      const now = Date.now();
      const id = 'bbbbbbbb-0000-4000-8000-000000000004';

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id,
        clientId: 'codex',
        version: '2.0.0',
        installPath: '/opt/makaio/codex/2.0.0',
        installedAt: now,
        createdAt: now,
      });

      // Second insert for the same client+version is silently ignored
      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000099',
        clientId: 'codex',
        version: '2.0.0',
        installPath: '/opt/makaio/codex/2.0.0-dup',
        installedAt: now,
        createdAt: now,
      });

      const versions = await selectVersionsByClientId(ctx.dbContext.db, 'codex');
      expect(versions).toHaveLength(1);
      expect(versions[0].id).toBe(id);
    });

    it('surfaces a primary-key conflict for a duplicate id with a different client+version', async () => {
      const now = Date.now();
      const sharedId = 'bbbbbbbb-0000-4000-8000-000000000005';

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: sharedId,
        clientId: 'codex',
        version: '2.0.0',
        installPath: '/opt/makaio/codex/2.0.0',
        installedAt: now,
        createdAt: now,
      });

      // Same primary key but a different client+version pair must not be
      // silently dropped — the conflict target is (clientId, version) only, so
      // a primary-key collision is still an error.
      await expect(
        MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
          id: sharedId,
          clientId: 'claude-code',
          version: '3.0.0',
          installPath: '/opt/makaio/claude-code/3.0.0',
          installedAt: now,
          createdAt: now,
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // listVersions
  // -------------------------------------------------------------------------

  describe('listVersions', () => {
    it('returns an empty array when no versions are installed', async () => {
      const { versions } = await MakaioBus.request(ClientBinaryStorageSubjects.listVersions, {
        clientId: 'claude-code',
      });
      expect(versions).toEqual([]);
    });

    it('returns only versions belonging to the requested client', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000020',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });
      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000021',
        clientId: 'codex',
        version: '2.0.0',
        installPath: '/opt/makaio/codex/2.0.0',
        installedAt: now,
        createdAt: now,
      });

      const { versions } = await MakaioBus.request(ClientBinaryStorageSubjects.listVersions, {
        clientId: 'claude-code',
      });

      expect(versions).toHaveLength(1);
      expect(versions[0].clientId).toBe('claude-code');
    });
  });

  // -------------------------------------------------------------------------
  // getSnapshot
  // -------------------------------------------------------------------------

  describe('getSnapshot', () => {
    it('returns one client state row and installed versions together', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000025',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });
      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000026',
        clientId: 'codex',
        version: '2.0.0',
        installPath: '/opt/makaio/codex/2.0.0',
        installedAt: now,
        createdAt: now,
      });
      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });

      const { state, versions } = await MakaioBus.request(ClientBinaryStorageSubjects.getSnapshot, {
        clientId: 'claude-code',
      });

      expect(state?.activeVersion).toBe('1.0.0');
      expect(versions.map((version) => version.clientId)).toEqual(['claude-code']);
      expect(versions[0]?.version).toBe('1.0.0');
    });
  });

  // -------------------------------------------------------------------------
  // loadAllVersions
  // -------------------------------------------------------------------------

  describe('loadAllVersions', () => {
    it('returns all version rows across all clients', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000030',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });
      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000031',
        clientId: 'codex',
        version: '2.0.0',
        installPath: '/opt/makaio/codex/2.0.0',
        installedAt: now,
        createdAt: now,
      });

      const { versions } = await MakaioBus.request(ClientBinaryStorageSubjects.loadAllVersions, {});

      expect(versions).toHaveLength(2);
      const ids = versions.map((v) => v.id).sort();
      expect(ids).toEqual(['bbbbbbbb-0000-4000-8000-000000000030', 'bbbbbbbb-0000-4000-8000-000000000031'].sort());
    });
  });

  // -------------------------------------------------------------------------
  // upsertState / getState — active version management
  // -------------------------------------------------------------------------

  describe('upsertState (active version management)', () => {
    it('inserts a state row with an active version', async () => {
      const now = Date.now();

      const { success } = await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });

      expect(success).toBe(true);

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state).toBeDefined();
      expect(state?.activeVersion).toBe('1.0.0');
    });

    it('switches the active version when upsertState is called again', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now - 1000,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.1.0',
        updatedAt: now,
      });

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state?.activeVersion).toBe('1.1.0');
    });

    it('sets activeVersion to null when the active version is uninstalled', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now - 500,
      });

      // After uninstalling the active version, the manager writes null
      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: null,
        updatedAt: now,
      });

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state?.activeVersion).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // setActiveVersion
  // -------------------------------------------------------------------------

  describe('setActiveVersion', () => {
    it('creates a minimal state row when no state exists yet', async () => {
      const now = Date.now();

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.setActiveVersion, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });

      expect(result).toEqual({
        previousActiveVersion: null,
        activeVersion: '1.0.0',
      });

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state).toMatchObject({
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });
    });

    it('switches the active version on an existing state row', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now - 1000,
      });

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.setActiveVersion, {
        clientId: 'claude-code',
        activeVersion: '1.5.0',
        updatedAt: now,
      });

      expect(result).toEqual({
        previousActiveVersion: '1.0.0',
        activeVersion: '1.5.0',
      });

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state).toMatchObject({
        activeVersion: '1.5.0',
        updatedAt: now,
      });
    });

    it('uses the conflict path when setting activeVersion on an existing minimal row', async () => {
      const now = Date.now();

      const first = await MakaioBus.request(ClientBinaryStorageSubjects.setActiveVersion, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });
      const second = await MakaioBus.request(ClientBinaryStorageSubjects.setActiveVersion, {
        clientId: 'claude-code',
        activeVersion: '1.1.0',
        updatedAt: now + 1,
      });

      expect(first.previousActiveVersion).toBeNull();
      expect(second.previousActiveVersion).toBe('1.0.0');

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state?.activeVersion).toBe('1.1.0');
    });
  });

  // -------------------------------------------------------------------------
  // recordInstalledVersion
  // -------------------------------------------------------------------------

  describe('recordInstalledVersion', () => {
    it('inserts the version row and activates it in one transaction', async () => {
      const now = Date.now();

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.recordInstalledVersion, {
        versionRecord: {
          id: 'bbbbbbbb-0000-4000-8000-000000000040',
          clientId: 'claude-code',
          version: '1.0.0',
          installPath: '/opt/makaio/claude-code/1.0.0',
          installedAt: now,
          createdAt: now,
        },
        makeActive: true,
        updatedAt: now,
      });

      expect(result).toEqual({
        previousActiveVersion: null,
        activeVersion: '1.0.0',
      });

      const versions = await selectVersionsByClientId(ctx.dbContext.db, 'claude-code');
      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe('1.0.0');
      expect(state?.activeVersion).toBe('1.0.0');
    });

    it('activates the installed version on an existing state row', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: null,
        updatedAt: now - 1000,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.recordInstalledVersion, {
        versionRecord: {
          id: 'bbbbbbbb-0000-4000-8000-000000000041',
          clientId: 'claude-code',
          version: '1.0.0',
          installPath: '/opt/makaio/claude-code/1.0.0',
          installedAt: now,
          createdAt: now,
        },
        makeActive: true,
        updatedAt: now,
      });

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state).toMatchObject({
        activeVersion: '1.0.0',
      });
    });

    it('leaves the active pointer unchanged when makeActive is false', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '0.9.0',
        updatedAt: now - 1000,
      });

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.recordInstalledVersion, {
        versionRecord: {
          id: 'bbbbbbbb-0000-4000-8000-000000000042',
          clientId: 'claude-code',
          version: '1.0.0',
          installPath: '/opt/makaio/claude-code/1.0.0',
          installedAt: now,
          createdAt: now,
        },
        makeActive: false,
        updatedAt: now,
      });

      expect(result).toEqual({
        previousActiveVersion: '0.9.0',
        activeVersion: '0.9.0',
      });

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state?.activeVersion).toBe('0.9.0');
    });
  });

  // -------------------------------------------------------------------------
  // getState
  // -------------------------------------------------------------------------

  describe('getState', () => {
    it('returns null when no state row exists for the client', async () => {
      const { state } = await MakaioBus.request(ClientBinaryStorageSubjects.getState, {
        clientId: 'nonexistent-client',
      });
      expect(state).toBeNull();
    });

    it('returns the persisted state row', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.2.3',
        updatedAt: now,
      });

      const { state } = await MakaioBus.request(ClientBinaryStorageSubjects.getState, {
        clientId: 'claude-code',
      });

      expect(state).not.toBeNull();
      expect(state?.activeVersion).toBe('1.2.3');
    });
  });

  // -------------------------------------------------------------------------
  // loadAllState
  // -------------------------------------------------------------------------

  describe('loadAllState', () => {
    it('returns an empty array when no state rows exist', async () => {
      const { states } = await MakaioBus.request(ClientBinaryStorageSubjects.loadAllState, {});
      expect(states).toEqual([]);
    });

    it('returns all state rows', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });
      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'codex',
        activeVersion: null,
        updatedAt: now,
      });

      const { states } = await MakaioBus.request(ClientBinaryStorageSubjects.loadAllState, {});
      expect(states).toHaveLength(2);
      const clientIds = states.map((s) => s.clientId).sort();
      expect(clientIds).toEqual(['claude-code', 'codex']);
    });
  });

  // -------------------------------------------------------------------------
  // loadSnapshot
  // -------------------------------------------------------------------------

  describe('loadSnapshot', () => {
    it('returns all state and version rows together', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'bbbbbbbb-0000-4000-8000-000000000060',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });
      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });

      const { states, versions } = await MakaioBus.request(ClientBinaryStorageSubjects.loadSnapshot, {});

      expect(states).toHaveLength(1);
      expect(states[0]?.clientId).toBe('claude-code');
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe('1.0.0');
    });
  });

  // -------------------------------------------------------------------------
  // removeVersionAndClearActive — atomic uninstall
  // -------------------------------------------------------------------------

  describe('removeVersionAndClearActive', () => {
    it('removes the version row and returns removedVersion when row exists', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'cccccccc-0000-4000-8000-000000000001',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.removeVersionAndClearActive, {
        clientId: 'claude-code',
        version: '1.0.0',
        updatedAt: now,
      });

      expect(result.removedVersion).toBe('1.0.0');

      const versions = await selectVersionsByClientId(ctx.dbContext.db, 'claude-code');
      expect(versions).toHaveLength(0);
    });

    it('returns removedVersion null when the version row does not exist', async () => {
      const now = Date.now();

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.removeVersionAndClearActive, {
        clientId: 'nonexistent',
        version: '9.9.9',
        updatedAt: now,
      });

      expect(result.removedVersion).toBeNull();
    });

    it('clears the active pointer when it matches the deleted version', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'cccccccc-0000-4000-8000-000000000002',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.0.0',
        updatedAt: now,
      });

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.removeVersionAndClearActive, {
        clientId: 'claude-code',
        version: '1.0.0',
        updatedAt: now + 1,
      });

      expect(result.removedVersion).toBe('1.0.0');
      expect(result.previousActiveVersion).toBe('1.0.0');
      expect(result.activeVersion).toBeNull();

      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state?.activeVersion).toBeNull();
    });

    it('does not clear the active pointer when it points to a different version', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'cccccccc-0000-4000-8000-000000000003',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'cccccccc-0000-4000-8000-000000000004',
        clientId: 'claude-code',
        version: '1.1.0',
        installPath: '/opt/makaio/claude-code/1.1.0',
        installedAt: now,
        createdAt: now,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '1.1.0',
        updatedAt: now,
      });

      // Remove 1.0.0 which is NOT the active version
      const result = await MakaioBus.request(ClientBinaryStorageSubjects.removeVersionAndClearActive, {
        clientId: 'claude-code',
        version: '1.0.0',
        updatedAt: now + 1,
      });

      expect(result.removedVersion).toBe('1.0.0');
      expect(result.previousActiveVersion).toBe('1.1.0');
      expect(result.activeVersion).toBe('1.1.0');

      // Active version must remain unchanged
      const state = await selectStateByClientId(ctx.dbContext.db, 'claude-code');
      expect(state?.activeVersion).toBe('1.1.0');
    });

    it('returns the previousActiveVersion from before the transaction', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'cccccccc-0000-4000-8000-000000000005',
        clientId: 'claude-code',
        version: '2.0.0',
        installPath: '/opt/makaio/claude-code/2.0.0',
        installedAt: now,
        createdAt: now,
      });

      await MakaioBus.request(ClientBinaryStorageSubjects.upsertState, {
        clientId: 'claude-code',
        activeVersion: '2.0.0',
        updatedAt: now,
      });

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.removeVersionAndClearActive, {
        clientId: 'claude-code',
        version: '2.0.0',
        updatedAt: now + 1,
      });

      // The pre-transaction value must be captured
      expect(result.previousActiveVersion).toBe('2.0.0');
      expect(result.activeVersion).toBeNull();
    });

    it('returns null for previousActiveVersion when no state row exists', async () => {
      const now = Date.now();

      await MakaioBus.request(ClientBinaryStorageSubjects.insertVersion, {
        id: 'cccccccc-0000-4000-8000-000000000006',
        clientId: 'claude-code',
        version: '1.0.0',
        installPath: '/opt/makaio/claude-code/1.0.0',
        installedAt: now,
        createdAt: now,
      });

      const result = await MakaioBus.request(ClientBinaryStorageSubjects.removeVersionAndClearActive, {
        clientId: 'claude-code',
        version: '1.0.0',
        updatedAt: now,
      });

      expect(result.removedVersion).toBe('1.0.0');
      expect(result.previousActiveVersion).toBeNull();
      expect(result.activeVersion).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Direct DB helper utilities
  // -------------------------------------------------------------------------

  describe('selectVersionsByClientId (direct DB helper)', () => {
    it('returns an empty array for unknown client', async () => {
      const versions = await selectVersionsByClientId(ctx.dbContext.db, 'unknown');
      expect(versions).toEqual([]);
    });
  });

  describe('selectStateByClientId (direct DB helper)', () => {
    it('returns undefined for unknown client', async () => {
      const state = await selectStateByClientId(ctx.dbContext.db, 'unknown');
      expect(state).toBeUndefined();
    });
  });
});
