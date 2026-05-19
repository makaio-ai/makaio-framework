import { describe, expect, it } from 'bun:test';
import { buildClaudeAccountOrgUuidIdentifier } from './account-identifiers.js';

describe('buildClaudeAccountOrgUuidIdentifier', () => {
  it('returns a strong identifier when both UUIDs are valid', () => {
    expect(
      buildClaudeAccountOrgUuidIdentifier(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).toEqual({
      scheme: 'account-org-uuid',
      value: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      strength: 'strong',
    });
  });

  it('canonicalizes UUID casing before building the identifier', () => {
    expect(
      buildClaudeAccountOrgUuidIdentifier(
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      ),
    ).toEqual({
      scheme: 'account-org-uuid',
      value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      strength: 'strong',
    });
  });

  it('rejects malformed UUID inputs', () => {
    expect(buildClaudeAccountOrgUuidIdentifier('not-a-uuid', '22222222-2222-4222-8222-222222222222')).toBeUndefined();
    expect(buildClaudeAccountOrgUuidIdentifier('11111111-1111-4111-8111-111111111111', 'org-1')).toBeUndefined();
  });
});
