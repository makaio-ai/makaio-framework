import { describe, expect, it } from 'vitest';
import { normalizeReviewBody } from './pr-comment-filters.js';

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
});
