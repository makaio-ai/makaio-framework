import { describe, expect, it } from 'vitest';
import type { VCSReviewComment } from '@makaio/contracts';
import {
  codeRabbitProcessor,
  extractDetailsBlock,
  parseDiffSuggestions,
  parseNitpickSection,
  stripCodeRabbitMetadata,
} from '../processor.js';

describe('extractDetailsBlock', () => {
  it('skips malformed details blocks and still finds later matching sections', () => {
    const body = [
      '<details>',
      'This malformed block has no summary.',
      '</details>',
      '<details>',
      '<summary>🧹 Nitpick comments</summary>',
      'Valid nitpick content.',
      '</details>',
    ].join('\n');

    expect(extractDetailsBlock(body, 'Nitpick comments')).toBe('Valid nitpick content.');
  });
});

describe('stripCodeRabbitMetadata', () => {
  it('removes paired CodeRabbit marker blocks before stripping standalone HTML comments', () => {
    const body = [
      'Visible review text.',
      '<!-- review_rate_limit_status_start -->',
      '{"remaining":0,"limit":10,"reset_at":"2026-05-10T12:00:00.000Z"}',
      '<!-- review_rate_limit_status_end -->',
      '<!-- coderabbit-comment-id:abc123 -->',
      'More visible review text.',
    ].join('\n');

    const cleaned = stripCodeRabbitMetadata(body);

    expect(cleaned).toContain('Visible review text.');
    expect(cleaned).toContain('More visible review text.');
    expect(cleaned).not.toContain('review_rate_limit_status_start');
    expect(cleaned).not.toContain('review_rate_limit_status_end');
    expect(cleaned).not.toContain('"remaining":0');
    expect(cleaned).not.toContain('coderabbit-comment-id');
  });
});

describe('parseNitpickSection', () => {
  it('keeps file-scoped nitpicks when details and summary tags use mixed case', () => {
    const findings = parseNitpickSection(
      [
        '<DETAILS>',
        '<SUMMARY>src/example.ts</SUMMARY>',
        '**Tighten assertion.**',
        '</DETAILS>',
        '<details>',
        '<summary>src/other.ts</summary>',
        '**Add coverage.**',
        '</details>',
      ].join('\n'),
      { sourceId: 'reviewer', target: { repository: 'makaio-ai/makaio', prNumber: 893 }, reviews: [] },
      123,
      1_700_000_000_000,
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.file)).toEqual(['src/example.ts', 'src/other.ts']);
  });
});

describe('parseDiffSuggestions', () => {
  it('preserves separate unified-diff hunks as separate suggestions', () => {
    const suggestions = parseDiffSuggestions(
      [
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const oldName = a;',
        '+const newName = a;',
        '@@ -20,3 +20,3 @@',
        ' const b = 2;',
        '-return oldName + b;',
        '+return newName + b;',
      ].join('\n'),
      'src/example.ts',
    );

    expect(suggestions).toEqual([
      {
        file: 'src/example.ts',
        oldCode: 'const oldName = a;',
        newCode: 'const newName = a;',
      },
      {
        file: 'src/example.ts',
        oldCode: 'return oldName + b;',
        newCode: 'return newName + b;',
      },
    ]);
  });

  it('keeps legacy single-block diffs without hunk headers as one suggestion', () => {
    const suggestions = parseDiffSuggestions(['-old', '+new'].join('\n'), 'src/example.ts');

    expect(suggestions).toEqual([
      {
        file: 'src/example.ts',
        oldCode: 'old',
        newCode: 'new',
      },
    ]);
  });
});

