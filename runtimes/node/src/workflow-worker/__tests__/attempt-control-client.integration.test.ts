import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptSubjects,
  FrameworkContractNamespaces,
  type ExecutionAttemptControlReceipt,
} from '@makaio/contracts';
import { reconcileAttemptCancellation } from '@makaio/subsystem-workflow-engine';
import { makeTestInstruction } from '@makaio/subsystem-workflow-engine/testing';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { installOperationDeliveryEndpoint, registerWorkerRuntime } from '../runtime-registration-client.js';
import {
  installAttemptControlEndpoint,
  type AttemptControlReportOptions,
  type InstalledAttemptControlEndpoint,
} from '../attempt-control-client.js';
import { createAttemptAuthorityHarness, type AttemptAuthorityHarness } from './attempt-authority-harness.js';

// ─────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────

/** Minimal workspace requirement for instructions that permit workspace-preparation. */
const WITH_WORKSPACE = makeTestInstruction({
  workspace: {
    provisioning: 'bind',
    custody: 'external',
    sourceRoots: [{ id: 'src-root-1', path: 'src' }],
    setup: [],
  },
});

interface IntegrationHarness {
  readonly authority: AttemptAuthorityHarness['authority'];
  readonly executionAttemptId: string;
  readonly executionId: string;
  readonly runtimeIncarnationId: string;
  readonly runtimeGeneration: number;
  readonly bus: IMakaioBus;
  readonly controlEndpoint: InstalledAttemptControlEndpoint;
  readonly cancel: () => Promise<void>;
  readonly deliver: (signal?: AbortSignal) => Promise<unknown>;
  readonly cleanup: () => Promise<void>;
}

