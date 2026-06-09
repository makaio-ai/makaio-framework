import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapter.js';

describe('ClaudeCodeAdapter capabilities', () => {
  it('declares native structured output support', () => {
    const adapter = new ClaudeCodeAdapter({ adapterId: 'adapter-test' });

    expect(adapter.capabilities).toContain('structuredOutput');
  });
});
