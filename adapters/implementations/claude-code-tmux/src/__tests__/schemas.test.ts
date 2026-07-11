import { describe, expect, it } from 'vitest';
import { ClaudeCodeTmuxProviderConfigSchema } from '../schemas.js';

describe('ClaudeCodeTmuxProviderConfigSchema', () => {
  it('rejects the removed provider-level binary override', () => {
    expect(ClaudeCodeTmuxProviderConfigSchema.safeParse({ binaryPath: '/legacy/bin/claude' }).success).toBe(false);
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
