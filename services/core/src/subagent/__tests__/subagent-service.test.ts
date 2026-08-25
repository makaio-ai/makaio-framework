// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 520 }] */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { DEFAULT_CONSTRAINTS, SessionSubjects, SubagentSubjects } from '@makaio/contracts';
import { SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

describe('SubagentService', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    mocks = setupSubagentServiceMocks(MakaioBus);
  });

  afterEach(() => {
    service.destroy();
  });

  /** Standard spawn event payload for 'sub-1'. */
  const SUB1_SPAWN = {
    subagentId: 'sub-1',
    parentSessionId: 'parent-1',
    task: 'Test task',
    config: {
      task: 'Test task',
      adapterName: 'claude-code',
      contextMode: 'fork' as const,
    },
    depth: 1,
  };

  /**
   * Collects executionFailed events from the bus.
   * @returns Array that fills as events arrive
   */
  function collectFailedEvents(): unknown[] {
    const events: unknown[] = [];
    MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
      events.push(ctx.payload);
    });
    return events;
  }

  type StartAgentHandler = Parameters<SubagentServiceMockController['setStartAgentHandler']>[0];
  type StartAgentContext = Parameters<StartAgentHandler>[0];
  type StartAgentResponse = Parameters<StartAgentContext['setResult']>[0];
  type StartAgentSuccessResponse = Extract<StartAgentResponse, { success: true }>;

  function setMockStartAgentSuccess(overrides?: (ctx: StartAgentContext) => Partial<StartAgentSuccessResponse>): void {
    mocks.setStartAgentHandler((ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: 'default',
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'child-1',
        messageId: 'msg-1',
        ...(overrides?.(ctx) ?? {}),
      });
    });
  }

  describe('execution flow', () => {
    it('executes only spawned events owned by this service while preserving observability', async () => {
      await service.destroy();
      service = new SubagentService(MakaioBus, DEFAULT_CONSTRAINTS, new Set(), 0, 'owner-local');
      await service.init();

      const observedOwners: Array<string | undefined> = [];
      const sessionCreateCalls: unknown[] = [];
      MakaioBus.on(SubagentSubjects.spawned, (ctx) => {
        observedOwners.push(ctx.payload.executionOwnerId);
      });
      MakaioBus.on(SessionSubjects.create, (ctx) => {
        sessionCreateCalls.push(ctx.payload);
        ctx.setResult({ sessionId: 'child-1' });
      });
      setMockStartAgentSuccess();

      await MakaioBus.emit(SubagentSubjects.spawned, { ...SUB1_SPAWN, executionOwnerId: 'owner-remote' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionCreateCalls).toHaveLength(0);
      expect(observedOwners).toEqual(['owner-remote']);

      await MakaioBus.emit(SubagentSubjects.spawned, { ...SUB1_SPAWN, executionOwnerId: 'owner-local' });
      await vi.waitFor(() => expect(sessionCreateCalls).toHaveLength(1));
      expect(observedOwners).toEqual(['owner-remote', 'owner-local']);
    });

    it('single-flights concurrent matching-owner spawned event echoes', async () => {
      await service.destroy();
      service = new SubagentService(MakaioBus, DEFAULT_CONSTRAINTS, new Set(), 0, 'owner-local');
      await service.init();

      const sessionCreateCalls: unknown[] = [];
      const adapterStartCalls: unknown[] = [];
      let releaseSessionCreate: (() => void) | undefined;
      const sessionCreateGate = new Promise<void>((resolve) => {
        releaseSessionCreate = resolve;
      });
      MakaioBus.on(SessionSubjects.create, async (ctx) => {
        sessionCreateCalls.push(ctx.payload);
        await sessionCreateGate;
        ctx.setResult({ sessionId: 'child-1' });
      });
      setMockStartAgentSuccess((ctx) => {
        adapterStartCalls.push(ctx.payload);
        return {};
      });

      const echo = { ...SUB1_SPAWN, executionOwnerId: 'owner-local' };
      await Promise.all([
        MakaioBus.emit(SubagentSubjects.spawned, echo),
        MakaioBus.emit(SubagentSubjects.spawned, echo),
      ]);
      await vi.waitFor(() => expect(sessionCreateCalls).toHaveLength(1));
      releaseSessionCreate?.();
      await vi.waitFor(() => expect(adapterStartCalls).toHaveLength(1));

      await MakaioBus.emit(SubagentSubjects.spawned, echo);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionCreateCalls).toHaveLength(1);
      expect(adapterStartCalls).toHaveLength(1);
    });

    it('creates child session when spawned event received', async () => {
      await service.init();

      const sessionCreateCalls: unknown[] = [];
      MakaioBus.on(SessionSubjects.create, (ctx) => {
        sessionCreateCalls.push(ctx.payload);
        ctx.setResult({ sessionId: 'child-1' });
      });

      setMockStartAgentSuccess();

      await MakaioBus.emit(SubagentSubjects.spawned, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Test task',
        config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
        depth: 1,
      });

      await vi.waitFor(() => expect(sessionCreateCalls).toHaveLength(1));

      expect(sessionCreateCalls[0]).toMatchObject({
        parentSessionId: 'parent-1',
        branchKind: 'subagent',
      });
    });

    it('starts adapter after session creation', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, (ctx) => {
        ctx.setResult({ sessionId: 'child-1' });
      });

      const adapterStartCalls: unknown[] = [];
      setMockStartAgentSuccess((ctx) => {
        adapterStartCalls.push(ctx.payload);
        return { adapterId: 'claude-code' };
      });

      await MakaioBus.emit(SubagentSubjects.spawned, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Do something',
        config: {
          task: 'Do something',
          adapterName: 'claude-code',
          model: 'sonnet',
          reasoningEffort: 'high',
          tools: ['read_file', 'run_tests'],
          disallowedTools: ['delete_file'],
          allowedDirectories: ['/workspace/project'],
          contextMode: 'fork',
        },
        depth: 1,
      });

      await vi.waitFor(() => expect(adapterStartCalls).toHaveLength(1));

      expect(adapterStartCalls[0]).toMatchObject({
        adapterId: 'resolved-claude-code',
        sessionId: 'child-1',
        model: 'sonnet',
        reasoningEffort: 'high',
        allowedTools: ['read_file', 'run_tests'],
        disallowedTools: ['delete_file'],
        allowedDirectories: ['/workspace/project'],
      });
    });

    it('delegates adapter resolution to the session attach boundary', async () => {
      service.destroy();
      MakaioBus.__resetHandlers?.();
      service = new SubagentService(MakaioBus);
      let resolvePayload: { adapterName?: string; machineId?: string } | undefined;
      mocks = setupSubagentServiceMocks(MakaioBus, {
        onResolveIdPayload: (payload) => {
          resolvePayload = payload;
        },
      });
      await service.init();

      MakaioBus.on(SessionSubjects.create, (ctx) => {
        ctx.setResult({ sessionId: 'child-1' });
      });
      setMockStartAgentSuccess((ctx) => ({ adapterId: String(ctx.payload.adapterId) }));

      await MakaioBus.emit(SubagentSubjects.spawned, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Do something',
        config: {
          task: 'Do something',
          adapterName: 'claude-code',
          contextMode: 'fork',
        },
        depth: 1,
      });

      await vi.waitFor(() => expect(resolvePayload).toBeDefined());
      expect(resolvePayload).toMatchObject({
        adapterName: 'claude-code',
      });
    });

    it('forwards harnessId from subagent config to adapter start', async () => {
      await service.init();
      MakaioBus.on(SessionSubjects.create, (ctx) => ctx.setResult({ sessionId: 'child-1' }));
      const adapterStartCalls: unknown[] = [];
      setMockStartAgentSuccess((ctx) => {
        adapterStartCalls.push(ctx.payload);
        return {};
      });
      await MakaioBus.emit(SubagentSubjects.spawned, {
        ...SUB1_SPAWN,
        task: 'review changes',
        config: {
          task: 'review changes',
          adapterName: 'claude-code',
          contextMode: 'fork',
          harnessId: 'harness-qa-reviewer',
        },
      });
      await vi.waitFor(() => expect(adapterStartCalls).toHaveLength(1));
      expect(adapterStartCalls[0]).toMatchObject({ harnessId: 'harness-qa-reviewer' });
    });

    it('emits executionFailed when session creation fails', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, () => {
        throw new Error('Session creation failed');
      });

      const failedEvents = collectFailedEvents();
      await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

      await vi.waitFor(() => expect(failedEvents).toHaveLength(1));

      expect(failedEvents[0]).toMatchObject({
        subagentId: 'sub-1',
        phase: 'session_create',
        error: expect.stringContaining('Session creation failed'),
      });
    });

    it('emits executionFailed when adapter start fails', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, (ctx) => {
        ctx.setResult({ sessionId: 'child-1' });
      });

      mocks.setStartAgentHandler(() => {
        throw new Error('Adapter start failed');
      });

      const failedEvents = collectFailedEvents();
      await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

      await vi.waitFor(() => expect(failedEvents).toHaveLength(1));

      expect(failedEvents[0]).toMatchObject({
        subagentId: 'sub-1',
        phase: 'adapter_start',
        error: expect.stringContaining('Adapter start failed'),
      });
    });

    it('emits executionFailed when adapterName is missing before session creation', async () => {
      await service.init();

      const sessionCreateCalls: unknown[] = [];
      MakaioBus.on(SessionSubjects.create, (ctx) => {
        sessionCreateCalls.push(ctx.payload);
        ctx.setResult({ sessionId: 'child-1' });
      });

      const failedEvents = collectFailedEvents();
      await MakaioBus.emit(SubagentSubjects.spawned, {
        ...SUB1_SPAWN,
        config: { task: 'Test task', contextMode: 'fork' },
      });

      await vi.waitFor(() => expect(failedEvents).toHaveLength(1));
      expect(sessionCreateCalls).toHaveLength(0);
      expect(failedEvents[0]).toMatchObject({
        subagentId: 'sub-1',
        phase: 'adapter_start',
        error: expect.stringContaining('adapterName'),
      });
    });
  });

  describe('manager ownership', () => {
    it('manager is private - tools interact via RPCs', async () => {
      // Manager is no longer exposed - tools use spawn/await/kill RPCs
      // @ts-expect-error - intentionally checking manager is not public
      expect(service.manager).toBeDefined();
      // The manager exists but is private - this test verifies the architectural change
    });
  });

  describe('execute RPC', () => {
    it('returns success: true when execution succeeds', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, (ctx) => {
        ctx.setResult({ sessionId: 'child-1' });
      });

      setMockStartAgentSuccess();

      const result = await MakaioBus.request(SubagentSubjects.execute, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Test task',
        config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
        depth: 1,
      });

      expect(result).toMatchObject({ success: true });
    });

    it('returns success: false when session creation fails', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, () => {
        throw new Error('Session creation failed');
      });

      const result = await MakaioBus.request(SubagentSubjects.execute, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Test task',
        config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
        depth: 1,
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Session creation failed'),
      });
    });

    it('returns success: false when adapter start fails', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, (ctx) => {
        ctx.setResult({ sessionId: 'child-1' });
      });

      mocks.setStartAgentHandler(() => {
        throw new Error('Adapter start failed');
      });

      const result = await MakaioBus.request(SubagentSubjects.execute, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Test task',
        config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
        depth: 1,
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Adapter start failed'),
      });
    });
  });

  describe('adapter response handling', () => {
    it('emits executionFailed when adapter returns success: false', async () => {
      await service.init();

      MakaioBus.on(SessionSubjects.create, (ctx) => {
        ctx.setResult({ sessionId: 'child-1' });
      });

      // Return success: false instead of throwing
      mocks.setStartAgentHandler((ctx) => {
        ctx.setResult({
          success: false,
          message: 'Adapter rejected the request',
          dispatch: 'not-dispatched',
        });
      });

      const failedEvents: unknown[] = [];
      MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
        failedEvents.push(ctx.payload);
      });

      await MakaioBus.emit(SubagentSubjects.spawned, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Test task',
        config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
        depth: 1,
      });

      await vi.waitFor(() => expect(failedEvents).toHaveLength(1));

      expect(failedEvents[0]).toMatchObject({
        subagentId: 'sub-1',
        phase: 'adapter_start',
        error: expect.stringContaining('Adapter rejected'),
      });
    });
  });

  describe('lifecycle', () => {
    it('cleans up handlers on destroy', async () => {
      await service.init();

      // Set up handlers to track if they're called after destroy
      let spawncalled = false;
      const cleanup = MakaioBus.on(SessionSubjects.create, (ctx) => {
        spawncalled = true;
        ctx.setResult({ sessionId: 'test' });
      });

      service.destroy();
      cleanup();

      // After destroy, spawned events should not trigger session creation
      // (the service's handlers are removed)
      spawncalled = false;
      await MakaioBus.emit(SubagentSubjects.spawned, {
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        task: 'Test task',
        config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
        depth: 1,
      });

      // Give time for any async handlers
      await new Promise((r) => setTimeout(r, 10));

      // Session create should NOT have been called because the service's
      // spawned handler was cleaned up
      expect(spawncalled).toBe(false);
    });

    it('init is idempotent - can be called multiple times', async () => {
      await service.init();
      await service.init();
      await service.init();

      // Should not throw or cause issues
      expect(true).toBe(true);
    });

    it('destroy is idempotent - can be called multiple times', async () => {
      await service.init();
      service.destroy();
      service.destroy();
      service.destroy();

      // Should not throw or cause issues
      expect(true).toBe(true);
    });

    it('destroy before init is safe (idempotent)', async () => {
      const newService = new SubagentService(MakaioBus);
      newService.destroy();

      // Should not throw or cause issues
      expect(true).toBe(true);
    });
  });
});
