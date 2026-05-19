import { describe, expect, it } from 'bun:test';
import type { FindingTarget, VCSReviewComment } from '@makaio/contracts';
import { copilotProcessor } from '../processor.js';

/** Minimal valid target used across all test cases. */
const TARGET: FindingTarget = { repository: 'owner/repo', prNumber: 42 };

/**
 * Minimal valid VCS review comment fixture.
 * @param overrides - Partial fields to override on the default comment
 */
function makeComment(overrides: Partial<VCSReviewComment> = {}): VCSReviewComment {
  return {
    id: 101,
    author: 'copilot-pull-request-reviewer[bot]',
    body: 'This variable could be renamed for clarity.',
    path: 'src/foo.ts',
    line: 10,
    inReplyToId: null,
    threadId: 'PRRT_abc123',
    isResolved: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('copilotProcessor', () => {
  describe('identity fields', () => {
    it('exposes the expected processor metadata', () => {
      expect(copilotProcessor.capabilityId).toBe('reviewer-processor');
      expect(copilotProcessor.reviewer).toBe('copilot');
      expect(copilotProcessor.processorKey).toBe('makaio/copilot');
      expect(copilotProcessor.botAuthors).toContain('copilot-pull-request-reviewer[bot]');
    });
  });

  describe('processComments', () => {
    it('maps a plain comment to an open minor finding', () => {
      const comment = makeComment();
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('minor');
      expect(finding?.status).toBe('open');
      expect(finding?.origin).toBe('inline');
      expect(finding?.reviewer).toBe('copilot');
      expect(finding?.file).toBe('src/foo.ts');
      expect(finding?.startLine).toBe(10);
      expect(finding?.endLine).toBe(10);
      expect(finding?.message).toBe('This variable could be renamed for clarity.');
      expect(finding?.agentPrompt).toBeNull();
      expect(finding?.suggestedChanges).toEqual([]);
    });

    it('produces a stable deterministic ID using threadId when present', () => {
      const comment = makeComment({ id: 55, threadId: 'PRRT_xyz' });
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(finding?.id).toBe('src-1:inline:55');
    });

    it('includes path and line in ID when threadId is absent', () => {
      const comment = makeComment({ id: 77, threadId: null, path: 'lib/bar.ts', line: 20 });
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-2',
        target: TARGET,
        comments: [comment],
      });

      expect(finding?.id).toBe('src-2:inline:77:lib/bar.ts:20');
    });

    it('sets status to verified and non-null verifiedAt when isResolved is true', () => {
      const before = Date.now();
      const comment = makeComment({ isResolved: true });
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });
      const after = Date.now();

      expect(finding?.status).toBe('verified');
      expect(finding?.verifiedAt).toBeGreaterThanOrEqual(before);
      expect(finding?.verifiedAt).toBeLessThanOrEqual(after);
    });

    it('extracts suggestion block as a structured change', () => {
      const body = 'Replace with a const.\n```suggestion\nconst x = 1;\n```\nThis avoids mutation.';
      const comment = makeComment({ body });
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(finding?.suggestedChanges).toHaveLength(1);
      expect(finding?.suggestedChanges[0]).toEqual({
        file: 'src/foo.ts',
        oldCode: '',
        newCode: 'const x = 1;\n',
      });
      expect(finding?.message).toBe('Replace with a const.\n\nThis avoids mutation.');
    });

    it('skips reply comments (inReplyToId !== null)', () => {
      const comment = makeComment({ inReplyToId: 99 });
      const findings = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(findings).toHaveLength(0);
    });

    it('skips comments with no file path (general PR comments)', () => {
      const comment = makeComment({ path: null });
      const findings = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(findings).toHaveLength(0);
    });

    it('skips comments with whitespace-only file path', () => {
      const comment = makeComment({ path: '   ' });
      const findings = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(findings).toHaveLength(0);
    });

    it('sets rawCommentId from the numeric comment id', () => {
      const comment = makeComment({ id: 202 });
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(finding?.rawCommentId).toBe(202);
    });

    it('derives createdAt and updatedAt from ISO timestamps', () => {
      const comment = makeComment({
        createdAt: '2024-06-15T12:00:00Z',
        updatedAt: '2024-06-15T13:00:00Z',
      });
      const [finding] = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [comment],
      });

      expect(finding?.createdAt).toBe(new Date('2024-06-15T12:00:00Z').getTime());
      expect(finding?.updatedAt).toBe(new Date('2024-06-15T13:00:00Z').getTime());
    });

    it('returns an empty array for empty input', () => {
      const findings = copilotProcessor.processComments({
        sourceId: 'src-1',
        target: TARGET,
        comments: [],
      });

      expect(findings).toEqual([]);
    });
  });

  describe('processReviewBody', () => {
    it('always returns an empty array', () => {
      const findings = copilotProcessor.processReviewBody({
        sourceId: 'src-1',
        target: TARGET,
        reviews: [
          { id: 1, author: 'bot', body: 'walkthrough text', state: 'COMMENTED', submittedAt: '2024-01-01T00:00:00Z' },
        ],
      });

      expect(findings).toEqual([]);
    });
  });
});
