import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedMessageSubjects,
  resolveHmacIdentityAllowedSubscriptionSubjects,
  resolveHmacIdentityPeer,
} from '@makaio/bus-transport-websocket';
import {
  buildExecutionAttemptSubjectAccess,
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

  // ── Directional subject access ──────────────────────────────

  describe('directional subject access', () => {
    it('registers execution-attempt identity with operational message and endpoint subscription grants', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-1',
        executionId: 'exec-1',
      });

      const allowedMessageSubjects = resolveHmacIdentityAllowedMessageSubjects('attempt-1');
      const allowedSubscriptionSubjects = resolveHmacIdentityAllowedSubscriptionSubjects('attempt-1');
      expect(allowedMessageSubjects).not.toBeNull();
      expect(allowedSubscriptionSubjects).toEqual(
        new Set([
          'execution-attempt.operation.deliver',
          'execution-attempt.control.deliver',
          'workflow.gate.respond',
          'workflow.exec-1.cancel',
        ]),
      );
      for (const subject of [
        'execution-attempt.runtime.register',
        'execution-attempt.instruction.get',
        'execution-attempt.operation.admit',
        'execution-attempt.operation.report',
        'execution-attempt.outcome.submit',
        'execution-attempt.control.report',
        'worker.runtime.inputs.get',
        'worker.control.outcome.submit',
        'workflow.getRunContext',
        'storage:workflow.getExecution',
        'workflow.frame.started',
        'workflow.gate.suspended',
        'workflow.state.get',
        'artifact.kind.list',
        'artifact.query',
        'artifact.resolve',
        'subagent.spawn',
        'subagent.getStatus',
      ]) {
        expect(allowedMessageSubjects!.has(subject)).toBe(true);
      }
    });

    it('denies sending endpoint subjects that the attempt may only subscribe to', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-directional-denial',
        executionId: 'exec-directional-denial',
      });

      const allowedMessageSubjects = resolveHmacIdentityAllowedMessageSubjects('attempt-directional-denial');
      const allowedSubscriptionSubjects = resolveHmacIdentityAllowedSubscriptionSubjects('attempt-directional-denial');
      expect(allowedMessageSubjects).not.toBeNull();
      expect(allowedSubscriptionSubjects).not.toBeNull();
      for (const subject of [
        'execution-attempt.operation.deliver',
        'execution-attempt.control.deliver',
        'workflow.gate.respond',
        'workflow.exec-directional-denial.cancel',
      ]) {
        expect(allowedMessageSubjects!.has(subject)).toBe(false);
        expect(allowedSubscriptionSubjects!.has(subject)).toBe(true);
      }
    });

    it('keeps selected-artifact reads and existing writes limited to explicit operations', () => {
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-artifact-read',
        executionId: 'exec-artifact-read',
      });

      const allowedMessageSubjects = resolveHmacIdentityAllowedMessageSubjects('attempt-artifact-read');
      expect(allowedMessageSubjects).not.toBeNull();
      expect([...allowedMessageSubjects!].filter((subject) => subject.startsWith('artifact.')).sort()).toStrictEqual([
        'artifact.create',
        'artifact.kind.list',
        'artifact.patch',
        'artifact.query',
        'artifact.resolve',
        'artifact.resolvePart',
        'artifact.revise',
      ]);
    });

    it('preserves both directional grants after rotation', () => {
      const executionId = 'exec-rot-allowed';
      mintWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot-allowed',
        executionId,
      });

      const messagesBeforeRotation = resolveHmacIdentityAllowedMessageSubjects('attempt-rot-allowed');
      const subscriptionsBeforeRotation = resolveHmacIdentityAllowedSubscriptionSubjects('attempt-rot-allowed');
      expect(messagesBeforeRotation).not.toBeNull();
      expect(subscriptionsBeforeRotation).not.toBeNull();

      rotateWorkflowExecutionBusSecret({
        executionAttemptId: 'attempt-rot-allowed',
        executionId,
      });

      expect(resolveHmacIdentityAllowedMessageSubjects('attempt-rot-allowed')).toEqual(messagesBeforeRotation);
      expect(resolveHmacIdentityAllowedSubscriptionSubjects('attempt-rot-allowed')).toEqual(
        subscriptionsBeforeRotation,
      );
    });
  });

  describe('legacy allowedSubjects rejection', () => {
    it('rejects stale runtime-shaped allowedSubjects through every public registration helper', () => {
      const staleAccess = {
        executionAttemptId: 'attempt-stale-allowed-subjects',
        executionId: 'exec-stale-allowed-subjects',
        allowedSubjects: ['execution-attempt.operation.deliver'],
      };

      expect(() =>
        registerWorkflowExecutionBusSecret({
          ...staleAccess,
          secret: 'stale-runtime-shaped-secret',
        }),
      ).toThrow(/no longer accepts allowedSubjects/);
      expect(() => mintWorkflowExecutionBusSecret(staleAccess)).toThrow(/no longer accepts allowedSubjects/);
      expect(() => mintOrRotateWorkflowExecutionBusSecret(staleAccess)).toThrow(/no longer accepts allowedSubjects/);
      expect(resolveWorkflowExecutionBusSecret(staleAccess.executionAttemptId)).toBeUndefined();
    });
  });

  // ── buildExecutionAttemptSubjectAccess ──────────────────────

  describe('buildExecutionAttemptSubjectAccess', () => {
    it('grants operational message subjects separately from delivery subscriptions', () => {
      const { allowedMessageSubjects, allowedSubscriptionSubjects } =
        buildExecutionAttemptSubjectAccess('exec-protocol');
      expect(
        allowedMessageSubjects.filter(
          (subject) => subject.startsWith('execution-attempt.') || subject.startsWith('worker.'),
        ),
      ).toStrictEqual([
        'execution-attempt.runtime.register',
        'execution-attempt.bootstrap.awaitStart',
        'execution-attempt.instruction.get',
        'execution-attempt.operation.admit',
        'execution-attempt.operation.report',
        'execution-attempt.outcome.submit',
        'execution-attempt.control.report',
        'worker.runtime.inputs.get',
        'worker.control.outcome.submit',
      ]);
      expect(allowedSubscriptionSubjects).toStrictEqual([
        'execution-attempt.operation.deliver',
        'execution-attempt.control.deliver',
        'workflow.gate.respond',
        'workflow.exec-protocol.cancel',
      ]);
      expect([...allowedMessageSubjects, ...allowedSubscriptionSubjects].some((subject) => subject.includes('*'))).toBe(
        false,
      );
      for (const subject of [
        'execution-attempt.runtime.ready',
        'execution-attempt.operation.admitted',
        'execution-attempt.invocation.ready',
        'worker.dispatch',
        'worker.control.bootstrap.claim',
        'worker.lifecycle.ready',
      ]) {
        expect(allowedMessageSubjects).not.toContain(subject);
        expect(allowedSubscriptionSubjects).not.toContain(subject);
      }
    });

    it('puts the dynamic cancel subject only in subscription grants', () => {
      const executionId = 'exec-build-test';
      const { allowedMessageSubjects, allowedSubscriptionSubjects } = buildExecutionAttemptSubjectAccess(executionId);

      expect(Array.isArray(allowedMessageSubjects)).toBe(true);
      expect(Array.isArray(allowedSubscriptionSubjects)).toBe(true);
      expect(allowedMessageSubjects.length).toBeGreaterThan(0);

      expect(allowedMessageSubjects).toContain('execution-attempt.runtime.register');
      expect(allowedMessageSubjects).toContain('execution-attempt.operation.admit');
      expect(allowedMessageSubjects).toContain('worker.control.outcome.submit');
      expect(allowedMessageSubjects).toContain('workflow.getRunContext');
      expect(allowedMessageSubjects).toContain('adapterSubsystem.listAdapters');
      expect(allowedMessageSubjects).toContain('workflow.bootstrapAuthorityState');

      // Storage subjects
      expect(allowedMessageSubjects).toContain('storage:workflow.getExecution');
      expect(allowedMessageSubjects).toContain('storage:workflow.setFrame');
      expect(allowedMessageSubjects).toContain('storage:workflow.setSpan');
      expect(allowedMessageSubjects).toContain('storage:workflow.listFrames');
      expect(allowedMessageSubjects).toContain('storage:workflow.getGateInstance');
      expect(allowedMessageSubjects).toContain('storage:workflow.setGateInstance');

      // Lifecycle events
      expect(allowedMessageSubjects).toContain('workflow.frame.started');
      expect(allowedMessageSubjects).toContain('workflow.frame.completed');
      expect(allowedMessageSubjects).toContain('workflow.frame.failed');
      expect(allowedMessageSubjects).toContain('workflow.frame.sessionLinked');
      expect(allowedMessageSubjects).toContain('workflow.execution.progress');

      // Gate events may be emitted by the attempt; response handling is an inbound endpoint.
      expect(allowedMessageSubjects).toContain('workflow.gate.suspended');
      expect(allowedMessageSubjects).toContain('workflow.gate.resumed');
      expect(allowedMessageSubjects).toContain('workflow.gate.resolved');
      expect(allowedMessageSubjects).not.toContain('workflow.gate.respond');

      // State RPC
      expect(allowedMessageSubjects).toContain('workflow.state.get');
      expect(allowedMessageSubjects).toContain('workflow.state.patch');

      // Delegation
      expect(allowedMessageSubjects).toContain('workflow.resolveAgent');
      expect(allowedMessageSubjects).toContain('workflow.resolveRole');

      // Artifact subjects
      expect(allowedMessageSubjects).toContain('artifact.kind.list');
      expect(allowedMessageSubjects).toContain('artifact.query');
      expect(allowedMessageSubjects).toContain('artifact.resolve');
      expect(allowedMessageSubjects).toContain('artifact.create');
      expect(allowedMessageSubjects).toContain('artifact.revise');
      expect(allowedMessageSubjects).toContain('artifact.patch');
      expect(allowedMessageSubjects).toContain('workflow.artifact.updated');

      // Subagent subjects
      expect(allowedMessageSubjects).toContain('subagent.spawn');
      expect(allowedMessageSubjects).toContain('subagent.await');
      expect(allowedMessageSubjects).toContain('subagent.getStatus');
      expect(allowedMessageSubjects).toContain('subagent.kill');

      expect(allowedMessageSubjects).not.toContain('execution-attempt.operation.deliver');
      expect(allowedMessageSubjects).not.toContain('execution-attempt.control.deliver');
      expect(allowedMessageSubjects).not.toContain(`workflow.${executionId}.cancel`);
      expect(allowedSubscriptionSubjects).toStrictEqual([
        'execution-attempt.operation.deliver',
        'execution-attempt.control.deliver',
        'workflow.gate.respond',
        `workflow.${executionId}.cancel`,
      ]);
    });

    it('does NOT include mutation or admin subjects', () => {
      const { allowedMessageSubjects, allowedSubscriptionSubjects } = buildExecutionAttemptSubjectAccess('exec-1');
      expect(allowedMessageSubjects).not.toContain('workflow.define');
      expect(allowedMessageSubjects).not.toContain('workflow.delete');
      expect(allowedMessageSubjects).not.toContain('workflow.create');
      expect(allowedSubscriptionSubjects).not.toContain('workflow.define');
      expect(allowedSubscriptionSubjects).not.toContain('workflow.delete');
      expect(allowedSubscriptionSubjects).not.toContain('workflow.create');
    });
  });
});
