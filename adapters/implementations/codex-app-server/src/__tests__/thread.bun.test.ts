/**
 * Tests for CodexAppServerThread
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CodexAppServerThread } from '../thread.js';
import { CodexAppServerNamespace } from '../namespaces/index.js';

describe('CodexAppServerThread', () => {
  const adapterId = 'test-adapter';
  const agentId = 'test-agent';
  let bus: Awaited<ReturnType<typeof CodexAppServerNamespace.scopedBus>>;
  let thread: CodexAppServerThread;

  beforeEach(async () => {
    bus = await CodexAppServerNamespace.scopedBus();
    thread = new CodexAppServerThread({
      bus,
      adapterId,
      agentId,
    });
  });

  describe('initialization', () => {
    it('initializes with empty state', () => {
      expect(thread.threadId).toBeUndefined();
      expect(thread.state).toBe('active');
      expect(thread.config).toEqual({});
      expect(thread.tokenUsage).toBeUndefined();
    });

    it('returns isActive true for new thread', () => {
      expect(thread.isActive()).toBe(true);
      expect(thread.isCompleted()).toBe(false);
    });
  });

  describe('handleThreadStarted', () => {
    it('sets threadId and keeps state active', async () => {
      const threadId = 'thread-123';

      await thread.handleThreadStarted(threadId);

      expect(thread.threadId).toBe(threadId);
      expect(thread.state).toBe('active');
    });
  });

  describe('handleThreadCompleted', () => {
    it('transitions state to completed', async () => {
      const threadId = 'thread-789';
      await thread.handleThreadStarted(threadId);

      await thread.handleThreadCompleted('completed');

      expect(thread.state).toBe('completed');
    });

    it('transitions state to archived when specified', async () => {
      const threadId = 'thread-archive';
      await thread.handleThreadStarted(threadId);

      await thread.handleThreadCompleted('archived');

      expect(thread.state).toBe('archived');
    });

    it('throws error when threadId not set', async () => {
      await expect(thread.handleThreadCompleted('completed')).rejects.toThrow(
        'Cannot complete thread: threadId not set',
      );
    });

    it('updates isCompleted after completion', async () => {
      await thread.handleThreadStarted('thread-1');
      expect(thread.isCompleted()).toBe(false);

      await thread.handleThreadCompleted('completed');
      expect(thread.isCompleted()).toBe(true);
    });
  });

  describe('handleTokenUsageUpdated', () => {
    it('updates token usage tracking', async () => {
      await thread.handleTokenUsageUpdated(100, 25, 50, 10, 175);

      expect(thread.tokenUsage).toEqual({
        promptTokens: 100,
        inputCachedTokens: 25,
        completionTokens: 50,
        reasoningTokens: 10,
        totalTokens: 175,
      });
    });

    it('tracks zero reasoning tokens when none are used', async () => {
      await thread.handleTokenUsageUpdated(100, 0, 50, 0, 150);

      expect(thread.tokenUsage).toEqual({
        promptTokens: 100,
        inputCachedTokens: 0,
        completionTokens: 50,
        reasoningTokens: 0,
        totalTokens: 150,
      });
    });

    it('replaces usage on each update', async () => {
      await thread.handleTokenUsageUpdated(100, 10, 50, 0, 160);
      expect(thread.tokenUsage?.totalTokens).toBe(160);

      await thread.handleTokenUsageUpdated(50, 5, 25, 5, 80);
      expect(thread.tokenUsage?.totalTokens).toBe(80);
      expect(thread.tokenUsage?.inputCachedTokens).toBe(5);
      expect(thread.tokenUsage?.reasoningTokens).toBe(5);
    });
  });

  describe('updateConfig', () => {
    it('updates thread configuration', () => {
      thread.updateConfig({
        model: 'claude-3-5-sonnet-20241022',
        cwd: '/tmp',
      });

      expect(thread.config).toMatchObject({
        model: 'claude-3-5-sonnet-20241022',
        cwd: '/tmp',
      });
    });

    it('merges with existing config', () => {
      thread.updateConfig({ model: 'gpt-4' });
      thread.updateConfig({ cwd: '/home' });

      expect(thread.config).toMatchObject({
        model: 'gpt-4',
        cwd: '/home',
      });
    });
  });

  describe('lifecycle flow', () => {
    it('handles complete thread lifecycle', async () => {
      // Thread starts
      await thread.handleThreadStarted('thread-lifecycle');
      expect(thread.isActive()).toBe(true);

      // Token usage updates
      await thread.handleTokenUsageUpdated(500, 0, 200, 0, 700);
      expect(thread.tokenUsage?.totalTokens).toBe(700);

      // Thread completes
      await thread.handleThreadCompleted('completed');
      expect(thread.isCompleted()).toBe(true);
    });
  });
});
