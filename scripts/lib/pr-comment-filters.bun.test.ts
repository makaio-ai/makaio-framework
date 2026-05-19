import { describe, expect, it } from 'bun:test';
import { isActionableIssueComment, isActionableReviewBody, normalizeReviewBody } from './pr-comment-filters.js';

describe('normalizeReviewBody', () => {
  it('removes HTML comment markers without dropping surrounding review text', () => {
    const body = ['before', '<!-- bot metadata -->', 'after'].join('\n');

    expect(normalizeReviewBody(body)).toBe(['before', '', 'after'].join('\n'));
  });

  it('removes CodeRabbit suggestion blocks including the suggested patch body', () => {
    const body = [
      'finding',
      '<!-- suggestion_start -->',
      '```ts',
      'const unsafe = true;',
      '```',
      '<!-- suggestion_end -->',
      'details',
    ].join('\n');

    expect(normalizeReviewBody(body)).toBe(['finding', '', 'details'].join('\n'));
  });

  it('drops an incomplete HTML comment tail instead of returning half-normalized markup', () => {
    const body = ['finding', '<!-- unterminated bot metadata', 'hidden tail'].join('\n');

    expect(normalizeReviewBody(body)).toBe('finding');
  });

  it('removes proposed-fix bot blocks with and without colon labels', () => {
    const body = [
      'finding',
      '<details><summary>🛡️ Proposed fix to bound concurrency</summary>',
      'hidden details',
      '</details>',
      '[🛡️ Proposed fix: sanitize output]',
      '```ts',
      'const hidden = true;',
      '```',
      '[🛡️ Proposed fix to sanitize output]',
      'details',
    ].join('\n');

    expect(normalizeReviewBody(body)).toBe(['finding', '', 'details'].join('\n'));
  });
});

describe('review actionability filters', () => {
  it('treats Codex review summaries with priority badges as actionable', () => {
    const body = [
      '💡 Codex Review',
      '',
      'makaio/scripts/lib/sync/scanner.ts',
      '',
      'P9 Badge Stop re-queuing already-migrated deletions',
      'The scanner needs a way to recognize already deleted baseline entries.',
    ].join('\n');

    expect(isActionableReviewBody(body)).toBe(true);
    expect(isActionableIssueComment(body)).toBe(true);
  });
});
