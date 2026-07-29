/**
 * Supervisor service integration tests.
 *
 * Uses a real `MakaioBus`, a real `RuntimeRegistry` backed by an in-memory
 * SQLite database, and a mock `IPtyBackend` to verify the four bus handlers
 * (`launch`, `attach`, `stop`, `status`) without spawning real processes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts/native-session-supervisor';
import { ClientSubjects } from '@makaio/contracts/client';
import { LazyNodePtyBackend, SupervisorService } from '../supervisor-service.js';
import type { PtyRuntimeFactory } from '../supervisor-service.js';
import { PtyRuntime } from '../pty/pty-runtime.js';
import { registerDrizzleSupervisorRuntimeStorage } from '../storage/drizzle-handler.js';
import { SupervisorRuntimeStorageSubjects } from '../storage/namespace.js';
import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from '../pty/types.js';
import { createTestDb } from './helpers/create-test-db.js';

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

    it('materializes a client profile into launch env when requested', async () => {
      let observedSessionConfigRequest: unknown;
      const cleanups = [
        MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
          observedSessionConfigRequest = ctx.payload;
          ctx.setResult({
            sessionDir: '/tmp/makaio/clients/claude-code/sessions/sess_profile',
            env: { CLAUDE_CONFIG_DIR: '/tmp/makaio/clients/claude-code/sessions/sess_profile' },
            authMaterialized: false,
          });
        }),
        // The lease this launch takes is released while its owner can still
        // answer, so the suite's teardown is not left holding one.
        MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => ctx.setResult({ success: true })),
      ];

      let launchedSupervisorSessionId: string;
      try {
        ({ supervisorSessionId: launchedSupervisorSessionId } = await MakaioBus.request(
          NativeSessionSupervisorSubjects.launch,
          {
            clientId: 'claude-code',
            cwd: '/home/user',
            command: '/bin/bash',
            args: [],
            env: { EXISTING: '1' },
            sessionId: 'sess_profile',
            clientProfileName: 'work',
          },
        ));

        await MakaioBus.request(NativeSessionSupervisorSubjects.stop, {
          supervisorSessionId: launchedSupervisorSessionId,
        });
      } finally {
        for (const cleanup of cleanups) cleanup();
      }

      expect(observedSessionConfigRequest).toEqual({
        clientId: 'claude-code',
        leaseId: launchedSupervisorSessionId,
        ownerSessionId: 'sess_profile',
        profileName: 'work',
      });
      expect(getLastSpawnOptions()?.env).toEqual({
        EXISTING: '1',
        CLAUDE_CONFIG_DIR: '/tmp/makaio/clients/claude-code/sessions/sess_profile',
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
