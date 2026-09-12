import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { ServerTransport } from '@makaio/bus-transport-websocket';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptOutcomeSchema,
  ExecutionAttemptSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
  type ExecutionAttemptControlReceipt,
  type ExecutionAttemptControlReport,
  type ExecutionAttemptOutcome,
} from '@makaio/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileAttemptCancellation } from '../attempt-control-delivery.js';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { registerExecutionAttemptHandlers } from '../execution-attempt-handlers.js';
import { mintWorkflowExecutionBusSecret } from '../../../../runtimes/node/src/workflow-execution-bus-access.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import { driveTestAttemptToAllocated, makeTestInstruction } from '../testing/attempt-fixtures.js';
import { AttemptGateTransport, attemptPeer } from './execution-attempt-gate-harness.js';
import { MockWebSocket, MockWebSocketServer } from '../../../../transports/ws/src/__tests__/test-helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/**
 * Real bus and Authority; protocol responders prove delivery only, never an actual worker stop.
 * @param registered - Whether to register a runtime.
 * @returns Live test ports and exact correlation.
 */
async function fixture(registered = true) {
  const repository = createInMemoryAttemptRepository<ExecutionAttemptOutcome>({
    parse: (input) => ExecutionAttemptOutcomeSchema.parse(input),
    serialize: JSON.stringify,
  });
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
  const executionId = 'control-owner';
  const { executionAttemptId } = await authority.createAttempt(executionId, makeTestInstruction());
  const ids = { executionId, executionAttemptId };
  await driveTestAttemptToAllocated(authority, executionAttemptId, executionId);
  const runtimeIncarnationId = 'runtime-control';
  const runtimeGeneration = 1;
  if (registered) {
    await authority.registerRuntime({ ...ids, runtimeIncarnationId });
    await authority.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() });
  }
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespace(ExecutionAttemptNamespace);
  const transport = new AttemptGateTransport();
  bus.registerTransport(transport);
  cleanups.push(
    registerExecutionAttemptHandlers(bus, {
      authority,
      decodeOutcome: ({ outcome }) => outcome,
      convergence: { converge: async () => 'projected' },
    }),
  );
  const correlation = {
    executionAttemptId,
    runtimeIncarnationId,
    runtimeGeneration,
    requestKey: 'stop',
    controlRevision: 1,
  };
  const receipt: ExecutionAttemptControlReceipt = { ...correlation, receivedAt: '2026-09-10T10:00:00Z' };
  const report: ExecutionAttemptControlReport = {
    ...correlation,
    conclusion: {
      status: 'achieved',
      boundary: 'admission-closed',
      evidence: {
        source: 'protocol-test',
        summary: 'No mutating operation admitted',
        observedAt: '2026-09-10T10:00:01Z',
      },
    },
  };
  const reconcile = (signal?: AbortSignal) =>
    reconcileAttemptCancellation({ bus, authority }, { ...ids, timeoutMs: 25, signal });
  const cancel = () => authority.requestAttemptCancellation({ ...ids, requestKey: 'stop' });
  return { repository, authority, ids, bus, transport, correlation, receipt, report, reconcile, cancel };
}

