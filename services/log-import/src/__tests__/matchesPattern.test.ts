/**
 * Tests for matchesPattern function in generic-import-handlers.
 *
 * This tests the file pattern matching logic used by findLogFiles
 * to ensure all supported glob patterns work correctly.
 */

import { describe, it, expect } from 'vitest';
import { matchesPattern } from '../generic-import-handlers.js';

describe('matchesPattern', () => {
  describe('simple extension patterns', () => {
    it('should match *.ext pattern', () => {
      expect(matchesPattern('test.jsonl', '*.jsonl')).toBe(true);
      expect(matchesPattern('session.jsonl', '*.jsonl')).toBe(true);
      expect(matchesPattern('test.json', '*.jsonl')).toBe(false);
    });

    it('should match **/*.ext pattern', () => {
      expect(matchesPattern('test.jsonl', '**/*.jsonl')).toBe(true);
      expect(matchesPattern('session.json', '**/*.json')).toBe(true);
      expect(matchesPattern('test.txt', '**/*.json')).toBe(false);
    });
  });

  describe('exact filename patterns', () => {
    it('should match exact filename', () => {
      expect(matchesPattern('session.json', 'session.json')).toBe(true);
      expect(matchesPattern('other.json', 'session.json')).toBe(false);
    });
  });

  describe('complex path patterns with wildcards', () => {
    it('should extract filename from **/storage/session/*/session.json (OpenCode)', () => {
      // Pattern: **/storage/session/*/session.json
      expect(matchesPattern('storage/session/abc123/session.json', '**/storage/session/*/session.json')).toBe(true);
      expect(matchesPattern('storage/session/abc123/other.json', '**/storage/session/*/session.json')).toBe(false);
    });

    it('should extract filename from **/chats/session-*.json (Gemini)', () => {
      // Pattern: **/chats/session-*.json should match any nested chats directory
      expect(matchesPattern('chats/session-123.json', '**/chats/session-*.json')).toBe(true);
      expect(matchesPattern('foo/bar/chats/session-abc.json', '**/chats/session-*.json')).toBe(true);
      expect(matchesPattern('chats/session-.json', '**/chats/session-*.json')).toBe(true);
      expect(matchesPattern('chats/other-123.json', '**/chats/session-*.json')).toBe(false);
      expect(matchesPattern('chats/session.json', '**/chats/session-*.json')).toBe(false);
    });

    it('should extract filename from **/*.jsonl', () => {
      // Pattern: **/*.jsonl
      // Should match: any file ending in .jsonl
      expect(matchesPattern('test.jsonl', '**/*.jsonl')).toBe(true);
      expect(matchesPattern('session.jsonl', '**/*.jsonl')).toBe(true);
      expect(matchesPattern('test.json', '**/*.jsonl')).toBe(false);
    });
  });

  describe('prefix-* patterns', () => {
    it('should match session-*.json pattern', () => {
      expect(matchesPattern('session-123.json', 'session-*.json')).toBe(true);
      expect(matchesPattern('session-abc.json', 'session-*.json')).toBe(true);
      expect(matchesPattern('session-.json', 'session-*.json')).toBe(true);
      expect(matchesPattern('other-123.json', 'session-*.json')).toBe(false);
      expect(matchesPattern('session.json', 'session-*.json')).toBe(false);
    });

    it('should match prefix-*.ext pattern with **/', () => {
      expect(matchesPattern('session-123.json', '**/session-*.json')).toBe(true);
      expect(matchesPattern('log-abc.txt', '**/log-*.txt')).toBe(true);
      expect(matchesPattern('other.txt', '**/log-*.txt')).toBe(false);
    });

    it('should match patterns with multiple wildcards', () => {
      expect(matchesPattern('session-2026-prod.json', 'session-*-*.json')).toBe(true);
      expect(matchesPattern('session-2026.json', 'session-*-*.json')).toBe(false);
      expect(matchesPattern('build-123-log.txt', 'build-*-*.txt')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle patterns without **/', () => {
      expect(matchesPattern('test.json', 'test.json')).toBe(true);
      expect(matchesPattern('test.json', '*.json')).toBe(true);
    });

    it('should handle empty wildcards', () => {
      expect(matchesPattern('session-.json', 'session-*.json')).toBe(true);
      expect(matchesPattern('test.json', '*.json')).toBe(true);
    });

    it('should not match partial filenames', () => {
      expect(matchesPattern('mysession.json', 'session.json')).toBe(false);
      expect(matchesPattern('session.json.bak', 'session.json')).toBe(false);
    });

    it('returns false when pattern exceeds complexity length limit', () => {
      const longPattern = `session-${'a'.repeat(201)}*.json`;
      expect(matchesPattern('session-test.json', longPattern)).toBe(false);
    });

    it('returns false when pattern wildcard count exceeds limit', () => {
      const wildcardHeavyPattern = `session-${'*'.repeat(65)}.json`;
      expect(matchesPattern('session-test.json', wildcardHeavyPattern)).toBe(false);
    });
  });

  describe('real-world adapter patterns', () => {
    it('should handle GitHub Copilot pattern', () => {
      // Pattern: *.jsonl
      expect(matchesPattern('conversation.jsonl', '*.jsonl')).toBe(true);
      expect(matchesPattern('session.jsonl', '*.jsonl')).toBe(true);
    });

    it('should handle Claude Code pattern', () => {
      // Pattern: **/*.jsonl
      expect(matchesPattern('session.jsonl', '**/*.jsonl')).toBe(true);
      expect(matchesPattern('conversation.jsonl', '**/*.jsonl')).toBe(true);
    });

    it('should handle OpenCode pattern', () => {
      // Pattern: **/storage/session/*/session.json
      expect(matchesPattern('storage/session/ses_123/session.json', '**/storage/session/*/session.json')).toBe(true);
    });

    it('should handle Gemini pattern', () => {
      // Pattern: **/chats/session-*.json
      expect(matchesPattern('chats/session-abc123.json', '**/chats/session-*.json')).toBe(true);
      expect(matchesPattern('tmp/foo/chats/session-20240101.json', '**/chats/session-*.json')).toBe(true);
    });

    it('should handle Codex pattern', () => {
      // Pattern: **/*.jsonl
      expect(matchesPattern('log.jsonl', '**/*.jsonl')).toBe(true);
    });
  });
});
