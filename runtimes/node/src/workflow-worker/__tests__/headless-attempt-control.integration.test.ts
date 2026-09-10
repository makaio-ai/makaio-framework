import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach, expect } from 'vitest';
import { reconcileAttemptCancellation } from '@makaio/subsystem-workflow-engine';
import { type WorkspaceRequirement } from '@makaio/contracts';
import { bindLocalWorkspace } from '../../workspace-preparation/workspace-preparation.js';
import { runHeadlessWorkflowWorker } from '../headless-workflow-worker.js';
import {
  buildSetupSource,
  createAuthoritySide,
  createTestDeps,
  isPidAbsentOrZombie,
  pollPidFile,
  type AuthoritySide,
} from './headless-worker-harness.js';

// ─────────────────────────────────────────────────────────────
// R3: cancel delivered while real setup is running
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker attempt-control — R3: cancel during real workspace setup', () => {
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

  it('aborts the setup process group, stores a receipt before the report, and resolves with cancelled', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-r3-'));
    const pidFilePath = join(cwd, 'setup-pids.txt');
    // The workspace root must not exist: provisioning:'create' calls fs.mkdir on it.
    const wsRoot = join(cwd, 'workspace');
    const executionId = 'cancel-r3-exec-1';

    const workspace: WorkspaceRequirement = {
      provisioning: 'create',
      custody: 'disposable',
      sourceRoots: [],
      setup: [
        {
          command: process.execPath,
          args: ['-e', buildSetupSource()],
          env: {},
          timeoutMs: 30_000,
        },
      ],
    };

    authoritySide = await createAuthoritySide(executionId, workspace);
    const { executionAttemptId } = authoritySide.attempt;

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workspaceRoot: wsRoot,
      // Bind the workspace via the production path; no Git sources are needed.
      preparation: { prepare: (input) => bindLocalWorkspace(input) },
      // Private setup-process environment: the pid file path is not stored
      // in the instruction (which is frozen and portable).
      setupEnv: { PID_FILE: pidFilePath },
      // materialize is called only inside an admitted workload-invocation
      // operation; for R3 the worker is cancelled during setup so this is
      // never reached. A stub is sufficient.
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

    // Start the worker; do not await — it is running setup in a subprocess.
    const workerPromise = runHeadlessWorkflowWorker(deps, new AbortController().signal);

    // Wait until the setup command has written both pids to the file (10 s bound).
    const pids = await pollPidFile(pidFilePath, 10_000);

    // --- Authority requests cancellation and reconcile delivers it ---
    await authoritySide.attempt.authority.requestAttemptCancellation({
      executionId,
      executionAttemptId,
      requestKey: 'r3-cancel',
    });

    // reconcileAttemptCancellation delivers the cancel over the shared bus to
    // the worker's control endpoint and returns after the receipt is stored.
    const reconcileResult = await reconcileAttemptCancellation(
      { bus: authoritySide.bus, authority: authoritySide.attempt.authority },
      { executionId, executionAttemptId, timeoutMs: 10_000 },
    );

    // Now wait for the worker to finish — it sends the report then resolves.
    const workerResult = await workerPromise;

    // ── Assert 1: worker resolves with a cancelled outcome ──────────────
    expect(workerResult.outcome.kind).toBe('cancelled');

    // ── Assert 2: reconcile received the receipt ────────────────────────
    expect(reconcileResult.kind).toBe('received');

    // ── Assert 3 & 5: store has receipt (before report) and report ──────
    const controlState = await authoritySide.attempt.authority.readAttemptCancellationControl({
      executionId,
      executionAttemptId,
    });
    expect(controlState?.evidence).toHaveLength(1);
    const evidence = controlState?.evidence[0];

    // Receipt existed (reconcile returned) before the report was sent.
    expect(evidence?.receipt).not.toBeNull();
    expect(evidence?.report).not.toBeNull();

    // ── Assert 3: report conclusion matches setup-process-group ─────────
    expect(evidence?.report?.conclusion.boundary).toBe('setup-process-group');
    expect(evidence?.report?.conclusion.status).toBe('achieved');
    expect(evidence?.report?.conclusion.evidence.code).toBe('signalled-and-quiesced');

    // The report operationId matches the admitted workspace-preparation operation
    // captured by the harness on the authority bus.
    const wsAdmission = authoritySide.attempt.operationAdmittedEvents.find(
      (e) => e.operationKind === 'workspace-preparation',
    );
    expect(wsAdmission).toBeDefined();
    expect(evidence?.report?.operationId).toBe(wsAdmission?.operationId);

    // ── Assert 4: child and grandchild pids are absent or zombie ────────
    for (const [label, pid] of [
      ['child', pids.child],
      ['grandchild', pids.grandchild],
    ] as const) {
      expect(await isPidAbsentOrZombie(pid), `${label} pid ${pid} must be absent or zombie after cancellation`).toBe(
        true,
      );
    }
  }, 60_000); // setup + cancel + quiescence check may take several seconds on a loaded host
});
