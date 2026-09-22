import { describe, expect, it } from 'vitest';
import {
  SessionStorageRegisterOwnedImportRequestSchema,
  SessionStorageRegisterOwnedImportResponseSchema,
  SessionStorageVerifyOwnerRequestSchema,
  SessionStorageVerifyOwnerResponseSchema,
} from '../session-storage-namespace.js';

const rootImport = {
  externalSessionId: 'external-1',
  source: 'claude-code-cli',
  cwd: '/workspace/project',
  kind: 'root' as const,
  parentAdapterSessionId: null,
  forkPointMessageId: null,
};

describe('principal-owned import contracts', () => {
  it('accepts a valid owned import without changing its import payload', () => {
    const parsed = SessionStorageRegisterOwnedImportRequestSchema.parse({
      ownerPrincipalId: 'principal-1',
      import: rootImport,
    });

    expect(parsed).toStrictEqual({
      ownerPrincipalId: 'principal-1',
      import: rootImport,
    });
  });

  it.each([
    ['blank', '   '],
    ['longer than 256 characters', 'p'.repeat(257)],
  ])('rejects a %s owner principal ID on both owner requests', (_description, ownerPrincipalId) => {
    expect(
      SessionStorageRegisterOwnedImportRequestSchema.safeParse({
        ownerPrincipalId,
        import: rootImport,
      }).success,
    ).toBe(false);
    expect(
      SessionStorageVerifyOwnerRequestSchema.safeParse({
        sessionId: 'session-1',
        ownerPrincipalId,
      }).success,
    ).toBe(false);
  });

  it('rejects owner requests without an owner principal ID', () => {
    expect(
      SessionStorageRegisterOwnedImportRequestSchema.safeParse({
        import: rootImport,
      }).success,
    ).toBe(false);
    expect(SessionStorageVerifyOwnerRequestSchema.safeParse({ sessionId: 'session-1' }).success).toBe(false);
  });

  it.each(['created', 'owned'] as const)('requires a session ID for a %s import outcome', (outcome) => {
    expect(SessionStorageRegisterOwnedImportResponseSchema.safeParse({ outcome }).success).toBe(false);
  });

  it.each(['unowned', 'foreign', 'missing'] as const)('accepts a %s import outcome without a session ID', (outcome) => {
    expect(SessionStorageRegisterOwnedImportResponseSchema.parse({ outcome })).toStrictEqual({ outcome });
  });

  it('does not return raw owner identities in ownership outcomes', () => {
    expect(
      SessionStorageRegisterOwnedImportResponseSchema.parse({
        outcome: 'owned',
        sessionId: 'session-1',
        ownerPrincipalId: 'principal-1',
      }),
    ).toStrictEqual({ outcome: 'owned', sessionId: 'session-1' });
    expect(
      SessionStorageVerifyOwnerResponseSchema.parse({
        outcome: 'owned',
        ownerPrincipalId: 'principal-1',
      }),
    ).toStrictEqual({ outcome: 'owned' });
  });
});
