import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, afterEach, expect, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ExecutionAttemptSubjects, FrameworkContractNamespaces, FrameworkStorageNamespaces } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  reconcileAttemptCancellation,
  workflowAttemptOutcomeCodec,
} from '@makaio/subsystem-workflow-engine';
import { createRestartableTempDb } from '@makaio/test-utils/drizzle-harness';
import { createSqliteAttemptRepository } from '@makaio/subsystem-workflow-engine/testing/sqlite';
import { bindLocalWorkspace } from '../../workspace-preparation/workspace-preparation.js';
import { runHeadlessWorkflowWorker } from '../headless-workflow-worker.js';
import {
  blockingSetupWorkspace,
  createAuthoritySide,
  createTestDeps,
  immediateExitWorkspace,
  pollPidFile,
  pollUntil,
  type AuthoritySide,
} from './headless-worker-harness.js';

// ─────────────────────────────────────────────────────────────
// Shared helpers are imported from headless-worker-harness.ts
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// R7: Cancel delivered while workload invocation is running
// ─────────────────────────────────────────────────────────────

describe('R7: cancel delivered during workload invocation', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('aborts execute signal, records unsupported/workload report, resolves with cancelled', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r7-'));
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r7-exec-1';

    const workspace = immediateExitWorkspace();
    authoritySide = await createAuthoritySide(executionId, workspace);
    const { executionAttemptId } = authoritySide.attempt;

    // Deferred to keep the execute dep blocked until we choose to release it.
    let signalStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let rejectExecution!: (err: Error) => void;
    const executionGate = new Promise<void>((_resolve, reject) => {
      rejectExecution = reject;
    });

    let capturedSignal!: AbortSignal;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      // Short retry budget so the test does not wait for the full default deadline.
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      execute: async (_bus, runContext, _runtimeCtx, signal) => {
        capturedSignal = signal;
        signalStarted();
        // Block until the test releases us; signal will be aborted by then.
        await executionGate;
        // This line is unreachable when rejectExecution is called.
        return { executionId: runContext.executionId, workflowId: runContext.workflowId, status: 'completed' as const };
      },
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // Wait until execute is actually running (setup has already exited 0).
    await executionStarted;

    // ── Request cancel and reconcile ──────────────────────────────────────
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r7-cancel',
    });

    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );

    // ── Receipt is stored; signal is now aborted ──────────────────────────
    expect(reconcileResult.kind).toBe('received');
    expect(capturedSignal.aborted).toBe(true);

    // Release the workload gate with a cooperative cancellation.
    rejectExecution(new DOMException('Aborted', 'AbortError'));

    // ── Worker resolves with cancelled ────────────────────────────────────
    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');

    // ── Control state: report is workload/unsupported ─────────────────────
    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.receipt).not.toBeNull();
    expect(evidence?.report).not.toBeNull();
    expect(evidence?.report?.conclusion.boundary).toBe('workload');
    expect(evidence?.report?.conclusion.status).toBe('unsupported');

    // The report operationId matches the admitted workload-invocation operation.
    const workloadAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workload-invocation',
    );
    expect(workloadAdmission).toBeDefined();
    expect(evidence?.report?.operationId).toBe(workloadAdmission?.operationId);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// R8: Stable replay + reconnect / report-duplicate handling
// ─────────────────────────────────────────────────────────────

