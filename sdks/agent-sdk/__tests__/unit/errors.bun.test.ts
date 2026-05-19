import { describe, expect, it } from 'bun:test';
import { MakaioCredentialError, MakaioConnectionError, MakaioModelError } from '../../src/shared/errors.js';

describe('SDK Errors', () => {
  describe('MakaioCredentialError', () => {
    it('includes provider name and env var hint', () => {
      const err = new MakaioCredentialError('openai', ['OPENAI_API_KEY']);
      expect(err.message).toContain('openai');
      expect(err.message).toContain('OPENAI_API_KEY');
      expect(err.name).toBe('MakaioCredentialError');
      expect(err.provider).toBe('openai');
    });

    it('handles multiple env var names', () => {
      const err = new MakaioCredentialError('anthropic', ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY']);
      expect(err.message).toContain('ANTHROPIC_API_KEY');
      expect(err.message).toContain('CLAUDE_API_KEY');
    });

    it('handles empty env var list', () => {
      const err = new MakaioCredentialError('custom', []);
      expect(err.message).toContain('custom');
      expect(err.message).toContain('settings');
    });
  });

  describe('MakaioConnectionError', () => {
    it('includes URL and reason', () => {
      const err = new MakaioConnectionError('ws://localhost:6252/bus', 'timeout');
      expect(err.message).toContain('ws://localhost:6252/bus');
      expect(err.message).toContain('timeout');
      expect(err.name).toBe('MakaioConnectionError');
      expect(err.url).toBe('ws://localhost:6252/bus');
    });
  });

  describe('MakaioModelError', () => {
    it('includes suggestions for ambiguous models', () => {
      const err = new MakaioModelError('sonnet', 'ambiguous', ['anthropic-sdk::sonnet', 'claude-agent-sdk::sonnet']);
      expect(err.message).toContain('sonnet');
      expect(err.message).toContain('anthropic-sdk::sonnet');
      expect(err.name).toBe('MakaioModelError');
      expect(err.suggestions).toHaveLength(2);
    });

    it('handles not-found reason', () => {
      const err = new MakaioModelError('nonexistent', 'not-found');
      expect(err.message).toContain('nonexistent');
      expect(err.message).toContain('not found');
      expect(err.reason).toBe('not-found');
    });

    it('handles parse-error reason', () => {
      const err = new MakaioModelError('', 'parse-error');
      expect(err.message).toContain('Invalid');
      expect(err.reason).toBe('parse-error');
      expect(err.suggestions).toHaveLength(0);
    });
  });
});
