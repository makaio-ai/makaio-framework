import { describe, expect, it } from 'bun:test';
import { getToolUseMetadata } from './claude-code-agent.js';

describe('getToolUseMetadata', () => {
  it('returns metadata for complete tool_use blocks', () => {
    expect(getToolUseMetadata({ type: 'tool_use', id: 'tool-1', name: 'Read' })).toEqual({
      toolCallId: 'tool-1',
      toolName: 'Read',
    });
  });

  it('returns null for non-tool blocks', () => {
    expect(getToolUseMetadata({ type: 'text', id: 'tool-1', name: 'Read' })).toBeNull();
  });

  it('returns null when tool_use is missing required identifiers', () => {
    expect(getToolUseMetadata({ type: 'tool_use', id: 'tool-1' })).toBeNull();
    expect(getToolUseMetadata({ type: 'tool_use', name: 'Read' })).toBeNull();
    expect(getToolUseMetadata({ type: 'tool_use' })).toBeNull();
  });
});