describe('R8: stable delivery replay', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('second reconcile returns identical receipt and store keeps one receipt entry', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r8-replay-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r8-replay-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    await pollPidFile(pidFilePath, 10_000);

    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r8-cancel',
    });

    // First reconcile — delivers the cancel and stores the receipt.
    const reconcile1 = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcile1.kind).toBe('received');
    if (reconcile1.kind !== 'received') throw new Error('invariant');
    // Read the stored receipt before the worker finishes to capture receivedAt.
    const stateAfterFirst = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    const storedReceivedAt = stateAfterFirst?.evidence[0]?.receipt?.receivedAt;
    expect(storedReceivedAt).toBeDefined();

    // Second reconcile — worker endpoint is still active (setup quiescence in progress).
    // Result is either 'received' (stable replay) or 'evidence-complete' (if report already landed).
    const reconcile2 = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(['received', 'evidence-complete']).toContain(reconcile2.kind);

    // If we got a replay receipt, its receivedAt must match the first one.
    if (reconcile2.kind === 'received') {
      const stateAfterSecond = await authoritySide.attempt.authority.readAttemptCancellationControl({
        executionId,
        executionAttemptId,
      });
      // Store should still have exactly one receipt entry (same controlRevision).
      expect(stateAfterSecond?.evidence).toHaveLength(1);
      // The stored receivedAt must be identical to the first receipt (stable replay).
      expect(stateAfterSecond?.evidence[0]?.receipt?.receivedAt).toBe(storedReceivedAt);
      expect(reconcile2.persistence.kind).toBe('duplicate');
    }

    // Wait for the worker to finish.
    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');

    // After completion, evidence is complete: pid file was written exactly once.
    await expect(access(pidFilePath)).resolves.toBeUndefined();
    const pidContent = await readFile(pidFilePath, 'utf8');
    // One pid pair: setup ran exactly once.
    expect(pidContent.trim()).toMatch(/^\d+:\d+$/);

    // Third reconcile after completion must return evidence-complete.
    const reconcile3 = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 5_000 },
    );
    expect(reconcile3.kind).toBe('evidence-complete');
  }, 60_000);

  it('authority treats an exact report replay as duplicate', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r8-dup-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r8-dup-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r8-dup',
    });

    await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );

    // Wait for the worker and the report to land.
    await workerPromise;

    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    const evidence = controlState?.evidence[0];
    expect(evidence?.report).not.toBeNull();

    // Re-submit the exact same report — the authority must treat it as duplicate.
    const report = evidence?.report;
    if (report === undefined || report === null) throw new Error('invariant: report must be defined');
    const dupResult = await authoritySide.attempt.authority.reportAttemptControl({
      ...report,
      executionId,
    });
    expect(dupResult).toEqual({ kind: 'duplicate' });
  }, 60_000);

  it('report survives a server-side connection drop: the runtime reconnects and the report lands', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r8-drop-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r8-drop-1';

    const side = await createAuthoritySide(executionId, blockingSetupWorkspace());
    authoritySide = side;
    const { executionAttemptId, authority } = side.attempt;

    // Sever the worker's transport on the first control.report, before any evidence is
    // written. The runtime sees a transport failure, not a refusal, so its retrying
    // report transport must reconnect and deliver the same conclusion again.
    let peerDropped = false;
    vi.spyOn(authority, 'reportAttemptControl').mockImplementationOnce(async () => {
      peerDropped = side.dropFirstPeer();
      throw new Error('transport dropped before the report could be recorded');
    });

    const deps = createTestDeps(side, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 500, deadlineMs: 60_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r8-drop',
    });

    const reconcileResult = await reconcileAttemptCancellation(
      { bus: side.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');
    expect(peerDropped).toBe(true);

    // Exactly one evidence entry, carrying both the receipt and the retried report.
    const control = await authority.readAttemptCancellationControl({ executionId, executionAttemptId });
    expect(control?.evidence).toHaveLength(1);
    expect(control?.evidence[0]?.receipt).not.toBeNull();
    expect(control?.evidence[0]?.report).not.toBeNull();
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────
// R9: Wrong generation / wrong attempt / late cancel
// ─────────────────────────────────────────────────────────────

describe('R9: stale / misrouted / late delivery', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('(a) delivery with runtimeGeneration + 1 is refused with stale-generation', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r9a-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r9a-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    // Wait for the runtime to be registered (runtimeReadyEvents will have an entry).
    await pollUntil(() => authoritySide!.attempt.runtimeReadyEvents.length > 0, 10_000);

    // Request cancellation to get a cancellation record in the store.
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r9a-cancel',
    });

    // Read the stored control state to get the real runtimeGeneration and runtimeIncarnationId.
    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    const { runtimeGeneration, runtimeIncarnationId } = controlState!.control;
    expect(typeof runtimeIncarnationId).toBe('string');
    expect(runtimeGeneration).toBeGreaterThan(0);

    // Deliver with a stale generation (one higher than the real one).
    const staleDelivery = {
      executionAttemptId,
      runtimeIncarnationId: runtimeIncarnationId!,
      runtimeGeneration: runtimeGeneration + 1,
      cancellation: controlState!.cancellation!,
    };
    const response = await authoritySide.bus.request(ExecutionAttemptSubjects.control.deliver, staleDelivery, {
      timeout: 5_000,
    });
    expect(response).toMatchObject({ decision: 'refused', reason: 'stale-generation' });

    // Worker is unaffected — setup is still running; reconcile the real cancel to let it finish.
    const realReconcile = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(realReconcile.kind).toBe('received');

    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');
  }, 60_000);

  it('(b) delivery for a different executionAttemptId times out (filter miss)', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r9b-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r9b-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);
    await pollUntil(() => authoritySide!.attempt.runtimeReadyEvents.length > 0, 10_000);

    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r9b-cancel',
    });

    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    const { runtimeGeneration, runtimeIncarnationId } = controlState!.control;

    // Send with a different executionAttemptId — the worker's filter does not match.
    const wrongDelivery = {
      executionAttemptId: 'completely-different-attempt-id',
      runtimeIncarnationId: runtimeIncarnationId!,
      runtimeGeneration,
      cancellation: controlState!.cancellation!,
    };
    await expect(
      authoritySide.bus.request(ExecutionAttemptSubjects.control.deliver, wrongDelivery, { timeout: 500 }),
    ).rejects.toThrow();

    // Properly cancel so the worker can exit.
    await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    await workerPromise;
  }, 60_000);

  it('(c) late cancel after outcome committed — outcome unchanged, reconcile returns unavailable', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r9c-'));
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r9c-exec-1';

    // No cancel during the run; worker completes normally.
    authoritySide = await createAuthoritySide(executionId, immediateExitWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      execute: async (_bus, runContext) => ({
        executionId: runContext.executionId,
        workflowId: runContext.workflowId,
        status: 'completed' as const,
      }),
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
    expect(workerResult.outcome.kind).toBe('workload-result');

    // Record the settled outcome before any cancel request.
    const settlementBefore = await authoritySide.attempt.authority.readAttemptSettlement({
      executionId,
      executionAttemptId,
    });
    expect(settlementBefore.kind).toBe('outcome');

    // Now request cancellation after completion.
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r9c-late',
    });

    // Reconcile: the worker endpoint is gone; delivery times out.
    const lateReconcile = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 1_500 },
    );
    // The runtime registered but its endpoint subscription is gone after cleanup.
    // Either 'unavailable' (timeout) or 'runtime-unregistered' if the generation
    // was not persisted; in the integration context the worker DID register.
    expect(['unavailable', 'runtime-unregistered']).toContain(lateReconcile.kind);

    // The settled outcome is unchanged.
    const settlementAfter = await authoritySide.attempt.authority.readAttemptSettlement({
      executionId,
      executionAttemptId,
    });
    expect(settlementAfter).toEqual(settlementBefore);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────