async function createHarness(
  opts: {
    readonly withWorkspace?: boolean;
    /** Report transport budget; short values let a case exhaust it deliberately. */
    readonly reportRetry?: AttemptControlReportOptions['retry'];
  } = {},
): Promise<IntegrationHarness> {
  const authorityBus = createBusInstance();
  authorityBus.registerNamespaces(FrameworkContractNamespaces);
  const executionId = 'control-client-integration';

  const instruction = opts.withWorkspace === true ? WITH_WORKSPACE : makeTestInstruction();
  const harness = await createAttemptAuthorityHarness(authorityBus, executionId, {
    instruction,
    beforeCommit: async () => undefined,
    beforeConverge: async () => undefined,
  });
  const { executionAttemptId, serverAuth } = harness;

  const server = createServer();
  const port = await listenOnLoopback(server);
  const serverTransport = new BusServerTransportProvider({
    httpServer: server,
    auth: serverAuth,
  });
  await serverTransport.connect(authorityBus, 'control-client-authority');

  const bus = createBusInstance();
  bus.registerNamespace(ExecutionAttemptNamespace);
  const runtimeIncarnationId = 'ctrl-incarnation-1';
  const clientTransport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${port}/bus`,
    autoReconnect: false,
    auth: harness.createClientAuth(),
  });
  bus.registerTransport(clientTransport);
  await bus.connect();

  // The operation delivery endpoint must exist before registration so the authority
  // can deliver its bounded runtime probe via operation.deliver.
  const opEndpoint = await installOperationDeliveryEndpoint(bus, { executionAttemptId, runtimeIncarnationId }, {});

  const controlEndpoint = await installAttemptControlEndpoint(
    bus,
    { executionAttemptId, runtimeIncarnationId },
    { reportOptions: { retry: opts.reportRetry ?? { maxRetries: 2, baseDelayMs: 10, deadlineMs: 5_000 } } },
  );

  const runtimeGeneration = await registerWorkerRuntime(bus, {
    executionAttemptId,
    runtimeIncarnationId,
  });
  opEndpoint.bindGeneration(runtimeGeneration);
  controlEndpoint.bindGeneration(runtimeGeneration);

  const cancel = async (): Promise<void> => {
    await harness.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'test-cancel',
    });
  };

  const deliver = (signal?: AbortSignal): Promise<unknown> =>
    reconcileAttemptCancellation(
      { bus: authorityBus, authority: harness.authority },
      { executionId, executionAttemptId, timeoutMs: 3_000, signal },
    );

  return {
    authority: harness.authority,
    executionAttemptId,
    executionId,
    runtimeIncarnationId,
    runtimeGeneration,
    bus,
    controlEndpoint,
    cancel,
    deliver,
    cleanup: async () => {
      controlEndpoint.cleanup();
      opEndpoint.cleanup();
      await bus.disconnect();
      await serverTransport.disconnect();
      await closeHttpServer(server);
      await harness.cleanup();
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * Deliver the accepted Cancel and wait until the endpoint has applied it locally.
 *
 * The endpoint answers a delivery with the receipt and nothing else, so the
 * abort and the observer notification land one macrotask later. Every case that
 * drives the observer after a delivery has to wait for that.
 * @param h - Harness whose control endpoint receives the delivery.
 * @returns The Authority-side reconciliation result.
 */
async function deliverAndApply(h: IntegrationHarness): Promise<unknown> {
  const result = await h.deliver();
  await expect.poll(() => h.controlEndpoint.signal.aborted).toBe(true);
  return result;
}

/**
 * Create a promise a test resolves by hand.
 * @returns The promise and its resolver.
 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

// ─────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────

describe('attempt control client — integration', () => {
  it('(a) cancel delivery aborts signal and persists receipt', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    expect(h.controlEndpoint.signal.aborted).toBe(false);
    await h.cancel();
    const result = await deliverAndApply(h);
    expect(result).toMatchObject({ kind: 'received' });

    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence).toHaveLength(1);
    expect(control?.evidence[0]?.receipt).toMatchObject({
      executionAttemptId: h.executionAttemptId,
      runtimeIncarnationId: h.runtimeIncarnationId,
      runtimeGeneration: h.runtimeGeneration,
      controlRevision: 1,
      requestKey: 'test-cancel',
    });
  }, 15_000);

  it('(b) replay of same delivery returns identical receipt, no double trigger', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    await h.cancel();
    const r1 = await deliverAndApply(h);
    const r2 = await h.deliver();

    expect(r1).toMatchObject({ kind: 'received' });
    // Second reconcile: receipt already stored → duplicate persistence.
    expect(r2).toMatchObject({ kind: 'received', persistence: { kind: 'duplicate' } });

    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence).toHaveLength(1);
    const storedAt = (control?.evidence[0]?.receipt as ExecutionAttemptControlReceipt | null)?.receivedAt;
    expect(typeof storedAt).toBe('string');
  }, 15_000);

  it('(c) a stale-generation endpoint refuses the delivery and aborts nothing', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    // An endpoint fenced against a generation the Authority never issued.
    const staleEndpoint = await installAttemptControlEndpoint(
      h.bus,
      {
        executionAttemptId: h.executionAttemptId,
        runtimeIncarnationId: h.runtimeIncarnationId,
        runtimeGeneration: h.runtimeGeneration + 99,
      },
      { reportOptions: { retry: { maxRetries: 0, deadlineMs: 500 } } },
    );
    // Remove the correctly fenced endpoint so the stale one is the only
    // responder left: with both installed, the dispatch order decides who
    // answers and the refusal would never be observed.
    h.controlEndpoint.cleanup();

    await h.cancel();
    const result = await h.deliver();
    expect(result).toEqual({ kind: 'refused', reason: 'stale-generation' });

    // A refusal is not a cancel: no endpoint's effective signal is aborted.
    expect(staleEndpoint.signal.aborted).toBe(false);
    expect(h.controlEndpoint.signal.aborted).toBe(false);
    // No receipt was persisted, so the durable Cancel stays redeliverable.
    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence).toHaveLength(0);

    staleEndpoint.cleanup();
  }, 15_000);

  it('(d-admission-closed) finished without admission → achieved admission-closed report', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    await h.cancel();
    await deliverAndApply(h);

    h.controlEndpoint.observer.admissionPending();
    h.controlEndpoint.observer.admissionSettled('gate-closed');
    h.controlEndpoint.observer.finished();

    await h.controlEndpoint.settle();

    expect(h.controlEndpoint.lastReport).toMatchObject({
      status: 'accepted',
      response: { decision: 'accepted' },
    });
    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence[0]?.report).toMatchObject({
      conclusion: { status: 'achieved', boundary: 'admission-closed' },
    });
  }, 15_000);

  it('(d-admission-refused) a refusal that is not gate-closed also concludes admission-closed', async () => {
    // No workspace in the instruction, so the real admission gate refuses a
    // preparation admission with 'preparation-not-required'.
    const h = await createHarness();
    cleanups.push(h.cleanup);

    h.controlEndpoint.observer.admissionPending();
    // Requested before the Cancel, so the refusal is the gate's own verdict on
    // the operation rather than the closed start gate of a cancelled Attempt.
    const admitResponse = await h.bus.request(ExecutionAttemptSubjects.operation.admit, {
      executionAttemptId: h.executionAttemptId,
      operationKind: 'workspace-preparation',
      admissionKey: 'prep-refused',
      runtimeGeneration: h.runtimeGeneration,
    });
    expect(admitResponse).toMatchObject({ decision: 'refused', refusalReason: 'preparation-not-required' });

    await h.cancel();
    await deliverAndApply(h);
    // R2: the runtime has not recorded the response yet, and an outstanding
    // admission may still occupy the Attempt, so nothing may be concluded.
    await h.controlEndpoint.settle();
    expect(h.controlEndpoint.lastReport).toBeUndefined();

    h.controlEndpoint.observer.admissionSettled('preparation-not-required');
    h.controlEndpoint.observer.finished();
    await h.controlEndpoint.settle();

    expect(h.controlEndpoint.lastReport).toMatchObject({ status: 'accepted' });
    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    // Exactly one report: finished() after a dispatched conclusion adds none.
    expect(control?.evidence).toHaveLength(1);
    expect(control?.evidence[0]?.report).toMatchObject({
      conclusion: { status: 'achieved', boundary: 'admission-closed' },
    });
  }, 15_000);

  it('(d-setup-achieved) preparation signalled-and-quiesced → achieved setup-process-group report', async () => {
    // Workspace instruction is required to admit workspace-preparation.
    const h = await createHarness({ withWorkspace: true });
    cleanups.push(h.cleanup);

    const { bus, executionAttemptId, runtimeGeneration } = h;
    const admitResp = (await bus.request(ExecutionAttemptSubjects.operation.admit, {
      executionAttemptId,
      operationKind: 'workspace-preparation',
      admissionKey: 'prep-achieved',
      runtimeGeneration,
    })) as { decision: string; operationId?: string };
    expect(admitResp.decision).toBe('admitted');
    const operationId = admitResp.operationId!;

    h.controlEndpoint.observer.operationAdmitted('workspace-preparation', operationId);

    await h.cancel();
    await deliverAndApply(h);

    h.controlEndpoint.observer.operationConcluded({
      kind: 'workspace-preparation',
      operationId,
      setup: { outcome: 'signalled-and-quiesced', pid: 12345, observedAt: new Date() },
    });

    await h.controlEndpoint.settle();

    expect(h.controlEndpoint.lastReport).toMatchObject({
      status: 'accepted',
      response: { decision: 'accepted' },
    });
    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence[0]?.report).toMatchObject({
      operationId,
      conclusion: { status: 'achieved', boundary: 'setup-process-group' },
    });
  }, 15_000);

  it('(d-setup-unconfirmed) preparation signalled-unconfirmed → unconfirmed setup-process-group report', async () => {
    const h = await createHarness({ withWorkspace: true });
    cleanups.push(h.cleanup);

    const { bus, executionAttemptId, runtimeGeneration } = h;
    const admitResp = (await bus.request(ExecutionAttemptSubjects.operation.admit, {
      executionAttemptId,
      operationKind: 'workspace-preparation',
      admissionKey: 'prep-unconfirmed',
      runtimeGeneration,
    })) as { decision: string; operationId?: string };
    expect(admitResp.decision).toBe('admitted');
    const operationId = admitResp.operationId!;

    h.controlEndpoint.observer.operationAdmitted('workspace-preparation', operationId);
    await h.cancel();
    await deliverAndApply(h);

    h.controlEndpoint.observer.operationConcluded({
      kind: 'workspace-preparation',
      operationId,
      setup: { outcome: 'signalled-unconfirmed', cause: 'poll-timeout', pid: 99999, observedAt: new Date() },
    });

    await h.controlEndpoint.settle();

    expect(h.controlEndpoint.lastReport).toMatchObject({
      status: 'accepted',
      response: { decision: 'accepted' },
    });
    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence[0]?.report).toMatchObject({
      conclusion: { status: 'unconfirmed', boundary: 'setup-process-group' },
    });
  }, 15_000);

  it('(d-workload) workload-invocation admitted → unsupported workload report', async () => {
    // Instruction WITHOUT workspace: workload-invocation does not require preparation.
    const h = await createHarness();
    cleanups.push(h.cleanup);

    const { bus, executionAttemptId, runtimeGeneration } = h;
    const admitResp = (await bus.request(ExecutionAttemptSubjects.operation.admit, {
      executionAttemptId,
      operationKind: 'workload-invocation',
      admissionKey: 'workload-key',
      runtimeGeneration,
    })) as { decision: string; operationId?: string };
    expect(admitResp.decision).toBe('admitted');
    const operationId = admitResp.operationId!;

    h.controlEndpoint.observer.operationAdmitted('workload-invocation', operationId);
    await h.cancel();
    await deliverAndApply(h);

    await h.controlEndpoint.settle();

    expect(h.controlEndpoint.lastReport).toMatchObject({
      status: 'accepted',
      response: { decision: 'accepted' },
    });
    const control = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(control?.evidence[0]?.report).toMatchObject({
      operationId,
      conclusion: { status: 'unsupported', boundary: 'workload' },
    });
  }, 15_000);

  it('(e) exact report replay returns duplicate and settle() resolves cleanly', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    await h.cancel();
    await deliverAndApply(h);
    h.controlEndpoint.observer.finished();
    await h.controlEndpoint.settle();

    expect(h.controlEndpoint.lastReport?.status).toBe('accepted');

    // Second reconcile sees evidence-complete (receipt + report both stored).
    const r2 = await h.deliver();
    expect(r2).toMatchObject({ kind: 'evidence-complete' });

    await expect(h.controlEndpoint.settle()).resolves.toBeUndefined();
  }, 15_000);

  it('(f) cleanup removes subscription — later delivery gets no answer', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    h.controlEndpoint.cleanup();
    await h.cancel();

    const result = await h.deliver();
    expect(result).toMatchObject({ kind: expect.stringMatching(/unavailable|aborted/) });
  }, 15_000);

  it('(g) settle() does not resolve until the in-flight report completes', async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    // The Authority mints exactly one controlRevision per Attempt and replays
    // it, so there is no second revision to race. The endpoint still keys its
    // receipts by revision because a re-registered generation is redelivered
    // that same revision and must answer with the same receipt.
    const authority = h.authority;
    const recordReport = authority.reportAttemptControl.bind(authority);
    const released = deferred();
    let reportsStarted = 0;
    authority.reportAttemptControl = async (input) => {
      reportsStarted += 1;
      await released.promise;
      return await recordReport(input);
    };

    await h.cancel();
    await deliverAndApply(h);
    h.controlEndpoint.observer.finished();

    let settled = false;
    const settling = h.controlEndpoint.settle().then(() => {
      settled = true;
    });
    // The report has reached the Authority and is held there.
    await expect.poll(() => reportsStarted).toBe(1);
    expect(settled).toBe(false);
    expect(h.controlEndpoint.lastReport).toBeUndefined();

    released.resolve();
    await settling;
    expect(settled).toBe(true);
    expect(h.controlEndpoint.lastReport).toMatchObject({ status: 'accepted' });
    expect(reportsStarted).toBe(1);
  }, 20_000);

  it('(h) a report that exhausted its transport budget is re-sent on the next redelivery', async () => {
    // One attempt per dispatch, so the first report fails terminally instead of
    // being repaired by the transport's own retry loop.
    const h = await createHarness({ reportRetry: { maxRetries: 0, deadlineMs: 500 } });
    cleanups.push(h.cleanup);

    const authority = h.authority;
    const recordReport = authority.reportAttemptControl.bind(authority);
    let reportsStarted = 0;
    authority.reportAttemptControl = async (input) => {
      reportsStarted += 1;
      if (reportsStarted === 1) throw new Error('authority report ingress unavailable');
      return await recordReport(input);
    };

    await h.cancel();
    await deliverAndApply(h);
    h.controlEndpoint.observer.finished();
    await h.controlEndpoint.settle();

    // ── The conclusion never reached the store ──────────────────────────────
    expect(reportsStarted).toBe(1);
    expect(h.controlEndpoint.lastReport?.status).toBe('error');
    const afterFailure = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(afterFailure?.evidence).toHaveLength(1);
    const failedReceipt = afterFailure?.evidence[0]?.receipt;
    expect(failedReceipt).not.toBeNull();
    expect(afterFailure?.evidence[0]?.report).toBeNull();

    // ── Redelivery: same receipt, and the missing report is sent again ──────
    const replay = await h.deliver();
    expect(replay).toMatchObject({ kind: 'received', persistence: { kind: 'duplicate' } });
    await h.controlEndpoint.settle();

    expect(reportsStarted).toBe(2);
    expect(h.controlEndpoint.lastReport).toMatchObject({ status: 'accepted' });
    const repaired = await h.authority.readAttemptCancellationControl({
      executionId: h.executionId,
      executionAttemptId: h.executionAttemptId,
    });
    expect(repaired?.evidence).toHaveLength(1);
    // The receipt is the stable first-seen one; only the report was added.
    expect(repaired?.evidence[0]?.receipt).toEqual(failedReceipt);
    expect(repaired?.evidence[0]?.report).toMatchObject({
      conclusion: { status: 'achieved', boundary: 'admission-closed' },
    });

    // ── An accepted report is terminal: nothing re-sends it ─────────────────
    // The Authority stops redelivering once the evidence is complete, and the
    // endpoint itself refuses a second dispatch on any later trigger.
    expect(await h.deliver()).toMatchObject({ kind: 'evidence-complete' });
    h.controlEndpoint.observer.finished();
    await h.controlEndpoint.settle();
    expect(reportsStarted).toBe(2);
  }, 20_000);
});
