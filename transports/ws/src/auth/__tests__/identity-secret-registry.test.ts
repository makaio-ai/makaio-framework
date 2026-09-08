import { describe, expect, it, afterEach } from 'vitest';
import {
  captureHmacIdentitySecretCleanup,
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedSubjects,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
  rotateHmacIdentitySecret,
} from '../identity-secret-registry.js';

afterEach(() => {
  clearHmacIdentitySecretsForTesting();
});

describe('registerHmacIdentitySecret with claims', () => {
  it('resolves peer context with claims when registered', () => {
    const attemptId = 'attempt-abc-123';
    const executionId = 'exec-abc-123';
    const secret = 'attempt-secret';
    registerHmacIdentitySecret(attemptId, secret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    expect(resolveHmacIdentitySecret(attemptId)).toBe(secret);
    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId },
    });
  });

  it('omits claims from peer context when not registered', () => {
    const identityId = 'exec-no-claims';
    const secret = 'no-claims-secret';
    registerHmacIdentitySecret(identityId, secret, { peerKind: 'test-identity' });

    expect(resolveHmacIdentityPeer(identityId)).toEqual({
      kind: 'test-identity',
      id: identityId,
      authenticated: true,
    });
  });

  it('rejects an empty peer kind', () => {
    expect(() => registerHmacIdentitySecret('empty-kind', 'secret', { peerKind: '  ' })).toThrow(/non-empty peerKind/i);
  });

  it('preserves claims across registration replacement', () => {
    const attemptId = 'attempt-replace';
    const firstCleanup = registerHmacIdentitySecret(attemptId, 'secret-1', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-1' },
    });
    registerHmacIdentitySecret(attemptId, 'secret-2', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-2' },
    });

    // Old cleanup must not remove the newer registration.
    firstCleanup();

    expect(resolveHmacIdentitySecret(attemptId)).toBe('secret-2');
    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId: 'exec-2' },
    });
  });

  it('cleanup removes claims-bearing registration', () => {
    const attemptId = 'attempt-cleanup';
    const cleanup = registerHmacIdentitySecret(attemptId, 'secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-cleanup' },
    });

    cleanup();

    expect(resolveHmacIdentitySecret(attemptId)).toBeNull();
    expect(resolveHmacIdentityPeer(attemptId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureHmacIdentitySecretCleanup
// ---------------------------------------------------------------------------

describe('captureHmacIdentitySecretCleanup', () => {
  it('returns undefined when no registration exists', () => {
    expect(captureHmacIdentitySecretCleanup('missing-attempt')).toBeUndefined();
  });

  it('captures the current cleanup when the original caller closure is unavailable', () => {
    const attemptId = 'attempt-captured-cleanup';
    registerHmacIdentitySecret(attemptId, 'test-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-captured-cleanup' },
    });

    const capturedCleanup = captureHmacIdentitySecretCleanup(attemptId);
    expect(capturedCleanup).toBeTypeOf('function');

    capturedCleanup?.();

    expect(resolveHmacIdentityPeer(attemptId)).toBeNull();
  });

  it('cannot revoke a later rotation of the captured registration', () => {
    const attemptId = 'attempt-captured-stale';
    registerHmacIdentitySecret(attemptId, 'test-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-captured-stale' },
    });
    const capturedCleanup = captureHmacIdentitySecretCleanup(attemptId);

    rotateHmacIdentitySecret(attemptId, 'rotated-test-secret');
    capturedCleanup?.();

    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId: 'exec-captured-stale' },
    });
  });

  it('cannot revoke a later replacement of the captured registration', () => {
    const attemptId = 'attempt-captured-replacement';
    registerHmacIdentitySecret(attemptId, 'test-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-before-replacement' },
    });
    const capturedCleanup = captureHmacIdentitySecretCleanup(attemptId);

    registerHmacIdentitySecret(attemptId, 'replacement-test-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-after-replacement' },
    });
    capturedCleanup?.();

    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId: 'exec-after-replacement' },
    });
  });
});

// ---------------------------------------------------------------------------
// rotateHmacIdentitySecret
// ---------------------------------------------------------------------------

