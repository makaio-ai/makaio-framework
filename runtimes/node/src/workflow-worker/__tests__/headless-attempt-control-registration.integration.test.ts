import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, afterEach, expect, vi } from 'vitest';
import { reconcileAttemptCancellation, type AttemptControlDeliveryResult } from '@makaio/subsystem-workflow-engine';
import { bindLocalWorkspace } from '../../workspace-preparation/workspace-preparation.js';
import { runHeadlessWorkflowWorker } from '../headless-workflow-worker.js';
import {
  blockingSetupWorkspace,
  createAuthoritySide,
  createDeferred,
  createTestDeps,
  stubMaterialize,
  type AuthoritySide,
} from './headless-worker-harness.js';

/**
 * How long a delivery is observed as unanswered before the hold is released.
 *
 * A refusal is immediate — the endpoint answers from local state without any
 * further round trip — so an unsettled reconcile after this window is evidence
 * that the delivery is deferred rather than merely slow.
 */
const UNANSWERED_OBSERVATION_MS = 300;

// ─────────────────────────────────────────────────────────────
// R7: cancel delivered while registration is still in flight
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R7: cancel during registration', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string | undefined;
  // Kept in outer scope so afterEach can release it on failure to prevent a hang.
  let releaseReadyGate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseReadyGate?.();
    releaseReadyGate = undefined;
    await authoritySide?.cleanup();
    authoritySide = undefined;
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  // The Authority allocates the generation in step 2 of the registration
  // handshake and only answers the runtime in step 8, so between the two it can
  // already address a Cancel at a generation the runtime has not bound yet.
  // Holding the readiness write (step 6) reproduces exactly that window: the
  // generation exists and is durable, the probe is already proven, and the
  // registration RPC has not returned. Holding `registerRuntime` itself would
  // not — before allocation the Attempt has no runtime and the Authority
  // answers `runtime-unregistered` without ever delivering.
  it('cancel delivered while the registration RPC is in flight: the delivery is deferred ' +
    'until the generation binds, not refused as stale, and the store ends with a ' +
    'receipt and an admission-closed/achieved report', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r7-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r7-exec-1';

    authoritySide = await createAuthoritySide(executionId, blockingSetupWorkspace());
    const { executionAttemptId, authority } = authoritySide.attempt;

    // Park the registration inside step 6, after the generation is allocated
    // and the probe is proven; the original method is called through afterwards
    // so the production readiness path stays intact.
    const readyGate = createDeferred<void>();
    releaseReadyGate = readyGate.resolve;
    const readyReached = createDeferred<void>();
    const markReady = authority.markRuntimeReady.bind(authority);
    vi.spyOn(authority, 'markRuntimeReady').mockImplementationOnce(async (input) => {
      readyReached.resolve();
      await readyGate.promise;
      return await markReady(input);
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

    // The runtime is mid-registration: the control endpoint is installed and
    // visible, but `bindGeneration` has not been called.
    await readyReached.promise;
    const heldControl = await authority.getAttemptControlState(executionAttemptId);
    expect(heldControl?.runtimeGeneration).toBeGreaterThan(0);
    expect(heldControl?.runtimeReadyAt).toBeNull();

    // ── Deliver the Cancel into the unbound window ─────────────────────────
    await authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r7-cancel',
    });
    let settled: AttemptControlDeliveryResult | undefined;
    const reconciling = reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    ).then((result) => {
      settled = result;
      return result;
    });

    // ── Assert 1: an unbound endpoint defers instead of refusing ───────────
    await delay(UNANSWERED_OBSERVATION_MS);
    expect(settled).toBeUndefined();

    releaseReadyGate = undefined;
    readyGate.resolve();

    // ── Assert 2: the deferred delivery is answered once the fence exists ──
    const reconcileResult = await reconciling;
    expect(reconcileResult.kind).toBe('received');
    if (reconcileResult.kind === 'received') {
      expect(reconcileResult.persistence.kind).toBe('accepted');
    }

    const workerResult = await workerPromise;

    // ── Assert 3: the worker concludes cancelled without mutating anything ─
    expect(workerResult.outcome.kind).toBe('cancelled');
    expect(
      authoritySide.attempt.operationAdmittedEvents.filter((e) => e.operationKind === 'workspace-preparation'),
    ).toHaveLength(0);
    await expect(readFile(pidFilePath, 'utf8')).rejects.toThrow();

    // ── Assert 4: durable evidence is complete, not empty ──────────────────
    const controlState = await authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];
    expect(evidence?.receipt?.runtimeGeneration).toBe(heldControl?.runtimeGeneration);
    expect(evidence?.report?.conclusion.boundary).toBe('admission-closed');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
  }, 60_000);
});
