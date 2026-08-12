import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  SubagentSubjects,
  SessionSubjects,
  AdapterSubjects,
  DEFAULT_CONSTRAINTS,
  type SubagentConstraints,
} from '@makaio/contracts';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { SubagentService } from '../subagent-service.js';
import { SessionStorageSubjects } from '../../session/storage/namespace.js';
import { registerSubagentSessionOrchestrationMocks } from './subagent-service.mocks.js';

/** Options for {@link withPeriodicSweepTest}. */
interface WithPeriodicSweepOptions {
  /** Which global timer function to spy on. */
  spy: 'setInterval' | 'clearInterval';
  /** Subagent execution constraints; defaults to {@link DEFAULT_CONSTRAINTS}. */
  constraints?: SubagentConstraints;
}

/**
 * Assertion callback passed to {@link withPeriodicSweepTest}.
 * @param spy - The timer spy (setInterval or clearInterval).
 * @param service - The initialized SubagentService instance.
 */
type WithPeriodicSweepCallback = (spy: MockInstance, service: SubagentService) => void | Promise<void>;

describe('SubagentService — hung detection and adapter session close', () => {
  let service: SubagentService;
  const resetBusHandlersOrThrow = (): void => {
    if (!MakaioBus.__resetHandlers) {
      throw new Error('MakaioBus.__resetHandlers is required for test isolation');
    }
    MakaioBus.__resetHandlers();
  };
  /**
   * Emit an adapter session closed event for testing.
   * @param sessionId - ID of the session to emit closed event for
   */
  const emitSessionClosed = async (sessionId: string): Promise<void> => {
    await MakaioBus.emit(AdapterSubjects.session.closed, {
      agentId: 'mock-agent',
      sessionId,
      adapterSessionId: 'adapter-session-1',
      adapterId: 'default',
      adapterName: 'claude-code',
    });
  };

  beforeEach(() => {
    resetBusHandlersOrThrow();
    service = new SubagentService(MakaioBus);
    MakaioBus.on(SessionStorageSubjects.get, (ctx) => {
      ctx.setResult({
        session: {
          sessionId: ctx.payload.sessionId,
          createdAt: 0,
          lastActivityAt: 0,
          status: 'active',
          agents: [],
        },
      });
    });
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    });
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({
        executionTarget: {
          id: 'system:local',
          name: 'Local',
          description: 'Default local process execution',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });
  });

  afterEach(() => {
    service.destroy();
  });

  /**
   * Spawns sub-1 through the execute RPC and wires up session + adapter mocks.
   * @returns The child sessionId assigned during spawn
   */
  async function spawnSub1(): Promise<string> {
    MakaioBus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-sess-1' });
    });
    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: 'default',
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'child-sess-1',
        messageId: 'msg-1',
      });
    });
    registerSubagentSessionOrchestrationMocks(MakaioBus);
    await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-1',
      parentSessionId: 'parent-1',
      task: 'Test task',
      config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
      depth: 1,
    });
    return 'child-sess-1';
  }

  describe('adapter.session.closed detection', () => {
    it('transitions active subagent to failed when its child session closes', async () => {
      await service.init();
      await spawnSub1();

      // Emit adapter session closed for the child session
      await emitSessionClosed('child-sess-1');

      // Sub-1 should now be failed
      const status = await MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-1' });
      expect(status.status).toBe('failed');
      expect(status.error).toBe('adapter-session-closed');
    });

    it('ignores adapter session closed events for unknown session IDs', async () => {
      await service.init();
      await spawnSub1();

      // Emit closed for a session that is not tracked
      await emitSessionClosed('unknown-session-999');

      // Sub-1 should remain running, not affected
      const status = await MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-1' });
      expect(status.status).toBe('running');
    });

    it('resolves awaiters when child adapter session closes', async () => {
      await service.init();
      await spawnSub1();

      const awaiterPromise = MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-1',
        timeoutMs: 5_000,
      });

      // Close the child adapter session
      await emitSessionClosed('child-sess-1');

      const result = await awaiterPromise;
      expect(result.status).toBe('failed');
      expect(result.error).toBe('adapter-session-closed');
    });
  });

  /**
   * Run a periodic sweep test with automatic lifecycle management.
   *
   * Spies on the specified global timer function, creates a SubagentService
   * with the given constraints, calls init(), invokes the callback for
   * assertions, then ensures destroy() and spy restoration in a finally block.
   * @param options - Test configuration. `spy` selects the timer function to
   *   spy on ('setInterval' or 'clearInterval'); `constraints` overrides the
   *   SubagentService constraints (defaults to DEFAULT_CONSTRAINTS).
   * @param callback - Assertion callback receiving the spy and service
   */
  async function withPeriodicSweepTest(
    options: WithPeriodicSweepOptions,
    callback: WithPeriodicSweepCallback,
  ): Promise<void> {
    const timerSpy = vi.spyOn(globalThis, options.spy);
    const svc = new SubagentService(MakaioBus, options.constraints ?? DEFAULT_CONSTRAINTS);
    try {
      await svc.init();
      await callback(timerSpy, svc);
    } finally {
      try {
        if (svc.initialized) {
          svc.destroy();
        }
      } finally {
        timerSpy.mockRestore();
      }
    }
  }

  describe('periodic sweep', () => {
    it('always starts a timer so cleanup can run even when inactivityTimeoutMs is 0', async () => {
      // DEFAULT_CONSTRAINTS has inactivityTimeoutMs: 0 — sweepHung is a no-op but cleanup still runs via interval.
      // sweepIntervalMs defaults to 60_000 (positive), so wirePeriodicSweep registers the timer.
      await withPeriodicSweepTest({ spy: 'setInterval' }, (spy) => {
        expect(spy).toHaveBeenCalled();
      });
    });

    it('sweep interval is cleared on destroy (no timer leak)', async () => {
      await withPeriodicSweepTest(
        {
          spy: 'clearInterval',
          constraints: {
            ...DEFAULT_CONSTRAINTS,
            inactivityTimeoutMs: 5_000,
            sweepIntervalMs: 60_000,
          },
        },
        async (spy, svc) => {
          await svc.destroy();
          expect(spy).toHaveBeenCalled();
        },
      );
    });

    it('does not register timer when sweepIntervalMs is non-positive', async () => {
      await withPeriodicSweepTest(
        { spy: 'setInterval', constraints: { ...DEFAULT_CONSTRAINTS, sweepIntervalMs: 0 } },
        (spy) => {
          expect(spy).not.toHaveBeenCalled();
        },
      );
    });
  });
});
