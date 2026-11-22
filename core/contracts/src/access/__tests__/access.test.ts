import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../../index.js';
import { CoreBoundaryKind } from '../../boundary/index.js';
import { AccessRevokeRequestSchema, AccessRevokeResponseSchema, AccessSubjects } from '../index.js';

describe('access revocation schemas', () => {
  it('accepts any revocation key, also one that matches nothing, and refuses a missing one', () => {
    expect(AccessRevokeRequestSchema.parse({ revocationKey: 'key-1' })).toEqual({ revocationKey: 'key-1' });
    expect(AccessRevokeRequestSchema.safeParse({ revocationKey: '' }).success).toBe(true);
    expect(AccessRevokeRequestSchema.safeParse({ revocationKey: 1 }).success).toBe(false);
    expect(AccessRevokeRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses unknown fields in request and response', () => {
    expect(AccessRevokeRequestSchema.safeParse({ revocationKey: 'key-1', extra: true }).success).toBe(false);
    expect(AccessRevokeResponseSchema.parse({})).toEqual({});
    expect(AccessRevokeResponseSchema.safeParse({ revoked: 1 }).success).toBe(false);
  });
});

describe('access namespace', () => {
  it('declares the subjects denied and revoke', () => {
    expect(AccessSubjects.denied.subject).toBe('denied');
    expect(AccessSubjects.revoke.subject).toBe('revoke');
  });

  it('is exported from the package root together with the boundary kinds', () => {
    expect(rootBarrel.AccessSubjects).toBe(AccessSubjects);
    expect(rootBarrel.AccessRevokeRequestSchema).toBe(AccessRevokeRequestSchema);
    expect(rootBarrel.CoreBoundaryKind).toBe(CoreBoundaryKind);
    expect(Object.values(CoreBoundaryKind).sort()).toEqual([
      'makaio.bus-connection',
      'makaio.http-route',
      'makaio.mcp-http',
    ]);
  });
});