describe('rotateHmacIdentitySecret', () => {
  it('replaces the secret for an existing identity', () => {
    const attemptId = 'attempt-rotate';
    const executionId = 'exec-rotate';
    registerHmacIdentitySecret(attemptId, 'old-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    rotateHmacIdentitySecret(attemptId, 'new-secret');

    expect(resolveHmacIdentitySecret(attemptId)).toBe('new-secret');
  });

  it('preserves peer kind and claims after rotation', () => {
    const attemptId = 'attempt-rotate-claims';
    const executionId = 'exec-rotate-claims';
    registerHmacIdentitySecret(attemptId, 'old-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    rotateHmacIdentitySecret(attemptId, 'new-secret');

    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId },
    });
  });

  it('allows overriding options during rotation', () => {
    const attemptId = 'attempt-rotate-override';
    registerHmacIdentitySecret(attemptId, 'old-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-1' },
    });

    rotateHmacIdentitySecret(attemptId, 'new-secret', {
      claims: { executionId: 'exec-updated' },
    });

    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId: 'exec-updated' },
    });
  });

  it('throws when rotating a non-existent identity', () => {
    expect(() => rotateHmacIdentitySecret('no-such-id', 'new-secret')).toThrow(/cannot rotate.*no-such-id/i);
  });

  it('throws when rotating with an empty secret', () => {
    const attemptId = 'attempt-empty-rotate';
    registerHmacIdentitySecret(attemptId, 'old-secret', { peerKind: 'test-identity' });

    expect(() => rotateHmacIdentitySecret(attemptId, '')).toThrow(/non-empty/i);
  });

  it('returns a cleanup that removes only the rotated registration', () => {
    const attemptId = 'attempt-rotate-cleanup';
    registerHmacIdentitySecret(attemptId, 'old-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId: 'exec-cleanup' },
    });

    const rotatedCleanup = rotateHmacIdentitySecret(attemptId, 'new-secret');
    rotatedCleanup();

    expect(resolveHmacIdentitySecret(attemptId)).toBeNull();
  });

  it('stale cleanup from before rotation cannot revoke the rotated secret', () => {
    const attemptId = 'attempt-stale-cleanup';
    const executionId = 'exec-stale';
    const originalCleanup = registerHmacIdentitySecret(attemptId, 'old-secret', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    rotateHmacIdentitySecret(attemptId, 'new-secret');

    // The original cleanup closure captured the OLD registration object;
    // it must not delete the new one.
    originalCleanup();

    expect(resolveHmacIdentitySecret(attemptId)).toBe('new-secret');
    expect(resolveHmacIdentityPeer(attemptId)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId },
    });
  });

  it('revoking one attempt does not affect another attempt of the same execution', () => {
    const executionId = 'shared-execution';
    const attemptA = 'attempt-A';
    const attemptB = 'attempt-B';

    const cleanupA = registerHmacIdentitySecret(attemptA, 'secret-A', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });
    registerHmacIdentitySecret(attemptB, 'secret-B', {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    // Revoke attempt A.
    cleanupA();

    // Attempt B is unaffected.
    expect(resolveHmacIdentitySecret(attemptA)).toBeNull();
    expect(resolveHmacIdentitySecret(attemptB)).toBe('secret-B');
    expect(resolveHmacIdentityPeer(attemptB)).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptB,
      authenticated: true,
      claims: { executionId },
    });
  });
});

// ---------------------------------------------------------------------------
// allowedSubjects — subject restriction for restricted identities
// ---------------------------------------------------------------------------

describe('allowedSubjects restriction', () => {
  it('resolves allowed subjects when registered', () => {
    const identityId = 'bootstrap-identity';
    registerHmacIdentitySecret(identityId, 'bootstrap-secret', {
      peerKind: 'worker-bootstrap',
      allowedSubjects: ['worker.control.bootstrap.claim'],
    });

    expect(resolveHmacIdentityAllowedSubjects(identityId)).toEqual(new Set(['worker.control.bootstrap.claim']));
  });

  it('returns null for identities without allowedSubjects', () => {
    const identityId = 'unrestricted-identity';
    registerHmacIdentitySecret(identityId, 'secret', { peerKind: 'test-identity' });

    expect(resolveHmacIdentityAllowedSubjects(identityId)).toBeNull();
  });

  it('returns null for unknown identities', () => {
    expect(resolveHmacIdentityAllowedSubjects('no-such-id')).toBeNull();
  });

  it('preserves allowedSubjects across rotation', () => {
    const identityId = 'rotate-restricted';
    registerHmacIdentitySecret(identityId, 'old-secret', {
      peerKind: 'worker-bootstrap',
      allowedSubjects: ['worker.control.bootstrap.claim'],
    });

    rotateHmacIdentitySecret(identityId, 'new-secret');

    expect(resolveHmacIdentityAllowedSubjects(identityId)).toEqual(new Set(['worker.control.bootstrap.claim']));
  });

  it('cleanup removes allowedSubjects along with registration', () => {
    const identityId = 'cleanup-restricted';
    const cleanup = registerHmacIdentitySecret(identityId, 'secret', {
      peerKind: 'worker-bootstrap',
      allowedSubjects: ['worker.control.bootstrap.claim'],
    });

    cleanup();

    expect(resolveHmacIdentityAllowedSubjects(identityId)).toBeNull();
  });
});
