import { describe, expect, it } from 'vitest';
import { toolVocabularyForAdapter } from '@makaio/contracts';
import { ClaudeCodeAdapterName } from '../src/constants.js';

// Pins the contracts vocabulary map to this adapter's name: buildQueryOptions translates
// tool lists with the 'claude' vocabulary, so ToolApprovalService must use the same one.
describe('tool vocabulary', () => {
  it('maps the adapter name to the claude vocabulary', () => {
    expect(toolVocabularyForAdapter(ClaudeCodeAdapterName)).toBe('claude');
  });
});
