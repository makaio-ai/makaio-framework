import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedSubjects,
  resolveHmacIdentityPeer,
} from '@makaio/bus-transport-websocket';
import {
  buildExecutionAttemptAllowedSubjects,
  captureWorkflowExecutionBusSecretCleanup,
  mintOrRotateWorkflowExecutionBusSecret,
  mintWorkflowExecutionBusSecret,
  registerWorkflowExecutionBusSecret,
  resolveWorkflowExecutionBusSecret,
  rotateWorkflowExecutionBusSecret,
} from '../workflow-execution-bus-access.js';

describe('workflow execution bus access', () => {
  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('registers a secret keyed by executionAttemptId', () => {
    const registration = mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });

    expect(registration.secret).toHaveLength(64);
    expect(resolveWorkflowExecutionBusSecret('attempt-1')).toBe(registration.secret);
  });

  it('registers a caller-provided secret with canonical attempt identity', () => {
    const registration = registerWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-provisioned',
      executionId: 'exec-provisioned',
      secret: 'provider-delivered-secret',
    });

    expect(registration.secret).toBe('provider-delivered-secret');
    expect(resolveWorkflowExecutionBusSecret('attempt-provisioned')).toBe('provider-delivered-secret');
    expect(resolveHmacIdentityPeer('attempt-provisioned')).toEqual({
      kind: 'workflow-execution-attempt',
      id: 'attempt-provisioned',
      authenticated: true,
      claims: { executionId: 'exec-provisioned' },
    });
  });

  it('registers with peer kind workflow-execution-attempt', () => {
    mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });

    const peer = resolveHmacIdentityPeer('attempt-1');
    expect(peer).toEqual({
      kind: 'workflow-execution-attempt',
      id: 'attempt-1',
      authenticated: true,
      claims: { executionId: 'exec-1' },
    });
  });

  it('attaches executionId as a claim on the peer context', () => {
    mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });

    const peer = resolveHmacIdentityPeer('attempt-1');
    expect(peer?.claims).toEqual({ executionId: 'exec-1' });
  });

  it('cleans up a secret by attempt id', () => {
    const registration = mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });

    registration.cleanup();

    expect(resolveWorkflowExecutionBusSecret('attempt-1')).toBeUndefined();
    expect(resolveHmacIdentityPeer('attempt-1')).toBeNull();
  });

  it('does not let an older cleanup remove a replacement secret for the same attempt', () => {
    const first = mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });
    const second = mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });

    first.cleanup();

    expect(resolveWorkflowExecutionBusSecret('attempt-1')).toBe(second.secret);

    second.cleanup();

    expect(resolveWorkflowExecutionBusSecret('attempt-1')).toBeUndefined();
  });

  it('revocation of one attempt does not affect another attempt of the same execution', () => {
    const attempt1 = mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });
    const attempt2 = mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-2',
      executionId: 'exec-1',
    });

    attempt1.cleanup();

    // attempt-1 is gone
    expect(resolveWorkflowExecutionBusSecret('attempt-1')).toBeUndefined();
    expect(resolveHmacIdentityPeer('attempt-1')).toBeNull();

    // attempt-2 is still live
    expect(resolveWorkflowExecutionBusSecret('attempt-2')).toBe(attempt2.secret);
    const peer2 = resolveHmacIdentityPeer('attempt-2');
    expect(peer2).toEqual({
      kind: 'workflow-execution-attempt',
      id: 'attempt-2',
      authenticated: true,
      claims: { executionId: 'exec-1' },
    });
  });

  it('does not resolve a secret by executionId (only by attempt id)', () => {
    mintWorkflowExecutionBusSecret({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
    });

    expect(resolveWorkflowExecutionBusSecret('exec-1')).toBeUndefined();
  });

  // ── Rotation ────────────────────────────────────────────────

  describe('rotateWorkflowExecutionBusSecret', () => {
    it('replaces the registered secret for an existing attempt', () => {
      const original = mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot',
        executionId: 'exec-1',
      });
      const rotated = rotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot',
        executionId: 'exec-1',
      });

      expect(rotated.secret).not.toBe(original.secret);
      expect(resolveWorkflowExecutionBusSecret('attempt-rot')).toBe(rotated.secret);
    });

    it('preserves peer kind and claims after rotation', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot',
        executionId: 'exec-1',
      });
      rotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot',
        executionId: 'exec-1',
      });

      const peer = resolveHmacIdentityPeer('attempt-rot');
      expect(peer).toEqual({
        kind: 'workflow-execution-attempt',
        id: 'attempt-rot',
        authenticated: true,
        claims: { executionId: 'exec-1' },
      });
    });

    it('throws when no registration exists for the attempt', () => {
      expect(() =>
        rotateWorkflowExecutionBusSecret({
          executionAttemptId: 'no-such-attempt',
          executionId: 'exec-1',
        }),
      ).toThrow(/not registered for execution/);
    });

    it('rejects rotation when the attempt belongs to another execution', () => {
      const original = mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot',
        executionId: 'exec-original',
      });

      expect(() =>
        rotateWorkflowExecutionBusSecret({
          executionAttemptId: 'attempt-rot',
          executionId: 'exec-other',
        }),
      ).toThrow(/not registered for execution "exec-other"/);
      expect(resolveWorkflowExecutionBusSecret('attempt-rot')).toBe(original.secret);
      expect(resolveHmacIdentityPeer('attempt-rot')?.claims).toEqual({
        executionId: 'exec-original',
      });
    });
  });

  // ── Mint or rotate ──────────────────────────────────────────

  describe('mintOrRotateWorkflowExecutionBusSecret', () => {
    it('mints a new secret when no registration exists', () => {
      const result = mintOrRotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-mor',
        executionId: 'exec-1',
      });

      expect(result.secret).toHaveLength(64);
      expect(resolveWorkflowExecutionBusSecret('attempt-mor')).toBe(result.secret);
    });

    it('rotates the secret when a registration already exists', () => {
      const first = mintOrRotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-mor',
        executionId: 'exec-1',
      });
      const second = mintOrRotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-mor',
        executionId: 'exec-1',
      });

      expect(second.secret).not.toBe(first.secret);
      expect(resolveWorkflowExecutionBusSecret('attempt-mor')).toBe(second.secret);
    });

    it('old cleanup does not revoke a rotated secret from mintOrRotate', () => {
      const first = mintOrRotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-mor',
        executionId: 'exec-1',
      });
      const second = mintOrRotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-mor',
        executionId: 'exec-1',
      });

      first.cleanup();

      expect(resolveWorkflowExecutionBusSecret('attempt-mor')).toBe(second.secret);
    });
  });

  // ── Capture current cleanup ─────────────────────────────────

  describe('captureWorkflowExecutionBusSecretCleanup', () => {
    it('returns undefined for an unregistered attempt', () => {
      expect(
        captureWorkflowExecutionBusSecretCleanup({
          executionAttemptId: 'missing-attempt',
          executionId: 'missing-execution',
        }),
      ).toBeUndefined();
    });

    it('captures a matching cleanup when the original registration closure is unavailable', () => {
      const executionAttemptId = 'attempt-captured-cleanup';
      const executionId = 'exec-captured-cleanup';
      mintWorkflowExecutionBusSecret({ executionAttemptId, executionId });

      const capturedCleanup = captureWorkflowExecutionBusSecretCleanup({ executionAttemptId, executionId });
      expect(capturedCleanup).toBeTypeOf('function');

      capturedCleanup?.();

      expect(resolveWorkflowExecutionBusSecret(executionAttemptId)).toBeUndefined();
    });

    it('refuses an identity registered for another peer kind', () => {
      registerHmacIdentitySecret('attempt-wrong-kind', 'test-secret', {
        peerKind: 'worker-bootstrap',
        claims: { executionId: 'exec-wrong-kind' },
      });

      expect(() =>
        captureWorkflowExecutionBusSecretCleanup({
          executionAttemptId: 'attempt-wrong-kind',
          executionId: 'exec-wrong-kind',
        }),
      ).toThrow(/not registered for execution/);
    });

    it('refuses an identity registered for another execution', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-wrong-execution',
        executionId: 'exec-original',
      });

      expect(() =>
        captureWorkflowExecutionBusSecretCleanup({
          executionAttemptId: 'attempt-wrong-execution',
          executionId: 'exec-other',
        }),
      ).toThrow(/not registered for execution "exec-other"/);
    });

    it('does not let a captured cleanup revoke a later rotation', () => {
      const executionAttemptId = 'attempt-captured-rotation';
      const executionId = 'exec-captured-rotation';
      mintWorkflowExecutionBusSecret({ executionAttemptId, executionId });
      const capturedCleanup = captureWorkflowExecutionBusSecretCleanup({ executionAttemptId, executionId });

      const rotated = rotateWorkflowExecutionBusSecret({ executionAttemptId, executionId });
      capturedCleanup?.();

      expect(resolveWorkflowExecutionBusSecret(executionAttemptId)).toBe(rotated.secret);
    });
  });

  // ── Allowed subjects ───────────────────────────────────────

  describe('allowedSubjects', () => {
    it('registers execution-attempt identity with allowedSubjects', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-1',
        executionId: 'exec-1',
      });

      const allowed = resolveHmacIdentityAllowedSubjects('attempt-1');
      expect(allowed).not.toBeNull();
      // Verify static subjects are present.
      expect(allowed!.has('execution-attempt.runtime.register')).toBe(true);
      expect(allowed!.has('execution-attempt.instruction.get')).toBe(true);
      expect(allowed!.has('execution-attempt.operation.admit')).toBe(true);
      expect(allowed!.has('execution-attempt.operation.report')).toBe(true);
      expect(allowed!.has('execution-attempt.operation.deliver')).toBe(true);
      expect(allowed!.has('execution-attempt.outcome.submit')).toBe(true);
      expect(allowed!.has('worker.runtime.inputs.get')).toBe(true);
      expect(allowed!.has('worker.control.outcome.submit')).toBe(true);
      expect(allowed!.has('workflow.getRunContext')).toBe(true);
      expect(allowed!.has('storage:workflow.getExecution')).toBe(true);
      expect(allowed!.has('workflow.frame.started')).toBe(true);
      expect(allowed!.has('workflow.gate.suspended')).toBe(true);
      expect(allowed!.has('workflow.state.get')).toBe(true);
      expect(allowed!.has('artifact.kind.list')).toBe(true);
      expect(allowed!.has('artifact.query')).toBe(true);
      expect(allowed!.has('artifact.resolve')).toBe(true);
      expect(allowed!.has('subagent.spawn')).toBe(true);
      expect(allowed!.has('subagent.getStatus')).toBe(true);
    });

    it('allowedSubjects includes the per-execution cancel subject', () => {
      const executionId = 'exec-cancel-test';
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-cancel',
        executionId,
      });

      const allowed = resolveHmacIdentityAllowedSubjects('attempt-cancel');
      expect(allowed).not.toBeNull();
      expect(allowed!.has(`workflow.${executionId}.cancel`)).toBe(true);
    });

    it('allowedSubjects does NOT include workflow-definition mutation subjects', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-no-mutation',
        executionId: 'exec-1',
      });

      const allowed = resolveHmacIdentityAllowedSubjects('attempt-no-mutation');
      expect(allowed).not.toBeNull();
      // Mutation/admin subjects must never appear.
      expect(allowed!.has('workflow.define')).toBe(false);
      expect(allowed!.has('workflow.delete')).toBe(false);
      expect(allowed!.has('workflow.create')).toBe(false);
    });

    it('keeps selected-artifact reads and existing writes limited to explicit operations', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-artifact-read',
        executionId: 'exec-artifact-read',
      });

      const allowed = resolveHmacIdentityAllowedSubjects('attempt-artifact-read');
      expect(allowed).not.toBeNull();
      expect([...allowed!].filter((subject) => subject.startsWith('artifact.')).sort()).toStrictEqual([
        'artifact.create',
        'artifact.kind.list',
        'artifact.query',
        'artifact.resolve',
        'artifact.revise',
      ]);
    });

    it('preserves allowedSubjects after rotation', () => {
      const executionId = 'exec-rot-allowed';
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot-allowed',
        executionId,
      });

      const beforeRotation = resolveHmacIdentityAllowedSubjects('attempt-rot-allowed');
      expect(beforeRotation).not.toBeNull();

      rotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot-allowed',
        executionId,
      });

      const afterRotation = resolveHmacIdentityAllowedSubjects('attempt-rot-allowed');
      expect(afterRotation).not.toBeNull();
      expect(afterRotation).toEqual(beforeRotation);
    });
  });

  // ── buildExecutionAttemptAllowedSubjects ────────────────────

  describe('buildExecutionAttemptAllowedSubjects', () => {
    it('grants only the exact Worker and Attempt protocol subjects, without authority events or wildcards', () => {
      const subjects = buildExecutionAttemptAllowedSubjects('exec-protocol');
      expect(
        subjects.filter((subject) => subject.startsWith('execution-attempt.') || subject.startsWith('worker.')),
      ).toStrictEqual([
        'execution-attempt.runtime.register',
        'execution-attempt.bootstrap.awaitStart',
        'execution-attempt.instruction.get',
        'execution-attempt.operation.admit',
        'execution-attempt.operation.report',
        'execution-attempt.operation.deliver',
        'execution-attempt.outcome.submit',
        'worker.runtime.inputs.get',
        'worker.control.outcome.submit',
      ]);
      expect(subjects.some((subject) => subject.includes('*'))).toBe(false);
      for (const subject of [
        'execution-attempt.runtime.ready',
        'execution-attempt.operation.admitted',
        'execution-attempt.invocation.ready',
        'worker.dispatch',
        'worker.control.bootstrap.claim',
        'worker.lifecycle.ready',
      ]) {
        expect(subjects).not.toContain(subject);
      }
    });

    it('returns correct subjects including dynamic cancel subject', () => {
      const executionId = 'exec-build-test';
      const subjects = buildExecutionAttemptAllowedSubjects(executionId);

      // Must be an array of strings.
      expect(Array.isArray(subjects)).toBe(true);
      expect(subjects.length).toBeGreaterThan(0);

      // Check representative subjects from each category.
      expect(subjects).toContain('execution-attempt.runtime.register');
      expect(subjects).toContain('execution-attempt.operation.admit');
      expect(subjects).toContain('execution-attempt.operation.deliver');
      expect(subjects).toContain('worker.control.outcome.submit');
      expect(subjects).toContain('workflow.getRunContext');
      expect(subjects).toContain('adapterSubsystem.listAdapters');
      expect(subjects).toContain('workflow.bootstrapAuthorityState');

      // Storage subjects
      expect(subjects).toContain('storage:workflow.getExecution');
      expect(subjects).toContain('storage:workflow.setFrame');
      expect(subjects).toContain('storage:workflow.setSpan');
      expect(subjects).toContain('storage:workflow.listFrames');
      expect(subjects).toContain('storage:workflow.getGateInstance');
      expect(subjects).toContain('storage:workflow.setGateInstance');

      // Lifecycle events
      expect(subjects).toContain('workflow.frame.started');
      expect(subjects).toContain('workflow.frame.completed');
      expect(subjects).toContain('workflow.frame.failed');
      expect(subjects).toContain('workflow.frame.sessionLinked');
      expect(subjects).toContain('workflow.execution.progress');

      // Gate subjects
      expect(subjects).toContain('workflow.gate.suspended');
      expect(subjects).toContain('workflow.gate.resumed');
      expect(subjects).toContain('workflow.gate.resolved');
      expect(subjects).toContain('workflow.gate.respond');

      // State RPC
      expect(subjects).toContain('workflow.state.get');
      expect(subjects).toContain('workflow.state.patch');

      // Delegation
      expect(subjects).toContain('workflow.resolveAgent');
      expect(subjects).toContain('workflow.resolveRole');

      // Artifact subjects
      expect(subjects).toContain('artifact.kind.list');
      expect(subjects).toContain('artifact.query');
      expect(subjects).toContain('artifact.resolve');
      expect(subjects).toContain('artifact.create');
      expect(subjects).toContain('artifact.revise');
      expect(subjects).toContain('workflow.artifact.updated');

      // Subagent subjects
      expect(subjects).toContain('subagent.spawn');
      expect(subjects).toContain('subagent.await');
      expect(subjects).toContain('subagent.getStatus');
      expect(subjects).toContain('subagent.kill');

      // Dynamic cancel subject
      expect(subjects).toContain(`workflow.${executionId}.cancel`);
    });

    it('does NOT include mutation or admin subjects', () => {
      const subjects = buildExecutionAttemptAllowedSubjects('exec-1');
      expect(subjects).not.toContain('workflow.define');
      expect(subjects).not.toContain('workflow.delete');
    });
  });
});
