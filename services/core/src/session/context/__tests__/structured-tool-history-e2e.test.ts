/**
 * End-to-end integration test for structured tool history flowing through
 * fork/conversation assembly.
 *
 * Verifies that tool_call, tool_output, and reasoning blocks survive the full
 * pipeline (storage → getFullConversation → convertSessionMessage) without
 * being flattened to text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { SessionMessage, MessageBlock } from '@makaio/contracts';
import { getFullConversation } from '../get-full-conversation.js';
import { convertSessionMessage } from '../convert-session-message.js';
import {
  createCleanupTracker,
  setupContextTest,
  mockGetSession,
  mockGetEvents,
  mockGetMessage,
  messageEvent,
} from './test-helpers.js';

/**
 * Helper to normalize blocks to an array.
 * @param blocks - Single block or array of blocks
 * @returns Array of blocks
 */
function toBlockArray(blocks: MessageBlock | MessageBlock[]): MessageBlock[] {
  return Array.isArray(blocks) ? blocks : [blocks];
}

describe('structured tool history E2E', () => {
  const cleanup = createCleanupTracker();

  beforeEach(() => {
    setupContextTest();
  });

  afterEach(() => {
    cleanup.runAll();
  });

  describe('single session with mixed block types', () => {
    it('should preserve tool_call, tool_output, and reasoning blocks', async () => {
      // Create messages with structured tool blocks
      const userMessage: SessionMessage = {
        messageId: 'msg-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        role: 'user',
        contentText: 'Please list files',
        blocks: [{ type: 'text', content: 'Please list files' }],
        timestamp: 1000,
      };

      const assistantMessage: SessionMessage = {
        messageId: 'msg-2',
        sessionId: 'session-1',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'I will run ls command',
        blocks: [
          { type: 'text', content: 'I will run ls command' },
          { type: 'reasoning', content: 'Let me check the directory' },
          {
            type: 'tool_call',
            toolCallId: 'tool-1',
            name: 'bash',
            args: { command: 'ls -la', cwd: '/tmp' },
          },
        ],
        timestamp: 2000,
      };

      const toolResultMessage: SessionMessage = {
        messageId: 'msg-3',
        sessionId: 'session-1',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'file1.txt\nfile2.txt',
        blocks: [
          {
            type: 'tool_output',
            toolCallId: 'tool-1',
            output: 'file1.txt\nfile2.txt',
          },
          { type: 'text', content: 'I found two files' },
        ],
        timestamp: 3000,
      };

      // Mock session and events
      mockGetSession(cleanup, { sessionId: 'session-1' });
      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { role: 'user' }),
        messageEvent('msg-2', 2000, { role: 'assistant' }),
        messageEvent('msg-3', 3000, { role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', userMessage);
      mockGetMessage(cleanup, 'msg-2', assistantMessage);
      mockGetMessage(cleanup, 'msg-3', toolResultMessage);

      // Step 1: Get full conversation
      const conversation = await getFullConversation(MakaioBus, 'session-1');

      expect(conversation.messages).toHaveLength(3);
      expect(conversation.sessionChain).toEqual(['session-1']);

      // Step 2: Convert each message
      const converted = conversation.messages.map((msg) => convertSessionMessage(msg));

      // Step 3: Verify structured blocks survived
      const blocks0 = toBlockArray(converted[0].blocks);
      expect(converted[0].role).toBe('user');
      expect(blocks0).toEqual([{ type: 'text', content: 'Please list files' }]);

      const blocks1 = toBlockArray(converted[1].blocks);
      expect(converted[1].role).toBe('assistant');
      expect(blocks1).toHaveLength(3);
      expect(blocks1[0]).toEqual({ type: 'text', content: 'I will run ls command' });
      expect(blocks1[1]).toEqual({ type: 'reasoning', content: 'Let me check the directory' });
      expect(blocks1[2]).toEqual({
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'bash',
        args: { command: 'ls -la', cwd: '/tmp' },
      });

      const blocks2 = toBlockArray(converted[2].blocks);
      expect(converted[2].role).toBe('assistant');
      expect(blocks2).toHaveLength(2);
      expect(blocks2[0]).toEqual({
        type: 'tool_output',
        toolCallId: 'tool-1',
        output: 'file1.txt\nfile2.txt',
      });
      expect(blocks2[1]).toEqual({ type: 'text', content: 'I found two files' });
    });

    it('should preserve tool_output blocks with isError flag', async () => {
      const errorMessage: SessionMessage = {
        messageId: 'msg-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Command failed',
        blocks: [
          {
            type: 'tool_output',
            toolCallId: 'tool-1',
            output: 'bash: command not found',
            isError: true,
          },
          { type: 'text', content: 'The command failed' },
        ],
        timestamp: 1000,
      };

      mockGetSession(cleanup, { sessionId: 'session-1' });
      mockGetEvents(cleanup, 'session-1', [messageEvent('msg-1', 1000, { role: 'assistant' })]);
      mockGetMessage(cleanup, 'msg-1', errorMessage);

      const conversation = await getFullConversation(MakaioBus, 'session-1');
      const converted = convertSessionMessage(conversation.messages[0]);
      const blocks = toBlockArray(converted.blocks);

      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({
        type: 'tool_output',
        toolCallId: 'tool-1',
        output: 'bash: command not found',
        isError: true,
      });
    });
  });

  describe('forked session with tool history', () => {
    it('should preserve structured tool blocks in inherited parent messages', async () => {
      // Parent session with tool blocks
      const parentMsg1: SessionMessage = {
        messageId: 'parent-msg-1',
        sessionId: 'parent-session',
        turnId: 'turn-1',
        role: 'user',
        contentText: 'Run tests',
        blocks: [{ type: 'text', content: 'Run tests' }],
        timestamp: 1000,
      };

      const parentMsg2: SessionMessage = {
        messageId: 'parent-msg-2',
        sessionId: 'parent-session',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Running tests',
        blocks: [
          { type: 'reasoning', content: 'I need to run the test suite' },
          {
            type: 'tool_call',
            toolCallId: 'tool-1',
            name: 'bash',
            args: { command: 'yarn test' },
          },
        ],
        timestamp: 2000,
      };

      const parentMsg3: SessionMessage = {
        messageId: 'parent-msg-3',
        sessionId: 'parent-session',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Tests passed',
        blocks: [
          {
            type: 'tool_output',
            toolCallId: 'tool-1',
            output: 'All tests passed: 42/42',
          },
        ],
        timestamp: 3000,
      };

      const childMsg: SessionMessage = {
        messageId: 'child-msg-1',
        sessionId: 'child-session',
        turnId: 'turn-2',
        role: 'user',
        contentText: 'Now run linter',
        blocks: [{ type: 'text', content: 'Now run linter' }],
        timestamp: 4000,
      };

      // Mock parent session
      mockGetSession(cleanup, { sessionId: 'parent-session' });
      mockGetEvents(cleanup, 'parent-session', [
        messageEvent('parent-msg-1', 1000, { sessionId: 'parent-session', role: 'user' }),
        messageEvent('parent-msg-2', 2000, { sessionId: 'parent-session', role: 'assistant' }),
        messageEvent('parent-msg-3', 3000, { sessionId: 'parent-session', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'parent-msg-1', parentMsg1);
      mockGetMessage(cleanup, 'parent-msg-2', parentMsg2);
      mockGetMessage(cleanup, 'parent-msg-3', parentMsg3);

      // Mock child session with fork point
      mockGetSession(cleanup, {
        sessionId: 'child-session',
        parentSessionId: 'parent-session',
        forkPointMessageId: 'parent-msg-3',
      });
      mockGetEvents(cleanup, 'child-session', [
        messageEvent('child-msg-1', 4000, { sessionId: 'child-session', role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'child-msg-1', childMsg);

      // Get full conversation for child
      const conversation = await getFullConversation(MakaioBus, 'child-session');

      expect(conversation.messages).toHaveLength(4);
      expect(conversation.sessionChain).toEqual(['parent-session', 'child-session']);

      // Convert all messages
      const converted = conversation.messages.map((msg) => convertSessionMessage(msg));

      // Verify parent message 1 (user)
      const blocks0 = toBlockArray(converted[0].blocks);
      expect(converted[0].role).toBe('user');
      expect(blocks0).toEqual([{ type: 'text', content: 'Run tests' }]);

      // Verify parent message 2 (assistant with reasoning + tool_call)
      const blocks1 = toBlockArray(converted[1].blocks);
      expect(converted[1].role).toBe('assistant');
      expect(blocks1).toHaveLength(2);
      expect(blocks1[0]).toEqual({ type: 'reasoning', content: 'I need to run the test suite' });
      expect(blocks1[1]).toEqual({
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'bash',
        args: { command: 'yarn test' },
      });

      // Verify parent message 3 (assistant with tool_output - fork point)
      const blocks2 = toBlockArray(converted[2].blocks);
      expect(converted[2].role).toBe('assistant');
      expect(blocks2).toEqual([
        {
          type: 'tool_output',
          toolCallId: 'tool-1',
          output: 'All tests passed: 42/42',
        },
      ]);

      // Verify child message (user)
      const blocks3 = toBlockArray(converted[3].blocks);
      expect(converted[3].role).toBe('user');
      expect(blocks3).toEqual([{ type: 'text', content: 'Now run linter' }]);
    });

    it('should preserve multiple tool call/output pairs', async () => {
      // Parent with multiple tool calls
      const parentMsg: SessionMessage = {
        messageId: 'parent-msg-1',
        sessionId: 'parent-session',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Running multiple commands',
        blocks: [
          { type: 'text', content: 'I will run multiple checks' },
          { type: 'tool_call', toolCallId: 'tool-1', name: 'bash', args: { command: 'ls' } },
          { type: 'tool_output', toolCallId: 'tool-1', output: 'file1.txt' },
          { type: 'tool_call', toolCallId: 'tool-2', name: 'bash', args: { command: 'pwd' } },
          { type: 'tool_output', toolCallId: 'tool-2', output: '/home/user' },
          { type: 'text', content: 'All checks completed' },
        ],
        timestamp: 1000,
      };

      const childMsg: SessionMessage = {
        messageId: 'child-msg-1',
        sessionId: 'child-session',
        turnId: 'turn-2',
        role: 'user',
        contentText: 'Continue',
        blocks: [{ type: 'text', content: 'Continue' }],
        timestamp: 2000,
      };

      mockGetSession(cleanup, { sessionId: 'parent-session' });
      mockGetEvents(cleanup, 'parent-session', [
        messageEvent('parent-msg-1', 1000, { sessionId: 'parent-session', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'parent-msg-1', parentMsg);

      mockGetSession(cleanup, {
        sessionId: 'child-session',
        parentSessionId: 'parent-session',
        forkPointMessageId: 'parent-msg-1',
      });
      mockGetEvents(cleanup, 'child-session', [
        messageEvent('child-msg-1', 2000, { sessionId: 'child-session', role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'child-msg-1', childMsg);

      const conversation = await getFullConversation(MakaioBus, 'child-session');
      const converted = conversation.messages.map((msg) => convertSessionMessage(msg));

      const blocks = toBlockArray(converted[0].blocks);
      expect(blocks).toHaveLength(6);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('tool_call');
      expect(blocks[2].type).toBe('tool_output');
      expect(blocks[3].type).toBe('tool_call');
      expect(blocks[4].type).toBe('tool_output');
      expect(blocks[5].type).toBe('text');

      // Verify toolCallIds match
      expect((blocks[1] as { toolCallId: string }).toolCallId).toBe('tool-1');
      expect((blocks[2] as { toolCallId: string }).toolCallId).toBe('tool-1');
      expect((blocks[3] as { toolCallId: string }).toolCallId).toBe('tool-2');
      expect((blocks[4] as { toolCallId: string }).toolCallId).toBe('tool-2');
    });
  });
});
