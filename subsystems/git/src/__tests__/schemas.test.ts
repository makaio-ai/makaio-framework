import { describe, it, expect } from 'vitest';
import {
  GitBranchRequestSchema,
  GitBranchResponseSchema,
  GitCommitRequestSchema,
  GitCommitResponseSchema,
  GitStatusResponseSchema,
  GitWorktreesResponseSchema,
  GitRemotesResponseSchema,
  GitDefaultBranchResponseSchema,
  GitCommitEventSchema,
  GitCheckoutEventSchema,
  GitAddRepoRequestSchema,
  GitAddRepoResponseSchema,
  GitLogFiltersSchema,
  GitLogRequestSchema,
  GitLogResponseSchema,
  GitFileAtRevisionRequestSchema,
  GitFileAtRevisionResponseSchema,
} from '../schemas.js';

describe('Git schemas', () => {
  describe('Query schemas', () => {
    describe('GitBranch', () => {
      it('should validate request with optional repoPath', () => {
        expect(GitBranchRequestSchema.parse({})).toEqual({});
        expect(GitBranchRequestSchema.parse({ repoPath: '/tmp/repo' })).toEqual({
          repoPath: '/tmp/repo',
        });
      });

      it('should validate response', () => {
        const response = { current: 'main', isDetached: false };
        expect(GitBranchResponseSchema.parse(response)).toEqual(response);
      });
    });

    describe('GitCommit', () => {
      it('should validate request with optional ref', () => {
        expect(GitCommitRequestSchema.parse({})).toEqual({});
        expect(GitCommitRequestSchema.parse({ ref: 'HEAD~1' })).toEqual({
          ref: 'HEAD~1',
        });
      });

      it('should validate response', () => {
        const response = {
          hash: 'abc123',
          message: 'feat: add feature',
          author: 'Dev',
          email: 'dev@example.com',
          date: '2025-12-23T10:00:00Z',
        };
        expect(GitCommitResponseSchema.parse(response)).toEqual(response);
      });
    });

    describe('GitStatus', () => {
      it('should validate response with file arrays', () => {
        const response = {
          staged: ['file1.ts'],
          modified: ['file2.ts'],
          untracked: ['file3.ts'],
          conflicted: [],
        };
        expect(GitStatusResponseSchema.parse(response)).toEqual(response);
      });
    });

    describe('GitWorktrees', () => {
      it('should validate response with worktree array', () => {
        const response = {
          worktrees: [
            { path: '/repo', branch: 'main', commit: 'abc123', isMain: true },
            { path: '/repo-feature', branch: 'feature', commit: 'def456', isMain: false },
          ],
        };
        expect(GitWorktreesResponseSchema.parse(response)).toEqual(response);
      });
    });

    describe('GitRemotes', () => {
      it('should validate response with remotes array', () => {
        const response = {
          remotes: [
            {
              name: 'origin',
              fetchUrl: 'git@github.com:user/repo.git',
              pushUrl: 'git@github.com:user/repo.git',
            },
          ],
        };
        expect(GitRemotesResponseSchema.parse(response)).toEqual(response);
      });
    });

    describe('GitDefaultBranch', () => {
      it('should validate response', () => {
        const response = { branch: 'main' };
        expect(GitDefaultBranchResponseSchema.parse(response)).toEqual(response);
      });
    });

    describe('GitLog schemas', () => {
      describe('GitLogFiltersSchema', () => {
        it('should accept valid filters', () => {
          const result = GitLogFiltersSchema.safeParse({
            branches: ['main', 'feature/test'],
            paths: ['src/'],
            author: 'john@example.com',
            since: '2024-01-01',
            until: '2024-12-31',
          });
          expect(result.success).toBe(true);
        });

        it('should accept empty object', () => {
          const result = GitLogFiltersSchema.safeParse({});
          expect(result.success).toBe(true);
        });
      });

      describe('GitLogRequestSchema', () => {
        it('should accept request with filters', () => {
          const result = GitLogRequestSchema.safeParse({
            repoPath: '/path/to/repo',
            limit: 500,
            ref: 'HEAD',
            filters: { branches: ['main'] },
          });
          expect(result.success).toBe(true);
        });

        it('should use defaults', () => {
          const result = GitLogRequestSchema.safeParse({});
          expect(result.success).toBe(true);
        });

        it('should reject limit below minimum', () => {
          const result = GitLogRequestSchema.safeParse({
            limit: 0,
          });
          expect(result.success).toBe(false);
        });

        it('should reject limit above maximum', () => {
          const result = GitLogRequestSchema.safeParse({
            limit: 10001,
          });
          expect(result.success).toBe(false);
        });
      });

      describe('GitLogResponseSchema', () => {
        it('should validate response with commits and refs', () => {
          const result = GitLogResponseSchema.safeParse({
            commits: [
              {
                hash: 'abc123def456',
                shortHash: 'abc123d',
                message: 'Initial commit',
                author: 'John Doe',
                email: 'john@example.com',
                date: '2024-01-15T10:30:00Z',
                parents: [],
              },
            ],
            refs: {
              branches: { main: 'abc123def456' },
              remoteBranches: { 'origin/main': 'abc123def456' },
              tags: { 'v1.0.0': 'abc123def456' },
              HEAD: 'abc123def456',
            },
            truncated: false,
          });
          expect(result.success).toBe(true);
        });

        it('should validate commit with multiple parents (merge commit)', () => {
          const result = GitLogResponseSchema.safeParse({
            commits: [
              {
                hash: 'abc123def456',
                shortHash: 'abc123d',
                message: 'Merge branch feature',
                author: 'John Doe',
                email: 'john@example.com',
                date: '2024-01-15T10:30:00Z',
                parents: ['parent1hash', 'parent2hash'],
              },
            ],
            refs: {
              branches: {},
              remoteBranches: {},
              tags: {},
              HEAD: 'abc123def456',
            },
            truncated: true,
          });
          expect(result.success).toBe(true);
        });
      });
    });

    describe('GitFileAtRevision schemas', () => {
      describe('GitFileAtRevisionRequestSchema', () => {
        it('should require path and ref', () => {
          const result = GitFileAtRevisionRequestSchema.safeParse({
            path: 'src/index.ts',
            ref: 'HEAD',
          });
          expect(result.success).toBe(true);
        });

        it('should accept optional repoPath', () => {
          const result = GitFileAtRevisionRequestSchema.safeParse({
            repoPath: '/path/to/repo',
            path: 'src/index.ts',
            ref: 'abc123',
          });
          expect(result.success).toBe(true);
        });

        it('should reject missing path', () => {
          const result = GitFileAtRevisionRequestSchema.safeParse({
            ref: 'HEAD',
          });
          expect(result.success).toBe(false);
        });

        it('should reject missing ref', () => {
          const result = GitFileAtRevisionRequestSchema.safeParse({
            path: 'src/index.ts',
          });
          expect(result.success).toBe(false);
        });
      });

      describe('GitFileAtRevisionResponseSchema', () => {
        it('should validate response with content', () => {
          const result = GitFileAtRevisionResponseSchema.safeParse({
            content: 'console.log("hello");',
            isBinary: false,
          });
          expect(result.success).toBe(true);
        });

        it('should validate binary file response', () => {
          const result = GitFileAtRevisionResponseSchema.safeParse({
            content: '',
            isBinary: true,
          });
          expect(result.success).toBe(true);
        });
      });
    });
  });

  describe('Event schemas', () => {
    describe('GitCommitEvent', () => {
      it('should validate commit event', () => {
        const event = {
          repoPath: '/path/to/repo',
          hash: 'abc123',
          message: 'feat: add feature',
          author: 'Dev',
          email: 'dev@example.com',
          branch: 'main',
          timestamp: '2025-12-23T10:00:00Z',
        };
        expect(GitCommitEventSchema.parse(event)).toEqual(event);
      });

      it('should allow optional worktree', () => {
        const event = {
          repoPath: '/path/to/repo',
          hash: 'abc123',
          message: 'feat: add feature',
          author: 'Dev',
          email: 'dev@example.com',
          branch: 'main',
          timestamp: '2025-12-23T10:00:00Z',
          worktree: 'feature-branch',
        };
        expect(GitCommitEventSchema.parse(event)).toEqual(event);
      });
    });

    describe('GitCheckoutEvent', () => {
      it('should validate checkout event', () => {
        const event = {
          repoPath: '/path/to/repo',
          currentBranch: 'feature',
          timestamp: '2025-12-23T10:00:00Z',
        };
        expect(GitCheckoutEventSchema.parse(event)).toEqual(event);
      });

      it('should allow optional previousBranch', () => {
        const event = {
          repoPath: '/path/to/repo',
          previousBranch: 'main',
          currentBranch: 'feature',
          timestamp: '2025-12-23T10:00:00Z',
        };
        expect(GitCheckoutEventSchema.parse(event)).toEqual(event);
      });
    });
  });

  describe('Control schemas', () => {
    describe('GitAddRepo', () => {
      it('should validate request', () => {
        const request = { repoPath: '/path/to/repo' };
        expect(GitAddRepoRequestSchema.parse(request)).toEqual(request);
      });

      it('should validate response', () => {
        expect(GitAddRepoResponseSchema.parse({ success: true })).toEqual({ success: true });
        expect(GitAddRepoResponseSchema.parse({ success: false, error: 'Not found' })).toEqual({
          success: false,
          error: 'Not found',
        });
      });
    });
  });
});