describe('codeRabbitProcessor', () => {
  const target = { repository: 'makaio-ai/makaio', prNumber: 893 };

  function makeCodeRabbitComment(overrides: Partial<VCSReviewComment> = {}): VCSReviewComment {
    return {
      id: 123,
      author: 'coderabbitai[bot]',
      body: [
        '⚠️ Potential issue',
        '',
        '**Guard missing state.**',
        'The update should preserve the resolved status from the source.',
        '',
        '<details>',
        '<summary>🔧 Suggested fix</summary>',
        '',
        '```diff',
        '-status: "open"',
        '+status: "verified"',
        '```',
        '</details>',
        '',
        '<details>',
        '<summary>🤖 Prompt for AI Agents</summary>',
        '<p>Preserve source resolution state.</p>',
        '</details>',
      ].join('\n'),
      path: 'src/reconcile.ts',
      line: 42,
      createdAt: '2026-05-20T12:00:00.000Z',
      updatedAt: '2026-05-20T12:10:00.000Z',
      inReplyToId: null,
      threadId: 'thread-1',
      isResolved: false,
      ...overrides,
    };
  }

  it('processes inline CodeRabbit comments through the public processor contract', () => {
    const findings = codeRabbitProcessor.processComments({
      sourceId: 'coderabbit',
      target,
      comments: [makeCodeRabbitComment()],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'coderabbit:inline:123',
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      origin: 'inline',
      severity: 'major',
      file: 'src/reconcile.ts',
      startLine: 42,
      endLine: 42,
      message:
        'Guard missing state.\n\n⚠️ Potential issue\n\n\nThe update should preserve the resolved status from the source.',
      agentPrompt: 'Preserve source resolution state.',
      status: 'open',
    });
    expect(findings[0]?.suggestedChanges).toEqual([
      {
        file: 'src/reconcile.ts',
        oldCode: 'status: "open"',
        newCode: 'status: "verified"',
      },
    ]);
  });

  it('skips non-actionable inline comments and preserves resolved status', () => {
    const findings = codeRabbitProcessor.processComments({
      sourceId: 'coderabbit',
      target,
      comments: [
        makeCodeRabbitComment({ id: 1, path: null, body: 'General PR comment' }),
        makeCodeRabbitComment({ id: 2, inReplyToId: 1, body: 'Reply comment' }),
        makeCodeRabbitComment({ id: 3, isResolved: true }),
      ],
    });

    expect(findings.map((finding) => ({ id: finding.id, status: finding.status }))).toEqual([
      { id: 'coderabbit:inline:3', status: 'verified' },
    ]);
  });

  it('processes review-body nitpicks through the public processor contract', () => {
    const findings = codeRabbitProcessor.processReviewBody({
      sourceId: 'coderabbit',
      target,
      reviews: [
        {
          id: 88,
          author: 'coderabbitai[bot]',
          state: 'COMMENTED',
          body: [
            '<details>',
            '<summary>🧹 Nitpick comments</summary>',
            '<details>',
            '<summary>src/example.ts</summary>',
            '**Tighten assertion.**',
            '</details>',
            '</details>',
          ].join('\n'),
          submittedAt: '2026-05-20T12:00:00.000Z',
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      sourceId: 'coderabbit',
      reviewer: 'coderabbit',
      origin: 'review-body',
      severity: 'nitpick',
      file: 'src/example.ts',
      message: 'Tighten assertion.',
    });
  });

  it('exposes rate-limit and agent-prompt parsing through the public processor contract', () => {
    const body = [
      '<!-- review_rate_limit_status_start -->',
      '{"remaining":3,"limit":10,"reset_at":"2026-05-20T13:00:00.000Z"}',
      '<!-- review_rate_limit_status_end -->',
      '<details>',
      '<summary>🤖 Prompt for AI Agents</summary>',
      '<p>Use the focused fix.</p>',
      '</details>',
    ].join('\n');

    expect(codeRabbitProcessor.parseRateLimit?.(body)).toMatchObject({
      sourceId: '',
      remaining: 3,
      limit: 10,
      resetsAt: Date.parse('2026-05-20T13:00:00.000Z'),
    });
    expect(codeRabbitProcessor.extractAgentPrompt?.(body)).toBe('Use the focused fix.');
  });
});
