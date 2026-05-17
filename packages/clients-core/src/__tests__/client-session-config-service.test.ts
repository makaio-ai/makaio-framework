/**
 * Tests for {@link ClientSessionConfigService}.
 *
 * Uses real temp directories so filesystem assertions (directory creation,
 * removal, idempotency) test the actual implementation.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { SessionSubjects } from '@makaio/contracts/session';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { ClientSessionConfigService } from '../client-session-config-service.js';
import { ClientProfileStorageSubjects, type ClientProfileRecord } from '../storage/profile-storage-namespace.js';

/**
 * Returns a `getNow` function whose clock is offset by `offsetMs` from real time.
 * @param offsetMs - Milliseconds to add to `Date.now()` on each call
 * @returns Clock function whose result is `Date.now() + offsetMs`
 */
function futureNow(offsetMs: number): () => number {
  return () => Date.now() + offsetMs;
}

describe('ClientSessionConfigService', () => {
  let bus: IMakaioBus;
  let service: ClientSessionConfigService;
  let baseDir: string;
  let profiles: ClientProfileRecord[];

  beforeEach(async () => {
    bus = createBusInstance();
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-session-config-test-'));
    profiles = [];
    // Register a no-profiles storage handler so resolveBaseConfigDir can call
    // list without needing a real database.
    bus.on(ClientProfileStorageSubjects.list, (ctx) => {
      ctx.setResult({ records: profiles.filter((profile) => profile.clientId === ctx.payload.clientId) });
    });
    bus.on(ClientProfileStorageSubjects.get, (ctx) => {
      ctx.setResult({
        record:
          profiles.find((profile) => profile.clientId === ctx.payload.clientId && profile.name === ctx.payload.name) ??
          null,
      });
    });
    service = new ClientSessionConfigService(bus, baseDir);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // sessionConfig.create
  // -------------------------------------------------------------------------

  describe('sessionConfig.create', () => {
    it('creates the session directory and returns its path', async () => {
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-abc',
      });

      const expectedDir = path.join(baseDir, 'claude-code', 'sessions', 'session-abc');
      expect(result.sessionDir).toBe(expectedDir);

      const stat = await fs.stat(expectedDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('returns an empty env map when no setup handler is registered', async () => {
      // Without a client-owned sessionConfig.setup handler the service returns
      // an empty env map.  Env vars are produced by the client-owned handler and
      // forwarded by the service — there is no client-identity-based hardcoding
      // in the framework service itself.
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-env-test',
      });

      expect(result.env).toEqual({});
    });

    it('forwards env vars returned by the client-owned setup handler', async () => {
      // Create a minimal namespace that mirrors what the service dispatches so
      // we can register a test handler without coupling to the private helper.
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: z.object({ env: z.record(z.string(), z.string()).optional() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        ctx.setResult({ env: { CUSTOM_VAR: ctx.payload.sessionDir } });
      });

      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-env-handler',
      });

      expect(result.env).toEqual({ CUSTOM_VAR: result.sessionDir });
    });

    it('returns an empty env map for unknown clients', async () => {
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'unknown-client',
        sessionId: 'session-xyz',
      });

      expect(result.env).toEqual({});
    });

    it('proceeds without a setup handler registered (no-op delegation)', async () => {
      // No client:<id>.sessionConfig.setup handler is registered — the request
      // must succeed and leave the directory in place.
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-no-handler',
      });

      const stat = await fs.stat(result.sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates nested session directories for multiple sessions', async () => {
      const first = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-1',
      });
      const second = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-2',
      });

      expect(first.sessionDir).not.toBe(second.sessionDir);
      await expect(fs.access(first.sessionDir)).resolves.toBeUndefined();
      await expect(fs.access(second.sessionDir)).resolves.toBeUndefined();
    });

    it('uses the default profile when no explicit profile is supplied', async () => {
      const defaultConfigDir = path.join(baseDir, 'claude-code', 'profiles', 'default');
      profiles.push({
        id: 'profile-default',
        clientId: 'claude-code',
        name: 'default',
        description: null,
        configDir: defaultConfigDir,
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      });

      let observedBaseConfigDir: string | undefined;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: z.object({ env: z.record(z.string(), z.string()).optional() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedBaseConfigDir = ctx.payload.baseConfigDir;
        ctx.setResult({ env: {} });
      });

      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-default-profile',
      });

      expect(observedBaseConfigDir).toBe(defaultConfigDir);
    });

    it('falls back to the immutable native config source when no default profile exists', async () => {
      let observedBaseConfigDir: string | undefined;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: z.object({ env: z.record(z.string(), z.string()).optional() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedBaseConfigDir = ctx.payload.baseConfigDir;
        ctx.setResult({ env: {} });
      });

      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-native-fallback',
      });

      expect(observedBaseConfigDir).toBe(result.sessionDir);
    });

    it('rejects an explicit missing profile instead of falling back', async () => {
      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          sessionId: 'session-missing-profile',
          profileName: 'does-not-exist',
        }),
      ).rejects.toThrow("Profile 'does-not-exist' not found for client 'claude-code'");
    });

    it('rejects session IDs that are not safe path components', async () => {
      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          sessionId: '../escape',
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // sessionConfig.destroy
  // -------------------------------------------------------------------------

  describe('sessionConfig.destroy', () => {
    it('removes an existing session directory', async () => {
      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-to-destroy',
      });

      // Directory must exist before destroy.
      await expect(fs.access(created.sessionDir)).resolves.toBeUndefined();

      const result = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        sessionId: 'session-to-destroy',
      });

      expect(result.success).toBe(true);
      await expect(fs.access(created.sessionDir)).rejects.toThrow();
    });

    it('is idempotent: destroy on a non-existent directory still succeeds', async () => {
      const result = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        sessionId: 'session-never-created',
      });

      expect(result.success).toBe(true);
    });

    it('second destroy of the same directory also succeeds', async () => {
      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-double-destroy',
      });

      const first = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        sessionId: 'session-double-destroy',
      });
      const second = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        sessionId: 'session-double-destroy',
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sessionConfig.cleanup
  // -------------------------------------------------------------------------

  describe('sessionConfig.cleanup', () => {
    it('returns an empty array when no stale directories exist', async () => {
      // Create a fresh session directory — it will not be considered stale.
      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'fresh-session',
      });

      const result = await bus.request(ClientSubjects.sessionConfig.cleanup, {});
      // The fresh session directory must not have been removed.
      expect(result.removed).toEqual([]);
    });

    it('removes directories whose creation time is older than 1 hour', async () => {
      // Initialise the service first (boot-time cleanup runs on an empty dir),
      // then create the session directory so it exists AFTER init.  Invoking
      // the explicit cleanup with a clock 2 hours ahead makes the just-created
      // directory appear stale relative to getNow().
      const staleBus = createBusInstance();
      const staleService = new ClientSessionConfigService(staleBus, baseDir, futureNow(2 * 60 * 60 * 1000));
      await staleService.init();

      const staleDir = path.join(baseDir, 'claude-code', 'sessions', 'stale-session');
      await fs.mkdir(staleDir, { recursive: true });

      const result = await staleBus.request(ClientSubjects.sessionConfig.cleanup, {});
      await staleService.destroy();

      expect(result.removed).toContain(staleDir);
      await expect(fs.access(staleDir)).rejects.toThrow();
    });

    it('respects the optional clientId scope', async () => {
      // Initialise first so boot-time cleanup runs on an empty directory, then
      // create session dirs for two clients after init.
      const staleBus = createBusInstance();
      const staleService = new ClientSessionConfigService(staleBus, baseDir, futureNow(2 * 60 * 60 * 1000));
      await staleService.init();

      const staleClaudeDir = path.join(baseDir, 'claude-code', 'sessions', 'old-session');
      const staleCodexDir = path.join(baseDir, 'codex', 'sessions', 'old-session');
      await fs.mkdir(staleClaudeDir, { recursive: true });
      await fs.mkdir(staleCodexDir, { recursive: true });

      // Both appear stale from the future clock, but scope the cleanup to
      // claude-code only.
      const result = await staleBus.request(ClientSubjects.sessionConfig.cleanup, {
        clientId: 'claude-code',
      });
      await staleService.destroy();

      expect(result.removed).toContain(staleClaudeDir);
      expect(result.removed).not.toContain(staleCodexDir);

      // codex stale dir must still exist.
      await expect(fs.access(staleCodexDir)).resolves.toBeUndefined();
    });

    it('does not remove stale directories for active sessions', async () => {
      const staleBus = createBusInstance();
      staleBus.on(SessionSubjects.get, (ctx) => {
        ctx.setResult({
          session:
            ctx.payload.sessionId === 'active-session'
              ? {
                  sessionId: 'active-session',
                  createdAt: 1,
                  lastActivityAt: 1,
                  agents: [],
                  status: 'active',
                }
              : null,
        });
      });
      const staleService = new ClientSessionConfigService(staleBus, baseDir, futureNow(2 * 60 * 60 * 1000));
      await staleService.init();

      const activeDir = path.join(baseDir, 'claude-code', 'sessions', 'active-session');
      await fs.mkdir(activeDir, { recursive: true });

      const result = await staleBus.request(ClientSubjects.sessionConfig.cleanup, {});
      await staleService.destroy();

      expect(result.removed).not.toContain(activeDir);
      await expect(fs.access(activeDir)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Session lifecycle cleanup
  // -------------------------------------------------------------------------

  describe('session.closed cleanup', () => {
    it('removes a session config directory when the framework session closes', async () => {
      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        sessionId: 'session-closing',
      });

      await bus.emit(SessionSubjects.closed, { sessionId: 'session-closing' });

      await expect(fs.access(created.sessionDir)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Boot-time cleanup
  // -------------------------------------------------------------------------

  describe('boot-time cleanup (onInit)', () => {
    it('removes stale session directories when a new service instance initialises', async () => {
      // Create a stale session directory before a fresh service starts up.
      const orphanDir = path.join(baseDir, 'claude-code', 'sessions', 'orphan-session');
      await fs.mkdir(orphanDir, { recursive: true });

      // Instantiate a new service with a clock 2 hours ahead so the directory
      // created just now already appears stale at init time.
      const bootBus = createBusInstance();
      const bootService = new ClientSessionConfigService(bootBus, baseDir, futureNow(2 * 60 * 60 * 1000));

      // init() triggers boot-time cleanup internally — no explicit cleanup call.
      await bootService.init();
      await bootService.destroy();

      // The orphaned directory must have been removed during init.
      await expect(fs.access(orphanDir)).rejects.toThrow();
    });
  });
});
