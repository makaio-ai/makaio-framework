import { describe, expect, it } from 'vitest';
import {
  createBusContext,
  createBusInstance,
  type BusBroadcastMessage,
  type BusMessage,
  type BusReceiveHandler,
  type BusRequestMessage,
  type BusTransport,
} from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import { WorkflowRunContextSchema, WorkflowSubjects } from '@makaio/contracts';
import { WorkflowNamespace } from '../namespace.js';
import {
  registerWorkflowStateHandlers,
  registerWorkflowStorageDelegationHandlers,
} from '../workflow-executor-handlers.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDbForBus, createWorkflowDefinition, createWorkflowExecution } from './shared.js';

/** Minimal transport fixture for injecting remote getRunContext requests. */
class StubTransport implements BusTransport {
  public readonly name = 'remote-workflow';
  public readonly messages: BusMessage[] = [];
  private handler?: BusReceiveHandler;

  public send(message: BusRequestMessage): Promise<unknown>;
  public send(message: BusBroadcastMessage): Promise<Array<{ nodeId: string; payload: unknown }>>;
  public send(message: BusMessage): Promise<unknown | boolean | Array<{ nodeId: string; payload: unknown }>>;
  public send(message: BusMessage): Promise<unknown | boolean | Array<{ nodeId: string; payload: unknown }>> {
    if (message.type !== 'subscribe-sync-complete') this.messages.push(message);
    if (message.type === 'broadcast') return Promise.resolve([]);
    return Promise.resolve(true);
  }

  public onReceive(handler: BusReceiveHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async subscribe(): Promise<void> {}
  public async unsubscribe(): Promise<void> {}

  /**
   * Inject a remote request with trusted receive context.
   * @param executionId - Requested workflow execution id.
   * @param context - Transport receive context for the remote caller.
   */
  public async requestRunContext(executionId: string, context: TransportReceiveContext): Promise<void> {
    await this.handler?.(
      {
        type: 'request',
        namespace: WorkflowSubjects.getRunContext.$meta.namespace,
        subject: WorkflowSubjects.getRunContext.subject as string,
        payload: { executionId },
        correlationId: `corr-${executionId}`,
        messageId: `msg-${executionId}`,
      },
      context,
    );
  }

  /**
   * Inject a remote request against the internal storage subject.
   * @param executionId - Requested workflow execution id.
   * @param context - Transport receive context for the remote caller.
   */
  public async requestStorageRunContext(executionId: string, context: TransportReceiveContext): Promise<void> {
    await this.handler?.(
      {
        type: 'request',
        namespace: WorkflowStorageSubjects.getRunContext.$meta.namespace,
        subject: WorkflowStorageSubjects.getRunContext.subject as string,
        payload: { executionId },
        correlationId: `storage-corr-${executionId}`,
        messageId: `storage-msg-${executionId}`,
      },
      context,
    );
  }

  /**
   * Inject a remote workflow.state.get request.
   * @param executionId - Requested workflow execution id.
   * @param context - Transport receive context for the remote caller.
   */
  public async requestStateGet(executionId: string, context: TransportReceiveContext): Promise<void> {
    await this.handler?.(
      {
        type: 'request',
        namespace: WorkflowSubjects.state.get.$meta.namespace,
        subject: WorkflowSubjects.state.get.subject as string,
        payload: { executionId },
        correlationId: `state-get-corr-${executionId}`,
        messageId: `state-get-msg-${executionId}`,
      },
      context,
    );
  }

  /**
   * Inject a remote workflow.state.patch request.
   * @param executionId - Requested workflow execution id.
   * @param context - Transport receive context for the remote caller.
   */
  public async requestStatePatch(executionId: string, context: TransportReceiveContext): Promise<void> {
    await this.handler?.(
      {
        type: 'request',
        namespace: WorkflowSubjects.state.patch.$meta.namespace,
        subject: WorkflowSubjects.state.patch.subject as string,
        payload: {
          executionId,
          expectedSequence: 0,
          patch: [{ op: 'replace', path: '/count', value: 1 }],
          nextValue: { count: 1 },
        },
        correlationId: `state-patch-corr-${executionId}`,
        messageId: `state-patch-msg-${executionId}`,
      },
      context,
    );
  }

  /**
   * Inject a remote external-execution settlement request.
   * @param executionId - External execution identifier to settle.
   * @param context - Transport receive context for the remote caller.
   */
  public async requestExternalCompletion(executionId: string, context: TransportReceiveContext): Promise<void> {
    await this.handler?.(
      {
        type: 'request',
        namespace: WorkflowSubjects.completeExternalExecution.$meta.namespace,
        subject: WorkflowSubjects.completeExternalExecution.subject as string,
        payload: { executionId, status: 'completed', completedAt: 1_250 },
        correlationId: `external-complete-corr-${executionId}`,
        messageId: `external-complete-msg-${executionId}`,
      },
      context,
    );
  }
}

const runContext = WorkflowRunContextSchema.parse({
  executionId: 'wfx-authorized',
  workflowId: 'wf-auth',
  source: { kind: 'definition', workflowId: 'wf-auth' },
  definitionSnapshot: {
    id: 'wf-auth',
    name: 'Auth Test Workflow',
    root: { id: 'wf-auth__root', type: 'sequence', nodes: [] },
    scope: { type: 'global' },
    createdAt: 1,
    updatedAt: 1,
  },
  workerManifest: { packages: [] },
  inputs: {},
  scope: { type: 'global' },
  triggerPayload: {},
  coordinatorSessionId: 'session-auth',
  cancelSubject: 'workflow.wfx-authorized.cancel',
  context: { repoPath: '/workspace', makaioHome: '/tmp/makaio', os: 'linux', arch: 'arm64' },
  env: {},
  createdAt: 1,
});

/**
 * Create a bus with the workflow namespaces registered so local-subject routing
 * matches real host boot behavior.
 * @returns Registered test bus.
 */
function createWorkflowTestBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  return bus;
}

