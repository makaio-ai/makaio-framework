import { describe, expect, it } from 'vitest';

import {
  formatRepoContextKey,
  normalizeRepoContext,
  parseRepoContextKey,
  RepoContextSchema,
  sameRepoContext,
} from '../repo-context.js';

describe('repository context', () => {
  it('normalizes GitHub Cloud paths without changing other providers', () => {
    expect(normalizeRepoContext({ kind: ' github-cloud ', path: ' Makaio-AI/Makaio ' })).toEqual({
      kind: 'github-cloud',
      path: 'makaio-ai/makaio',
    });
    expect(normalizeRepoContext({ kind: 'gitlab', path: 'Group/Repo' })).toEqual({
      kind: 'gitlab',
      path: 'Group/Repo',
    });
  });

  it('formats, parses, and compares normalized identities', () => {
    expect(formatRepoContextKey({ kind: 'github-cloud', path: 'Makaio-AI/Makaio' })).toBe(
      'github-cloud:makaio-ai/makaio',
    );
    expect(parseRepoContextKey('github-cloud:Makaio-AI/Makaio')).toEqual({
      kind: 'github-cloud',
      path: 'makaio-ai/makaio',
    });
    expect(parseRepoContextKey('custom:path:with:colons')).toEqual({ kind: 'custom', path: 'path:with:colons' });
    expect(parseRepoContextKey('invalid')).toBeNull();
    expect(parseRepoContextKey(' : path ')).toBeNull();
    expect(
      sameRepoContext(
        { kind: 'github-cloud', path: 'Makaio-AI/Makaio' },
        { kind: 'github-cloud', path: 'makaio-ai/makaio' },
      ),
    ).toBe(true);
    expect(sameRepoContext({ kind: 'gitlab', path: 'group/repo' }, { kind: 'github-cloud', path: 'group/repo' })).toBe(
      false,
    );
    expect(sameRepoContext({ kind: 'a', path: 'b:c' }, { kind: 'a:b', path: 'c' })).toBe(false);
    expect(() => formatRepoContextKey({ kind: 'a:b', path: 'c' })).toThrow("kind must not contain ':'");
  });

  it('canonicalizes schema values while preserving unknown-field stripping', () => {
    expect(RepoContextSchema.parse({ kind: ' github-cloud ', path: ' Owner/Repo ', host: 'ignored' })).toEqual({
      kind: 'github-cloud',
      path: 'Owner/Repo',
    });
    expect(RepoContextSchema.safeParse({ kind: ' ', path: 'owner/repo' }).success).toBe(false);
  });
});
