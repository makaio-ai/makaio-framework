import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedMessageSubjects,
  resolveHmacIdentityAllowedSubscriptionSubjects,
  resolveHmacIdentityParty,
} from '@makaio/bus-transport-websocket';
import { resolveHmacIdentityRequiredSubscriptionFilters } from '../../../../transports/ws/src/auth/identity-secret-registry.js';
import {
  buildWorkflowExecutionSubjectAccess,
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

  it('registers a secret keyed by identityId', () => {
    const registration = mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });

    expect(registration.secret).toHaveLength(64);
    expect(resolveWorkflowExecutionBusSecret('identity-1')).toBe(registration.secret);
  });

  it('registers a caller-provided secret with canonical job-run party kind', () => {
    const registration = registerWorkflowExecutionBusSecret({
      identityId: 'identity-provisioned',
      executionId: 'exec-provisioned',
      secret: 'provider-delivered-secret',
    });

    expect(registration.secret).toBe('provider-delivered-secret');
    expect(resolveWorkflowExecutionBusSecret('identity-provisioned')).toBe('provider-delivered-secret');
    expect(resolveHmacIdentityParty('identity-provisioned')).toEqual({
      kind: 'makaio.job-run',
      id: 'identity-provisioned',
      claims: { executionId: 'exec-provisioned' },
    });
  });

  it('registers with party kind makaio.job-run', () => {
    mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });

    const party = resolveHmacIdentityParty('identity-1');
    expect(party).toEqual({
      kind: 'makaio.job-run',
      id: 'identity-1',
      claims: { executionId: 'exec-1' },
    });
  });

  it('attaches executionId as a claim on the party', () => {
    mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });

    const party = resolveHmacIdentityParty('identity-1');
    expect(party?.claims).toEqual({ executionId: 'exec-1' });
  });

  it('cleans up a secret by its transport identity', () => {
    const registration = mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });

    registration.cleanup();

    expect(resolveWorkflowExecutionBusSecret('identity-1')).toBeUndefined();
    expect(resolveHmacIdentityParty('identity-1')).toBeNull();
  });

  it('does not let an older cleanup remove a replacement secret for the same identity', () => {
    const first = mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });
    const second = mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });

    first.cleanup();

    expect(resolveWorkflowExecutionBusSecret('identity-1')).toBe(second.secret);

    second.cleanup();

    expect(resolveWorkflowExecutionBusSecret('identity-1')).toBeUndefined();
  });

  it('revoking one identity leaves other identities for the same execution active', () => {
    const first = mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });
    const second = mintWorkflowExecutionBusSecret({
      identityId: 'identity-2',
      executionId: 'exec-1',
    });

    first.cleanup();

    expect(resolveWorkflowExecutionBusSecret('identity-1')).toBeUndefined();
    expect(resolveHmacIdentityParty('identity-1')).toBeNull();

    expect(resolveWorkflowExecutionBusSecret('identity-2')).toBe(second.secret);
    const party2 = resolveHmacIdentityParty('identity-2');
    expect(party2).toEqual({
      kind: 'makaio.job-run',
      id: 'identity-2',
      claims: { executionId: 'exec-1' },
    });
  });

  it('uses the transport identity instead of the execution claim for secret lookup', () => {
    mintWorkflowExecutionBusSecret({
      identityId: 'identity-1',
      executionId: 'exec-1',
    });

    expect(resolveWorkflowExecutionBusSecret('exec-1')).toBeUndefined();
  });

  // ── Rotation ────────────────────────────────────────────────

  describe('rotateWorkflowExecutionBusSecret', () => {
    it('preserves caller-supplied required subscription filters after rotation', () => {
      const identity = { identityId: 'filtered-identity', executionId: 'filtered-execution' };
      const endpoint = 'test.receive';
      const filters = { [endpoint]: { executionId: identity.executionId } };
      const registration = {
        ...identity,
        allowedSubscriptionSubjects: [endpoint],
        requiredSubscriptionFilters: filters,
      };

      mintWorkflowExecutionBusSecret(registration);
      expect(resolveHmacIdentityAllowedSubscriptionSubjects(identity.identityId)).toEqual(new Set([endpoint]));
      expect(resolveHmacIdentityAllowedMessageSubjects(identity.identityId)).not.toContain(endpoint);
      expect(resolveHmacIdentityRequiredSubscriptionFilters(identity.identityId)).toEqual(filters);

      rotateWorkflowExecutionBusSecret(identity);
      expect(resolveHmacIdentityRequiredSubscriptionFilters(identity.identityId)).toEqual(filters);
    });

    it('replaces the registered secret for an existing identity', () => {
      const original = mintWorkflowExecutionBusSecret({
        identityId: 'identity-rot',
        executionId: 'exec-1',
      });
      const rotated = rotateWorkflowExecutionBusSecret({
        identityId: 'identity-rot',
        executionId: 'exec-1',
      });

      expect(rotated.secret).not.toBe(original.secret);
      expect(resolveWorkflowExecutionBusSecret('identity-rot')).toBe(rotated.secret);
    });

    it('preserves party kind and claims after rotation', () => {
      mintWorkflowExecutionBusSecret({
        identityId: 'identity-rot',
        executionId: 'exec-1',
      });
      rotateWorkflowExecutionBusSecret({
        identityId: 'identity-rot',
        executionId: 'exec-1',
      });

      const party = resolveHmacIdentityParty('identity-rot');
      expect(party).toEqual({
        kind: 'makaio.job-run',
        id: 'identity-rot',
        claims: { executionId: 'exec-1' },
      });
    });

    it('throws when no registration exists for the identity', () => {
      expect(() =>
        rotateWorkflowExecutionBusSecret({
          identityId: 'no-such-identity',
          executionId: 'exec-1',
        }),
      ).toThrow(/not registered for execution/);
    });

    it('rejects rotation when the identity belongs to another execution', () => {
      const original = mintWorkflowExecutionBusSecret({
        identityId: 'identity-rot',
        executionId: 'exec-original',
      });

      expect(() =>
        rotateWorkflowExecutionBusSecret({
          identityId: 'identity-rot',
          executionId: 'exec-other',
        }),
      ).toThrow(/not registered for execution "exec-other"/);
      expect(resolveWorkflowExecutionBusSecret('identity-rot')).toBe(original.secret);
      expect(resolveHmacIdentityParty('identity-rot')?.claims).toEqual({
        executionId: 'exec-original',
      });
    });
  });

  // ── Mint or rotate ──────────────────────────────────────────

  describe('mintOrRotateWorkflowExecutionBusSecret', () => {
    it('mints a new secret when no registration exists', () => {
      const result = mintOrRotateWorkflowExecutionBusSecret({
        identityId: 'identity-mor',
        executionId: 'exec-1',
      });

      expect(result.secret).toHaveLength(64);
      expect(resolveWorkflowExecutionBusSecret('identity-mor')).toBe(result.secret);
    });

    it('rotates the secret when a registration already exists', () => {
      const first = mintOrRotateWorkflowExecutionBusSecret({
        identityId: 'identity-mor',
        executionId: 'exec-1',
      });
      const second = mintOrRotateWorkflowExecutionBusSecret({
        identityId: 'identity-mor',
        executionId: 'exec-1',
      });

      expect(second.secret).not.toBe(first.secret);
      expect(resolveWorkflowExecutionBusSecret('identity-mor')).toBe(second.secret);
    });

    it('old cleanup does not revoke a rotated secret from mintOrRotate', () => {
      const first = mintOrRotateWorkflowExecutionBusSecret({
        identityId: 'identity-mor',
        executionId: 'exec-1',
      });
      const second = mintOrRotateWorkflowExecutionBusSecret({
        identityId: 'identity-mor',
        executionId: 'exec-1',
      });

      first.cleanup();

      expect(resolveWorkflowExecutionBusSecret('identity-mor')).toBe(second.secret);
    });
  });

  // ── Capture current cleanup ─────────────────────────────────

  describe('captureWorkflowExecutionBusSecretCleanup', () => {
    it('returns undefined for an unregistered identity', () => {
      expect(
        captureWorkflowExecutionBusSecretCleanup({
          identityId: 'missing-identity',
          executionId: 'missing-execution',
        }),
      ).toBeUndefined();
    });

    it('captures a matching cleanup when the original registration closure is unavailable', () => {
      const identityId = 'identity-captured-cleanup';
      const executionId = 'exec-captured-cleanup';
      mintWorkflowExecutionBusSecret({ identityId, executionId });

      const capturedCleanup = captureWorkflowExecutionBusSecretCleanup({ identityId, executionId });
      expect(capturedCleanup).toBeTypeOf('function');

      capturedCleanup?.();

      expect(resolveWorkflowExecutionBusSecret(identityId)).toBeUndefined();
    });

    it('refuses an identity registered for another party kind', () => {
      registerHmacIdentitySecret('identity-wrong-kind', 'test-secret', {
        partyKind: 'test.worker-bootstrap',
        claims: { executionId: 'exec-wrong-kind' },
      });

      expect(() =>
        captureWorkflowExecutionBusSecretCleanup({
          identityId: 'identity-wrong-kind',
          executionId: 'exec-wrong-kind',
        }),
      ).toThrow(/not registered for execution/);
    });

    it('refuses an identity registered for another execution', () => {
      mintWorkflowExecutionBusSecret({
        identityId: 'identity-wrong-execution',
        executionId: 'exec-original',
      });

      expect(() =>
        captureWorkflowExecutionBusSecretCleanup({
          identityId: 'identity-wrong-execution',
          executionId: 'exec-other',
        }),
      ).toThrow(/not registered for execution "exec-other"/);
    });

    it('does not let a captured cleanup revoke a later rotation', () => {
      const identityId = 'identity-captured-rotation';
      const executionId = 'exec-captured-rotation';
      mintWorkflowExecutionBusSecret({ identityId, executionId });
      const capturedCleanup = captureWorkflowExecutionBusSecretCleanup({ identityId, executionId });

      const rotated = rotateWorkflowExecutionBusSecret({ identityId, executionId });
      capturedCleanup?.();

      expect(resolveWorkflowExecutionBusSecret(identityId)).toBe(rotated.secret);
    });
  });

  // ── Directional subject access ──────────────────────────────

  describe('directional subject access', () => {
    it('registers job-run identities with the default directional grants', () => {
      const identityId = 'default-identity';
      const executionId = 'default-execution';

      mintWorkflowExecutionBusSecret({ identityId, executionId });

      const { allowedMessageSubjects, allowedSubscriptionSubjects } = buildWorkflowExecutionSubjectAccess(executionId);
      expect(resolveHmacIdentityAllowedMessageSubjects(identityId)).toEqual(new Set(allowedMessageSubjects));
      expect(resolveHmacIdentityAllowedSubscriptionSubjects(identityId)).toEqual(new Set(allowedSubscriptionSubjects));
      expect(resolveHmacIdentityRequiredSubscriptionFilters(identityId)).toBeNull();
    });

    it('mintOrRotateWorkflowExecutionBusSecret reflects allowedMessageSubjects on first mint and preserves them through rotation', () => {
      const identityId = 'identity-mint-or-rotate-extended';
      const executionId = 'exec-mint-or-rotate-extended';

      // First call: mint with an explicit subject list — it REPLACES the default, not merges with it.
      mintOrRotateWorkflowExecutionBusSecret({
        identityId,
        executionId,
        allowedMessageSubjects: ['agent.started', 'workflow.bootstrapAuthorityState'],
      });

      const afterMint = resolveHmacIdentityAllowedMessageSubjects(identityId);
      expect(afterMint).toEqual(new Set(['agent.started', 'workflow.bootstrapAuthorityState']));

      // Second call: rotate — party metadata (including allowedMessageSubjects) is preserved exactly.
      mintOrRotateWorkflowExecutionBusSecret({ identityId, executionId });
      const afterRotate = resolveHmacIdentityAllowedMessageSubjects(identityId);
      expect(afterRotate).toEqual(new Set(['agent.started', 'workflow.bootstrapAuthorityState']));
    });

    it('keeps selected-artifact reads and existing writes limited to explicit operations', () => {
      mintWorkflowExecutionBusSecret({
        identityId: 'identity-artifact-read',
        executionId: 'exec-artifact-read',
      });

      const allowedMessageSubjects = resolveHmacIdentityAllowedMessageSubjects('identity-artifact-read');
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
        identityId: 'identity-rot-allowed',
        executionId,
      });

      const messagesBeforeRotation = resolveHmacIdentityAllowedMessageSubjects('identity-rot-allowed');
      const subscriptionsBeforeRotation = resolveHmacIdentityAllowedSubscriptionSubjects('identity-rot-allowed');
      expect(messagesBeforeRotation).not.toBeNull();
      expect(subscriptionsBeforeRotation).not.toBeNull();

      rotateWorkflowExecutionBusSecret({
        identityId: 'identity-rot-allowed',
        executionId,
      });

      expect(resolveHmacIdentityAllowedMessageSubjects('identity-rot-allowed')).toEqual(messagesBeforeRotation);
      expect(resolveHmacIdentityAllowedSubscriptionSubjects('identity-rot-allowed')).toEqual(
        subscriptionsBeforeRotation,
      );
    });
  });

  describe('legacy allowedSubjects rejection', () => {
    it('rejects stale runtime-shaped allowedSubjects through every public registration helper', () => {
      const staleAccess = {
        identityId: 'identity-stale-allowed-subjects',
        executionId: 'exec-stale-allowed-subjects',
        allowedSubjects: ['test.receive'],
      };

      expect(() =>
        registerWorkflowExecutionBusSecret({
          ...staleAccess,
          secret: 'stale-runtime-shaped-secret',
        }),
      ).toThrow(/no longer accepts allowedSubjects/);
      expect(() => mintWorkflowExecutionBusSecret(staleAccess)).toThrow(/no longer accepts allowedSubjects/);
      expect(() => mintOrRotateWorkflowExecutionBusSecret(staleAccess)).toThrow(/no longer accepts allowedSubjects/);
      expect(resolveWorkflowExecutionBusSecret(staleAccess.identityId)).toBeUndefined();
    });
  });

  // ── buildWorkflowExecutionSubjectAccess ──────────────────────

  describe('buildWorkflowExecutionSubjectAccess', () => {
    it('excludes attempt-specific and privileged subjects from the default grants', () => {
      const { allowedMessageSubjects, allowedSubscriptionSubjects } = buildWorkflowExecutionSubjectAccess('exec-1');
      const grants = [...allowedMessageSubjects, ...allowedSubscriptionSubjects];
      expect(grants.some((subject) => subject.includes('*'))).toBe(false);
      for (const subject of [
        'workflow.bootstrapAuthorityState',
        'worker.dispatch',
        'worker.control.bootstrap.claim',
        'worker.lifecycle.ready',
      ]) {
        expect(grants).not.toContain(subject);
      }
    });

    it('puts the dynamic cancel subject only in subscription grants', () => {
      const executionId = 'exec-build-test';
      const { allowedMessageSubjects, allowedSubscriptionSubjects } = buildWorkflowExecutionSubjectAccess(executionId);

      expect(Array.isArray(allowedMessageSubjects)).toBe(true);
      expect(Array.isArray(allowedSubscriptionSubjects)).toBe(true);
      expect(allowedMessageSubjects.length).toBeGreaterThan(0);

      expect(allowedMessageSubjects).toContain('worker.runtime.inputs.get');
      expect(allowedMessageSubjects).toContain('worker.control.outcome.submit');
      expect(allowedMessageSubjects).toContain('workflow.getRunContext');
      expect(allowedMessageSubjects).toContain('adapterSubsystem.listAdapters');

      // Storage subjects
      expect(allowedMessageSubjects).toContain('storage:workflow.getExecution');
      expect(allowedMessageSubjects).toContain('storage:workflow.setFrame');
      expect(allowedMessageSubjects).toContain('storage:workflow.setSpan');
      expect(allowedMessageSubjects).toContain('storage:workflow.listFrames');

      // Lifecycle events
      expect(allowedMessageSubjects).toContain('workflow.frame.started');
      expect(allowedMessageSubjects).toContain('workflow.frame.completed');
      expect(allowedMessageSubjects).toContain('workflow.frame.failed');
      expect(allowedMessageSubjects).toContain('workflow.frame.sessionLinked');
      expect(allowedMessageSubjects).not.toContain('workflow.execution.progress');

      // State RPC
      expect(allowedMessageSubjects).toContain('workflow.state.get');
      expect(allowedMessageSubjects).toContain('workflow.state.patch');

      // Delegation
      expect(allowedMessageSubjects).toContain('workflow.resolveRole');

      // Artifact subjects
      expect(allowedMessageSubjects).toContain('artifact.kind.list');
      expect(allowedMessageSubjects).toContain('artifact.query');
      expect(allowedMessageSubjects).toContain('artifact.resolve');
      expect(allowedMessageSubjects).toContain('artifact.create');
      expect(allowedMessageSubjects).toContain('artifact.revise');
      expect(allowedMessageSubjects).toContain('artifact.patch');
      expect(allowedMessageSubjects).not.toContain('workflow.artifact.updated');

      // Subagent subjects
      expect(allowedMessageSubjects).toContain('subagent.spawn');
      expect(allowedMessageSubjects).toContain('subagent.await');
      expect(allowedMessageSubjects).toContain('subagent.getStatus');
      expect(allowedMessageSubjects).toContain('subagent.kill');

      expect(allowedMessageSubjects).not.toContain(`workflow.${executionId}.cancel`);
      expect(allowedSubscriptionSubjects).toStrictEqual([`workflow.${executionId}.cancel`]);
    });

    it('does NOT include mutation or admin subjects', () => {
      const { allowedMessageSubjects, allowedSubscriptionSubjects } = buildWorkflowExecutionSubjectAccess('exec-1');
      expect(allowedMessageSubjects).not.toContain('workflow.define');
      expect(allowedMessageSubjects).not.toContain('workflow.delete');
      expect(allowedMessageSubjects).not.toContain('workflow.create');
      expect(allowedSubscriptionSubjects).not.toContain('workflow.define');
      expect(allowedSubscriptionSubjects).not.toContain('workflow.delete');
      expect(allowedSubscriptionSubjects).not.toContain('workflow.create');
    });
  });
});