describe('bounded Attempt Cancel delivery', () => {
  it('does not fabricate delivery before Cancel or runtime registration', async () => {
    const h = await fixture(false);
    expect(await h.reconcile()).toEqual({ kind: 'not-requested' });
    await h.cancel();
    expect(await h.reconcile()).toEqual({ kind: 'runtime-unregistered' });
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence).toEqual([]);
  });

  it('delivers despite an occupied workload slot and persists only its genuine receipt', async () => {
    const h = await fixture();
    await h.authority.admitOperation({
      ...h.ids,
      runtimeGeneration: 1,
      operationKind: 'workload-invocation',
      admissionKey: 'work',
    });
    await h.cancel();
    const before = await h.authority.getAttemptControlState(h.ids.executionAttemptId);
    cleanups.push(
      h.bus
        .withFilter({ executionAttemptId: h.ids.executionAttemptId, runtimeIncarnationId: 'runtime-control' })
        .on(ExecutionAttemptSubjects.control.deliver, (ctx) => {
          ctx.setResult({ decision: 'received', receipt: h.receipt });
        }),
    );
    expect(await h.reconcile()).toEqual({ kind: 'received', persistence: { kind: 'accepted' } });
    expect(await h.reconcile()).toEqual({ kind: 'received', persistence: { kind: 'duplicate' } });
    expect(await h.authority.getAttemptControlState(h.ids.executionAttemptId)).toEqual(before);
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence).toEqual([
      { controlRevision: 1, runtimeGeneration: 1, receipt: h.receipt, report: null },
    ]);
  });

  it('accepts a real bus report before delivery ACK and stops redelivery only when both facts exist', async () => {
    const h = await fixture();
    await h.cancel();
    let deliveries = 0;
    cleanups.push(
      h.bus
        .withFilter({ executionAttemptId: h.ids.executionAttemptId, runtimeIncarnationId: 'runtime-control' })
        .on(ExecutionAttemptSubjects.control.deliver, async (ctx) => {
          deliveries += 1;
          const response = await h.transport.requestAs(
            'execution-attempt',
            'control.report',
            h.report,
            attemptPeer(h.ids.executionAttemptId, h.ids.executionId),
          );
          expect(response.result).toEqual({ decision: 'accepted' });
          expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence[0]?.receipt).toBeNull();
          ctx.setResult({ decision: 'received', receipt: h.receipt });
        }),
    );
    expect(await h.reconcile()).toEqual({ kind: 'received', persistence: { kind: 'accepted' } });
    expect(await h.reconcile()).toEqual({ kind: 'evidence-complete' });
    expect(deliveries).toBe(1);
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence[0]).toMatchObject({
      receipt: h.receipt,
      report: h.report,
    });
  });

  it('keeps a report durable when the receipt response is lost and recovers with a fresh Authority', async () => {
    const h = await fixture();
    await h.cancel();
    let loseResponse = true;
    cleanups.push(
      h.bus
        .withFilter({ executionAttemptId: h.ids.executionAttemptId, runtimeIncarnationId: 'runtime-control' })
        .on(ExecutionAttemptSubjects.control.deliver, async (ctx) => {
          await h.authority.reportAttemptControl({ ...h.report, executionId: h.ids.executionId });
          if (loseResponse) throw new Error('Lost receipt response');
          ctx.setResult({ decision: 'received', receipt: h.receipt });
        }),
    );
    expect(await h.reconcile()).toEqual({ kind: 'unavailable' });
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence[0]).toMatchObject({
      receipt: null,
      report: h.report,
    });
    loseResponse = false;
    const authority = new ExecutionAttemptAuthority(h.repository, { bootstrapTimeoutMs: 60_000 });
    expect(await reconcileAttemptCancellation({ authority, bus: h.bus }, { ...h.ids, timeoutMs: 100 })).toEqual({
      kind: 'received',
      persistence: { kind: 'accepted' },
    });
  });

  it('bounds unavailable delivery and abort without inventing a runtime conclusion', async () => {
    const h = await fixture();
    await h.cancel();
    expect(await h.reconcile()).toEqual({ kind: 'unavailable' });
    const controller = new AbortController();
    controller.abort('shutdown');
    expect(await h.reconcile(controller.signal)).toEqual({ kind: 'aborted' });
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence).toEqual([]);
    await expect(reconcileAttemptCancellation(h, { ...h.ids, timeoutMs: 0 })).rejects.toThrow('positive safe integer');
  });

  it('rejects an answer claiming a different runtime than the one addressed', async () => {
    const h = await fixture();
    await h.cancel();
    cleanups.push(
      h.bus
        .withFilter({ executionAttemptId: h.ids.executionAttemptId, runtimeIncarnationId: 'runtime-control' })
        .on(ExecutionAttemptSubjects.control.deliver, (ctx) => {
          ctx.setResult({ decision: 'received', receipt: { ...h.receipt, runtimeIncarnationId: 'other' } });
        }),
    );
    expect(await h.reconcile()).toEqual({ kind: 'invalid-receipt' });
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence).toEqual([]);
  });

  it('cancels an in-flight transport wait without discarding a response already received', async () => {
    const h = await fixture();
    await h.cancel();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unregister = h.bus
      .withFilter({ executionAttemptId: h.ids.executionAttemptId, runtimeIncarnationId: 'runtime-control' })
      .on(ExecutionAttemptSubjects.control.deliver, async (ctx) => {
        entered();
        await waiting;
        ctx.setResult({ decision: 'received', receipt: h.receipt });
      });
    cleanups.push(unregister);
    const pending = reconcileAttemptCancellation(h, { ...h.ids, timeoutMs: 1_000, signal: controller.signal });
    await started;
    controller.abort('shutdown');
    expect(await pending).toEqual({ kind: 'aborted' });
    release();
    unregister();
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence).toEqual([]);

    const second = new AbortController();
    cleanups.push(
      h.bus
        .withFilter({ executionAttemptId: h.ids.executionAttemptId, runtimeIncarnationId: 'runtime-control' })
        .on(ExecutionAttemptSubjects.control.deliver, (ctx) => {
          ctx.setResult({ decision: 'received', receipt: h.receipt });
        }),
    );
    const authority = {
      readAttemptCancellationControl: h.authority.readAttemptCancellationControl.bind(h.authority),
      async recordAttemptControlReceipt(input: Parameters<typeof h.authority.recordAttemptControlReceipt>[0]) {
        second.abort('caller left after runtime response');
        return h.authority.recordAttemptControlReceipt(input);
      },
    };
    expect(
      await reconcileAttemptCancellation(
        { authority, bus: h.bus },
        { ...h.ids, timeoutMs: 100, signal: second.signal },
      ),
    ).toEqual({ kind: 'received', persistence: { kind: 'accepted' } });
  });

  it('requires the authenticated Attempt peer and removes the control handler on cleanup', async () => {
    const h = await fixture();
    await h.cancel();
    const response = await h.transport.requestAs(
      'execution-attempt',
      'control.report',
      h.report,
      attemptPeer('other-attempt', h.ids.executionId),
    );
    expect(response.error?.message).toContain('authenticated peer identity');
    expect((await h.authority.readAttemptCancellationControl(h.ids))?.evidence).toEqual([]);
    for (const cleanup of cleanups.splice(0)) cleanup();
    const after = await h.transport.requestAs(
      'execution-attempt',
      'control.report',
      h.report,
      attemptPeer(h.ids.executionAttemptId, h.ids.executionId),
    );
    expect(after.error).toBeDefined();
  });

  it.each([
    false,
    true,
  ])('isolates Authority deliveries from a higher-priority Attempt (forged filters: %s)', async (forgedFilters) => {
    const h = await fixture();
    await h.cancel();
    h.bus.unregisterTransport(h.transport.name);

    const runtimeAIdentity = h.ids.executionAttemptId;
    const runtimeBIdentity = 'attempt-b';
    h.bus.registerNamespace(WorkflowNamespace);
    const gateResponseSubject = 'workflow.gate.respond';
    const controlDeliverySubject = 'execution-attempt.control.deliver';
    const operationDeliverySubject = 'execution-attempt.operation.deliver';
    const cleanupRuntimeA = mintWorkflowExecutionBusSecret({
      executionAttemptId: runtimeAIdentity,
      executionId: h.ids.executionId,
    }).cleanup;
    const cleanupRuntimeB = mintWorkflowExecutionBusSecret({
      executionAttemptId: runtimeBIdentity,
      executionId: h.ids.executionId,
    }).cleanup;
    const websocket = new MockWebSocketServer();
    const runtimeA = new MockWebSocket();
    const runtimeB = new MockWebSocket();
    const server = new ServerTransport({
      websocket,
      auth: {
        authenticateClient: async () => undefined,
        authenticateServer: async () => undefined,
        handleAuthMessage: () => false,
        getReceiveContext: (socket) => {
          const id = socket === runtimeA ? runtimeAIdentity : socket === runtimeB ? runtimeBIdentity : undefined;
          return id === undefined
            ? undefined
            : {
                transportName: 'websocket',
                peer: {
                  kind: 'workflow-execution-attempt',
                  id,
                  authenticated: true,
                  claims: { executionId: h.ids.executionId },
                },
              };
        },
        isSocketAuthenticated: () => true,
        cleanupSocket: () => undefined,
        cleanup: () => undefined,
      },
    });
    let authorityIngressDeliveries = 0;
    const unregisterAuthorityIngressProbe = server.onReceive(async (message) => {
      if (message.type === 'request' && `${message.namespace}.${message.subject}` === controlDeliverySubject) {
        authorityIngressDeliveries += 1;
      }
    });

    try {
      h.bus.registerTransport(server);
      await server.connect();
      websocket.simulateConnection(runtimeA);
      websocket.simulateConnection(runtimeB);
      await new Promise<void>((resolve) => setImmediate(resolve));
      runtimeA.receiveMessage(
        JSON.stringify({
          type: 'subscribe',
          subjects: { [operationDeliverySubject]: [0], [controlDeliverySubject]: [0], [gateResponseSubject]: [0] },
          deliveryClasses: {
            [operationDeliverySubject]: 'relayable',
            [controlDeliverySubject]: 'relayable',
            [gateResponseSubject]: 'relayable',
          },
          filters: {
            [gateResponseSubject]: { executionAttemptId: h.ids.executionAttemptId },
            [operationDeliverySubject]: {
              executionAttemptId: h.ids.executionAttemptId,
              runtimeIncarnationId: h.correlation.runtimeIncarnationId,
            },
            [controlDeliverySubject]: {
              executionAttemptId: h.ids.executionAttemptId,
              runtimeIncarnationId: h.correlation.runtimeIncarnationId,
            },
          },
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      runtimeA.clearSentMessages();
      runtimeB.receiveMessage(
        JSON.stringify({
          type: 'subscribe',
          subjects: {
            [operationDeliverySubject]: [100],
            [controlDeliverySubject]: [100],
            [gateResponseSubject]: [100],
          },
          deliveryClasses: {
            [operationDeliverySubject]: 'relayable',
            [controlDeliverySubject]: 'relayable',
            [gateResponseSubject]: 'relayable',
          },
          filters: forgedFilters
            ? {
                [operationDeliverySubject]: { executionAttemptId: h.ids.executionAttemptId },
                [controlDeliverySubject]: { executionAttemptId: h.ids.executionAttemptId },
                [gateResponseSubject]: { executionAttemptId: h.ids.executionAttemptId },
              }
            : undefined,
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      runtimeB.clearSentMessages();

      const operationDelivered = h.bus.request(
        ExecutionAttemptSubjects.operation.deliver,
        {
          executionAttemptId: h.ids.executionAttemptId,
          runtimeIncarnationId: h.correlation.runtimeIncarnationId,
          runtimeGeneration: h.correlation.runtimeGeneration,
          operationId: 'operation-a',
          operationKind: 'runtime-probe',
        },
        { timeout: 1_000 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const authorityOperationDelivery = JSON.parse(runtimeA.sentMessages.at(-1)!);
      expect(authorityOperationDelivery).toMatchObject({
        type: 'request',
        namespace: 'execution-attempt',
        subject: 'operation.deliver',
      });
      expect(runtimeB.sentMessages).toEqual([]);
      runtimeA.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: authorityOperationDelivery.correlationId,
          result: { receipt: 'completed' },
        }),
      );
      await expect(operationDelivered).resolves.toEqual({ receipt: 'completed' });
      runtimeA.clearSentMessages();

      const gateDelivered = h.bus.request(
        WorkflowSubjects.gate.respond,
        {
          executionId: h.ids.executionId,
          executionAttemptId: h.ids.executionAttemptId,
          gateId: 'attempt-gate',
          action: 'approve',
          resumeData: { approved: true },
        },
        { timeout: 1_000 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const authorityGateResponse = JSON.parse(runtimeA.sentMessages.at(-1)!);
      expect(authorityGateResponse).toMatchObject({
        type: 'request',
        namespace: 'workflow',
        subject: 'gate.respond',
        payload: { executionAttemptId: h.ids.executionAttemptId },
      });
      expect(runtimeB.sentMessages).toEqual([]);
      runtimeA.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: authorityGateResponse.correlationId,
          result: { accepted: true },
        }),
      );
      await expect(gateDelivered).resolves.toEqual({ accepted: true });
      runtimeA.clearSentMessages();

      runtimeB.receiveMessage(
        JSON.stringify({
          type: 'request',
          namespace: 'execution-attempt',
          subject: 'control.deliver',
          payload: {
            executionAttemptId: h.ids.executionAttemptId,
            runtimeIncarnationId: h.correlation.runtimeIncarnationId,
            runtimeGeneration: h.correlation.runtimeGeneration,
            cancellation: {
              requestKey: h.correlation.requestKey,
              controlRevision: h.correlation.controlRevision,
              requestedAt: '2026-09-10T10:00:00Z',
            },
          },
          correlationId: 'runtime-b-forged-delivery',
          messageId: 'runtime-b-forged-delivery-message',
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.parse(runtimeB.sentMessages.at(-1)!)).toMatchObject({
        type: 'response',
        correlationId: 'runtime-b-forged-delivery',
        error: { message: expect.stringContaining(controlDeliverySubject) },
      });
      expect(authorityIngressDeliveries).toBe(0);
      expect(runtimeA.sentMessages).toEqual([]);
      runtimeB.clearSentMessages();

      const delivered = h.reconcile();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const authorityDelivery = JSON.parse(runtimeA.sentMessages.at(-1)!);
      expect(authorityDelivery).toMatchObject({
        type: 'request',
        namespace: 'execution-attempt',
        subject: 'control.deliver',
      });
      expect(runtimeB.sentMessages).toEqual([]);
      runtimeA.receiveMessage(
        JSON.stringify({
          type: 'response',
          correlationId: authorityDelivery.correlationId,
          result: { decision: 'received', receipt: h.receipt },
        }),
      );
      expect(await delivered).toEqual({ kind: 'received', persistence: { kind: 'accepted' } });
    } finally {
      unregisterAuthorityIngressProbe();
      cleanupRuntimeB();
      cleanupRuntimeA();
      await server.disconnect();
    }
  });
});
