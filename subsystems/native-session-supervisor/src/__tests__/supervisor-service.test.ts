/**
 * Supervisor service integration tests.
 *
 * Uses a real `MakaioBus`, a real `RuntimeRegistry` backed by an in-memory
 * SQLite database, and a mock `IPtyBackend` to verify the four bus handlers
 * (`launch`, `attach`, `stop`, `status`) without spawning real processes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance, MakaioBus, waitForSubscriptionPropagation } from '@makaio/bus-core';
import {
  HmacAuth,
  MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID,
  registerHmacIdentitySecret,
  registerMakaioLocalCliHmacIdentity,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
  ServerTransport,
  type TransportAuth,
  type WebSocketLike,
  WebSocketClientTransport,
} from '@makaio/bus-transport-websocket';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import {
  NativeSessionSupervisorNamespace,
  NativeSessionSupervisorSubjects,
} from '@makaio/contracts/native-session-supervisor';
import { ClientSubjects } from '@makaio/contracts/client';
import { WebSocketServer } from 'ws';
import { LazyNodePtyBackend, SupervisorService } from '../supervisor-service.js';
import type { PtyRuntimeFactory } from '../supervisor-service.js';
import { PtyRuntime } from '../pty/pty-runtime.js';
import { registerDrizzleSupervisorRuntimeStorage } from '../storage/drizzle-handler.js';
import { SupervisorRuntimeStorageSubjects } from '../storage/namespace.js';
import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from '../pty/types.js';
import { createTestDb } from './helpers/create-test-db.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Mock PTY backend
// ---------------------------------------------------------------------------

/**
 * Creates a mock `IPtyProcess` that captures listeners for test-driven event
 * simulation.
 * @param pid - OS process ID to assign to the mock process.
 * @returns A mock PTY process handle.
 */
function createMockProcess(pid: number): IPtyProcess & {
  _fireData: (data: string) => void;
  _fireExit: (exitCode: number, signal?: number) => void;
} {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  return {
    pid,
    process: 'mock',
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (listener) => {
      dataListeners.push(listener);
      return { dispose: () => dataListeners.splice(dataListeners.indexOf(listener), 1) };
    },
    onExit: (listener) => {
      exitListeners.push(listener);
      return { dispose: () => exitListeners.splice(exitListeners.indexOf(listener), 1) };
    },
    _fireData: (data) => {
      for (const listener of dataListeners) listener(data);
    },
    _fireExit: (exitCode, signal) => {
      for (const l of exitListeners) l({ exitCode, signal });
    },
  };
}

let nextPid = 10000;

/**
 * Build a mock `IPtyBackend` that returns controllable mock processes.
 * @returns Backend and a reference to the last spawned mock process.
 */
function createMockBackend(): {
  backend: IPtyBackend;
  getLastProcess: () => ReturnType<typeof createMockProcess> | null;
  getLastSpawnOptions: () => IPtySpawnOptions | null;
} {
  let lastProcess: ReturnType<typeof createMockProcess> | null = null;
  let lastSpawnOptions: IPtySpawnOptions | null = null;

  const backend: IPtyBackend = {
    spawn: (_file: string, _args: string[], _options: IPtySpawnOptions) => {
      lastSpawnOptions = _options;
      const proc = createMockProcess(nextPid++);
      lastProcess = proc;
      return Promise.resolve(proc);
    },
  };

  return { backend, getLastProcess: () => lastProcess, getLastSpawnOptions: () => lastSpawnOptions };
}

/**
 * Wait until the supplied predicate returns a non-nullish value, then return it.
 * @param read - Predicate/read function polled via `vi.waitFor`.
 * @returns The first non-nullish value observed after the wait completes.
 */