describe('workflow.getRunContext authorization', () => {
  it('allows local callers', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));

    await expect(bus.request(WorkflowSubjects.getRunContext, { executionId: runContext.executionId })).resolves.toEqual(
      runContext,
    );
  });

  it('allows authenticated workflow execution peers for their own execution', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'workflow-execution', id: runContext.executionId, authenticated: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      result: runContext,
    });
  });

  it('allows encrypted relay peers bound to their own execution identity', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'e2e', id: runContext.executionId, authenticated: true, encrypted: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      result: runContext,
    });
  });

  it('denies encrypted peers that are not bound to the requested execution', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'machine', id: 'machine-1', authenticated: true, encrypted: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('Unauthorized') },
    });
  });

  it('denies relay peers for a different execution', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'e2e', id: 'wfx-other', authenticated: true, encrypted: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('Unauthorized') },
    });
  });

  it('denies workflow execution peers for a different execution', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'workflow-execution', id: 'wfx-other', authenticated: true, encrypted: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('Unauthorized') },
    });
  });

  it('does not expose internal run-context storage reads to remote peers', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestStorageRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'workflow-execution', id: runContext.executionId, authenticated: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `storage-corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('local-only') },
    });
  });
});

describe('workflow.completeExternalExecution authorization', () => {
  it('allows an authenticated workflow peer bound to the external execution', async () => {
    const bus = createWorkflowTestBus();
    const dbContext = await createTestDbForBus(bus);
    const cleanups = registerWorkflowStorageDelegationHandlers(bus);
    const executionId = 'wfx-ext-authorized-completion';

    try {
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'authorized-external-completion',
        startedAt: 1_000,
      });
      const transport = new StubTransport();
      bus.registerTransport(transport);
      await transport.requestExternalCompletion(executionId, {
        transportName: 'remote-workflow',
        peer: { kind: 'workflow-execution', id: executionId, authenticated: true },
      });

      expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
        type: 'response',
        correlationId: `external-complete-corr-${executionId}`,
        result: { success: true },
      });
      await expect(bus.request(WorkflowSubjects.getExecution, { executionId })).resolves.toMatchObject({
        execution: { status: 'completed', completedAt: 1_250 },
      });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      dbContext.cleanup();
    }
  });

  it('denies a remote peer that is not bound to the external execution', async () => {
    const bus = createWorkflowTestBus();
    const dbContext = await createTestDbForBus(bus);
    const cleanups = registerWorkflowStorageDelegationHandlers(bus);
    const executionId = 'wfx-ext-unauthorized-completion';

    try {
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'unauthorized-external-completion',
        startedAt: 1_000,
      });
      const transport = new StubTransport();
      bus.registerTransport(transport);
      await transport.requestExternalCompletion(executionId, {
        transportName: 'remote-workflow',
        peer: { kind: 'workflow-execution', id: 'wfx-ext-other-execution', authenticated: true },
      });

      expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
        type: 'response',
        correlationId: `external-complete-corr-${executionId}`,
        error: { message: expect.stringContaining('Unauthorized') },
      });
      await expect(bus.request(WorkflowSubjects.getExecution, { executionId })).resolves.toMatchObject({
        execution: { status: 'running', completedAt: undefined },
      });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      dbContext.cleanup();
    }
  });
});

describe('workflow state authorization', () => {
  it('denies remote state reads and writes from peers bound to a different execution', async () => {
    const bus = createWorkflowTestBus();
    const dbContext = await createTestDbForBus(bus);
    const cleanups = [...registerWorkflowStorageDelegationHandlers(bus), ...registerWorkflowStateHandlers(bus)];
    const workflow = {
      ...createWorkflowDefinition({ id: 'wf-state-auth' }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    };
    const execution = createWorkflowExecution({ id: 'wfx-state-auth', workflowId: workflow.id });
    const runContextForState = WorkflowRunContextSchema.parse({
      ...runContext,
      executionId: execution.id,
      workflowId: workflow.id,
      definitionSnapshot: workflow,
      cancelSubject: `workflow.${execution.id}.cancel`,
    });

    try {
      await bus.request(WorkflowStorageSubjects.set, { workflow });
      await bus.request(WorkflowStorageSubjects.setExecution, { execution });
      await bus.request(WorkflowStorageSubjects.setRunContext, { runContext: runContextForState });
      await bus.request(WorkflowStorageSubjects.initializeState, {
        executionId: execution.id,
        initialValue: workflow.state.initial,
      });

      const transport = new StubTransport();
      bus.registerTransport(transport);
      const remoteContext: TransportReceiveContext = {
        transportName: 'remote-workflow',
        peer: { kind: 'workflow-execution', id: 'wfx-other', authenticated: true },
      };

      await transport.requestStateGet(execution.id, remoteContext);
      await transport.requestStatePatch(execution.id, remoteContext);

      expect(
        transport.messages.find(
          (message) => message.type === 'response' && message.correlationId === `state-get-corr-${execution.id}`,
        ),
      ).toMatchObject({
        type: 'response',
        error: { message: expect.stringContaining('Unauthorized') },
      });
      expect(
        transport.messages.find(
          (message) => message.type === 'response' && message.correlationId === `state-patch-corr-${execution.id}`,
        ),
      ).toMatchObject({
        type: 'response',
        error: { message: expect.stringContaining('Unauthorized') },
      });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      dbContext.cleanup();
    }
  });
});
