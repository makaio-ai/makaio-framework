/**
 * Tests for delta-handlers - Type guards and validation
 *
 * Tests that handlers properly validate incoming JSON-RPC notification payloads
 * and handle invalid data gracefully.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { CodexAppServerNamespace } from '../../namespaces/index.js';
import {
  handleAgentMessageDelta,
  handleCommandOutputDelta,
  handleReasoningDelta,
  handleFileChangeDelta,
} from '../delta-handlers.js';

describe('delta-handlers - Type guards', () => {
  let mockBus: Awaited<ReturnType<typeof CodexAppServerNamespace.scopedBus>>;
  let consoleWarnSpy: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBus = await CodexAppServerNamespace.scopedBus();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /**
   * Helper to check if console.warn was called with a message containing the substring.
   * console.warn can be called with multiple arguments, so we join all args and check.
   * @param substring - The substring to search for
   * @returns True if any console.warn call contains the substring
   */
  function wasWarnedWith(substring: string): boolean {
    return consoleWarnSpy.mock.calls.some((call) => call.join(' ').includes(substring));
  }

  describe('handleAgentMessageDelta', () => {
    it('should handle valid notification with threadId and turnId', async () => {
      const mockAccumulate = vi.fn();
      const validParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        delta: 'Hello world',
      };

      await handleAgentMessageDelta(mockBus.emit.bind(mockBus), validParams, mockAccumulate);

      expect(mockAccumulate).toHaveBeenCalledWith('Hello world');
      expect(wasWarnedWith('[delta-handlers] Skipping invalid')).toBe(false);
    });

    it('should handle valid notification with only delta (no threadId)', async () => {
      const mockAccumulate = vi.fn();
      const validParams = {
        delta: 'Hello world',
      };

      await handleAgentMessageDelta(mockBus.emit.bind(mockBus), validParams, mockAccumulate);

      expect(mockAccumulate).toHaveBeenCalledWith('Hello world');
      expect(wasWarnedWith('Agent message delta received without threadId')).toBe(true);
    });

    it('should reject notification with missing delta field', async () => {
      const mockAccumulate = vi.fn();
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
      };

      await handleAgentMessageDelta(mockBus.emit.bind(mockBus), invalidParams, mockAccumulate);

      expect(mockAccumulate).not.toHaveBeenCalled();
      expect(wasWarnedWith('[delta-handlers] Invalid agent message delta notification:')).toBe(true);
      expect(wasWarnedWith('[delta-handlers] Skipping invalid agent message delta notification')).toBe(true);
    });

    it('should reject notification with wrong delta type', async () => {
      const mockAccumulate = vi.fn();
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        delta: 42,
      };

      await handleAgentMessageDelta(mockBus.emit.bind(mockBus), invalidParams, mockAccumulate);

      expect(mockAccumulate).not.toHaveBeenCalled();
      expect(wasWarnedWith('[delta-handlers] Invalid agent message delta notification:')).toBe(true);
    });

    it('should reject notification with null params', async () => {
      const mockAccumulate = vi.fn();

      await handleAgentMessageDelta(mockBus.emit.bind(mockBus), null, mockAccumulate);

      expect(mockAccumulate).not.toHaveBeenCalled();
      expect(wasWarnedWith('[delta-handlers] Invalid agent message delta notification:')).toBe(true);
    });

    it('should reject notification with undefined params', async () => {
      const mockAccumulate = vi.fn();

      await handleAgentMessageDelta(mockBus.emit.bind(mockBus), undefined, mockAccumulate);

      expect(mockAccumulate).not.toHaveBeenCalled();
      expect(wasWarnedWith('[delta-handlers] Invalid agent message delta notification:')).toBe(true);
    });
  });

  describe('handleCommandOutputDelta', () => {
    it('should handle valid notification', async () => {
      const validParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-789',
        delta: 'stdout content',
      };

      await handleCommandOutputDelta(mockBus.emit.bind(mockBus), validParams);

      expect(wasWarnedWith('[delta-handlers] Skipping invalid')).toBe(false);
    });

    it('should reject notification with missing threadId', async () => {
      const invalidParams = {
        turnId: 'turn-456',
        itemId: 'item-789',
        delta: 'stdout content',
      };

      await handleCommandOutputDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid command output delta notification:')).toBe(true);
      expect(wasWarnedWith('[delta-handlers] Skipping invalid command output delta notification')).toBe(true);
    });

    it('should reject notification with missing itemId', async () => {
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        delta: 'stdout content',
      };

      await handleCommandOutputDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid command output delta notification:')).toBe(true);
    });

    it('should reject notification with wrong delta type', async () => {
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-789',
        delta: { content: 'stdout' },
      };

      await handleCommandOutputDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid command output delta notification:')).toBe(true);
    });

    it('should reject notification with empty object', async () => {
      await handleCommandOutputDelta(mockBus.emit.bind(mockBus), {});

      expect(wasWarnedWith('[delta-handlers] Invalid command output delta notification:')).toBe(true);
    });
  });

  describe('handleReasoningDelta', () => {
    it('should handle valid notification with threadId and turnId', async () => {
      const validParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        delta: 'Let me think...',
      };

      await handleReasoningDelta(mockBus.emit.bind(mockBus), validParams);

      expect(wasWarnedWith('[delta-handlers] Skipping invalid')).toBe(false);
    });

    it('should handle valid notification with only delta (no threadId)', async () => {
      const validParams = {
        delta: 'Let me think...',
      };

      await handleReasoningDelta(mockBus.emit.bind(mockBus), validParams);

      expect(wasWarnedWith('[delta-handlers] Skipping invalid')).toBe(false);
    });

    it('should reject notification with missing delta field', async () => {
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
      };

      await handleReasoningDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid reasoning delta notification:')).toBe(true);
      expect(wasWarnedWith('[delta-handlers] Skipping invalid reasoning delta notification')).toBe(true);
    });

    it('should reject notification with wrong delta type', async () => {
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        delta: ['array', 'of', 'strings'],
      };

      await handleReasoningDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid reasoning delta notification:')).toBe(true);
    });

    it('should reject notification with primitive type', async () => {
      await handleReasoningDelta(mockBus.emit.bind(mockBus), 'just a string');

      expect(wasWarnedWith('[delta-handlers] Invalid reasoning delta notification:')).toBe(true);
    });
  });

  describe('handleFileChangeDelta', () => {
    it('should handle valid notification', async () => {
      const validParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-789',
        delta: 'file content delta',
      };

      await handleFileChangeDelta(mockBus.emit.bind(mockBus), validParams);

      expect(wasWarnedWith('[delta-handlers] Skipping invalid')).toBe(false);
    });

    it('should reject notification with missing turnId', async () => {
      const invalidParams = {
        threadId: 'thread-123',
        itemId: 'item-789',
        delta: 'file content delta',
      };

      await handleFileChangeDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid file change delta notification:')).toBe(true);
      expect(wasWarnedWith('[delta-handlers] Skipping invalid file change delta notification')).toBe(true);
    });

    it('should reject notification with missing itemId', async () => {
      const invalidParams = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        delta: 'file content delta',
      };

      await handleFileChangeDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid file change delta notification:')).toBe(true);
    });

    it('should accept notification with extra unexpected fields (Zod default behavior)', async () => {
      const paramsWithExtra = {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-789',
        delta: 'file content delta',
        unexpectedField: 'should not be here',
      };

      // Note: Zod by default allows extra fields, so this should still pass
      // This test documents the current behavior
      await handleFileChangeDelta(mockBus.emit.bind(mockBus), paramsWithExtra);

      // Should not warn because Zod allows extra fields by default
      expect(wasWarnedWith('[delta-handlers] Skipping invalid')).toBe(false);
    });

    it('should reject notification with array instead of object', async () => {
      const invalidParams = ['thread-123', 'turn-456', 'item-789', 'delta'];

      await handleFileChangeDelta(mockBus.emit.bind(mockBus), invalidParams);

      expect(wasWarnedWith('[delta-handlers] Invalid file change delta notification:')).toBe(true);
    });
  });
});
