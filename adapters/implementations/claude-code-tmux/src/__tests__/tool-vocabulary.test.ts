import { describe, expect, it } from 'vitest';
import { toolVocabularyForAdapter } from '@makaio/contracts';
import { ADAPTER_NAME } from '../constants.js';

// Pins the contracts vocabulary map to this adapter's name: its PreToolUse hook forwards
// native Claude Code tool names on toolApprove, so ToolApprovalService must read them with
// the 'claude' vocabulary.
describe('tool vocabulary', () => {
  it('maps the adapter name to the claude vocabulary', () => {
    expect(toolVocabularyForAdapter(ADAPTER_NAME)).toBe('claude');
  });
});
