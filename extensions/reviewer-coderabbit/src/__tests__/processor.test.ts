import { describe, expect, it } from 'vitest';
import { parseDiffSuggestions, stripCodeRabbitMetadata } from '../processor.js';

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
