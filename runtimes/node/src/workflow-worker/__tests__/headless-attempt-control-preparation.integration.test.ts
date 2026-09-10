import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach, expect, vi } from 'vitest';
import { reconcileAttemptCancellation } from '@makaio/subsystem-workflow-engine';
import { type WorkspaceRequirement } from '@makaio/contracts';
import { bindLocalWorkspace } from '../../workspace-preparation/workspace-preparation.js';
import { BootstrapStartRefusedError } from '../bootstrap-start-client.js';
import { runHeadlessWorkflowWorker } from '../headless-workflow-worker.js';
import {
  blockingSetupWorkspace,
  createAuthoritySide,
  createDeferred,
  createTestDeps,
  immediateExitWorkspace,
  pollPidFile,
  pollUntil,
  stubMaterialize,
  type AuthoritySide,
} from './headless-worker-harness.js';

// ─────────────────────────────────────────────────────────────
// Local helpers (preparation-specific)
// ─────────────────────────────────────────────────────────────

/**
 * The workspace root must not exist so provisioning:'create' can mkdir it.
 * @param cwd - Temporary directory returned by mkdtemp.
 * @returns Workspace root path one level below the temp dir.
 */
function freshWsRoot(cwd: string): string {
  return join(cwd, 'workspace');
}

