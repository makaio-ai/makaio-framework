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
import {
  createWorkflowDelegateResultFinalizerNamespace,
  WorkflowRunContextSchema,
  WorkflowSubjects,
} from '@makaio/contracts';
import { WorkflowNamespace } from '../namespace.js';
import {
  registerWorkflowStateHandlers,
  registerWorkflowStorageDelegationHandlers,
} from '../workflow-executor-handlers.js';
import { registerAuthorityStateBootstrapHandler } from '../authority-state-bootstrap.js';
import { registerDelegateResultFinalizationGateway } from '../delegate-result-finalization-gateway.js';
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

  /**
   * Inject a remote request against a supplied subject.
   * @param namespace - Bus namespace containing the subject.
   * @param subject - Subject name.
   * @param payload - Request payload.
   * @param correlationId - Correlation ID used to locate the response.
   * @param context - Transport receive context for the remote caller.
   */
  public async request(
    namespace: string,
    subject: string,
    payload: unknown,
    correlationId: string,
    context: TransportReceiveContext,
  ): Promise<void> {
    await this.handler?.(
      {
        type: 'request',
        namespace,
        subject,
        payload,
        correlationId,
        messageId: `message-${correlationId}`,
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
  workerManifest: { contributionRefs: [] },
  inputs: {},
  scope: { type: 'global' },
  triggerPayload: {},
  coordinatorSessionId: 'session-auth',
  cancelSubject: 'workflow.wfx-authorized.cancel',
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

  it('denies non-attempt direct peers even when their id matches the execution', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'test-identity', id: runContext.executionId, authenticated: true },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('Unauthorized') },
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

  it('allows authenticated attempt-scoped peers whose claims carry the execution id', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: {
        kind: 'workflow-execution-attempt',
        id: 'attempt-abc-123',
        authenticated: true,
        claims: { executionId: runContext.executionId },
      },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      result: runContext,
    });
  });

  it('denies attempt-scoped peers whose claims carry a different execution id', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: {
        kind: 'workflow-execution-attempt',
        id: 'attempt-wrong',
        authenticated: true,
        claims: { executionId: 'wfx-other' },
      },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('Unauthorized') },
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

  it('denies attempt-scoped peers without an Authority-issued execution claim', async () => {
    const bus = createWorkflowTestBus();
    registerWorkflowStorageDelegationHandlers(bus);
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext }));
    const transport = new StubTransport();
    bus.registerTransport(transport);

    await transport.requestRunContext(runContext.executionId, {
      transportName: 'remote-workflow',
      peer: { kind: 'workflow-execution-attempt', id: 'attempt-without-claim', authenticated: true },
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
      peer: {
        kind: 'workflow-execution-attempt',
        id: 'attempt-storage-direct-read',
        authenticated: true,
        claims: { executionId: runContext.executionId },
      },
    });

    expect(transport.messages.find((message) => message.type === 'response')).toMatchObject({
      type: 'response',
      correlationId: `storage-corr-${runContext.executionId}`,
      error: { message: expect.stringContaining('local-only') },
    });
  });
});

