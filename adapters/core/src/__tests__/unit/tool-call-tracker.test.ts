import { describe, test, expect } from 'vitest';
import { ToolCallTracker } from '../../agent/tool-call-tracker.js';

describe('ToolCallTracker', () => {
  describe('register()', () => {
    test('returns nativeId as correlationId when provided', () => {
      const tracker = new ToolCallTracker();

      const correlationId = tracker.register('Read', { path: '/foo' }, 'toolu_123');

      expect(correlationId).toBe('toolu_123');
    });

    test('generates UUID when nativeId not provided', () => {
      const tracker = new ToolCallTracker();

      const correlationId = tracker.register('Bash', { command: 'ls' });

      // Should be a valid UUID format
      expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe('resolve()', () => {
    test('matches by nativeId and removes from pending', () => {
      const tracker = new ToolCallTracker();
      tracker.register('Read', { path: '/foo' }, 'toolu_123');
      tracker.register('Bash', { command: 'ls' }, 'toolu_456');

      const result = tracker.resolve({ nativeId: 'toolu_123' });

      expect(result).toMatchObject({
        correlationId: 'toolu_123',
        strategy: 'nativeId',
        toolName: 'Read',
        args: { path: '/foo' },
      });
      // Second resolve for same nativeId should return null (removed)
      expect(tracker.resolve({ nativeId: 'toolu_123' })).toMatchObject({ correlationId: null, strategy: 'none' });
    });

    test('returns none when nativeId does not match pending entries', () => {
      const tracker = new ToolCallTracker();
      const first = tracker.register('Read', { path: '/foo' }, 'toolu_123');

      const result = tracker.resolve({ nativeId: 'toolu_nonexistent' });

      expect(result).toMatchObject({ correlationId: null, strategy: 'none' });
      expect(tracker.resolve({ toolName: 'Read' })).toMatchObject({
        correlationId: first,
        strategy: 'toolName',
        toolName: 'Read',
      });
    });

    test('falls back to FIFO by toolName when no nativeId in hints', () => {
      const tracker = new ToolCallTracker();
      // Register without nativeId (simulating adapter without native correlation)
      const first = tracker.register('Bash', { command: 'ls' });
      const second = tracker.register('Bash', { command: 'pwd' });

      // First resolve should match the first registered Bash call
      expect(tracker.resolve({ toolName: 'Bash' })).toMatchObject({
        correlationId: first,
        strategy: 'toolName',
        toolName: 'Bash',
        args: { command: 'ls' },
      });
      // Second resolve should match the remaining Bash call
      expect(tracker.resolve({ toolName: 'Bash' })).toMatchObject({
        correlationId: second,
        strategy: 'toolName',
        toolName: 'Bash',
        args: { command: 'pwd' },
      });
      // Third resolve should return null (no more Bash calls)
      expect(tracker.resolve({ toolName: 'Bash' })).toMatchObject({ correlationId: null, strategy: 'none' });
    });

    test('FIFO fallback only matches same tool name', () => {
      const tracker = new ToolCallTracker();
      const bashId = tracker.register('Bash', { command: 'ls' });
      const readId = tracker.register('Read', { path: '/foo' });

      // Should match the Read, not the first-registered Bash
      expect(tracker.resolve({ toolName: 'Read' })).toMatchObject({
        correlationId: readId,
        strategy: 'toolName',
        toolName: 'Read',
      });
      // Bash should still be pending
      expect(tracker.resolve({ toolName: 'Bash' })).toMatchObject({
        correlationId: bashId,
        strategy: 'toolName',
        toolName: 'Bash',
      });
    });

    test('falls back to oldest pending when no hints match', () => {
      const tracker = new ToolCallTracker();
      const first = tracker.register('Bash', { command: 'ls' });
      const second = tracker.register('Read', { path: '/foo' });

      expect(tracker.resolve({})).toMatchObject({ correlationId: first, strategy: 'oldest', toolName: 'Bash' });
      expect(tracker.resolve({})).toMatchObject({ correlationId: second, strategy: 'oldest', toolName: 'Read' });
      expect(tracker.resolve({})).toMatchObject({ correlationId: null, strategy: 'none' });
    });

    test('does not consume oldest when toolName is provided but no match exists', () => {
      const tracker = new ToolCallTracker();
      const first = tracker.register('Bash', { command: 'ls' });

      expect(tracker.resolve({ toolName: 'Read' })).toMatchObject({ correlationId: null, strategy: 'none' });
      expect(tracker.resolve({})).toMatchObject({ correlationId: first, strategy: 'oldest', toolName: 'Bash' });
    });
  });

  describe('clear()', () => {
    test('removes all pending tool calls', () => {
      const tracker = new ToolCallTracker();
      tracker.register('Bash', { command: 'ls' }, 'toolu_123');
      tracker.register('Read', { path: '/foo' }, 'toolu_456');

      tracker.clear();

      // All should return null after clear
      expect(tracker.resolve({ nativeId: 'toolu_123' })).toMatchObject({ correlationId: null, strategy: 'none' });
      expect(tracker.resolve({ nativeId: 'toolu_456' })).toMatchObject({ correlationId: null, strategy: 'none' });
      expect(tracker.resolve({ toolName: 'Bash' })).toMatchObject({ correlationId: null, strategy: 'none' });
    });
  });
});