// ─────────────────────────────────────────────────────────────
// R1: cancel before the first mutating admission
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R1: cancel before first admission', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;
  // Kept in outer scope so afterEach can release it on failure to prevent a hang.
  let releaseInstructionGate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseInstructionGate?.();
    releaseInstructionGate = undefined;
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  // R1a — the Cancel wins the race against the worker entirely. Requesting a
  // Cancel closes the Attempt's operation start gate, and the bootstrap
  // await-start gate reads that same gate: the worker never registers, so there
  // is no endpoint to deliver to and nothing to conclude about.
  it('cancel requested before bootstrap: the worker is refused at the start gate, ' +
    'nothing registers or is admitted, and no evidence is fabricated', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r1a-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r1a-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    // Durable Cancel before the worker connects.
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r1a-cancel',
    });

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      materialize: stubMaterialize(wsRoot),
    });

    // ── Assert 1: the worker never passes the bootstrap start gate ─────────
    let refusal: unknown;
    try {
      await runHeadlessWorkflowWorker(deps, new AbortController().signal);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BootstrapStartRefusedError);
    expect(refusal instanceof BootstrapStartRefusedError ? refusal.refusalReason : undefined).toBe('gate-closed');

    // ── Assert 2: no registration, no admission, no setup process ──────────
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(0);
    expect(authoritySide.attempt.operationAdmittedEvents).toHaveLength(0);
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();

    // ── Assert 3: reconcile has no registered runtime to deliver to ────────
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 5_000 },
    );
    expect(reconcileResult.kind).toBe('runtime-unregistered');

    // ── Assert 4: the Cancel is durable, but no receipt and no report ──────
    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.cancellation).not.toBeNull();
    expect(controlState?.evidence).toHaveLength(0);
  }, 60_000);

  // R1b — the real R1: the runtime is registered and its control endpoint has a
  // bound generation, but no mutating operation has been admitted yet. The
  // worker is held at the frozen-instruction read, which is the first bus call
  // runWorkloadInvocation makes and strictly precedes the first admitOperation.
  it('cancel delivered after registration but before the first mutating admission: ' +
    'no workspace-preparation is admitted, setup never runs, and the store holds ' +
    'a receipt and an admission-closed/achieved report', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r1b-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r1b-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId, authority } = authoritySide.attempt;

    // Hold the worker between registration and the first admission by parking
    // the Authority-side instruction read; the original method is called
    // through afterwards so the production path stays intact.
    const instructionGate = createDeferred<void>();
    releaseInstructionGate = instructionGate.resolve;
    const instructionRead = createDeferred<void>();
    const readInstruction = authority.getInstruction.bind(authority);
    vi.spyOn(authority, 'getInstruction').mockImplementationOnce(async (input) => {
      instructionRead.resolve();
      await instructionGate.promise;
      return readInstruction(input);
    });

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      materialize: stubMaterialize(wsRoot),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // The read only happens after registerWorkerRuntime resolved and the
    // control endpoint bound its generation.
    await instructionRead.promise;
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.attempt.operationAdmittedEvents).toHaveLength(0);

    // ── Deliver the Cancel while the runtime is parked before admission ────
    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r1b-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');
    if (reconcileResult.kind === 'received') {
      expect(reconcileResult.persistence.kind).toBe('accepted');
    }

    // ── Assert 1: the receipt is durable before the worker is released ─────
    const heldState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(heldState?.evidence).toHaveLength(1);
    expect(heldState?.evidence[0]?.receipt).not.toBeNull();
    // No mutating operation is admitted and the runtime has not finished, so
    // derivation is still pending: no report may exist yet.
    expect(heldState?.evidence[0]?.report).toBeNull();

    releaseInstructionGate = undefined;
    instructionGate.resolve();

    const workerResult = await workerPromise;

    // ── Assert 2: the worker acknowledges a cancelled outcome ──────────────
    expect(workerResult.outcome.kind).toBe('cancelled');

    // ── Assert 3: no workspace-preparation admission, no setup process ─────
    expect(
      authoritySide.attempt.operationAdmittedEvents.filter((e) => e.operationKind === 'workspace-preparation'),
    ).toHaveLength(0);
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();

    // ── Assert 4: report is admission-closed/achieved, correlated to nothing ─
    const controlState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.receipt).not.toBeNull();
    expect(evidence?.report).not.toBeNull();
    expect(evidence?.report?.conclusion.boundary).toBe('admission-closed');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
    expect(evidence?.report?.conclusion.evidence.source).toBe('headless-runtime');
    // Nothing was admitted, so the report may not name an operation.
    expect(evidence?.report?.operationId ?? null).toBeNull();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// R1c: the closed cancellation gate refuses the first admission
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R1c: admission refused by the closed gate', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;
  // Kept in outer scope so afterEach can release it on failure to prevent a hang.
  let releaseAdmitGate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseAdmitGate?.();
    releaseAdmitGate = undefined;
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  // Unlike R1a, the runtime is registered and holds a bound generation here, so
  // the refusal is not the end of the story: nothing worker-side would settle
  // the attempt on a throw, and the explicit Cancel would land as a retryable
  // infrastructure failure. The worker owns the settlement and submits the
  // cancelled outcome the closed gate is evidence of.
  it('cancel closes the start gate while the first admission is being processed: ' +
    'the worker settles the attempt with a cancelled outcome instead of rejecting', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r1c-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r1c-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId, authority } = authoritySide.attempt;

    // Hold the preparation admission BEFORE the Authority decides it, so the
    // durable Cancel closes the start gate while the request is in flight and
    // the real decision is then taken against the closed gate.
    const admitGate = createDeferred<void>();
    releaseAdmitGate = admitGate.resolve;
    const admitEntered = createDeferred<void>();
    const originalAdmit = authority.admitOperation.bind(authority);
    vi.spyOn(authority, 'admitOperation').mockImplementation(async (input) => {
      // Runtime registration admits a bounded runtime-probe operation of its
      // own; holding that one would park the worker before it binds its
      // control generation. Select the preparation admission by kind.
      if (input.operationKind !== 'workspace-preparation') return await originalAdmit(input);
      admitEntered.resolve();
      await admitGate.promise;
      return await originalAdmit(input);
    });

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      materialize: stubMaterialize(wsRoot),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    await admitEntered.promise;
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r1c-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    // The runtime still owes an admission response, so no conclusion is derivable yet.
    const heldState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(heldState?.evidence[0]?.report).toBeNull();

    releaseAdmitGate = undefined;
    admitGate.resolve();

    const workerResult = await workerPromise;

    // ── Assert 1: the refusal became a cancelled outcome, not a rejection ──
    expect(workerResult.outcome.kind).toBe('cancelled');

    // ── Assert 2: the attempt is settled by that outcome ───────────────────
    expect(authoritySide.capture.outcomeSubmissions.map((submission) => submission.outcome.kind)).toEqual([
      'cancelled',
    ]);
    expect(authoritySide.attempt.convergedOutcomes).toHaveLength(1);

    // ── Assert 3: nothing was admitted and setup never ran ─────────────────
    expect(
      authoritySide.attempt.operationAdmittedEvents.filter((e) => e.operationKind === 'workspace-preparation'),
    ).toHaveLength(0);
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();

    // ── Assert 4: the report names the closed gate, correlated to nothing ──
    const controlState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.report?.conclusion.boundary).toBe('admission-closed');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
    expect(evidence?.report?.conclusion.evidence.summary).toContain('gate-closed');
    expect(evidence?.report?.operationId ?? null).toBeNull();
  }, 60_000);
});
// ─────────────────────────────────────────────────────────────
// R2: cancel during an unanswered workspace-preparation admission
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R2: cancel during pending admission', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;
  // Kept in outer scope so afterEach can release it on failure to prevent hang.
  let releaseAdmissionGate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseAdmissionGate?.();
    releaseAdmissionGate = undefined;
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('cancel delivered while admission is in flight: real admission succeeds, ' +
    'signal already aborted → setup-process-group/achieved with headless-runtime evidence', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r2-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r2-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    // Gate that holds the admission receipt on the wire until released.
    const admissionGate = createDeferred<void>();
    releaseAdmissionGate = admissionGate.resolve;

    // Deferred that fires once the durable admission happened but its RPC
    // receipt has not reached the runtime yet.
    const admissionEntered = createDeferred<void>();

    // Capture the original method before the spy replaces it to avoid recursion.
    const { authority } = authoritySide.attempt;
    const originalAdmit = authority.admitOperation.bind(authority);

    // The first admitOperation of an attempt is NOT the workspace preparation:
    // runtime registration admits a bounded `runtime-probe` operation before it
    // answers the register request (runtime-registration.ts proveRuntimeEndpoint).
    // Holding that one would park the worker before it binds its control
    // generation, and the endpoint would correctly refuse the delivery as
    // `stale-generation`. Select the preparation admission by kind instead.
    //
    // The admission is performed for real first and only its receipt is held:
    // this is the hazard the derivation guards with `admissionPending` — the
    // operation is already durably admitted while the runtime is still unaware.
    vi.spyOn(authority, 'admitOperation').mockImplementation(async (input) => {
      const decision = await originalAdmit(input);
      if (input.operationKind !== 'workspace-preparation') return decision;
      admissionEntered.resolve();
      await admissionGate.promise;
      return decision;
    });

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      materialize: stubMaterialize(wsRoot),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // The preparation operation is durably admitted; its receipt is held.
    await admissionEntered.promise;
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);

    // Request cancellation + reconcile while the admission receipt is in flight.
    // The runtime IS registered at this point, so the deliver reaches the endpoint.
    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r2-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    // The runtime cannot conclude while it still owes an admission response:
    // derivation stays pending, so no report may exist yet.
    const heldState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(heldState?.evidence).toHaveLength(1);
    expect(heldState?.evidence[0]?.receipt).not.toBeNull();
    expect(heldState?.evidence[0]?.report).toBeNull();

    // Release the held admission: the authority responds; the worker gets the
    // operationId, checks signal.aborted → true, calls acknowledgeOutcome
    // with operationId but no handle (setup never started).
    releaseAdmissionGate = undefined;
    admissionGate.resolve();

    const workerResult = await workerPromise;

    // ── Assert 1: outcome is cancelled ─────────────────────────────────────
    expect(workerResult.outcome.kind).toBe('cancelled');

    // ── Assert 2: workspace-preparation WAS admitted ───────────────────────
    const wsAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workspace-preparation',
    );
    expect(wsAdmission).toBeDefined();

    // ── Assert 3: workload-invocation was NOT admitted ─────────────────────
    const workloadAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workload-invocation',
    );
    expect(workloadAdmission).toBeUndefined();

    // ── Assert 4: pid file never written (setup never ran) ─────────────────
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();

    // ── Assert 5: report is setup-process-group/achieved/headless-runtime ──
    const controlState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.receipt).not.toBeNull();
    expect(evidence?.report).not.toBeNull();
    expect(evidence?.report?.conclusion.boundary).toBe('setup-process-group');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
    expect(evidence?.report?.conclusion.evidence.source).toBe('headless-runtime');

    // ── Assert 6: report operationId matches the admitted preparation ───────
    expect(evidence?.report?.operationId).toBe(wsAdmission?.operationId);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// R4: missing / failed driver proof (signalled-unconfirmed)
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R4: missing driver stop proof', () => {
  it.todo(
    'reports setup-process-group/unconfirmed when the driver cannot prove quiescence — ' +
      'BLOCKED: suppressing the ps probe is not enough, because stopRemainingGroup ' +
      '(setup-command.ts:141-153) still concludes quiesced as soon as kill(-pid, 0) ' +
      'returns ESRCH, which a SIGKILLed group reaches far inside its 2 s deadline; ' +
      'an unconfirmed observation needs a process that survives SIGKILL.',
  );
});