describe('workflow.finalizeDelegateResult authority gateway', () => {
  async function requestFinalization(input: {
    readonly peer: TransportReceiveContext['peer'];
    readonly executionId?: string;
    readonly nodeId?: string;
    readonly nodeType?: 'delegate-agent' | 'delegate-role';
    readonly finalizerId?: string;
  }): Promise<BusMessage | undefined> {
    const bus = createWorkflowTestBus();
    const gatewayRunContext = WorkflowRunContextSchema.parse({
      ...runContext,
      definitionSnapshot: {
        ...runContext.definitionSnapshot!,
        root: {
          id: 'gateway-root',
          type: 'sequence',
          nodes: [
            {
              id: 'delegate-read',
              type: 'delegate-agent',
              agentId: 'repository-reader',
              inputExpression: '"Read"',
              resultFinalizerId: 'artifact.read-wrap',
            },
          ],
        },
      },
    });
    const finalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    bus.registerNamespace(finalizer.namespace);
    bus.on(WorkflowStorageSubjects.getExecution, (ctx) =>
      ctx.setResult({
        execution: createWorkflowExecution({ id: runContext.executionId, workflowId: runContext.workflowId }),
      }),
    );
    bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => ctx.setResult({ runContext: gatewayRunContext }));
    bus.on(finalizer.subjects.finalize, (ctx) => ctx.setResult({ output: { finalized: ctx.payload.rawResult } }));
    const cleanup = registerDelegateResultFinalizationGateway(bus);
    const transport = new StubTransport();
    bus.registerTransport(transport);
    const executionId = input.executionId ?? runContext.executionId;
    await transport.request(
      WorkflowSubjects.finalizeDelegateResult.$meta.namespace,
      WorkflowSubjects.finalizeDelegateResult.subject as string,
      {
        finalizerId: input.finalizerId ?? 'artifact.read-wrap',
        executionId,
        workflowId: runContext.workflowId,
        frameId: 'frame-1',
        nodeId: input.nodeId ?? 'delegate-read',
        nodeType: input.nodeType ?? 'delegate-agent',
        rawResult: 'raw',
        toolObservations: [],
      },
      `finalize-${executionId}`,
      { transportName: 'remote-workflow', peer: input.peer },
    );
    cleanup();
    return transport.messages.find((message) => message.type === 'response');
  }

  const allowedPeer = {
    kind: 'workflow-execution-attempt' as const,
    id: 'attempt-gateway',
    authenticated: true,
    claims: { executionId: runContext.executionId },
  };

  it('allows an authenticated attempt for its selected durable delegate finalizer', async () => {
    await expect(requestFinalization({ peer: allowedPeer })).resolves.toMatchObject({
      type: 'response',
      result: { output: { finalized: 'raw' } },
    });
  });

  it('rejects a different execution, delegate node, finalizer, or peer', async () => {
    for (const input of [
      { peer: allowedPeer, executionId: 'wfx-other' },
      { peer: allowedPeer, nodeId: 'other-node' },
      { peer: allowedPeer, finalizerId: 'artifact.write-wrap' },
      {
        peer: {
          kind: 'e2e' as const,
          id: runContext.executionId,
          authenticated: true,
          encrypted: true,
        },
      },
    ]) {
      await expect(requestFinalization(input)).resolves.toMatchObject({
        type: 'response',
        error: { message: expect.any(String) },
      });
    }
  });
});

