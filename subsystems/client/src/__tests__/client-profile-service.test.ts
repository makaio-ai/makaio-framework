/**
 * Tests for {@link ClientProfileService}.
 *
 * Storage subjects are stubbed on an in-memory Map so the tests exercise
 * real service logic (duplicate detection, filesystem directory creation,
 * default-setting invariant, etc.) without requiring a database.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { ClientConfigPrimeRequest } from '@makaio/contracts/client';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { ClientProfileService } from '../client-profile-service.js';
import { ClientProfileStorageSubjects, type ClientProfileRecord } from '../storage/profile-storage-namespace.js';

// ---------------------------------------------------------------------------
// In-memory storage stub
// ---------------------------------------------------------------------------

/**
 * Register lightweight in-memory handlers for the profile storage subjects.
 *
 * Returns a cleanup function and direct access to the in-memory store for
 * assertions.
 * @param bus - Bus instance to register handlers on
 * @returns Object with `cleanup` function and `store` Map reference
 */
function registerInMemoryProfileStorage(bus: IMakaioBus): {
  cleanup: () => void;
  store: Map<string, ClientProfileRecord>;
} {
  const store = new Map<string, ClientProfileRecord>();

  // Composite lookup key for (clientId, name).
  const key = (clientId: string, name: string): string => `${clientId}::${name}`;

  const cleanups = [
    bus.on(ClientProfileStorageSubjects.get, (ctx) => {
      const { clientId, name } = ctx.payload;
      ctx.setResult({ record: store.get(key(clientId, name)) ?? null });
    }),

    bus.on(ClientProfileStorageSubjects.list, (ctx) => {
      const { clientId } = ctx.payload;
      const records = Array.from(store.values()).filter((r) => r.clientId === clientId);
      ctx.setResult({ records });
    }),

    bus.on(ClientProfileStorageSubjects.set, (ctx) => {
      const record = ctx.payload;
      store.set(key(record.clientId, record.name), record);
      ctx.setResult({ success: true });
    }),

    bus.on(ClientProfileStorageSubjects.delete, (ctx) => {
      const { clientId, name } = ctx.payload;
      const existed = store.has(key(clientId, name));
      store.delete(key(clientId, name));
      ctx.setResult({ success: existed });
    }),

    bus.on(ClientProfileStorageSubjects.clearDefault, (ctx) => {
      const { clientId } = ctx.payload;
      for (const [k, record] of store) {
        if (record.clientId === clientId && record.isDefault) {
          store.set(k, { ...record, isDefault: false });
        }
      }
      ctx.setResult({ success: true });
    }),

    bus.on(ClientProfileStorageSubjects.setDefault, (ctx) => {
      const { clientId, name } = ctx.payload;
      const targetKey = key(clientId, name);
      const target = store.get(targetKey);
      if (target === undefined) {
        ctx.setResult({ record: null });
        return;
      }

      for (const [k, record] of store) {
        if (record.clientId === clientId && record.isDefault) {
          store.set(k, { ...record, isDefault: false });
        }
      }

      const updated = { ...target, isDefault: true, updatedAt: Date.now() };
      store.set(targetKey, updated);
      ctx.setResult({ record: updated });
    }),
  ];

  return {
    cleanup: () => {
      for (const unsubscribe of cleanups) {
        unsubscribe();
      }
    },
    store,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClientProfileService', () => {
  let bus: IMakaioBus;
  let service: ClientProfileService;
  let baseDir: string;
  let storageCleanup: () => void;
  let storageStore: Map<string, ClientProfileRecord>;

  beforeEach(async () => {
    bus = createBusInstance();

    // Use a real temp directory so filesystem assertions are exercised.
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-profile-service-test-'));

    const storage = registerInMemoryProfileStorage(bus);
    storageCleanup = storage.cleanup;
    storageStore = storage.store;

    service = new ClientProfileService(bus, baseDir);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    storageCleanup();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // profile.create
  // -------------------------------------------------------------------------

  describe('profile.create', () => {
    it('creates a profile and its config directory', async () => {
      const result = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
        description: 'Work profile',
      });

      expect(result.profile.clientId).toBe('claude-code');
      expect(result.profile.name).toBe('work');
      expect(result.profile.description).toBe('Work profile');
      expect(result.profile.isDefault).toBe(false);
      expect(typeof result.profile.id).toBe('string');
      expect(result.profile.id).toMatch(/^[0-9a-f-]{36}$/);

      // Verify the config directory was created on the filesystem.
      const expectedDir = path.join(baseDir, 'claude-code', 'profiles', 'work');
      expect(result.profile.configDir).toBe(expectedDir);
      const stat = await fs.stat(expectedDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates a profile without an optional description', async () => {
      const result = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'personal',
      });

      expect(result.profile.description).toBeNull();
    });

    it('rejects a duplicate profile name for the same client', async () => {
      await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });

      await expect(
        bus.request(ClientSubjects.profile.create, {
          clientId: 'claude-code',
          name: 'work',
        }),
      ).rejects.toThrow("Profile 'work' already exists for client 'claude-code'");
    });

    it('rejects profile names that are not safe path components', async () => {
      await expect(
        bus.request(ClientSubjects.profile.create, {
          clientId: 'claude-code',
          name: '../escape',
        }),
      ).rejects.toThrow();

      await expect(fs.access(path.join(baseDir, 'escape'))).rejects.toThrow();
    });

    it('allows the same profile name for different clients', async () => {
      const first = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });
      const second = await bus.request(ClientSubjects.profile.create, {
        clientId: 'codex',
        name: 'work',
      });

      expect(first.profile.clientId).toBe('claude-code');
      expect(second.profile.clientId).toBe('codex');
    });

    // -----------------------------------------------------------------------
    // Config prime lifecycle — profile-create phase
    // -----------------------------------------------------------------------

    it('calls client-specific config.prime with profile-create phase after directory creation', async () => {
      const observed: ClientConfigPrimeRequest[] = [];
      const primeNs = createBusNamespace('client:claude-code', {
        'config.prime': {
          request: z.object({
            clientId: z.string(),
            configDir: z.string(),
            phase: z.string(),
            binaryVersion: z.string().optional(),
            adapterName: z.string().optional(),
            projectDir: z.string().optional(),
          }),
          response: z.object({ primed: z.boolean() }),
        },
      });
      const unsubPrime = bus.on(primeNs.subjects.config.prime, (ctx) => {
        observed.push(ctx.payload as ClientConfigPrimeRequest);
        ctx.setResult({ primed: true });
      });

      const result = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });

      unsubPrime();

      expect(observed).toHaveLength(1);
      expect(observed[0]?.clientId).toBe('claude-code');
      expect(observed[0]?.phase).toBe('profile-create');
      expect(observed[0]?.configDir).toBe(result.profile.configDir);
      expect(observed[0]?.binaryVersion).toBeUndefined();
    });

    it('proceeds with profile creation when no config.prime handler is registered', async () => {
      // No client:claude-code.config.prime handler — creation must succeed.
      const result = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'personal',
      });

      expect(result.profile.name).toBe('personal');
    });

    it('does not persist the profile when config.prime fails', async () => {
      const expectedDir = path.join(baseDir, 'claude-code', 'profiles', 'work');
      const primeNs = createBusNamespace('client:claude-code', {
        'config.prime': {
          request: z.object({
            clientId: z.string(),
            configDir: z.string(),
            phase: z.string(),
          }),
          response: z.object({ primed: z.boolean() }),
        },
      });
      const unsubPrime = bus.on(primeNs.subjects.config.prime, () => {
        throw new Error('prime failed');
      });

      await expect(
        bus.request(ClientSubjects.profile.create, {
          clientId: 'claude-code',
          name: 'work',
        }),
      ).rejects.toThrow('prime failed');

      unsubPrime();

      expect(storageStore.size).toBe(0);
      await expect(fs.access(expectedDir)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // profile.list
  // -------------------------------------------------------------------------

  describe('profile.list', () => {
    it('lists all profiles for a client', async () => {
      await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });
      await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'personal',
      });
      // Profile for a different client — should not appear in the list.
      await bus.request(ClientSubjects.profile.create, {
        clientId: 'codex',
        name: 'work',
      });

      const result = await bus.request(ClientSubjects.profile.list, {
        clientId: 'claude-code',
      });

      expect(result.profiles).toHaveLength(2);
      expect(result.profiles.map((p) => p.name).sort()).toEqual(['personal', 'work']);
    });

    it('returns an empty array when no profiles exist', async () => {
      const result = await bus.request(ClientSubjects.profile.list, {
        clientId: 'unknown-client',
      });

      expect(result.profiles).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // profile.get
  // -------------------------------------------------------------------------

  describe('profile.get', () => {
    it('returns the profile when found', async () => {
      const created = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
        description: 'Work context',
      });

      const found = await bus.request(ClientSubjects.profile.get, {
        clientId: 'claude-code',
        name: 'work',
      });

      expect(found.profile).toEqual(created.profile);
    });

    it('returns null when the profile does not exist', async () => {
      const result = await bus.request(ClientSubjects.profile.get, {
        clientId: 'claude-code',
        name: 'nonexistent',
      });

      expect(result.profile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // profile.update
  // -------------------------------------------------------------------------

  describe('profile.update', () => {
    it('updates the description and bumps updatedAt', async () => {
      const created = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
        description: 'Old description',
      });

      const updated = await bus.request(ClientSubjects.profile.update, {
        clientId: 'claude-code',
        name: 'work',
        description: 'New description',
      });

      expect(updated.profile.description).toBe('New description');
      expect(updated.profile.updatedAt).toBeGreaterThanOrEqual(created.profile.updatedAt);
      // Immutable fields must not change.
      expect(updated.profile.id).toBe(created.profile.id);
      expect(updated.profile.configDir).toBe(created.profile.configDir);
    });

    it('preserves the existing description when none is provided in the update', async () => {
      await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
        description: 'Keep me',
      });

      const updated = await bus.request(ClientSubjects.profile.update, {
        clientId: 'claude-code',
        name: 'work',
      });

      expect(updated.profile.description).toBe('Keep me');
    });

    it('rejects an update for a non-existent profile', async () => {
      await expect(
        bus.request(ClientSubjects.profile.update, {
          clientId: 'claude-code',
          name: 'ghost',
        }),
      ).rejects.toThrow("Profile 'ghost' not found for client 'claude-code'");
    });
  });

  // -------------------------------------------------------------------------
  // profile.setDefault
  // -------------------------------------------------------------------------

  describe('profile.setDefault', () => {
    it('marks a profile as default and removes the flag from any prior default', async () => {
      const work = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });
      const personal = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'personal',
      });
      expect(work.profile.isDefault).toBe(false);
      expect(personal.profile.isDefault).toBe(false);

      const setWork = await bus.request(ClientSubjects.profile.setDefault, {
        clientId: 'claude-code',
        name: 'work',
      });
      expect(setWork.profile.isDefault).toBe(true);

      // Switching default: work loses the flag, personal gains it.
      const setPersonal = await bus.request(ClientSubjects.profile.setDefault, {
        clientId: 'claude-code',
        name: 'personal',
      });
      expect(setPersonal.profile.isDefault).toBe(true);

      const workAfter = await bus.request(ClientSubjects.profile.get, {
        clientId: 'claude-code',
        name: 'work',
      });
      expect(workAfter.profile?.isDefault).toBe(false);
    });

    it('rejects setDefault for a non-existent profile', async () => {
      await expect(
        bus.request(ClientSubjects.profile.setDefault, {
          clientId: 'claude-code',
          name: 'ghost',
        }),
      ).rejects.toThrow("Profile 'ghost' not found for client 'claude-code'");
    });
  });

  // -------------------------------------------------------------------------
  // profile.delete
  // -------------------------------------------------------------------------

  describe('profile.delete', () => {
    it('deletes the profile and removes its config directory', async () => {
      const created = await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });

      const expectedDir = created.profile.configDir;
      // Directory must exist before deletion.
      await expect(fs.access(expectedDir)).resolves.toBeUndefined();

      const result = await bus.request(ClientSubjects.profile.delete, {
        clientId: 'claude-code',
        name: 'work',
      });

      expect(result.success).toBe(true);
      // Directory must be gone after deletion.
      await expect(fs.access(expectedDir)).rejects.toThrow();

      // Storage must not contain the record.
      const gone = await bus.request(ClientSubjects.profile.get, {
        clientId: 'claude-code',
        name: 'work',
      });
      expect(gone.profile).toBeNull();
    });

    it('returns success:false when the profile does not exist', async () => {
      const result = await bus.request(ClientSubjects.profile.delete, {
        clientId: 'claude-code',
        name: 'nonexistent',
      });

      // No record in storage, so the storage handler returns success:false.
      expect(result.success).toBe(false);
    });

    it('is idempotent: second delete still returns without error', async () => {
      await bus.request(ClientSubjects.profile.create, {
        clientId: 'claude-code',
        name: 'work',
      });
      await bus.request(ClientSubjects.profile.delete, {
        clientId: 'claude-code',
        name: 'work',
      });
      // Second delete: profile not in storage, configDir gone.
      const second = await bus.request(ClientSubjects.profile.delete, {
        clientId: 'claude-code',
        name: 'work',
      });
      expect(second.success).toBe(false);
    });

    it('refuses to delete the profiles root when a stored configDir points at it', async () => {
      const profilesBasePath = path.join(baseDir, 'claude-code', 'profiles');
      await fs.mkdir(profilesBasePath, { recursive: true });
      const now = Date.now();
      storageStore.set('claude-code::root', {
        id: 'profile-root',
        clientId: 'claude-code',
        name: 'root',
        description: null,
        configDir: profilesBasePath,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        bus.request(ClientSubjects.profile.delete, {
          clientId: 'claude-code',
          name: 'root',
        }),
      ).rejects.toThrow('profile.delete refused to access path outside client profile root');

      await expect(fs.access(profilesBasePath)).resolves.toBeUndefined();
      const stillStored = await bus.request(ClientSubjects.profile.get, {
        clientId: 'claude-code',
        name: 'root',
      });
      expect(stillStored.profile).not.toBeNull();
    });
  });
});