// R10: Report and outcome ACK are independent; orderly shutdown drains reports
// ─────────────────────────────────────────────────────────────

describe('R10: report and outcome ACK are independent; orderly shutdown drains reports', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('commits the outcome while the control report is gated, and resolves only after the report drains', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r10-report-gate-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r10-report-gate-1';

    const side = await createAuthoritySide(executionId, blockingSetupWorkspace());
    authoritySide = side;
    const { executionAttemptId, authority } = side.attempt;

    // Hold the Authority's control-report write. The runtime dispatches its report
    // before it submits the outcome, so gating the report is what makes the two
    // paths distinguishable: nothing about their dispatch order is asserted here.
    let releaseReport!: () => void;
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    const originalReport = authority.reportAttemptControl.bind(authority);
    vi.spyOn(authority, 'reportAttemptControl').mockImplementationOnce(async (...args) => {
      await reportGate;
      return originalReport(...args);
    });

    const deps = createTestDeps(side, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      // One attempt is enough: the per-request timeout is the whole remaining budget,
      // so the gated report waits rather than retrying while the gate is held.
      outcomeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 500, deadlineMs: 60_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r10-report-gate',
    });

    const reconcileResult = await reconcileAttemptCancellation(
      { bus: side.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    // (a) The outcome ACK does not wait for the control report: the outcome commits
    //     while the report is still held inside the Authority.
    await pollUntil(
      async () => (await authority.readAttemptSettlement({ executionId, executionAttemptId })).kind === 'outcome',
      30_000,
    );
    const heldControl = await authority.readAttemptCancellationControl({ executionId, executionAttemptId });
    expect(heldControl?.evidence[0]?.receipt).not.toBeNull();
    expect(heldControl?.evidence[0]?.report ?? null).toBeNull();
    expect(side.capture.outcomeSubmissions.length).toBeGreaterThan(0);

    // (b) The worker does not resolve while a dispatched report is still in flight —
    //     the runtime's finally block awaits settle().
    const raced = await Promise.race([
      workerPromise.then(() => 'resolved' as const),
      sleep(500).then(() => 'pending' as const),
    ]);
    expect(raced).toBe('pending');

    // (c) Once the gate opens the report drains, the worker resolves, and the store
    //     holds both facts.
    releaseReport();
    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');
    const finalControl = await authority.readAttemptCancellationControl({ executionId, executionAttemptId });
    expect(finalControl?.evidence[0]?.receipt).not.toBeNull();
    expect(finalControl?.evidence[0]?.report).not.toBeNull();
  }, 120_000);

  it('accepts the control report while the outcome submission is gated', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r10-outcome-gate-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r10-outcome-gate-1';

    const side = await createAuthoritySide(executionId, blockingSetupWorkspace());
    authoritySide = side;
    const { executionAttemptId, authority } = side.attempt;

    // Mirror of the first case: hold the outcome submission inside the Authority
    // ingress and prove the control report is accepted regardless.
    let releaseOutcome!: () => void;
    side.outcomeSubmitGate = new Promise<void>((resolve) => {
      releaseOutcome = resolve;
    });

    const deps = createTestDeps(side, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 500, deadlineMs: 60_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r10-outcome-gate',
    });

    const reconcileResult = await reconcileAttemptCancellation(
      { bus: side.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    // The report lands while the outcome submission is still held.
    await pollUntil(async () => {
      const control = await authority.readAttemptCancellationControl({ executionId, executionAttemptId });
      return (control?.evidence[0]?.report ?? null) !== null;
    }, 30_000);

    expect(side.capture.outcomeSubmissions.length).toBeGreaterThan(0);
    const heldSettlement = await authority.readAttemptSettlement({ executionId, executionAttemptId });
    expect(heldSettlement.kind).toBe('unsettled');

    const raced = await Promise.race([
      workerPromise.then(() => 'resolved' as const),
      sleep(500).then(() => 'pending' as const),
    ]);
    expect(raced).toBe('pending');

    releaseOutcome();
    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');
    const settled = await authority.readAttemptSettlement({ executionId, executionAttemptId });
    expect(settled.kind).toBe('outcome');
  }, 120_000);

  it('reports the same conclusion when the outer worker signal aborts after the cancel receipt', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r10-outer-abort-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r10-outer-abort-1';

    const side = await createAuthoritySide(executionId, blockingSetupWorkspace());
    authoritySide = side;
    const { executionAttemptId, authority } = side.attempt;

    const deps = createTestDeps(side, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 500, deadlineMs: 30_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const outer = new AbortController();
    const workerPromise = runHeadlessWorkflowWorker(deps, outer.signal);
    await pollPidFile(pidFilePath, 10_000);

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r10-outer-abort',
    });

    const reconcileResult = await reconcileAttemptCancellation(
      { bus: side.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    // The receipt is stored, so the runtime's effective signal is already aborted by the
    // control endpoint. Aborting the outer signal on top of it must not fabricate a
    // different conclusion, and must not suppress the report the runtime owes.
    outer.abort();

    const settled = await workerPromise.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    expect(settled.status).toBe('resolved');
    if (settled.status !== 'resolved') throw new Error('invariant: worker must resolve');
    expect(settled.value.outcome.kind).toBe('cancelled');

    const control = await authority.readAttemptCancellationControl({ executionId, executionAttemptId });
    expect(control?.evidence).toHaveLength(1);
    expect(control?.evidence[0]?.receipt).not.toBeNull();
    expect(control?.evidence[0]?.report).not.toBeNull();
  }, 120_000);
});
// ─────────────────────────────────────────────────────────────
// R11: Listener and connection cleanup
// ─────────────────────────────────────────────────────────────