// ─────────────────────────────────────────────────────────────
// R5: setup exits naturally before cancel; cancel arrives during workload
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R5: setup exits naturally, cancel during workload', () => {
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

  it('workload outcome is not rewritten to cancelled; store reports workload/unsupported', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r5-'));
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r5-exec-1';

    // Setup exits 0 immediately; no process group is spawned.
    const workspace: WorkspaceRequirement = {
      provisioning: 'create',
      custody: 'disposable',
      sourceRoots: [],
      setup: [
        {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: {},
          timeoutMs: 5_000,
        },
      ],
    };

    authoritySide = await createAuthoritySide(executionId, workspace);
    const { executionAttemptId } = authoritySide.attempt;

    // Gate that keeps the workload adapter blocked until the test releases it,
    // and a flag proving the adapter was entered before the cancel is sent.
    const workloadGate = createDeferred<void>();
    let workloadEntered = false;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      materialize: stubMaterialize(wsRoot),
      // Block until the test signals completion, then return a normal result.
      execute: async (_bus, runContext) => {
        workloadEntered = true;
        await workloadGate.promise;
        return {
          executionId: runContext.executionId,
          workflowId: runContext.workflowId,
          status: 'completed' as const,
        };
      },
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // Wait until the workload adapter has been entered.  Admission alone is not
    // enough: the worker re-checks its cancel signal between the admission RPC
    // and `adapter.invoke`, so a cancel that lands in that window is honestly
    // reported as `cancelled` — which is not the premise of this case.
    await pollUntil(() => workloadEntered, 20_000, {
      description: 'workload adapter entry (proving setup completed)',
    });

    // Request cancellation + reconcile while the workload adapter is blocked.
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r5-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    // Release the workload: execute returns its normal result.  The worker
    // reports the workload result rather than rewriting it to cancelled.
    workloadGate.resolve();

    const workerResult = await workerPromise;

    // ── Assert 1: outcome is the workload result, not cancelled ─────────────
    expect(workerResult.outcome.kind).toBe('workload-result');

    // ── Assert 2: store has receipt + workload/unsupported report ──────────
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

    // ── Assert 3: both operations were admitted in order ────────────────────
    const wsAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workspace-preparation',
    );
    expect(wsAdmission).toBeDefined();

    const workloadAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workload-invocation',
    );
    expect(workloadAdmission).toBeDefined();

    // ── Assert 4: report operationId matches the admitted workload operation ─
    expect(evidence?.report?.operationId).toBe(workloadAdmission?.operationId);

    // Note: the setup driver observation (processGroup.outcome === 'exited') is
    // recorded by the control state machine but is not surfaced in the
    // cancellation control evidence — the cancel arrived during workload, so the
    // control report describes the workload boundary, not the setup observation.
    // The indirect proof is that workload-invocation was admitted, which requires
    // setup to have exited with code 0.
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// R6: report correlated with preparation operation after slot release
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R6: report.operationId correlated after slot release', () => {
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

  it('after the worker finishes (slot released, outcome acknowledged), ' +
    'report.operationId matches the admitted preparation operation and ' +
    'the receipt was accepted (no operation-mismatch)', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r6-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r6-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      setupEnv: { PID_FILE: pidFilePath },
      materialize: stubMaterialize(wsRoot),
    });

    // Start the worker; it will begin workspace setup.
    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // Wait until the setup command has written both pids to the file.
    await pollPidFile(pidFilePath, 10_000);

    // Request cancellation + reconcile while setup is running.
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r6-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');
    // The receipt is newly accepted, not a duplicate.
    if (reconcileResult.kind === 'received') {
      expect(reconcileResult.persistence.kind).toBe('accepted');
    }

    // Await the worker fully: slot released + outcome acknowledged.
    const workerResult = await workerPromise;
    expect(workerResult.outcome.kind).toBe('cancelled');

    // Read the control state AFTER the worker has fully finished.
    // This proves the authority stored the report correctly even after the
    // preparation slot was released (no operation-mismatch).
    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.receipt).not.toBeNull();
    expect(evidence?.report).not.toBeNull();
    expect(evidence?.report?.conclusion.boundary).toBe('setup-process-group');
    expect(evidence?.report?.conclusion.status).toBe('achieved');

    // ── Core R6 assertion: operationId correlation survives slot release ─────
    // The report must be correlated with the exact preparation operation that was
    // admitted, even though the slot has since been released and the outcome
    // committed.  operation-mismatch would manifest as a missing or wrong operationId.
    const wsAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workspace-preparation',
    );
    expect(wsAdmission).toBeDefined();
    expect(evidence?.report?.operationId).toBe(wsAdmission?.operationId);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// R7: the prepared-workspace report fails permanently under a delivered cancel
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R7: prepared-workspace report fails permanently', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;
  // Kept in outer scope so afterEach can release it on failure to prevent a hang.
  let releaseReportGate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseReportGate?.();
    releaseReportGate = undefined;
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  // The setup process group is already observed (it exited on its own) when the
  // binding report starts failing permanently. The worker cannot continue, but
  // the durable Cancel must still be answered with the evidence in hand: the
  // terminal setup fact belongs to the runtime, not to the Authority's receipt
  // for the report.
  it('setup produced a process-group observation and operation.report exhausts its retries: ' +
    'the store still holds the setup-process-group/achieved report for the admitted preparation', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r7-'));
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r7-exec-1';

    authoritySide = await createAuthoritySide(executionId, immediateExitWorkspace());
    const { executionAttemptId, authority } = authoritySide.attempt;

    // Hold the first prepared-workspace report inside the Authority ingress so
    // the Cancel can be delivered while it is in flight, then fail every
    // attempt: the runtime's bounded retries are exhausted and the call throws.
    const reportGate = createDeferred<void>();
    releaseReportGate = reportGate.resolve;
    const reportEntered = createDeferred<void>();
    vi.spyOn(authority, 'reportOperation').mockImplementation(async () => {
      reportEntered.resolve();
      await reportGate.promise;
      throw new Error('Prepared-workspace report ingress failure');
    });

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      materialize: stubMaterialize(wsRoot),
      // Bound the report retries so a permanent failure terminates in-test.
      outcomeRetry: { maxRetries: 1, baseDelayMs: 10, deadlineMs: 10_000 },
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // Reaching the report proves setup completed and its process group was observed.
    await reportEntered.promise;

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r7-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    releaseReportGate = undefined;
    reportGate.resolve();

    // ── Assert 1: the failing report terminates the worker ─────────────────
    await expect(workerPromise).rejects.toThrow();

    // ── Assert 2: the setup evidence reached the store anyway ──────────────
    const controlState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.receipt).not.toBeNull();
    expect(evidence?.report).not.toBeNull();
    expect(evidence?.report?.conclusion.boundary).toBe('setup-process-group');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
    expect(evidence?.report?.conclusion.evidence.source).toBe('setup-driver');
    expect(evidence?.report?.conclusion.evidence.code).toBe('exited');

    // ── Assert 3: the report names the admitted preparation operation ──────
    const wsAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workspace-preparation',
    );
    expect(wsAdmission).toBeDefined();
    expect(evidence?.report?.operationId).toBe(wsAdmission?.operationId);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// R8: an empty setup recipe is proven no-spawn, not missing evidence
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R8: empty setup recipe', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;
  // Kept in outer scope so afterEach can release it on failure to prevent a hang.
  let releaseReportGate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseReportGate?.();
    releaseReportGate = undefined;
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  // A requirement with no setup commands is an ordinary shape: the driver
  // returns a completed result without a process group, which is positive
  // evidence that no setup process ever existed under this operation.
  it('a workspace requirement with no setup commands reports setup-process-group/achieved: ' +
    'an absent process group is proven, not a missing observation', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r8-'));
    const wsRoot = freshWsRoot(cwd);
    const executionId = 'cancel-r8-exec-1';

    const workspace: WorkspaceRequirement = {
      provisioning: 'create',
      custody: 'disposable',
      sourceRoots: [],
      setup: [],
    };

    authoritySide = await createAuthoritySide(executionId, workspace);
    const { executionAttemptId, authority } = authoritySide.attempt;

    // Hold the prepared-workspace report so the Cancel is delivered while the
    // preparation is still the admitted operation; the real report runs after.
    const reportGate = createDeferred<void>();
    releaseReportGate = reportGate.resolve;
    const reportEntered = createDeferred<void>();
    const originalReport = authority.reportOperation.bind(authority);
    vi.spyOn(authority, 'reportOperation').mockImplementation(async (input) => {
      reportEntered.resolve();
      await reportGate.promise;
      return await originalReport(input);
    });

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      materialize: stubMaterialize(wsRoot),
    });

    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // Reaching the report proves the empty recipe completed without spawning.
    await reportEntered.promise;

    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r8-cancel',
    });
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );
    expect(reconcileResult.kind).toBe('received');

    releaseReportGate = undefined;
    reportGate.resolve();

    const workerResult = await workerPromise;

    // ── Assert 1: the cancellation is the outcome ──────────────────────────
    expect(workerResult.outcome.kind).toBe('cancelled');

    // ── Assert 2: the proven absence of a process group is achieved ────────
    const controlState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.report?.conclusion.boundary).toBe('setup-process-group');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
    expect(evidence?.report?.conclusion.evidence.source).toBe('setup-driver');
    expect(evidence?.report?.conclusion.evidence.summary).toBe(
      'no live setup process group remains under this operation',
    );
    expect(evidence?.report?.conclusion.evidence.code).toBeUndefined();

    // ── Assert 3: the report names the admitted preparation operation ──────
    const wsAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workspace-preparation',
    );
    expect(wsAdmission).toBeDefined();
    expect(evidence?.report?.operationId).toBe(wsAdmission?.operationId);
  }, 60_000);
});