describe('workflow.completeExternalExecution authorization', () => {
  it('allows an authenticated encrypted relay peer bound to the external execution', async () => {
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
        peer: { kind: 'e2e', id: executionId, authenticated: true, encrypted: true },
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
        peer: {
          kind: 'workflow-execution-attempt',
          id: 'attempt-external-completion',
          authenticated: true,
          claims: { executionId: 'wfx-ext-other-execution' },
        },
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
        peer: {
          kind: 'workflow-execution-attempt',
          id: 'attempt-state-other',
          authenticated: true,
          claims: { executionId: 'wfx-other' },
        },
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

describe('attempt-scoped raw workflow storage authorization', () => {
  const executionId = 'wfx-attempt-storage';
  const otherExecutionId = 'wfx-attempt-storage-other';
  const matchingAttemptContext: TransportReceiveContext = {
    transportName: 'remote-workflow',
    peer: {
      kind: 'workflow-execution-attempt',
      id: 'attempt-storage',
      authenticated: true,
      claims: { executionId },
    },
  };

  function storageRequests(targetExecutionId: string): ReadonlyArray<{
    readonly subject: (typeof WorkflowStorageSubjects)[keyof typeof WorkflowStorageSubjects];
    readonly payload: unknown;
  }> {
    return [
      { subject: WorkflowStorageSubjects.getExecution, payload: { executionId: targetExecutionId } },
      {
        subject: WorkflowStorageSubjects.setFrame,
        payload: {
          executionId: targetExecutionId,
          frame: {
            frameId: `frame-${targetExecutionId}`,
            nodeId: 'node-storage',
            nodeType: 'station',
            path: ['node-storage'],
            status: 'running',
            attempt: 0,
          },
        },
      },
      {
        subject: WorkflowStorageSubjects.setSpan,
        payload: {
          span: {
            executionId: targetExecutionId,
            frameId: `frame-${targetExecutionId}`,
            stepId: 'node-storage',
            stepType: 'station',
            status: 'running',
            startedAt: 1,
          },
        },
      },
      { subject: WorkflowStorageSubjects.listFrames, payload: { executionId: targetExecutionId } },
      {
        subject: WorkflowStorageSubjects.setGateInstance,
        payload: {
          gate: {
            executionId: targetExecutionId,
            nodeId: 'gate-storage',
            frameId: `gate-frame-${targetExecutionId}`,
            schema: {},
            status: 'waiting',
            autoAction: 'reject',
            timeoutMs: null,
            createdAt: 1,
          },
        },
      },
      {
        subject: WorkflowStorageSubjects.getGateInstance,
        payload: { executionId: targetExecutionId, nodeId: 'gate-storage' },
      },
    ];
  }

  it('allows an attempt identity to use every allowlisted raw storage operation for its execution', async () => {
    const bus = createWorkflowTestBus();
    const dbContext = await createTestDbForBus(bus);
    const transport = new StubTransport();
    bus.registerTransport(transport);

    try {
      await bus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({ id: executionId }),
      });

      for (const [index, request] of storageRequests(executionId).entries()) {
        const correlationId = `matching-storage-${index}`;
        await transport.request(
          request.subject.$meta.namespace,
          request.subject.subject as string,
          request.payload,
          correlationId,
          matchingAttemptContext,
        );
        expect(
          transport.messages.find((message) => message.type === 'response' && message.correlationId === correlationId),
        ).toMatchObject({
          type: 'response',
          result: expect.anything(),
        });
      }
    } finally {
      dbContext.cleanup();
    }
  });

  it('denies every allowlisted raw storage operation when an attempt targets another execution', async () => {
    const bus = createWorkflowTestBus();
    const dbContext = await createTestDbForBus(bus);
    const transport = new StubTransport();
    bus.registerTransport(transport);

    try {
      for (const [index, request] of storageRequests(otherExecutionId).entries()) {
        const correlationId = `denied-storage-${index}`;
        await transport.request(
          request.subject.$meta.namespace,
          request.subject.subject as string,
          request.payload,
          correlationId,
          matchingAttemptContext,
        );
        expect(
          transport.messages.find((message) => message.type === 'response' && message.correlationId === correlationId),
        ).toMatchObject({
          type: 'response',
          error: { message: expect.stringContaining('Unauthorized') },
        });
      }
    } finally {
      dbContext.cleanup();
    }
  });
});

describe('attempt-scoped authority state bootstrap authorization', () => {
  it('accepts a matching attempt claim and denies a different execution', async () => {
    const bus = createWorkflowTestBus();
    const dbContext = await createTestDbForBus(bus);
    const cleanup = registerAuthorityStateBootstrapHandler(bus);
    const transport = new StubTransport();
    bus.registerTransport(transport);
    const definition = createWorkflowDefinition({ id: 'wf-attempt-bootstrap' });
    const executionId = 'wfx-attempt-bootstrap';
    const context: TransportReceiveContext = {
      transportName: 'remote-workflow',
      peer: {
        kind: 'workflow-execution-attempt',
        id: 'attempt-bootstrap',
        authenticated: true,
        claims: { executionId },
      },
    };

    try {
      await bus.request(WorkflowStorageSubjects.set, { workflow: definition });
      await bus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({ id: executionId, workflowId: definition.id }),
      });
      await bus.request(WorkflowStorageSubjects.setRunContext, {
        runContext: WorkflowRunContextSchema.parse({
          ...runContext,
          executionId,
          workflowId: definition.id,
          definitionSnapshot: definition,
          cancelSubject: `workflow.${executionId}.cancel`,
        }),
      });

      await transport.request(
        WorkflowSubjects.bootstrapAuthorityState.$meta.namespace,
        WorkflowSubjects.bootstrapAuthorityState.subject as string,
        { executionId, terminalAuthority: 'authority', definition },
        'matching-bootstrap',
        context,
      );
      await transport.request(
        WorkflowSubjects.bootstrapAuthorityState.$meta.namespace,
        WorkflowSubjects.bootstrapAuthorityState.subject as string,
        { executionId: 'wfx-other-bootstrap', terminalAuthority: 'authority', definition },
        'denied-bootstrap',
        context,
      );

      expect(
        transport.messages.find(
          (message) => message.type === 'response' && message.correlationId === 'matching-bootstrap',
        ),
      ).toMatchObject({
        type: 'response',
        result: { persisted: true },
      });
      expect(
        transport.messages.find(
          (message) => message.type === 'response' && message.correlationId === 'denied-bootstrap',
        ),
      ).toMatchObject({
        type: 'response',
        error: { message: expect.stringContaining('execution-bound') },
      });
    } finally {
      cleanup();
      dbContext.cleanup();
    }
  });
});
