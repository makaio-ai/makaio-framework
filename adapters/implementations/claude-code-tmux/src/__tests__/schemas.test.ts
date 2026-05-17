import { describe, expect, it } from 'vitest';
import { ClaudeCodeTmuxProviderConfigSchema } from '../schemas.js';

describe('ClaudeCodeTmuxProviderConfigSchema', () => {
  it('accepts an absolute binaryPath', () => {
    expect(ClaudeCodeTmuxProviderConfigSchema.parse({ binaryPath: '/usr/local/bin/claude' }).binaryPath).toBe(
      '/usr/local/bin/claude',
    );
  });

  it('rejects a relative binaryPath', () => {
    expect(() => ClaudeCodeTmuxProviderConfigSchema.parse({ binaryPath: 'bin/claude' })).toThrow(
      /binaryPath must be an absolute path/,
    );
  });
});