async function waitForValue<T>(read: () => T | null | undefined): Promise<T> {
  await vi.waitFor(() => {
    expect(read()).not.toBeNull();
    expect(read()).toBeDefined();
  });
  return read() as T;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('SupervisorService', () => {
  let db: MakaioDatabase;
  let dbClose: () => void;
  let storageCleanup: (() => void) | undefined;
  let service: SupervisorService;
  let getLastProcess: () => ReturnType<typeof createMockProcess> | null;
  let getLastSpawnOptions: () => IPtySpawnOptions | null;

  beforeEach(async () => {
    ({ db, close: dbClose } = await createTestDb());
    storageCleanup = registerDrizzleSupervisorRuntimeStorage(MakaioBus, db);

    const mock = createMockBackend();
    getLastProcess = mock.getLastProcess;
    getLastSpawnOptions = mock.getLastSpawnOptions;

    const factory: PtyRuntimeFactory = (handlers) => new PtyRuntime(mock.backend, handlers);

    service = new SupervisorService(MakaioBus, factory);
    await service.init();
  });

  afterEach(async () => {
    // Storage handlers and the database are released even when teardown fails,
    // so one unclean shutdown cannot leak registrations into the next test.
    try {
      await service.destroy();
    } finally {
      storageCleanup?.();
      dbClose();
    }
  });

  // -------------------------------------------------------------------------
  // startup reconciliation
  // -------------------------------------------------------------------------

  describe('startup reconciliation', () => {
    it('marks persisted running runtimes as unknown because PTY handles are process-local', async () => {
      await service.destroy();

      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        supervisorSessionId: 'persisted-running',
        clientId: 'test-client',
        pid: 12345,
        status: 'running',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
        startedAt: 1_700_000_000_000,
      });

      const mock = createMockBackend();
      getLastProcess = mock.getLastProcess;
      getLastSpawnOptions = mock.getLastSpawnOptions;
      const factory: PtyRuntimeFactory = (handlers) => new PtyRuntime(mock.backend, handlers);

      service = new SupervisorService(MakaioBus, factory);
      await service.init();

      const runtime = service.getRegistry().getBySupervisorId('persisted-running');
      expect(runtime?.status).toBe('unknown');
      expect(runtime?.pid).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // launch
  // -------------------------------------------------------------------------

  describe('launch', () => {
    it('spawns a PTY and returns supervisorSessionId and pid', async () => {
      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'claude-code',
        cwd: '/home/user',
        command: '/bin/bash',
        args: [],
      });

      expect(response.supervisorSessionId).toBeTypeOf('string');
      expect(response.supervisorSessionId.length).toBeGreaterThan(0);
      expect(response.pid).toBeTypeOf('number');
      expect(response.pid).toBeGreaterThan(0);
    });

    it('registers the runtime in the registry with status = running', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'claude-code',
        cwd: '/home/user',
        command: '/bin/bash',
        args: [],
      });

      const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
      expect(runtime).toBeDefined();
      expect(runtime?.status).toBe('running');
      expect(runtime?.clientId).toBe('claude-code');
      expect(runtime?.command).toBe('/bin/bash');
    });

    it('stores optional sessionId and adapterSessionId correlations', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
        sessionId: 'sess_abc',
        adapterSessionId: 'adp_xyz',
      });

      expect(service.getRegistry().getBySessionId('sess_abc')?.supervisorSessionId).toBe(supervisorSessionId);
      expect(service.getRegistry().getByAdapterSessionId('adp_xyz')?.supervisorSessionId).toBe(supervisorSessionId);
    });

    it('materializes config, preserves the request/config merge, and stamps the supervisor session identity', async () => {
      const inheritedEnvKey = 'MAKAIO_SUPERVISOR_TEST_HOST_ONLY';
      const inheritedEnvValue = process.env[inheritedEnvKey];
      let observedSessionConfigRequest: unknown;
      const cleanups = [
        MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
          observedSessionConfigRequest = ctx.payload;
          ctx.setResult({
            sessionDir: '/tmp/makaio/clients/claude-code/sessions/sess_profile',
            env: {
              CLAUDE_CONFIG_DIR: '/tmp/makaio/clients/claude-code/sessions/sess_profile',
              CONFIG_ONLY: 'config',
              MERGE_PRECEDENCE: 'config',
              MAKAIO_SUPERVISOR_SESSION_ID: 'config-spoofed-id',
            },
            authMaterialized: false,
          });
        }),
        // The lease this launch takes is released while its owner can still
        // answer, so the suite's teardown is not left holding one.
        MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => ctx.setResult({ success: true })),
      ];

      let launchedSupervisorSessionId: string;
      process.env[inheritedEnvKey] = 'host-only';
      try {
        ({ supervisorSessionId: launchedSupervisorSessionId } = await MakaioBus.request(
          NativeSessionSupervisorSubjects.launch,
          {
            clientId: 'claude-code',
            cwd: '/home/user',
            command: '/bin/bash',
            args: [],
            env: {
              REQUEST_ONLY: 'request',
              MERGE_PRECEDENCE: 'request',
              MAKAIO_SUPERVISOR_SESSION_ID: 'request-spoofed-id',
            },
            sessionId: 'sess_profile',
            clientProfileName: 'work',
          },
        ));

        await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
          supervisorSessionId: launchedSupervisorSessionId,
        });
      } finally {
        if (inheritedEnvValue === undefined) {
          delete process.env[inheritedEnvKey];
        } else {
          process.env[inheritedEnvKey] = inheritedEnvValue;
        }
        for (const cleanup of cleanups) cleanup();
      }

      expect(observedSessionConfigRequest).toEqual({
        clientId: 'claude-code',
        leaseId: launchedSupervisorSessionId,
        ownerSessionId: 'sess_profile',
        profileName: 'work',
      });
      expect(getLastSpawnOptions()).toEqual({
        cwd: '/home/user',
        inheritEnvironment: true,
        env: {
          REQUEST_ONLY: 'request',
          CONFIG_ONLY: 'config',
          MERGE_PRECEDENCE: 'config',
          CLAUDE_CONFIG_DIR: '/tmp/makaio/clients/claude-code/sessions/sess_profile',
          MAKAIO_SUPERVISOR_SESSION_ID: launchedSupervisorSessionId,
        },
      });
      expect(service.getRegistry().getBySupervisorId(launchedSupervisorSessionId)?.env).toEqual({
        REQUEST_ONLY: 'request',
        CONFIG_ONLY: 'config',
        MERGE_PRECEDENCE: 'config',
        CLAUDE_CONFIG_DIR: '/tmp/makaio/clients/claude-code/sessions/sess_profile',
        MAKAIO_SUPERVISOR_SESSION_ID: 'config-spoofed-id',
      });
    });

    it('destroys materialized session config when a launched runtime stops', async () => {
      const destroyed: Array<{ clientId: string; leaseId: string }> = [];
      const cleanups = [
        MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
          ctx.setResult({
            sessionDir: '/tmp/makaio/clients/claude-code/sessions/sess_profile_cleanup',
            env: {},
            authMaterialized: false,
          });
        }),
        MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
          destroyed.push(ctx.payload);
          ctx.setResult({ success: true });
        }),
      ];

      let supervisorSessionId: string;
      try {
        ({ supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'claude-code',
          cwd: '/home/user',
          command: '/bin/bash',
          args: [],
          sessionId: 'sess_profile_cleanup',
          clientProfileName: 'work',
        }));

        await MakaioBus.request(NativeSessionSupervisorSubjects.stop, { supervisorSessionId });
      } finally {
        for (const cleanup of cleanups) cleanup();
      }

      expect(destroyed).toContainEqual({ clientId: 'claude-code', leaseId: supervisorSessionId });
    });

    it('destroys every materialized session config when the supervisor shuts down', async () => {
      const destroyed: Array<{ clientId: string; leaseId: string }> = [];
      const cleanups = [
        MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
          ctx.setResult({
            sessionDir: `/tmp/makaio/clients/${ctx.payload.clientId}/sessions/${ctx.payload.leaseId}`,
            env: {},
            authMaterialized: false,
          });
        }),
        MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
          destroyed.push(ctx.payload);
          ctx.setResult({ success: true });
        }),
      ];

      let supervisorSessionId: string;
      try {
        ({ supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'claude-code',
          cwd: '/home/user',
          command: '/bin/bash',
          args: [],
          clientProfileName: 'work',
        }));

        await service.destroy();
      } finally {
        for (const cleanup of cleanups) cleanup();
      }

      expect(destroyed).toEqual([{ clientId: 'claude-code', leaseId: supervisorSessionId }]);
    });

    it('retains a failed config release and retries it during supervisor shutdown', async () => {
      let destroyAttempts = 0;
      const cleanups = [
        MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
          ctx.setResult({
            sessionDir: `/tmp/makaio/clients/${ctx.payload.clientId}/sessions/${ctx.payload.leaseId}`,
            env: {},
            authMaterialized: false,
          });
        }),
        MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
          destroyAttempts += 1;
          if (destroyAttempts === 1) {
            throw new Error('credential reconciliation failed');
          }
          ctx.setResult({ success: true });
        }),
      ];

      let supervisorSessionId: string;
      try {
        ({ supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'claude-code',
          cwd: '/home/user',
          command: '/bin/bash',
          args: [],
          clientProfileName: 'work',
        }));

        await expect(MakaioBus.request(NativeSessionSupervisorSubjects.stop, { supervisorSessionId })).rejects.toThrow(
          `Failed to release config lease for supervised runtime '${supervisorSessionId}'`,
        );
        expect(destroyAttempts).toBe(1);

        await service.destroy();
        expect(destroyAttempts).toBe(2);
      } finally {
        for (const cleanup of cleanups) cleanup();
      }
    });

    it('kills the spawned PTY and clears pendingExits when registry.register() throws', async () => {
      // Exercises the _handleLaunch error branch: if the storage set fails,
      // the supervisor kills the spawned PTY (to avoid an untracked orphan) and
      // clears any premature exit event so it cannot be replayed later.
      //
      // Simulation: inject a high-priority bus handler that forces the storage
      // `set` subject to return success: false, which makes registry.register()
      // throw. The bus handler for `launch` must propagate the error.

      const unsubOverride = MakaioBus.on(
        SupervisorRuntimeStorageSubjects.set,
        (ctx) => ctx.setResult({ success: false }),
        { priority: 999 },
      );

      try {
        await expect(
          MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
            clientId: 'test-client',
            cwd: '/tmp',
            command: '/bin/sh',
            args: [],
          }),
        ).rejects.toThrow();

        // The process was spawned but the registry rejected it, so no runtime
        // entry should exist in the in-memory registry.
        expect(service.getRegistry().getAll()).toHaveLength(0);

        // The mock process should have been killed by the error-handling branch.
        const mockProcess = getLastProcess();
        expect(mockProcess).not.toBeNull();
        expect(mockProcess?.kill).toHaveBeenCalledWith('SIGTERM');
      } finally {
        unsubOverride();
      }
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe('status', () => {
    let launchedId: string;

    beforeEach(async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
        sessionId: 'sess_status',
        adapterSessionId: 'adp_status',
      });
      launchedId = supervisorSessionId;
    });

    it('returns a snapshot when looking up by supervisorSessionId', async () => {
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        supervisorSessionId: launchedId,
      });

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.supervisorSessionId).toBe(launchedId);
      expect(runtimes[0]?.status).toBe('running');
    });

    it('returns a snapshot when looking up by sessionId', async () => {
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        sessionId: 'sess_status',
      });

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.supervisorSessionId).toBe(launchedId);
    });

    it('returns a snapshot when looking up by adapterSessionId', async () => {
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        adapterSessionId: 'adp_status',
      });

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.supervisorSessionId).toBe(launchedId);
    });

    it('returns all runtimes when no locator is provided', async () => {
      // Launch a second runtime
      await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'other-client',
        cwd: '/var',
        command: '/bin/sh',
        args: [],
      });

      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {});
      expect(runtimes.length).toBeGreaterThanOrEqual(2);
    });

    it('returns an empty array for an unknown supervisorSessionId', async () => {
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        supervisorSessionId: 'nonexistent',
      });
      expect(runtimes).toHaveLength(0);
    });

    it('returns an empty array for an unknown adapterSessionId', async () => {
      // Exercises the `adapterSessionId` branch of _handleStatus. The branch
      // must delegate to registry.getByAdapterSessionId() and return [] when no
      // runtime is found — symmetrically to the supervisorSessionId branch.
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        adapterSessionId: 'nonexistent_adp',
      });
      expect(runtimes).toHaveLength(0);
    });

    it('returns an empty array for an unknown sessionId', async () => {
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        sessionId: 'nonexistent_sess',
      });
      expect(runtimes).toHaveLength(0);
    });

    it('snapshot includes adapterSessionId when the runtime was launched with one', async () => {
      // Verifies that the toSnapshot() helper preserves the adapterSessionId
      // field in status responses, completing the adapterSessionId round-trip
      // through the _handleStatus branch.
      const { runtimes } = await MakaioBus.request(NativeSessionSupervisorSubjects.status, {
        adapterSessionId: 'adp_status',
      });

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.supervisorSessionId).toBe(launchedId);
      expect(runtimes[0]?.adapterSessionId).toBe('adp_status');
      expect(runtimes[0]?.sessionId).toBe('sess_status');
    });
  });

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('kills the PTY process and marks the runtime as stopped', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
      });

      const mockProcess = getLastProcess();
      expect(mockProcess).not.toBeNull();

      const { success } = await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
        supervisorSessionId,
      });

      expect(success).toBe(true);
      expect(mockProcess?.kill).toHaveBeenCalledWith('SIGTERM');

      const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
      expect(runtime?.status).toBe('stopped');
      expect(runtime?.pid).toBeNull();
      expect(runtime?.stoppedAt).toBeTypeOf('number');
    });

    it('preserves stopped status when the killed PTY later emits an exit event', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
      });

      const mockProcess = getLastProcess();
      expect(mockProcess).not.toBeNull();

      await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
        supervisorSessionId,
      });

      mockProcess!._fireExit(143);

      await vi.waitFor(() => {
        const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
        expect(runtime?.status).toBe('stopped');
      });

      const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
      expect(runtime?.pid).toBeNull();
    });

    it('forwards a custom signal to the PTY kill call', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
      });

      const mockProcess = getLastProcess();

      await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
        supervisorSessionId,
        signal: 'SIGKILL',
      });

      expect(mockProcess?.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('returns success = false for an unknown supervisorSessionId', async () => {
      const { success } = await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
        supervisorSessionId: 'nonexistent',
      });
      expect(success).toBe(false);
    });

    it('returns success = false for a hydrated unknown runtime with no active PTY', async () => {
      // Simulate a restart: insert a persisted runtime then re-init the service
      // so the registry loads it as 'unknown' (no in-memory PTY).
      await service.destroy();

      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        supervisorSessionId: 'hydrated-unknown',
        clientId: 'test-client',
        pid: 99999,
        status: 'running',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
        startedAt: 1_700_000_000_000,
      });

      const mock = createMockBackend();
      getLastProcess = mock.getLastProcess;
      const factory: PtyRuntimeFactory = (handlers) => new PtyRuntime(mock.backend, handlers);
      service = new SupervisorService(MakaioBus, factory);
      await service.init();

      const hydratedRuntime = service.getRegistry().getBySupervisorId('hydrated-unknown');
      expect(hydratedRuntime?.status).toBe('unknown');

      const { success } = await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
        supervisorSessionId: 'hydrated-unknown',
      });

      expect(success).toBe(false);
      // Registry status must not be changed to 'stopped'.
      const runtimeAfter = service.getRegistry().getBySupervisorId('hydrated-unknown');
      expect(runtimeAfter?.status).toBe('unknown');
    });
  });

  // -------------------------------------------------------------------------
  // attach
  // -------------------------------------------------------------------------

  describe('attach', () => {
    let launchedId: string;

    beforeEach(async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
        sessionId: 'sess_attach',
        adapterSessionId: 'adp_attach',
      });
      launchedId = supervisorSessionId;
    });

    it('resolves and attaches via supervisorSessionId', async () => {
      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.attach, {
        supervisorSessionId: launchedId,
      });

      expect(response.success).toBe(true);
      expect(response.supervisorSessionId).toBe(launchedId);
      expect(response.terminalAttachment?.canAttach).toBe(true);
    });

    it('resolves and attaches via sessionId', async () => {
      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.attach, {
        sessionId: 'sess_attach',
      });

      expect(response.success).toBe(true);
      expect(response.supervisorSessionId).toBe(launchedId);
    });

    it('resolves and attaches via adapterSessionId', async () => {
      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.attach, {
        adapterSessionId: 'adp_attach',
      });

      expect(response.success).toBe(true);
      expect(response.supervisorSessionId).toBe(launchedId);
    });

    it('returns success = false for an unknown sessionId', async () => {
      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.attach, {
        sessionId: 'unknown_session',
      });
      expect(response.success).toBe(false);
    });

    it('returns success = false for an unknown adapterSessionId', async () => {
      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.attach, {
        adapterSessionId: 'unknown_adp',
      });
      expect(response.success).toBe(false);
    });

    it('returns success = false after the runtime has been stopped', async () => {
      await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
        supervisorSessionId: launchedId,
      });

      const response = await MakaioBus.request(NativeSessionSupervisorSubjects.attach, {
        supervisorSessionId: launchedId,
      });

      expect(response.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // terminal attachment
  // -------------------------------------------------------------------------

  describe('terminal attachment', () => {
    it('accepts the named local CLI peer over a real WebSocket while rejecting global and other HMAC peers', async () => {
      const secret = 'terminal-attachment-test-secret';
      const unregisterLocalCli = registerMakaioLocalCliHmacIdentity(secret);
      const unregisterOtherPeer = registerHmacIdentitySecret('other-peer:v1', secret, { peerKind: 'other-peer' });
      const websocket = new WebSocketServer({ host: '127.0.0.1', path: '/bus', port: 0 });
      await new Promise<void>((resolve, reject) => {
        websocket.once('listening', resolve);
        websocket.once('error', reject);
      });
      const address = websocket.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP WebSocket address');

      const serverTransport = new ServerTransport({
        websocket,
        auth: new HmacAuth({ secret, resolveSecret: resolveHmacIdentitySecret, resolvePeer: resolveHmacIdentityPeer }),
      });
      MakaioBus.registerTransport(serverTransport);
      await serverTransport.connect();

      const clients: Array<ReturnType<typeof createBusInstance>> = [];
      const connectClient = async (identityId?: string) => {
        const bus = createBusInstance();
        bus.registerNamespace(NativeSessionSupervisorNamespace);
        bus.registerTransport(
          new WebSocketClientTransport({
            url: `ws://127.0.0.1:${address.port}/bus`,
            auth: new HmacAuth({ secret, identityId }),
            autoReconnect: false,
            heartbeat: false,
          }),
        );
        clients.push(bus);
        await bus.connect();
        return bus;
      };

      try {
        const localCli = await connectClient(MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID);
        const secondLocalCli = await connectClient(MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID);
        const output: string[] = [];
        const secondOutput: string[] = [];
        const unsubscribe = localCli.on(NativeSessionSupervisorSubjects.terminal.output, (ctx) => {
          output.push(ctx.payload.data);
        });
        await waitForSubscriptionPropagation(unsubscribe);
        const unsubscribeSecond = secondLocalCli.on(NativeSessionSupervisorSubjects.terminal.output, (ctx) => {
          secondOutput.push(ctx.payload.data);
        });
        await waitForSubscriptionPropagation(unsubscribeSecond);

        const { supervisorSessionId } = await localCli.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'claude-agent-sdk',
          cwd: '/tmp',
          command: 'claude',
          args: [],
          adapterSessionId: 'adapter-session-1',
        });
        const attachmentId = '18d9f462-48e9-4b96-bc93-37a96d09831c';
        await expect(
          localCli.request(NativeSessionSupervisorSubjects.terminal.open, {
            attachmentId,
            locator: { adapterSessionId: 'adapter-session-1' },
          }),
        ).resolves.toMatchObject({ success: true, supervisorSessionId });
        const process = getLastProcess();
        process?._fireData('ready');
        await vi.waitFor(() => expect(output).toEqual(['ready']));
        expect(secondOutput).toEqual([]);

        await expect(
          secondLocalCli.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId }),
        ).resolves.toEqual({ success: false });
        await expect(
          secondLocalCli.request(NativeSessionSupervisorSubjects.terminal.input, {
            attachmentId,
            data: 'foreign-input',
          }),
        ).rejects.toThrow(`Terminal attachment '${attachmentId}' is not open`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(process?.write).not.toHaveBeenCalledWith('foreign-input');

        await localCli.request(NativeSessionSupervisorSubjects.terminal.input, { attachmentId, data: '/compact' });
        await localCli.request(NativeSessionSupervisorSubjects.terminal.resize, { attachmentId, cols: 120, rows: 40 });
        await vi.waitFor(() => {
          expect(process?.write).toHaveBeenCalledWith('/compact');
          expect(process?.resize).toHaveBeenCalledWith(120, 40);
        });
        await expect(
          localCli.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId }),
        ).resolves.toEqual({
          success: true,
        });
        const localAttachmentId = 'c8dd005d-f036-44c2-8148-3e2607128e1c';
        await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.open, {
          attachmentId: localAttachmentId,
          locator: { supervisorSessionId },
        });
        process?._fireData('local-only');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(output).toEqual(['ready']);
        await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId: localAttachmentId });
        expect(process?.kill).not.toHaveBeenCalled();
        unsubscribe();
        unsubscribeSecond();

        const globalPeer = await connectClient();
        await expect(
          globalPeer.request(NativeSessionSupervisorSubjects.terminal.open, {
            attachmentId: 'a45877ca-0d39-4f92-bc98-682d7210c2e2',
            locator: { supervisorSessionId },
          }),
        ).rejects.toThrow('Unauthorized: supervisor.terminal.open requires local CLI control');

        const otherPeer = await connectClient('other-peer:v1');
        await expect(otherPeer.request(NativeSessionSupervisorSubjects.stop, { supervisorSessionId })).rejects.toThrow(
          'Unauthorized: supervisor.stop requires local CLI control',
        );
      } finally {
        for (const client of clients.reverse()) await client.disconnect();
        MakaioBus.unregisterTransport(serverTransport.name);
        await serverTransport.disconnect();
        unregisterOtherPeer();
        unregisterLocalCli();
      }
    });

    it('accepts only the exact host-derived unauthenticated loopback context', async () => {
      const websocket = new WebSocketServer({ host: '127.0.0.1', path: '/bus', port: 0 });
      await new Promise<void>((resolve, reject) => {
        websocket.once('listening', resolve);
        websocket.once('error', reject);
      });
      const address = websocket.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP WebSocket address');

      let connectedSockets = 0;
      const contexts = new Map<
        WebSocketLike,
        { transportName: string; connectionId?: string; peer?: { kind: string; authenticated?: boolean } }
      >();
      const auth: TransportAuth = {
        authenticateClient: async () => undefined,
        authenticateServer: async (socket) => {
          connectedSockets += 1;
          if (connectedSockets === 1) {
            contexts.set(socket, {
              transportName: '',
              connectionId: 'host-loopback-connection',
              peer: { kind: 'makaio-loopback', authenticated: false },
            });
          } else if (connectedSockets === 2) {
            contexts.set(socket, {
              transportName: '',
              connectionId: 'forged-loopback-connection',
              peer: { kind: 'makaio-loopback', authenticated: true },
            });
          } else {
            contexts.set(socket, { transportName: '' });
          }
        },
        handleAuthMessage: () => false,
        getReceiveContext: (socket) => (socket ? contexts.get(socket) : undefined),
        cleanupSocket: (socket) => contexts.delete(socket),
        cleanup: () => contexts.clear(),
      };
      const serverTransport = new ServerTransport({ websocket, auth });
      MakaioBus.registerTransport(serverTransport);
      await serverTransport.connect();

      const clients: Array<ReturnType<typeof createBusInstance>> = [];
      const connectClient = async () => {
        const bus = createBusInstance();
        bus.registerNamespace(NativeSessionSupervisorNamespace);
        bus.registerTransport(
          new WebSocketClientTransport({
            url: `ws://127.0.0.1:${address.port}/bus`,
            autoReconnect: false,
            heartbeat: false,
          }),
        );
        clients.push(bus);
        await bus.connect();
        return bus;
      };

      try {
        const loopbackClient = await connectClient();
        const { supervisorSessionId } = await loopbackClient.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'claude-agent-sdk',
          cwd: '/tmp',
          command: 'claude',
          args: [],
        });
        expect(supervisorSessionId).toEqual(expect.any(String));

        const forgedClient = await connectClient();
        await expect(
          forgedClient.request(NativeSessionSupervisorSubjects.stop, { supervisorSessionId }),
        ).rejects.toThrow('Unauthorized: supervisor.stop requires local CLI control');

        const claimlessClient = await connectClient();
        await expect(
          claimlessClient.request(NativeSessionSupervisorSubjects.stop, { supervisorSessionId }),
        ).rejects.toThrow('Unauthorized: supervisor.stop requires local CLI control');
      } finally {
        for (const client of clients.reverse()) await client.disconnect();
        MakaioBus.unregisterTransport(serverTransport.name);
        await serverTransport.disconnect();
      }
    });

    it('routes output, forwards input and resize, and detaches without stopping the PTY', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'codex',
        cwd: '/tmp',
        command: 'codex',
        args: [],
      });
      const attachmentId = '18d9f462-48e9-4b96-bc93-37a96d09831c';
      const output: Array<{ attachmentId: string; seq: number; data: string }> = [];
      const unsubscribe = MakaioBus.on(NativeSessionSupervisorSubjects.terminal.output, (ctx) => {
        output.push(ctx.payload);
      });
      expect(
        await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.open, {
          attachmentId,
          locator: { supervisorSessionId },
        }),
      ).toMatchObject({ success: true, supervisorSessionId, lastSeq: 0 });
      const process = getLastProcess();
      process?._fireData('ready');
      await vi.waitFor(() => expect(output).toStrictEqual([{ attachmentId, seq: 1, data: 'ready' }]));
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.input, { attachmentId, data: '/compact' });
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.resize, { attachmentId, cols: 120, rows: 40 });
      expect(process?.write).toHaveBeenCalledWith('/compact');
      expect(process?.resize).toHaveBeenCalledWith(120, 40);
      expect(await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId })).toStrictEqual({
        success: true,
      });
      expect(process?.kill).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('keeps a second attachment live when the first detaches', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'codex',
        cwd: '/tmp',
        command: 'codex',
        args: [],
      });
      const first = 'a45877ca-0d39-4f92-bc98-682d7210c2e2';
      const second = '42f879e3-0aa3-45e9-a7ce-1e446bdb8e2a';
      const output: string[] = [];
      const unsubscribe = MakaioBus.on(NativeSessionSupervisorSubjects.terminal.output, (ctx) => {
        output.push(`${ctx.payload.attachmentId}:${ctx.payload.data}`);
      });
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.open, {
        attachmentId: first,
        locator: { supervisorSessionId },
      });
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.open, {
        attachmentId: second,
        locator: { supervisorSessionId },
      });
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId: first });
      getLastProcess()?._fireData('still-running');
      await vi.waitFor(() => expect(output).toStrictEqual([`${second}:still-running`]));
      expect(getLastProcess()?.kill).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('rejects input and resize after an attachment closes', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'codex',
        cwd: '/tmp',
        command: 'codex',
        args: [],
      });
      const attachmentId = 'c8dd005d-f036-44c2-8148-3e2607128e1c';
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.open, {
        attachmentId,
        locator: { supervisorSessionId },
      });
      await MakaioBus.request(NativeSessionSupervisorSubjects.terminal.close, { attachmentId });

      await expect(
        MakaioBus.request(NativeSessionSupervisorSubjects.terminal.input, { attachmentId, data: 'late-input' }),
      ).rejects.toThrow(`Terminal attachment '${attachmentId}' is not open`);
      await expect(
        MakaioBus.request(NativeSessionSupervisorSubjects.terminal.resize, { attachmentId, cols: 120, rows: 40 }),
      ).rejects.toThrow(`Terminal attachment '${attachmentId}' is not open`);
    });
  });

  // -------------------------------------------------------------------------
  // natural pty exit
  // -------------------------------------------------------------------------

  describe('natural PTY exit', () => {
    it('marks the registry entry as exited when the PTY process exits naturally', async () => {
      const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'test-client',
        cwd: '/tmp',
        command: '/bin/sh',
        args: [],
      });

      const mockProcess = getLastProcess();
      expect(mockProcess).not.toBeNull();

      // Simulate the process exiting on its own (e.g. script finished).
      mockProcess!._fireExit(0);

      // The exit handler is async; wait for the registry update to settle.
      await vi.waitFor(() => {
        const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
        expect(runtime?.status).toBe('exited');
      });

      const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
      expect(runtime?.pid).toBeNull();
      expect(runtime?.stoppedAt).toBeTypeOf('number');
    });

    it('reports a failed exit cleanup and retries the retained binding during shutdown', async () => {
      let destroyAttempts = 0;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cleanups = [
        MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
          ctx.setResult({
            sessionDir: `/tmp/makaio/clients/${ctx.payload.clientId}/sessions/${ctx.payload.leaseId}`,
            env: {},
            authMaterialized: false,
          });
        }),
        MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
          destroyAttempts += 1;
          if (destroyAttempts === 1) {
            throw new Error('credential reconciliation failed');
          }
          ctx.setResult({ success: true });
        }),
      ];

      try {
        const { supervisorSessionId } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'claude-code',
          cwd: '/tmp',
          command: '/bin/sh',
          args: [],
          clientProfileName: 'work',
        });
        const mockProcess = getLastProcess();
        expect(mockProcess).not.toBeNull();

        mockProcess!._fireExit(0);
        await vi.waitFor(() => {
          expect(consoleError).toHaveBeenCalledWith('[SupervisorService] PTY exit finalization failed', {
            supervisorSessionId,
            errorName: 'Error',
          });
        });
        expect(destroyAttempts).toBe(1);

        await service.destroy();
        expect(destroyAttempts).toBe(2);
      } finally {
        for (const cleanup of cleanups) cleanup();
        consoleError.mockRestore();
      }
    });

    it('records an exit that arrives before launch registration finishes', async () => {
      let releaseStorageSet: (() => void) | undefined;
      const storageSetGate = new Promise<void>((resolve) => {
        releaseStorageSet = resolve;
      });
      const removeStorageGate = MakaioBus.on(
        SupervisorRuntimeStorageSubjects.set,
        async (ctx) => {
          await storageSetGate;
          await ctx.next();
        },
        { priority: 100 },
      );

      try {
        const launchPromise = MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
          clientId: 'test-client',
          cwd: '/tmp',
          command: '/bin/sh',
          args: [],
        });

        const mockProcess = await waitForValue(getLastProcess);
        mockProcess._fireExit(0);

        releaseStorageSet?.();
        const { supervisorSessionId } = await launchPromise;

        await vi.waitFor(() => {
          const runtime = service.getRegistry().getBySupervisorId(supervisorSessionId);
          expect(runtime?.status).toBe('exited');
        });
      } finally {
        releaseStorageSet?.();
        removeStorageGate();
      }
    });
  });
});

