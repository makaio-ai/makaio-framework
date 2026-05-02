import { describe, expect, it } from 'vitest';
import { parseDiffSuggestions } from '../processor.js';

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
