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
import { registerWorkflowStorageDelegationHandlers } from '../workflow-executor-handlers.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';

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
}

const runContext = WorkflowRunContextSchema.parse({
  executionId: 'wfx-authorized',
  workflowId: 'wf-auth',
  source: { kind: 'definition', workflowId: 'wf-auth' },
  definitionSnapshot: {
    id: 'wf-auth',
    name: 'Auth Test Workflow',
    steps: [],
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