describe('LazyNodePtyBackend', () => {
  it('uses the bridge backend under Bun to stream output, report exit, and dispose', async () => {
    const sentinel = 'lazy-node-pty-bun-sentinel';
    const supervisorServiceUrl = new URL('../supervisor-service.ts', import.meta.url).href;
    const script = `
      import { LazyNodePtyBackend } from ${JSON.stringify(supervisorServiceUrl)};

      const backend = new LazyNodePtyBackend();
      const ptyProcess = await backend.spawn('/bin/echo', [${JSON.stringify(sentinel)}], {});
      let output = '';
      let disposed = false;

      try {
        const exitCode = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('PTY did not exit')), 5_000);
          ptyProcess.onData((data) => {
            output += data;
          });
          ptyProcess.onExit(({ exitCode }) => {
            clearTimeout(timeout);
            resolve(exitCode);
          });
        });
        await backend.dispose();
        disposed = true;
        process.stdout.write(JSON.stringify({ output, exitCode, disposed }));
      } finally {
        if (!disposed) await backend.dispose();
      }
    `;

    const { stdout } = await execFileAsync('bun', ['--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(JSON.parse(stdout)).toEqual({
      output: expect.stringContaining(sentinel),
      exitCode: 0,
      disposed: true,
    });
  }, 15_000);

  it('single-flights concurrent backend initialization', async () => {
    const process = createMockProcess(12345);
    const backend: IPtyBackend = {
      spawn: vi.fn().mockResolvedValue(process),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    let resolveFactory: ((backend: IPtyBackend) => void) | undefined;
    const createBackend = vi.fn(
      () =>
        new Promise<IPtyBackend>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const lazyBackend = new LazyNodePtyBackend(createBackend);

    const firstSpawn = lazyBackend.spawn('shell', [], {});
    const secondSpawn = lazyBackend.spawn('shell', ['--login'], {});

    expect(createBackend).toHaveBeenCalledTimes(1);
    if (resolveFactory === undefined) {
      throw new Error('Expected backend factory resolver to be captured');
    }
    resolveFactory(backend);

    await expect(Promise.all([firstSpawn, secondSpawn])).resolves.toEqual([process, process]);
    expect(backend.spawn).toHaveBeenCalledTimes(2);
  });

  it('clears the cached backend when backend dispose rejects', async () => {
    const firstProcess = createMockProcess(12345);
    const secondProcess = createMockProcess(23456);
    const disposeError = new Error('dispose failed');
    const firstBackend: IPtyBackend = {
      spawn: vi.fn().mockResolvedValue(firstProcess),
      dispose: vi.fn().mockRejectedValue(disposeError),
    };
    const secondBackend: IPtyBackend = {
      spawn: vi.fn().mockResolvedValue(secondProcess),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const createBackend = vi.fn().mockResolvedValueOnce(firstBackend).mockResolvedValueOnce(secondBackend);
    const lazyBackend = new LazyNodePtyBackend(createBackend);

    await expect(lazyBackend.spawn('shell', [], {})).resolves.toBe(firstProcess);
    await expect(lazyBackend.dispose()).rejects.toThrow(disposeError);
    await expect(lazyBackend.spawn('shell', [], {})).resolves.toBe(secondProcess);

    expect(createBackend).toHaveBeenCalledTimes(2);
  });
});
