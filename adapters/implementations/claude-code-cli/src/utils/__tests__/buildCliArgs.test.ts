import { describe, it, expect } from 'vitest';
import { buildCliArgs } from '../buildCliArgs.js';
import type { ClaudeCliSessionConfig } from '../../types.js';

/**
 * Minimal session config factory for buildCliArgs tests.
 * @param overrides - Partial config overrides
 * @returns Partial ClaudeCliSessionConfig suitable for buildCliArgs
 */
function makeConfig(overrides: Partial<ClaudeCliSessionConfig> = {}): ClaudeCliSessionConfig {
  return {
    bus: {} as ClaudeCliSessionConfig['bus'],
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: '/tmp',
    env: {},
    ...overrides,
  } as ClaudeCliSessionConfig;
}

describe('buildCliArgs', () => {
  it('includes required base flags', () => {
    const args = buildCliArgs({ config: makeConfig(), prompt: 'hello', sessionId: 'sid-1' });
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--verbose');
    expect(args[args.length - 1]).toBe('hello');
  });

  it('uses --session-id for new sessions', () => {
    const args = buildCliArgs({ config: makeConfig(), prompt: 'hi', sessionId: 'new-sid' });
    expect(args).toContain('--session-id');
    expect(args).toContain('new-sid');
    expect(args).not.toContain('--resume');
  });

  it('uses --resume when resumeAdapterSessionId is set', () => {
    const args = buildCliArgs({
      config: makeConfig({ resumeAdapterSessionId: 'prev-sid' }),
      prompt: 'hi',
      sessionId: 'new-sid',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('prev-sid');
    expect(args).not.toContain('--session-id');
  });

  describe('systemPrompt', () => {
    it('uses --system-prompt for plain string', () => {
      const args = buildCliArgs({
        config: makeConfig({ systemPrompt: 'You are helpful.' }),
        prompt: 'hi',
        sessionId: 'sid',
      });
      const idx = args.indexOf('--system-prompt');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('You are helpful.');
      expect(args).not.toContain('--append-system-prompt');
    });

    it('uses --append-system-prompt for append mode object', () => {
      const args = buildCliArgs({
        config: makeConfig({ systemPrompt: { mode: 'append', content: 'Extra context.' } }),
        prompt: 'hi',
        sessionId: 'sid',
      });
      const idx = args.indexOf('--append-system-prompt');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('Extra context.');
      expect(args).not.toContain('--system-prompt');
    });

    it('omits system prompt flags when systemPrompt is undefined', () => {
      const args = buildCliArgs({ config: makeConfig(), prompt: 'hi', sessionId: 'sid' });
      expect(args).not.toContain('--system-prompt');
      expect(args).not.toContain('--append-system-prompt');
    });
  });

  describe('responseSchema', () => {
    it('passes json schema flag for response schema descriptors', () => {
      const args = buildCliArgs({
        config: makeConfig({ responseSchema: { schema: { type: 'object' }, name: 'object_schema' } }),
        prompt: 'hi',
        sessionId: 'sid',
      });

      expect(args).toContain('--json-schema');
      expect(args).toContain(JSON.stringify({ type: 'object' }));
    });

    it('omits --json-schema when responseSchema is not provided', () => {
      const args = buildCliArgs({ config: makeConfig(), prompt: 'hi', sessionId: 'sid' });

      expect(args).not.toContain('--json-schema');
    });
  });

  describe('tool policy', () => {
    it('passes allowedTools as a deterministic comma-separated allow-list', () => {
      const args = buildCliArgs({
        config: makeConfig({ allowedTools: ['Bash(git status)', 'Edit', 'mcp__makaio__approve'] }),
        prompt: 'hi',
        sessionId: 'sid',
      });

      const idx = args.indexOf('--allowedTools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('Bash(git status),Edit,mcp__makaio__approve');
      expect(args).not.toContain('--disallowedTools');
    });

    it('passes disallowedTools as a deterministic comma-separated deny-list', () => {
      const args = buildCliArgs({
        config: makeConfig({ disallowedTools: ['WebSearch', 'Bash(rm *)'] }),
        prompt: 'hi',
        sessionId: 'sid',
      });

      const idx = args.indexOf('--disallowedTools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('WebSearch,Bash(rm *)');
      expect(args).not.toContain('--allowedTools');
    });

    it('preserves an empty allowedTools list as an explicit empty allow-list', () => {
      const args = buildCliArgs({
        config: makeConfig({ allowedTools: [] }),
        prompt: 'hi',
        sessionId: 'sid',
      });

      const idx = args.indexOf('--allowedTools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('');
    });
  });

  describe('reasoningEffort', () => {
    it('emits --effort low for level "low"', () => {
      const args = buildCliArgs({ config: makeConfig({ reasoningEffort: 'low' }), prompt: 'hi', sessionId: 'sid' });
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('low');
    });

    it('emits --effort medium for level "medium"', () => {
      const args = buildCliArgs({ config: makeConfig({ reasoningEffort: 'medium' }), prompt: 'hi', sessionId: 'sid' });
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('medium');
    });

    it('emits --effort high for level "high"', () => {
      const args = buildCliArgs({ config: makeConfig({ reasoningEffort: 'high' }), prompt: 'hi', sessionId: 'sid' });
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('high');
    });

    it('emits --effort max for level "extra-high"', () => {
      const args = buildCliArgs({
        config: makeConfig({ reasoningEffort: 'extra-high' }),
        prompt: 'hi',
        sessionId: 'sid',
      });
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('max');
    });

    it('omits --effort flag for level "none"', () => {
      const args = buildCliArgs({ config: makeConfig({ reasoningEffort: 'none' }), prompt: 'hi', sessionId: 'sid' });
      expect(args).not.toContain('--effort');
    });

    it('omits --effort flag when reasoningEffort is undefined', () => {
      const args = buildCliArgs({ config: makeConfig(), prompt: 'hi', sessionId: 'sid' });
      expect(args).not.toContain('--effort');
    });
  });
});
