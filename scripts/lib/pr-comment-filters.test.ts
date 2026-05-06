import { describe, expect, it } from 'vitest';
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

  it('keeps human caution callouts while dropping known bot caution preambles', () => {
    expect(normalizeReviewBody(['[!CAUTION]', 'Do not merge until the migration lands.'].join('\n'))).toBe(
      ['[!CAUTION]', 'Do not merge until the migration lands.'].join('\n'),
    );

    expect(
      normalizeReviewBody(
        ['[!CAUTION]', 'This automated review from CodeRabbit may contain false positives.', '<details>body</details>'].join(
          '\n',
        ),
      ),
    ).toBe('body');
  });

  it('removes CodeRabbit autofix metadata without dropping actionable findings', () => {
    const body = [
      'finding',
      '[🪄 Autofix (Beta)]',
      '',
      'Fix all unresolved CodeRabbit comments on this PR:',
      '',
      '---',
      '',
      '[ℹ️ Review info]',
      'Run configuration',
    ].join('\n');

    expect(normalizeReviewBody(body)).toBe('finding');
  });
});

describe('review actionability', () => {
  it('keeps normalized human review summaries as actionable feedback', () => {
    expect(isActionableReviewBody('please fix the flaky CI workflow')).toBe(true);
    expect(isActionableIssueComment('please check `.github/workflows/ci.yml`')).toBe(true);
  });

  it('drops walkthrough-only bot comments', () => {
    expect(isActionableIssueComment(['[📝 Walkthrough]', '', '## Walkthrough', 'summary only'].join('\n'))).toBe(false);
  });

  it('drops review trigger and bot acknowledgement comments', () => {
    expect(isActionableIssueComment('@coderabbitai review')).toBe(false);
    expect(isActionableIssueComment(['[✅ Actions performed]', '', 'Review triggered.'].join('\n'))).toBe(false);
  });
});
