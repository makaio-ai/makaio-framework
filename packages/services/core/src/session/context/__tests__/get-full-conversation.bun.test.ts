// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 450 }] */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import type { SessionMessage, ForkTransforms } from '@makaio/contracts';
import { getFullConversation } from '../get-full-conversation.js';
import {
  createCleanupTracker,
  setupContextTest,
  mockGetSession,
  mockGetEvents,
  mockGetMessage,
  createMessage,
  messageEvent,
} from './test-helpers.js';

describe('getFullConversation', () => {
  const cleanup = createCleanupTracker();

  beforeEach(() => {
    setupContextTest();
  });

  afterEach(() => {
    cleanup.runAll();
  });

  describe('single session (no parent)', () => {
    it('should return own messages only', async () => {
      mockGetSession(cleanup, { sessionId: 'session-1', parentSessionId: undefined });

      const msg1 = createMessage('msg-1', 'user', 'Hello', { sessionId: 'session-1', timestamp: 1000 });
      const msg2 = createMessage('msg-2', 'assistant', 'Hi', { sessionId: 'session-1', timestamp: 2000 });

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { sessionId: 'session-1', role: 'user' }),
        messageEvent('msg-2', 2000, { sessionId: 'session-1', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);
      mockGetMessage(cleanup, 'msg-2', msg2);

      const result = await getFullConversation(MakaioBus, 'session-1');

      expect(result.messages).toHaveLength(2);
      expect(result.sessionChain).toEqual(['session-1']);
    });

    it('should only return messages from the requested session even when an aside child exists elsewhere', async () => {
      mockGetSession(cleanup, { sessionId: 'session-1', parentSessionId: undefined });
      mockGetSession(cleanup, {
        sessionId: 'aside-child',
        parentSessionId: 'session-1',
        branchKind: 'aside',
      });

      const parentMsg = createMessage('parent-msg-1', 'user', 'Parent only', {
        sessionId: 'session-1',
        timestamp: 1000,
      });
      const childAsideMsg = createMessage('aside-msg-1', 'assistant', 'Aside answer', {
        sessionId: 'aside-child',
        timestamp: 2000,
      });

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('parent-msg-1', 1000, { sessionId: 'session-1', role: 'user' }),
      ]);
      mockGetEvents(cleanup, 'aside-child', [
        messageEvent('aside-msg-1', 2000, { sessionId: 'aside-child', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'parent-msg-1', parentMsg);
      mockGetMessage(cleanup, 'aside-msg-1', childAsideMsg);

      // getFullConversation walks parentSessionId upward from the requested session
      // and never traverses children, so the aside child must stay excluded.
      const result = await getFullConversation(MakaioBus, 'session-1');

      expect(result.messages.map((message) => message.messageId)).toEqual(['parent-msg-1']);
      expect(result.sessionChain).toEqual(['session-1']);
    });
  });

  describe('forked session (with parent)', () => {
    it('should include parent messages up to fork point', async () => {
      // Parent session
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });
      const parentMsg1 = createMessage('parent-msg-1', 'user', 'Parent hello', {
        sessionId: 'parent',
        timestamp: 1000,
      });
      const parentMsg2 = createMessage('parent-msg-2', 'assistant', 'Parent hi', {
        sessionId: 'parent',
        timestamp: 2000,
      });
      const parentMsg3 = createMessage('parent-msg-3', 'user', 'After fork point', {
        sessionId: 'parent',
        timestamp: 5000,
      });

      mockGetEvents(cleanup, 'parent', [
        messageEvent('parent-msg-1', 1000, { sessionId: 'parent', role: 'user' }),
        messageEvent('parent-msg-2', 2000, { sessionId: 'parent', role: 'assistant' }),
        messageEvent('parent-msg-3', 5000, { sessionId: 'parent', role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'parent-msg-1', parentMsg1);
      mockGetMessage(cleanup, 'parent-msg-2', parentMsg2);
      mockGetMessage(cleanup, 'parent-msg-3', parentMsg3);

      // Child session (forked at parent-msg-2)
      // Note: forkPointMessageId is now normalized to Makaio message ID
      mockGetSession(cleanup, {
        sessionId: 'child',
        parentSessionId: 'parent',
        forkPointMessageId: 'parent-msg-2',
      });
      const childMsg1 = createMessage('child-msg-1', 'user', 'Child diverges', {
        sessionId: 'child',
        timestamp: 3000,
      });
      const childMsg2 = createMessage('child-msg-2', 'assistant', 'Child response', {
        sessionId: 'child',
        timestamp: 4000,
      });

      mockGetEvents(cleanup, 'child', [
        messageEvent('child-msg-1', 3000, { sessionId: 'child', role: 'user' }),
        messageEvent('child-msg-2', 4000, { sessionId: 'child', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'child-msg-1', childMsg1);
      mockGetMessage(cleanup, 'child-msg-2', childMsg2);

      const result = await getFullConversation(MakaioBus, 'child');

      // Should have: parent-msg-1, parent-msg-2 (up to fork point), child-msg-1, child-msg-2
      // Should NOT have: parent-msg-3 (after fork point)
      expect(result.messages).toHaveLength(4);
      expect(result.messages.map((m) => m.messageId)).toEqual([
        'parent-msg-1',
        'parent-msg-2',
        'child-msg-1',
        'child-msg-2',
      ]);
      expect(result.sessionChain).toEqual(['parent', 'child']);
    });

    it('should handle grandchild (three-level chain)', async () => {
      // Root session
      mockGetSession(cleanup, { sessionId: 'root', parentSessionId: undefined });
      const rootMsg = createMessage('root-msg', 'user', 'Root', { sessionId: 'root', timestamp: 1000 });
      mockGetEvents(cleanup, 'root', [messageEvent('root-msg', 1000, { sessionId: 'root', role: 'user' })]);
      mockGetMessage(cleanup, 'root-msg', rootMsg);

      // Parent session (forked from root)
      mockGetSession(cleanup, {
        sessionId: 'parent',
        parentSessionId: 'root',
        forkPointMessageId: 'root-msg',
      });
      const parentMsg = createMessage('parent-msg', 'user', 'Parent', { sessionId: 'parent', timestamp: 2000 });
      mockGetEvents(cleanup, 'parent', [messageEvent('parent-msg', 2000, { sessionId: 'parent', role: 'user' })]);
      mockGetMessage(cleanup, 'parent-msg', parentMsg);

      // Child session (forked from parent)
      mockGetSession(cleanup, {
        sessionId: 'child',
        parentSessionId: 'parent',
        forkPointMessageId: 'parent-msg',
      });
      const childMsg = createMessage('child-msg', 'user', 'Child', { sessionId: 'child', timestamp: 3000 });
      mockGetEvents(cleanup, 'child', [messageEvent('child-msg', 3000, { sessionId: 'child', role: 'user' })]);
      mockGetMessage(cleanup, 'child-msg', childMsg);

      const result = await getFullConversation(MakaioBus, 'child');

      expect(result.messages.map((m) => m.messageId)).toEqual(['root-msg', 'parent-msg', 'child-msg']);
      expect(result.sessionChain).toEqual(['root', 'parent', 'child']);
    });
  });

  describe('fork transforms', () => {
    it('should filter removedMessageIds from ancestor messages only', async () => {
      // Parent session with 3 messages
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });
      const parentMsg1 = createMessage('msg-1', 'user', 'Hello', { sessionId: 'parent', timestamp: 1000 });
      const parentMsg2 = createMessage('msg-2', 'assistant', 'To be removed', { sessionId: 'parent', timestamp: 2000 });
      const parentMsg3 = createMessage('msg-3', 'user', 'Fork point', { sessionId: 'parent', timestamp: 3000 });

      mockGetEvents(cleanup, 'parent', [
        messageEvent('msg-1', 1000, { sessionId: 'parent', role: 'user' }),
        messageEvent('msg-2', 2000, { sessionId: 'parent', role: 'assistant' }),
        messageEvent('msg-3', 3000, { sessionId: 'parent', role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', parentMsg1);
      mockGetMessage(cleanup, 'msg-2', parentMsg2);
      mockGetMessage(cleanup, 'msg-3', parentMsg3);

      // Fork session with removedMessageIds transform
      const transforms: ForkTransforms = {
        removedMessageIds: ['msg-2'],
      };
      mockGetSession(cleanup, {
        sessionId: 'fork',
        parentSessionId: 'parent',
        forkPointMessageId: 'msg-3',
        forkTransforms: transforms,
      });

      // Add message to fork session itself
      const forkMsg = createMessage('msg-4', 'assistant', 'Child message', { sessionId: 'fork', timestamp: 4000 });
      mockGetEvents(cleanup, 'fork', [messageEvent('msg-4', 4000, { sessionId: 'fork', role: 'assistant' })]);
      mockGetMessage(cleanup, 'msg-4', forkMsg);

      const result = await getFullConversation(MakaioBus, 'fork');

      // msg-2 filtered from ancestors, msg-4 kept (fork's own)
      expect(result.messages.map((m) => m.messageId)).toEqual(['msg-1', 'msg-3', 'msg-4']);
    });

    it('should not filter removedMessageIds from fork session own messages', async () => {
      // Parent session with 2 messages
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });
      const parentMsg1 = createMessage('msg-1', 'user', 'Hello', { sessionId: 'parent', timestamp: 1000 });
      const parentMsg2 = createMessage('msg-2', 'assistant', 'Fork point', { sessionId: 'parent', timestamp: 2000 });

      mockGetEvents(cleanup, 'parent', [
        messageEvent('msg-1', 1000, { sessionId: 'parent', role: 'user' }),
        messageEvent('msg-2', 2000, { sessionId: 'parent', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', parentMsg1);
      mockGetMessage(cleanup, 'msg-2', parentMsg2);

      // Fork session with removedMessageIds that includes fork's own message
      // This should NOT filter the fork's own message
      const transforms: ForkTransforms = {
        removedMessageIds: ['msg-3'], // Trying to filter fork's own message
      };
      mockGetSession(cleanup, {
        sessionId: 'fork',
        parentSessionId: 'parent',
        forkPointMessageId: 'msg-2',
        forkTransforms: transforms,
      });

      // Fork's own message
      const forkMsg = createMessage('msg-3', 'user', 'My own message', { sessionId: 'fork', timestamp: 3000 });
      mockGetEvents(cleanup, 'fork', [messageEvent('msg-3', 3000, { sessionId: 'fork', role: 'user' })]);
      mockGetMessage(cleanup, 'msg-3', forkMsg);

      const result = await getFullConversation(MakaioBus, 'fork');

      // msg-3 should NOT be filtered because it belongs to the fork session
      expect(result.messages.map((m) => m.messageId)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('should apply pipeline transforms to ancestor messages only', async () => {
      // Parent session with tool_output block
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });

      // Create message with tool_output block
      const parentMsgWithTool: SessionMessage = {
        messageId: 'msg-1',
        sessionId: 'parent',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Tool result',
        blocks: [
          { type: 'tool_call', toolCallId: 'tool-1', name: 'bash', args: { cmd: 'ls' } },
          { type: 'tool_output', toolCallId: 'tool-1', output: 'file1.txt\nfile2.txt' },
        ],
        timestamp: 1000,
      };
      const parentMsg2 = createMessage('msg-2', 'user', 'Fork point', { sessionId: 'parent', timestamp: 2000 });

      mockGetEvents(cleanup, 'parent', [
        messageEvent('msg-1', 1000, { sessionId: 'parent', role: 'assistant' }),
        messageEvent('msg-2', 2000, { sessionId: 'parent', role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', parentMsgWithTool);
      mockGetMessage(cleanup, 'msg-2', parentMsg2);

      // Fork session with strip-tool-outputs pipeline
      const transforms: ForkTransforms = {
        appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
      };
      mockGetSession(cleanup, {
        sessionId: 'fork',
        parentSessionId: 'parent',
        forkPointMessageId: 'msg-2',
        forkTransforms: transforms,
      });

      // Fork's own message with tool_output (should NOT be stripped)
      const forkMsgWithTool: SessionMessage = {
        messageId: 'msg-3',
        sessionId: 'fork',
        turnId: 'turn-2',
        role: 'assistant',
        contentText: 'Fork tool result',
        blocks: [
          { type: 'tool_call', toolCallId: 'tool-2', name: 'read', args: { file: 'x.ts' } },
          { type: 'tool_output', toolCallId: 'tool-2', output: 'fork content here' },
        ],
        timestamp: 3000,
      };
      mockGetEvents(cleanup, 'fork', [messageEvent('msg-3', 3000, { sessionId: 'fork', role: 'assistant' })]);
      mockGetMessage(cleanup, 'msg-3', forkMsgWithTool);

      const result = await getFullConversation(MakaioBus, 'fork');

      expect(result.messages).toHaveLength(3);

      // Ancestor tool output should be stripped
      const ancestorMsg = result.messages.find((m) => m.messageId === 'msg-1');
      const ancestorToolOutput = ancestorMsg?.blocks.find((b) => b.type === 'tool_output');
      expect(ancestorToolOutput?.output).toMatch(/^\[output removed - \d+ chars\]$/);

      // Fork's own tool output should be intact
      const forkMsg = result.messages.find((m) => m.messageId === 'msg-3');
      const forkToolOutput = forkMsg?.blocks.find((b) => b.type === 'tool_output');
      expect(forkToolOutput?.output).toBe('fork content here');
    });

    it('should apply both removedMessageIds and pipeline transforms', async () => {
      // Parent session
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });

      const parentMsg1 = createMessage('msg-1', 'user', 'First message', { sessionId: 'parent', timestamp: 1000 });
      const parentMsgWithTool: SessionMessage = {
        messageId: 'msg-2',
        sessionId: 'parent',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Tool response',
        blocks: [
          { type: 'tool_call', toolCallId: 'tool-1', name: 'bash', args: {} },
          { type: 'tool_output', toolCallId: 'tool-1', output: 'large output' },
        ],
        timestamp: 2000,
      };
      const parentMsg3 = createMessage('msg-3', 'user', 'To be removed', { sessionId: 'parent', timestamp: 3000 });
      const parentMsg4 = createMessage('msg-4', 'assistant', 'Fork point', { sessionId: 'parent', timestamp: 4000 });

      mockGetEvents(cleanup, 'parent', [
        messageEvent('msg-1', 1000, { sessionId: 'parent', role: 'user' }),
        messageEvent('msg-2', 2000, { sessionId: 'parent', role: 'assistant' }),
        messageEvent('msg-3', 3000, { sessionId: 'parent', role: 'user' }),
        messageEvent('msg-4', 4000, { sessionId: 'parent', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', parentMsg1);
      mockGetMessage(cleanup, 'msg-2', parentMsgWithTool);
      mockGetMessage(cleanup, 'msg-3', parentMsg3);
      mockGetMessage(cleanup, 'msg-4', parentMsg4);

      // Fork with both transforms
      const transforms: ForkTransforms = {
        removedMessageIds: ['msg-3'],
        appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
      };
      mockGetSession(cleanup, {
        sessionId: 'fork',
        parentSessionId: 'parent',
        forkPointMessageId: 'msg-4',
        forkTransforms: transforms,
      });

      const forkMsg = createMessage('msg-5', 'user', 'New direction', { sessionId: 'fork', timestamp: 5000 });
      mockGetEvents(cleanup, 'fork', [messageEvent('msg-5', 5000, { sessionId: 'fork', role: 'user' })]);
      mockGetMessage(cleanup, 'msg-5', forkMsg);

      const result = await getFullConversation(MakaioBus, 'fork');

      // msg-3 should be removed, tool outputs stripped from ancestors
      expect(result.messages.map((m) => m.messageId)).toEqual(['msg-1', 'msg-2', 'msg-4', 'msg-5']);

      // Tool output in msg-2 should be stripped
      const toolMsg = result.messages.find((m) => m.messageId === 'msg-2');
      const toolOutput = toolMsg?.blocks.find((b) => b.type === 'tool_output');
      expect(toolOutput?.output).toMatch(/^\[output removed - \d+ chars\]$/);
    });

    it('preserves ancestor prefix outside segment transform boundaries', async () => {
      // Root ancestor session (prefix that must be preserved)
      mockGetSession(cleanup, { sessionId: 'root', parentSessionId: undefined });
      const rootMsg = createMessage('root-msg-1', 'user', 'Root prefix', { sessionId: 'root', timestamp: 1000 });
      mockGetEvents(cleanup, 'root', [messageEvent('root-msg-1', 1000, { sessionId: 'root', role: 'user' })]);
      mockGetMessage(cleanup, 'root-msg-1', rootMsg);

      // Parent/source session where segment transforms are defined
      mockGetSession(cleanup, {
        sessionId: 'parent',
        parentSessionId: 'root',
        forkPointMessageId: 'root-msg-1',
      });
      const parentMsg1 = createMessage('parent-msg-1', 'user', 'Keep parent message', {
        sessionId: 'parent',
        timestamp: 2000,
      });
      const parentMsg2 = createMessage('parent-msg-2', 'assistant', 'Drop this parent message', {
        sessionId: 'parent',
        timestamp: 3000,
      });
      mockGetEvents(cleanup, 'parent', [
        messageEvent('parent-msg-1', 2000, { sessionId: 'parent', role: 'user' }),
        messageEvent('parent-msg-2', 3000, { sessionId: 'parent', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'parent-msg-1', parentMsg1);
      mockGetMessage(cleanup, 'parent-msg-2', parentMsg2);

      // Fork session with segment transforms covering only parent message range
      mockGetSession(cleanup, {
        sessionId: 'fork',
        parentSessionId: 'parent',
        forkPointMessageId: 'parent-msg-2',
        forkTransforms: {
          segments: [{ fromMessageId: 'parent-msg-1', toMessageId: 'parent-msg-2', policy: 'exclude' }],
        },
      });
      const forkMsg = createMessage('fork-msg-1', 'assistant', 'Fork response', { sessionId: 'fork', timestamp: 4000 });
      mockGetEvents(cleanup, 'fork', [messageEvent('fork-msg-1', 4000, { sessionId: 'fork', role: 'assistant' })]);
      mockGetMessage(cleanup, 'fork-msg-1', forkMsg);

      const result = await getFullConversation(MakaioBus, 'fork');

      // root-msg-1 must remain, segment exclusion applies only to parent scope.
      expect(result.messages.map((m) => m.messageId)).toEqual(['root-msg-1', 'fork-msg-1']);
    });
  });
});
