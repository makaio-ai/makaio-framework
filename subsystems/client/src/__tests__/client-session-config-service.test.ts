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
import {
  ClientSessionConfigSchemas,
  ClientSubjects,
  SessionConfigSetupRequestSchema,
  SessionConfigSetupResponseSchema,
} from '@makaio/contracts/client';
import type { ClientConfigPrimeRequest } from '@makaio/contracts/client';
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
    it('accepts only known config inheritance policies', () => {
      const createSchema = ClientSessionConfigSchemas['sessionConfig.create'].request;

      expect(
        createSchema.safeParse({
          clientId: 'claude-code',
          leaseId: 'lease-policy',
          ownerSessionId: 'framework-session',
          projectDir: path.join(baseDir, 'project'),
          configInheritance: 'auth-only',
        }).success,
      ).toBe(true);
      expect(
        createSchema.safeParse({
          clientId: 'claude-code',
          leaseId: 'lease-policy',
          configInheritance: 'plugins-only',
        }).success,
      ).toBe(false);
      expect(createSchema.safeParse({ clientId: 'claude-code', sessionId: 'legacy-session' }).success).toBe(false);
    });

    it('requires config inheritance on client-owned setup delegation', () => {
      expect(
        SessionConfigSetupRequestSchema.safeParse({
          sessionDir: path.join(baseDir, 'session'),
          baseConfigDir: path.join(baseDir, 'base'),
          projectDir: path.join(baseDir, 'project'),
          platform: 'darwin',
          configInheritance: 'full',
        }).success,
      ).toBe(true);
      expect(
        SessionConfigSetupRequestSchema.safeParse({
          sessionDir: path.join(baseDir, 'session'),
          baseConfigDir: path.join(baseDir, 'base'),
          platform: 'darwin',
        }).success,
      ).toBe(false);

      expect(SessionConfigSetupResponseSchema.safeParse({ env: {} }).success).toBe(false);
      expect(SessionConfigSetupResponseSchema.safeParse({ env: {}, authMaterialized: false }).success).toBe(true);
    });

    it('creates the session directory and returns its path', async () => {
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-abc',
      });

      const expectedDir = path.join(baseDir, 'claude-code', 'sessions', 'lease-abc');
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
        leaseId: 'lease-env-test',
      });

      expect(result.env).toEqual({});
      expect(result.authMaterialized).toBe(false);
    });

    it('forwards env vars returned by the client-owned setup handler', async () => {
      // Create a minimal namespace that mirrors what the service dispatches so
      // we can register a test handler without coupling to the private helper.
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: SessionConfigSetupResponseSchema,
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        ctx.setResult({ env: { CUSTOM_VAR: ctx.payload.sessionDir }, authMaterialized: true });
      });

      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-env-handler',
      });

      expect(result.env).toEqual({ CUSTOM_VAR: result.sessionDir });
      expect(result.authMaterialized).toBe(true);
    });

    it('defaults config inheritance to full when delegating setup', async () => {
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({
            sessionDir: z.string(),
            baseConfigDir: z.string(),
            platform: z.string(),
            configInheritance: z.enum(['auth-only', 'full', 'empty']),
          }),
          response: SessionConfigSetupResponseSchema,
        },
      });

      let observedPolicy: string | undefined;
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedPolicy = ctx.payload.configInheritance;
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-default-policy',
      });

      expect(observedPolicy).toBe('full');
    });

    it('forwards explicit config inheritance to setup', async () => {
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({
            sessionDir: z.string(),
            baseConfigDir: z.string(),
            platform: z.string(),
            configInheritance: z.enum(['auth-only', 'full', 'empty']),
          }),
          response: SessionConfigSetupResponseSchema,
        },
      });

      const observedPolicies: string[] = [];
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedPolicies.push(ctx.payload.configInheritance);
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-auth-only-policy',
        configInheritance: 'auth-only',
      });
      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-empty-policy',
        configInheritance: 'empty',
      });

      expect(observedPolicies).toEqual(['auth-only', 'empty']);
    });

    it('forwards projectDir to setup when supplied', async () => {
      const projectDir = path.join(baseDir, 'workspace');
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({
            sessionDir: z.string(),
            baseConfigDir: z.string(),
            projectDir: z.string().optional(),
            platform: z.string(),
            configInheritance: z.enum(['auth-only', 'full', 'empty']),
          }),
          response: SessionConfigSetupResponseSchema,
        },
      });

      let observedProjectDir: string | undefined;
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedProjectDir = ctx.payload.projectDir;
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-project-dir',
        projectDir,
      });

      expect(observedProjectDir).toBe(projectDir);
    });

    it('returns an empty env map for unknown clients', async () => {
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'unknown-client',
        leaseId: 'lease-xyz',
      });

      expect(result.env).toEqual({});
      expect(result.authMaterialized).toBe(false);
    });

    it('proceeds without a setup handler registered (no-op delegation)', async () => {
      // No client:<id>.sessionConfig.setup handler is registered — the request
      // must succeed and leave the directory in place.
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-no-handler',
      });

      const stat = await fs.stat(result.sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates separate directories for connector-unique leases', async () => {
      const first = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-1',
      });
      const second = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-2',
      });

      expect(first.sessionDir).not.toBe(second.sessionDir);
      await expect(fs.access(first.sessionDir)).resolves.toBeUndefined();
      await expect(fs.access(second.sessionDir)).resolves.toBeUndefined();
    });

    it('rejects an overlapping duplicate lease before materializing or changing its owner', async () => {
      const setupStarted = Promise.withResolvers<void>();
      const releaseFirstSetup = Promise.withResolvers<void>();
      let setupCalls = 0;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: SessionConfigSetupRequestSchema,
          response: SessionConfigSetupResponseSchema,
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, async (ctx) => {
        setupCalls += 1;
        if (setupCalls === 1) {
          setupStarted.resolve();
          await releaseFirstSetup.promise;
        }
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      const originalRequest = bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-duplicate',
        ownerSessionId: 'original-owner',
      });
      await setupStarted.promise;

      try {
        await expect(
          bus.request(ClientSubjects.sessionConfig.create, {
            clientId: 'claude-code',
            leaseId: 'lease-duplicate',
            ownerSessionId: 'replacement-owner',
          }),
        ).rejects.toThrow("Config lease 'lease-duplicate' is already active for client 'claude-code'");
      } finally {
        releaseFirstSetup.resolve();
      }

      const original = await originalRequest;
      expect(setupCalls).toBe(1);

      await bus.emit(SessionSubjects.closed, { sessionId: 'replacement-owner' });
      await expect(fs.access(original.sessionDir)).resolves.toBeUndefined();

      await bus.emit(SessionSubjects.closed, { sessionId: 'original-owner' });
      await expect(fs.access(original.sessionDir)).rejects.toThrow();
    });

    it('settles and cleans a creating lease before allowing its ID to be retried', async () => {
      const setupStarted = Promise.withResolvers<void>();
      const releaseSetup = Promise.withResolvers<void>();
      let setupCalls = 0;
      let teardownCalls = 0;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: SessionConfigSetupRequestSchema,
          response: SessionConfigSetupResponseSchema,
        },
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, async (ctx) => {
        setupCalls += 1;
        if (setupCalls === 1) {
          setupStarted.resolve();
          await releaseSetup.promise;
        }
        ctx.setResult({ env: {}, authMaterialized: true });
      });
      bus.on(testNs.subjects.sessionConfig.destroy, (ctx) => {
        teardownCalls += 1;
        ctx.setResult({ success: true });
      });

      const creating = bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-close-during-create',
        ownerSessionId: 'owner-close-during-create',
      });
      const creationFailure = expect(creating).rejects.toThrow(
        "Config lease 'lease-close-during-create' was released while it was being created",
      );
      await setupStarted.promise;

      let closeSettled = false;
      const close = bus.emit(SessionSubjects.closed, { sessionId: 'owner-close-during-create' }).then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: 'lease-close-during-create',
        }),
      ).rejects.toThrow("Config lease 'lease-close-during-create' is already active for client 'claude-code'");

      releaseSetup.resolve();
      await creationFailure;
      await close;
      expect(teardownCalls).toBe(1);

      const retried = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-close-during-create',
      });
      expect(setupCalls).toBe(2);
      await expect(fs.access(retried.sessionDir)).resolves.toBeUndefined();
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
          response: SessionConfigSetupResponseSchema,
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedBaseConfigDir = ctx.payload.baseConfigDir;
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-default-profile',
      });

      expect(observedBaseConfigDir).toBe(defaultConfigDir);
    });

    it('falls back to the immutable native config source when no default profile exists', async () => {
      let observedBaseConfigDir: string | undefined;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: SessionConfigSetupResponseSchema,
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        observedBaseConfigDir = ctx.payload.baseConfigDir;
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-native-fallback',
      });

      expect(observedBaseConfigDir).toBe(result.sessionDir);
    });

    it('rejects an explicit missing profile instead of falling back', async () => {
      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: 'lease-missing-profile',
          profileName: 'does-not-exist',
        }),
      ).rejects.toThrow("Profile 'does-not-exist' not found for client 'claude-code'");
    });

    it('rejects lease IDs that are not safe path components', async () => {
      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: '../escape',
        }),
      ).rejects.toThrow();
    });

    it('runs client teardown and removes the lease directory when setup fails', async () => {
      const expectedDir = path.join(baseDir, 'claude-code', 'sessions', 'lease-setup-fails');
      const calls: string[] = [];
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: SessionConfigSetupRequestSchema,
          response: SessionConfigSetupResponseSchema,
        },
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, async (ctx) => {
        calls.push('setup');
        await fs.writeFile(path.join(ctx.payload.sessionDir, 'partial-state'), 'partial', 'utf-8');
        throw new Error('setup failed');
      });
      bus.on(testNs.subjects.sessionConfig.destroy, (ctx) => {
        calls.push('teardown');
        expect(ctx.payload.sessionDir).toBe(expectedDir);
        ctx.setResult({ success: true });
      });

      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: 'lease-setup-fails',
          ownerSessionId: 'owner-setup-fails',
        }),
      ).rejects.toThrow('setup failed');

      expect(calls).toEqual(['setup', 'teardown']);
      await expect(fs.access(expectedDir)).rejects.toThrow();
      await bus.emit(SessionSubjects.closed, { sessionId: 'owner-setup-fails' });
      expect(calls).toEqual(['setup', 'teardown']);
    });

    it('releases the reservation after failed materialization so the lease can be retried', async () => {
      let setupAttempts = 0;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: SessionConfigSetupRequestSchema,
          response: SessionConfigSetupResponseSchema,
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        setupAttempts += 1;
        if (setupAttempts === 1) {
          throw new Error('first materialization failed');
        }
        ctx.setResult({ env: {}, authMaterialized: true });
      });

      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: 'lease-retry-after-failure',
        }),
      ).rejects.toThrow('first materialization failed');

      const retried = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-retry-after-failure',
      });

      expect(setupAttempts).toBe(2);
      await expect(fs.access(retried.sessionDir)).resolves.toBeUndefined();
    });

    it('releases the reservation when both materialization and rollback teardown fail', async () => {
      let setupAttempts = 0;
      let teardownAttempts = 0;
      const expectedDir = path.join(baseDir, 'claude-code', 'sessions', 'lease-double-failure');
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: SessionConfigSetupRequestSchema,
          response: SessionConfigSetupResponseSchema,
        },
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.setup, (ctx) => {
        setupAttempts += 1;
        if (setupAttempts === 1) {
          throw new Error('materialization failed');
        }
        ctx.setResult({ env: {}, authMaterialized: true });
      });
      bus.on(testNs.subjects.sessionConfig.destroy, (ctx) => {
        teardownAttempts += 1;
        if (teardownAttempts === 1) {
          throw new Error('rollback teardown failed');
        }
        ctx.setResult({ success: true });
      });

      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: 'lease-double-failure',
        }),
      ).rejects.toThrow('Client session config creation and rollback both failed');
      await expect(fs.access(expectedDir)).rejects.toThrow();

      const retried = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-double-failure',
      });
      expect(setupAttempts).toBe(2);
      await expect(fs.access(retried.sessionDir)).resolves.toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Config prime lifecycle — session-create phase
    // -----------------------------------------------------------------------

    it('calls client-specific config.prime with session-create phase after setup delegation', async () => {
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

      const projectDir = path.join(baseDir, 'my-project');
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-prime-test',
        projectDir,
      });

      unsubPrime();

      expect(observed).toHaveLength(1);
      expect(observed[0]?.clientId).toBe('claude-code');
      expect(observed[0]?.phase).toBe('session-create');
      expect(observed[0]?.configDir).toBe(result.sessionDir);
      expect(observed[0]?.projectDir).toBe(projectDir);
      expect(observed[0]?.binaryVersion).toBeUndefined();
    });

    it('proceeds without a config.prime handler registered for session-create', async () => {
      // No client:claude-code.config.prime handler — creation must succeed.
      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-no-prime-handler',
      });

      const stat = await fs.stat(result.sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('calls config.prime after setup delegation (setup env is returned correctly)', async () => {
      // Register both a setup handler and a prime handler to confirm ordering:
      // setup runs first (returns env), then prime is called.
      const callOrder: string[] = [];
      const setupNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: SessionConfigSetupResponseSchema,
        },
      });
      bus.on(setupNs.subjects.sessionConfig.setup, (ctx) => {
        callOrder.push('setup');
        ctx.setResult({ env: { SETUP_VAR: 'setup-value' }, authMaterialized: true });
      });

      const primeNs = createBusNamespace('client:claude-code', {
        'config.prime': {
          request: z.object({ clientId: z.string(), configDir: z.string(), phase: z.string() }),
          response: z.object({ primed: z.boolean() }),
        },
      });
      bus.on(primeNs.subjects.config.prime, (ctx) => {
        callOrder.push('prime');
        ctx.setResult({ primed: true });
      });

      const result = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-order-test',
      });

      // Setup must run before prime.
      expect(callOrder).toEqual(['setup', 'prime']);
      // Env from setup is returned correctly even when prime is called after.
      expect(result.env).toEqual({ SETUP_VAR: 'setup-value' });
    });

    it('rejects session config creation when config.prime fails after setup', async () => {
      const callOrder: string[] = [];
      const expectedDir = path.join(baseDir, 'claude-code', 'sessions', 'lease-prime-fails');
      const setupNs = createBusNamespace('client:claude-code', {
        'sessionConfig.setup': {
          request: z.object({ sessionDir: z.string(), baseConfigDir: z.string(), platform: z.string() }),
          response: SessionConfigSetupResponseSchema,
        },
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      bus.on(setupNs.subjects.sessionConfig.setup, (ctx) => {
        callOrder.push('setup');
        ctx.setResult({ env: { SETUP_VAR: 'setup-value' }, authMaterialized: true });
      });
      bus.on(setupNs.subjects.sessionConfig.destroy, (ctx) => {
        callOrder.push('teardown');
        ctx.setResult({ success: true });
      });

      const primeNs = createBusNamespace('client:claude-code', {
        'config.prime': {
          request: z.object({ clientId: z.string(), configDir: z.string(), phase: z.string() }),
          response: z.object({ primed: z.boolean() }),
        },
      });
      bus.on(primeNs.subjects.config.prime, () => {
        callOrder.push('prime');
        throw new Error('prime failed');
      });

      await expect(
        bus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId: 'lease-prime-fails',
          ownerSessionId: 'owner-prime-fails',
        }),
      ).rejects.toThrow('prime failed');

      expect(callOrder).toEqual(['setup', 'prime', 'teardown']);
      await expect(fs.access(expectedDir)).rejects.toThrow();
      await bus.emit(SessionSubjects.closed, { sessionId: 'owner-prime-fails' });
      expect(callOrder).toEqual(['setup', 'prime', 'teardown']);
    });
  });

  // -------------------------------------------------------------------------
  // sessionConfig.destroy
  // -------------------------------------------------------------------------

  describe('sessionConfig.destroy', () => {
    it('removes an existing session directory', async () => {
      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-to-destroy',
      });

      // Directory must exist before destroy.
      await expect(fs.access(created.sessionDir)).resolves.toBeUndefined();

      const result = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-to-destroy',
      });

      expect(result.success).toBe(true);
      await expect(fs.access(created.sessionDir)).rejects.toThrow();
    });

    it('delegates client-owned teardown before removing the session directory', async () => {
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });

      const observed: Array<{ sessionDir: string; existsDuringTeardown: boolean }> = [];
      bus.on(testNs.subjects.sessionConfig.destroy, async (ctx) => {
        observed.push({
          sessionDir: ctx.payload.sessionDir,
          existsDuringTeardown: await fs
            .access(ctx.payload.sessionDir)
            .then(() => true)
            .catch(() => false),
        });
        ctx.setResult({ success: true });
      });

      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-teardown-handler',
      });

      const result = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-teardown-handler',
      });

      expect(result.success).toBe(true);
      expect(observed).toEqual([{ sessionDir: created.sessionDir, existsDuringTeardown: true }]);
      await expect(fs.access(created.sessionDir)).rejects.toThrow();
    });

    it('is idempotent: destroy on a non-existent directory still succeeds', async () => {
      const result = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-never-created',
      });

      expect(result.success).toBe(true);
    });

    it('second destroy of the same directory also succeeds', async () => {
      await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-double-destroy',
      });

      const first = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-double-destroy',
      });
      const second = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-double-destroy',
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
    });

    it('shares one cleanup operation across overlapping destroy requests', async () => {
      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-overlapping-destroy',
      });
      const teardownStarted = Promise.withResolvers<void>();
      const releaseTeardown = Promise.withResolvers<void>();
      let teardownCalls = 0;
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      bus.on(testNs.subjects.sessionConfig.destroy, async (ctx) => {
        teardownCalls += 1;
        teardownStarted.resolve();
        await releaseTeardown.promise;
        ctx.setResult({ success: true });
      });

      const first = bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-overlapping-destroy',
      });
      await teardownStarted.promise;
      const second = bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-overlapping-destroy',
      });
      await Promise.resolve();
      expect(teardownCalls).toBe(1);

      releaseTeardown.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([{ success: true }, { success: true }]);
      expect(teardownCalls).toBe(1);
      await expect(fs.access(created.sessionDir)).rejects.toThrow();
    });

    it('runs client-owned teardown even after the lease directory disappeared', async () => {
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });

      let teardownCalls = 0;
      bus.on(testNs.subjects.sessionConfig.destroy, (ctx) => {
        teardownCalls += 1;
        ctx.setResult({ success: true });
      });

      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-disappears-before-destroy',
      });
      await fs.rm(created.sessionDir, { recursive: true, force: true });

      const result = await bus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        leaseId: 'lease-disappears-before-destroy',
      });

      expect(result.success).toBe(true);
      expect(teardownCalls).toBe(1);
    });

    it('removes the directory and both lease indexes when client teardown fails', async () => {
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      let teardownCalls = 0;
      bus.on(testNs.subjects.sessionConfig.destroy, () => {
        teardownCalls += 1;
        throw new Error('teardown failed');
      });

      const created = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-teardown-fails',
        ownerSessionId: 'owner-teardown-fails',
      });

      await expect(
        bus.request(ClientSubjects.sessionConfig.destroy, {
          clientId: 'claude-code',
          leaseId: 'lease-teardown-fails',
        }),
      ).rejects.toThrow('teardown failed');
      await expect(fs.access(created.sessionDir)).rejects.toThrow();

      await bus.emit(SessionSubjects.closed, { sessionId: 'owner-teardown-fails' });
      expect(teardownCalls).toBe(1);
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
        leaseId: 'fresh-lease',
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

    it('does not remove stale-looking directories for live leases', async () => {
      const staleBus = createBusInstance();
      const staleService = new ClientSessionConfigService(staleBus, baseDir, futureNow(2 * 60 * 60 * 1000));
      await staleService.init();

      const active = await staleBus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'active-lease',
        baseConfigDir: baseDir,
      });

      const result = await staleBus.request(ClientSubjects.sessionConfig.cleanup, {});
      await staleService.destroy();

      expect(result.removed).not.toContain(active.sessionDir);
      await expect(fs.access(active.sessionDir)).resolves.toBeUndefined();
    });

    it('surfaces stale-lease teardown failures after still removing the directory', async () => {
      const staleBus = createBusInstance();
      const staleService = new ClientSessionConfigService(staleBus, baseDir, futureNow(2 * 60 * 60 * 1000));
      await staleService.init();
      const testNs = createBusNamespace('client:claude-code', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      staleBus.on(testNs.subjects.sessionConfig.destroy, () => {
        throw new Error('stale teardown failed');
      });
      const staleDir = path.join(baseDir, 'claude-code', 'sessions', 'stale-teardown-failure');
      await fs.mkdir(staleDir, { recursive: true });

      await expect(staleBus.request(ClientSubjects.sessionConfig.cleanup, {})).rejects.toThrow('stale teardown failed');
      await expect(fs.access(staleDir)).rejects.toThrow();
      await staleService.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Session lifecycle cleanup
  // -------------------------------------------------------------------------

  describe('session.closed cleanup', () => {
    it('releases every lease owned by the closed session and leaves other leases live', async () => {
      const first = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-closing-1',
        ownerSessionId: 'session-closing',
      });
      const second = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'codex',
        leaseId: 'lease-closing-2',
        ownerSessionId: 'session-closing',
      });
      const other = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-other-owner',
        ownerSessionId: 'other-session',
      });

      await bus.emit(SessionSubjects.closed, { sessionId: 'session-closing' });

      await expect(fs.access(first.sessionDir)).rejects.toThrow();
      await expect(fs.access(second.sessionDir)).rejects.toThrow();
      await expect(fs.access(other.sessionDir)).resolves.toBeUndefined();
    });

    it('releases and untracks every owned lease when one client teardown fails', async () => {
      const teardownCalls: string[] = [];
      const claudeNs = createBusNamespace('client:claude-code', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      const codexNs = createBusNamespace('client:codex', {
        'sessionConfig.destroy': {
          request: z.object({
            sessionDir: z.string(),
            platform: z.enum(['darwin', 'linux', 'win32']),
          }),
          response: z.object({ success: z.boolean() }),
        },
      });
      bus.on(claudeNs.subjects.sessionConfig.destroy, (ctx) => {
        teardownCalls.push(ctx.payload.sessionDir);
        throw new Error('claude teardown failed');
      });
      bus.on(codexNs.subjects.sessionConfig.destroy, (ctx) => {
        teardownCalls.push(ctx.payload.sessionDir);
        ctx.setResult({ success: true });
      });

      const first = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId: 'lease-failing-owner-cleanup',
        ownerSessionId: 'session-failing-cleanup',
      });
      const second = await bus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'codex',
        leaseId: 'lease-successful-owner-cleanup',
        ownerSessionId: 'session-failing-cleanup',
      });

      await expect(bus.emit(SessionSubjects.closed, { sessionId: 'session-failing-cleanup' })).rejects.toThrow(
        "Failed to release config leases owned by session 'session-failing-cleanup'",
      );
      await expect(fs.access(first.sessionDir)).rejects.toThrow();
      await expect(fs.access(second.sessionDir)).rejects.toThrow();

      await bus.emit(SessionSubjects.closed, { sessionId: 'session-failing-cleanup' });
      expect(teardownCalls).toHaveLength(2);
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