describe('R11: listener and connection cleanup after run', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('after completed cancel run, worker bus disconnects and subsequent reconcile returns evidence-complete', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r11-cleanup-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r11-cleanup-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r11-cancel',
    });

    await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );

    await workerPromise;

    // After the worker resolves, its bus connection must be closed.
    // The socket close event fires asynchronously; poll briefly.
    await pollUntil(() => authoritySide!.getPeerCount() === 0, 2_000);
    expect(authoritySide.getPeerCount()).toBe(0);

    // A subsequent reconcile must return evidence-complete (not a stale runtime answer).
    const followUpReconcile = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 2_000 },
    );
    expect(followUpReconcile.kind).toBe('evidence-complete');
  }, 60_000);

  it('on bootstrap failure, no peer connection is established and peer count remains 0', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r11-boot-'));
    const executionId = 'cancel-r11-boot-1';

    authoritySide = await createAuthoritySide(executionId);

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      // Bootstrap dep rejects before any bus connection is attempted.
      bootstrap: async () => {
        throw new Error('simulated bootstrap failure');
      },
      outcomeRetry: { maxRetries: 0, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 2_000 },
    });

    // The worker rejects because bootstrap failed.
    await expect(runHeadlessWorkflowWorker(deps, new AbortController().signal)).rejects.toThrow(
      'simulated bootstrap failure',
    );

    // No WS connection was ever established, so peer count is 0.
    expect(authoritySide.getPeerCount()).toBe(0);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────
