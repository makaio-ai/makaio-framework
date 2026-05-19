import { describe, expect, it } from 'bun:test';
import { parsePrUrl } from './pr-comment-fetch.js';

describe('parsePrUrl', () => {
  it('parses canonical GitHub pull request URLs', () => {
    expect(parsePrUrl('https://github.com/makaio-ai/makaio-framework/pull/655')).toEqual({
      owner: 'makaio-ai',
      repo: 'makaio-framework',
      pullNumber: 655,
    });
  });

  it('rejects URLs that only contain a PR URL as a substring', () => {
    expect(() =>
      parsePrUrl('https://example.com/?next=https://github.com/makaio-ai/makaio-framework/pull/655'),
    ).toThrow('Invalid PR URL');
  });
});
