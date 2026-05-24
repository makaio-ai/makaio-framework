import { describe, expect, it } from 'vitest';
import type { GitLogRequest } from '../schemas.js';
import { normalizeLogRequest } from '../log-request-normalizer.js';

describe('normalizeLogRequest', () => {
  it('returns original request when filters are undefined', () => {
    const request: GitLogRequest = { repoPath: '/repo', limit: 10 };

    const result = normalizeLogRequest(request, '/repo/worktree');

    expect(result).toBe(request);
  });

  it('returns original request when selectedWorktree is undefined', () => {
    const request: GitLogRequest = {
      repoPath: '/repo',
      filters: {
        searchQuery: 'fix',
      },
    };

    const result = normalizeLogRequest(request, '/repo/worktree');

    expect(result).toBe(request);
  });

  it('normalizes selectedWorktree while preserving other filter fields', () => {
    const request: GitLogRequest = {
      repoPath: '/repo',
      filters: {
        selectedWorktree: '/repo/wt/../wt',
        searchQuery: 'fix',
        author: 'test',
      },
    };

    const result = normalizeLogRequest(request, '/repo/wt');

    expect(result).not.toBe(request);
    expect(result.filters?.selectedWorktree).toBe('/repo/wt');
    expect(result.filters?.searchQuery).toBe('fix');
    expect(result.filters?.author).toBe('test');
  });
});