// R12: Workspace preserved after cancel
// ─────────────────────────────────────────────────────────────

describe('R12: workspace directory is preserved after cancel', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('workspace root still exists on disk after a cancel with achieved report', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r12-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r12-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
      materialize: async () => ({
        context: {
          workspaceRoot: wsRoot,
          sourcePath: join(wsRoot, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64' as const,
        },
      }),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await pollPidFile(pidFilePath, 10_000);

    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r12-cancel',
    });

    await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );

    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');

    // The workspace root must still exist — releaseExecutable skips deletion on cancelled outcomes
    // (outcome.kind !== 'workload-result', so the early-return guard in releaseExecutable fires).
    await expect(access(wsRoot)).resolves.toBeUndefined();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// SQLite recovery: receipt and report survive database restart
// ─────────────────────────────────────────────────────────────

describe('SQLite recovery: evidence persists across database restart', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('receipt and report are readable from a fresh authority after closeConnections + reconnect', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-sqlite-recovery-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-sqlite-rec-1';

    // Build the durable SQLite repository before creating the authority side.
    const store = createRestartableTempDb(`headless-cancel-r-${Date.now()}`);
    try {
      const repository = await createSqliteAttemptRepository(await store.connect(), workflowAttemptOutcomeCodec);

      authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace(), undefined, {
        repository,
      });
      const { executionAttemptId } = authoritySide.attempt;

      const deps = createTestDeps(authoritySide, {
        cwd,
        executionId,
        workspaceRoot: wsRoot,
        preparation: { prepare: (input) => bindLocalWorkspace(input) },
        setupEnv: { PID_FILE: pidFilePath },
        outcomeRetry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200, deadlineMs: 5_000 },
        materialize: async () => ({
          context: {
            workspaceRoot: wsRoot,
            sourcePath: join(wsRoot, 'workflow.ts'),
            contributionEntrypoints: [],
            platform: 'linux' as const,
            arch: 'x64' as const,
          },
        }),
      });

      const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);
      await pollPidFile(pidFilePath, 10_000);

      await authoritySide.attempt.authority.requestAttemptCancellation({
        executionId,
        executionAttemptId,
        requestKey: 'sqlite-rec-cancel',
      });

      await reconcileAttemptCancellation(
        { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
        { executionId, executionAttemptId, timeoutMs: 10_000 },
      );

      await workerPromise;

      // Capture the control state before closing connections.
      const controlBefore = await authoritySide.attempt.authority.readAttemptCancellationControl({
        executionId,
        executionAttemptId,
      });
      expect(controlBefore?.evidence[0]?.receipt).not.toBeNull();
      expect(controlBefore?.evidence[0]?.report).not.toBeNull();

      // Tear down the authority side's harness (does not close DB connections).
      await authoritySide.cleanup();
      authoritySide = undefined;

      // Close all active DB connections.
      await store.closeConnections();

      // Reconnect and build a fresh authority over the same on-disk database.
      const freshRepository = await createSqliteAttemptRepository(await store.connect(), workflowAttemptOutcomeCodec);
      const freshAuthority = new ExecutionAttemptAuthority(freshRepository, {
        bootstrapTimeoutMs: 60_000,
      });

      // Evidence must survive the restart.
      const controlAfter = await freshAuthority.readAttemptCancellationControl({
        executionId,
        executionAttemptId,
      });
      expect(controlAfter).toEqual(controlBefore);

      // A fresh reconcile on the recovered authority returns evidence-complete
      // without contacting any runtime (short-circuit on both-facts-stored).
      const freshBus = createBusInstance();
      freshBus.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
      const freshReconcile = await reconcileAttemptCancellation(
        { bus: freshBus, authority: freshAuthority },
        { executionId, executionAttemptId, timeoutMs: 1_000 },
      );
      expect(freshReconcile.kind).toBe('evidence-complete');
    } finally {
      await store.close();
    }
  }, 90_000);
});
