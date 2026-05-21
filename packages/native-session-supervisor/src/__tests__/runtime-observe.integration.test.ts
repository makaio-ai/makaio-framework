/**
 * Integration tests: supervisor emits `client.runtime.observe` on launch.
 *
 * Uses a real `MakaioBus`, real `RuntimeRegistry` backed by an in-memory
 * SQLite database, and a mock `IPtyBackend`. Verifies that the supervisor
 * emits `client.runtime.observe` with the correct evidence fields and that
 * the fire-and-forget semantics mean launch succeeds even when no handler
 * is registered for the observation subject.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts/native-session-supervisor';
import { ClientSubjects, type ClientRuntimeObserveRequest } from '@makaio/contracts';
import { SupervisorService } from '../supervisor-service.js';
import type { PtyRuntimeFactory } from '../supervisor-service.js';
import { PtyRuntime } from '../pty/pty-runtime.js';
import { registerDrizzleSupervisorRuntimeStorage } from '../storage/drizzle-handler.js';
import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from '../pty/types.js';
import { createTestDb } from './helpers/create-test-db.js';

// ---------------------------------------------------------------------------
// Mock PTY backend (minimal — we only need spawn to succeed)
// ---------------------------------------------------------------------------

let nextPid = 20000;

/**
 * Build a minimal mock `IPtyBackend` that returns a fixed pid per spawn.
 * @returns A backend and the pid it will assign on next spawn.
 */
function createMockBackend(): { backend: IPtyBackend } {
  const backend: IPtyBackend = {
    spawn: (_file: string, _args: string[], _options: IPtySpawnOptions): Promise<IPtyProcess> => {
      const pid = nextPid++;
      const process: IPtyProcess = {
        pid,
        process: 'mock',
        cols: 80,
        rows: 24,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
      };
      return Promise.resolve(process);
    },
  };
  return { backend };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('SupervisorService — client.runtime.observe on launch', () => {
  let db: MakaioDatabase;
  let dbClose: () => void;
  let storageCleanup: (() => void) | undefined;
  let service: SupervisorService;
  let runtimeObserveCleanups: Array<() => void>;

  beforeEach(async () => {
    runtimeObserveCleanups = [];
    ({ db, close: dbClose } = await createTestDb());
    storageCleanup = registerDrizzleSupervisorRuntimeStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));

    const { backend } = createMockBackend();
    const factory: PtyRuntimeFactory = (handlers) => new PtyRuntime(backend, handlers);

    service = new SupervisorService(MakaioBus, factory);
    await service.init();
  });

  afterEach(async () => {
    for (const cleanup of runtimeObserveCleanups.splice(0).reverse()) {
      cleanup();
    }
    await service.destroy();
    storageCleanup?.();
    dbClose();
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Register a standard `client.runtime.observe` handler that captures
   * incoming payloads and immediately acknowledges the observation.
   * @param captured - Array to push each received {@link ClientRuntimeObserveRequest} into.
   * @param cleanups - Cleanup array that receives the handler's unsubscribe
   *   function, so `afterEach` can tear it down.
   */
  function registerObserveCapture(captured: ClientRuntimeObserveRequest[], cleanups: Array<() => void>): void {
    cleanups.push(
      MakaioBus.on(ClientSubjects.runtime.observe, async (ctx) => {
        captured.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'test-runtime-id', created: true, promoted: false });
        await ctx.next();
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it('emits client.runtime.observe with source.layer = supervisor and correct producer', async () => {
    const captured: ClientRuntimeObserveRequest[] = [];

    registerObserveCapture(captured, runtimeObserveCleanups);

    await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
      clientId: 'claude-code',
      cwd: '/home/user',
      command: '/bin/bash',
      args: [],
    });

    // Fire-and-forget — allow microtasks to flush.
    await vi.waitFor(() => expect(captured).toHaveLength(1));

    expect(captured[0]?.source.layer).toBe('supervisor');
    expect(captured[0]?.source.producer).toBe('native-session-supervisor');
  });

  it('forwards all hard-evidence fields: supervisorSessionId, pid, clientId', async () => {
    const captured: ClientRuntimeObserveRequest[] = [];

    registerObserveCapture(captured, runtimeObserveCleanups);

    const { supervisorSessionId, pid } = await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
      clientId: 'my-client',
      cwd: '/tmp',
      command: '/bin/sh',
      args: [],
    });

    await vi.waitFor(() => expect(captured).toHaveLength(1));

    const obs = captured[0];
    expect(obs?.clientId).toBe('my-client');
    expect(obs?.supervisorSessionId).toBe(supervisorSessionId);
    expect(obs?.pid).toBe(pid);
  });

  it('forwards optional sessionId and adapterSessionId when provided', async () => {
    const captured: ClientRuntimeObserveRequest[] = [];

    registerObserveCapture(captured, runtimeObserveCleanups);

    await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
      clientId: 'test-client',
      cwd: '/tmp',
      command: '/bin/sh',
      args: [],
      sessionId: 'sess-123',
      adapterSessionId: 'adp-456',
    });

    await vi.waitFor(() => expect(captured).toHaveLength(1));

    expect(captured[0]?.sessionId).toBe('sess-123');
    expect(captured[0]?.adapterSessionId).toBe('adp-456');
  });

  it('launch succeeds even when no handler is registered for client.runtime.observe', async () => {
    // No handler registered: the optional runtime observation remains
    // fire-and-forget and must not reject the launch request.
    await expect(
      MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
        clientId: 'claude-code',
        cwd: '/home/user',
        command: '/bin/bash',
        args: [],
      }),
    ).resolves.toMatchObject({
      supervisorSessionId: expect.any(String),
      pid: expect.any(Number),
    });
  });

  it('observation call does not block the launch response', async () => {
    // Install a slow observe handler to verify the launch response is not
    // delayed by the fire-and-forget observation.
    let observeResolved = false;

    runtimeObserveCleanups.push(
      MakaioBus.on(ClientSubjects.runtime.observe, async (ctx) => {
        // Simulate a slow handler with a short delay.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        observeResolved = true;
        ctx.setResult({ clientRuntimeId: 'test-runtime-id', created: true, promoted: false });
        await ctx.next();
      }),
    );

    await MakaioBus.request(NativeSessionSupervisorSubjects.launch, {
      clientId: 'claude-code',
      cwd: '/home/user',
      command: '/bin/bash',
      args: [],
    });

    // The launch must resolve before the slow observe handler finishes.
    expect(observeResolved).toBe(false);

    // Wait for the background observation to complete before teardown.
    await vi.waitFor(() => expect(observeResolved).toBe(true));
  });
});
