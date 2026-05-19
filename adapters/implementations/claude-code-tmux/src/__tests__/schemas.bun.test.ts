import { describe, expect, it } from 'bun:test';
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

  it('accepts a safe tmux server name', () => {
    expect(ClaudeCodeTmuxProviderConfigSchema.parse({ tmuxServerName: 'makaio-test-123_abc' }).tmuxServerName).toBe(
      'makaio-test-123_abc',
    );
    expect(ClaudeCodeTmuxProviderConfigSchema.parse({ tmuxServerName: 'a'.repeat(64) }).tmuxServerName).toBe(
      'a'.repeat(64),
    );
  });

  it('rejects unsafe tmux server names', () => {
    expect(() => ClaudeCodeTmuxProviderConfigSchema.parse({ tmuxServerName: '../makaio' })).toThrow(
      /tmuxServerName may contain only/,
    );
    expect(() => ClaudeCodeTmuxProviderConfigSchema.parse({ tmuxServerName: 'a'.repeat(65) })).toThrow(
      /tmuxServerName must be 64 characters or fewer/,
    );
  });
});
