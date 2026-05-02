import { describe, it, expect } from 'vitest';
import { AgentSubjects } from '@makaio/contracts';
import {
  normalizeAssistantTurnStart,
  normalizeAssistantMessage,
  normalizeToolUserRequested,
  normalizeToolExecutionStart,
  normalizeToolExecutionPartialResult,
  normalizeToolExecutionComplete,
  normalizeSessionTruncation,
  normalizeSessionError,
  normalizeUserMessage,
  normalizeAssistantTurnEnd,
  normalizeGitHubCopilotLogRecord,
  type NormalizationContext,
  type RawGitHubCopilotLogRecord,
} from '../src/event-normalizers.js';

const baseContext: NormalizationContext = {
  adapterId: 'test-adapter',
  adapterName: 'github-copilot-sdk',
  agentId: 'main',
  adapterSessionId: 'session-123',
};

function createRecord(type: string, data: Record<string, unknown>): RawGitHubCopilotLogRecord {
  return { type, data, id: `event-${type}`, timestamp: new Date().toISOString(), parentId: null };
}

describe('event-normalizers', () => {
  // =========================================================================
  // LIVE-MATCHING NORMALIZERS
  // =========================================================================

  describe('normalizeAssistantTurnStart', () => {
    it('normalizes to agent.started with model and cwd', () => {
      const result = normalizeAssistantTurnStart({}, baseContext, 'gpt-4o', '/home/user');
      expect(result.subject).toBe(AgentSubjects.started);
      expect(result.payload).toMatchObject({ model: 'gpt-4o', cwd: '/home/user', adapterId: 'test-adapter' });
    });

    it('handles missing model and cwd', () => {
      const result = normalizeAssistantTurnStart({}, baseContext);
      expect(result.payload).toMatchObject({ model: null, cwd: null });
    });
  });

  describe('normalizeAssistantMessage', () => {
    it('normalizes to agent.message with content', () => {
      const result = normalizeAssistantMessage({ messageId: 'msg-1', content: 'Hello world' }, baseContext);
      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe(AgentSubjects.message);
      expect(result[0].payload).toMatchObject({ content: 'Hello world' });
    });

    it('returns empty array when content is empty', () => {
      expect(normalizeAssistantMessage({ messageId: 'msg-1', content: '' }, baseContext)).toHaveLength(0);
    });

    it('does NOT emit tool.use (handled by tool.user_requested)', () => {
      const result = normalizeAssistantMessage({ messageId: 'msg-1', content: 'Running tool' }, baseContext);
      expect(result.some((e) => e.subject === AgentSubjects.tool.use)).toBe(false);
    });
  });

  describe('normalizeToolUserRequested', () => {
    it('normalizes to agent.tool.use with object args', () => {
      const result = normalizeToolUserRequested(
        { toolName: 'readFile', toolCallId: 'call-1', arguments: { path: '/tmp/test.txt' } },
        baseContext,
      );
      expect(result.subject).toBe(AgentSubjects.tool.use);
      expect(result.payload).toMatchObject({ toolName: 'readFile', args: { path: '/tmp/test.txt' } });
    });

    it('wraps non-object arguments in { value: ... }', () => {
      const result = normalizeToolUserRequested(
        { toolName: 'echo', toolCallId: 'c2', arguments: 'hello' },
        baseContext,
      );
      expect(result.payload).toMatchObject({ args: { value: 'hello' } });
    });

    it('wraps array arguments in { value: ... }', () => {
      const result = normalizeToolUserRequested(
        { toolName: 'multiSelect', toolCallId: 'c3', arguments: ['a', 'b'] },
        baseContext,
      );
      expect(result.payload).toMatchObject({ args: { value: ['a', 'b'] } });
    });
  });

  describe('normalizeToolExecutionStart', () => {
    it('normalizes to agent.tool.use + agent.tool.started', () => {
      const result = normalizeToolExecutionStart(
        { toolName: 'writeFile', toolCallId: 'call-5', arguments: { path: '/tmp/out.txt' } },
        baseContext,
      );
      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe(AgentSubjects.tool.use);
      expect(result[0].payload).toMatchObject({ toolName: 'writeFile', toolCallId: 'call-5' });
      expect(result[1].subject).toBe(AgentSubjects.tool.started);
      expect(result[1].payload).toMatchObject({ toolName: 'writeFile', toolCallId: 'call-5' });
    });
  });

  describe('normalizeToolExecutionPartialResult', () => {
    it('normalizes to agent.tool.output', () => {
      const result = normalizeToolExecutionPartialResult(
        { toolCallId: 'call-6', partialOutput: 'Progress: 50%' },
        baseContext,
      );
      expect(result.subject).toBe(AgentSubjects.tool.output);
      expect(result.payload).toMatchObject({ output: 'Progress: 50%', toolCallId: 'call-6' });
    });
  });

  describe('normalizeToolExecutionComplete', () => {
    it('normalizes to agent.tool.completed with provided toolName', () => {
      const result = normalizeToolExecutionComplete(
        { toolCallId: 'call-7', result: { status: 'ok' }, success: true },
        baseContext,
        'customTool',
      );
      expect(result.subject).toBe(AgentSubjects.tool.completed);
      expect(result.payload).toMatchObject({ toolName: 'customTool', result: { status: 'ok' }, success: true });
    });

    it('uses "unknown" when toolName is not provided', () => {
      const result = normalizeToolExecutionComplete(
        { toolCallId: 'call-8', result: 'done', success: true },
        baseContext,
      );
      expect(result.payload).toMatchObject({ toolName: 'unknown' });
    });

    it('handles failed tool execution', () => {
      const result = normalizeToolExecutionComplete(
        { toolCallId: 'call-9', result: { error: 'File not found' }, success: false },
        baseContext,
        'readFile',
      );
      expect(result.payload).toMatchObject({ success: false });
    });
  });

  describe('normalizeSessionTruncation', () => {
    it('returns agent.usage and agent.contextWindow.updated', () => {
      const result = normalizeSessionTruncation(
        { postTruncationTokensInMessages: 5000, tokenLimit: 128000 },
        baseContext,
        'gpt-4o',
      );
      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe(AgentSubjects.usage);
      expect(result[0].payload).toMatchObject({ provider: 'copilot', model: 'gpt-4o', inputTokens: 5000 });
      expect(result[1].subject).toBe(AgentSubjects.contextWindow.updated);
      expect(result[1].payload).toMatchObject({ currentTokens: 5000, maxTokens: 128000 });
    });

    it('uses "unknown" model when not provided', () => {
      const result = normalizeSessionTruncation(
        { postTruncationTokensInMessages: 1000, tokenLimit: 8000 },
        baseContext,
      );
      expect(result[0].payload).toMatchObject({ model: 'unknown' });
    });
  });

  describe('normalizeSessionError', () => {
    it('normalizes to agent.complete with error outcome', () => {
      const result = normalizeSessionError({ message: 'Rate limit exceeded' }, baseContext);
      expect(result.subject).toBe(AgentSubjects.complete);
      expect(result.payload).toMatchObject({ outcome: 'error', error: 'Rate limit exceeded' });
    });
  });

  // =========================================================================
  // IMPORT-ONLY NORMALIZERS
  // =========================================================================

  describe('normalizeUserMessage', () => {
    it('returns agent.user_message.sent and agent.turn.started', () => {
      const result = normalizeUserMessage({ content: 'Hello AI' }, baseContext);
      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe(AgentSubjects.user_message.sent);
      expect(result[0].payload).toMatchObject({
        content: { role: 'user', blocks: [{ type: 'text', content: 'Hello AI' }] },
        deliveryMode: 'enqueue',
      });
      expect(result[1].subject).toBe(AgentSubjects.turn.started);
    });
  });

  describe('normalizeAssistantTurnEnd', () => {
    it('returns agent.turn.completed and agent.complete', () => {
      const result = normalizeAssistantTurnEnd({}, baseContext, 'Final response');
      expect(result).toHaveLength(2);
      expect(result[0].subject).toBe(AgentSubjects.turn.completed);
      expect(result[0].payload).toMatchObject({ message: 'Final response' });
      expect(result[1].subject).toBe(AgentSubjects.complete);
    });

    it('returns empty array for undefined accumulated message (tool-only turns)', () => {
      const result = normalizeAssistantTurnEnd({}, baseContext);
      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty string accumulated message', () => {
      const result = normalizeAssistantTurnEnd({}, baseContext, '');
      expect(result).toHaveLength(0);
    });
  });

  // =========================================================================
  // MAIN DISPATCHER
  // =========================================================================

  describe('normalizeGitHubCopilotLogRecord', () => {
    describe('live-matching event routing', () => {
      it('routes assistant.turn_start to agent.started', () => {
        const result = normalizeGitHubCopilotLogRecord(createRecord('assistant.turn_start', {}), baseContext, {
          model: 'gpt-4o',
        });
        expect(result).toHaveLength(1);
        expect(result[0].subject).toBe(AgentSubjects.started);
      });

      it('routes assistant.message to agent.message', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('assistant.message', { messageId: 'msg-1', content: 'Hi' }),
          baseContext,
        );
        expect(result[0].subject).toBe(AgentSubjects.message);
      });

      it('routes tool.user_requested to agent.tool.use', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('tool.user_requested', { toolName: 'search', toolCallId: 'c1', arguments: {} }),
          baseContext,
        );
        expect(result[0].subject).toBe(AgentSubjects.tool.use);
      });

      it('routes tool.execution_start to agent.tool.use + agent.tool.started', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('tool.execution_start', { toolName: 'search', toolCallId: 'c1' }),
          baseContext,
        );
        expect(result).toHaveLength(2);
        expect(result[0].subject).toBe(AgentSubjects.tool.use);
        expect(result[1].subject).toBe(AgentSubjects.tool.started);
      });

      it('routes tool.execution_partial_result to agent.tool.output', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('tool.execution_partial_result', { toolCallId: 'c1', partialOutput: 'streaming...' }),
          baseContext,
        );
        expect(result[0].subject).toBe(AgentSubjects.tool.output);
      });

      it('routes tool.execution_complete to agent.tool.completed', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('tool.execution_complete', { toolCallId: 'c1', result: 'done', success: true }),
          baseContext,
        );
        expect(result[0].subject).toBe(AgentSubjects.tool.completed);
      });

      it('uses toolNameResolver for tool.execution_complete', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('tool.execution_complete', { toolCallId: 'call-resolved', result: 'done', success: true }),
          baseContext,
          { toolNameResolver: (id) => (id === 'call-resolved' ? 'resolvedTool' : undefined) },
        );
        expect(result[0].payload).toMatchObject({ toolName: 'resolvedTool' });
      });

      it('routes session.truncation to agent.usage + agent.contextWindow.updated', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('session.truncation', { postTruncationTokensInMessages: 4000, tokenLimit: 128000 }),
          baseContext,
        );
        expect(result).toHaveLength(2);
        expect(result[0].subject).toBe(AgentSubjects.usage);
        expect(result[1].subject).toBe(AgentSubjects.contextWindow.updated);
      });

      it('routes session.error to agent.complete with error outcome', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('session.error', { message: 'Something went wrong' }),
          baseContext,
        );
        expect(result[0].subject).toBe(AgentSubjects.complete);
        expect(result[0].payload).toMatchObject({ outcome: 'error', error: 'Something went wrong' });
      });
    });

    describe('import-only event routing', () => {
      it('routes user.message to agent.user_message.sent + agent.turn.started', () => {
        const result = normalizeGitHubCopilotLogRecord(
          createRecord('user.message', { content: 'User input' }),
          baseContext,
        );
        expect(result).toHaveLength(2);
        expect(result[0].subject).toBe(AgentSubjects.user_message.sent);
        expect(result[1].subject).toBe(AgentSubjects.turn.started);
      });

      it('routes assistant.turn_end to agent.turn.completed + agent.complete', () => {
        const result = normalizeGitHubCopilotLogRecord(createRecord('assistant.turn_end', {}), baseContext, {
          accumulatedMessage: 'Finished',
        });
        expect(result).toHaveLength(2);
        expect(result[0].subject).toBe(AgentSubjects.turn.completed);
        expect(result[1].subject).toBe(AgentSubjects.complete);
      });
    });

    describe('lifecycle events (skipped)', () => {
      it.each([
        'session.start',
        'session.resume',
        'session.info',
        'session.idle',
        'abort',
        'hook.start',
        'hook.end',
        'system.message',
      ])('returns empty array for %s', (eventType) => {
        expect(normalizeGitHubCopilotLogRecord(createRecord(eventType, {}), baseContext)).toHaveLength(0);
      });
    });

    describe('unknown and edge cases', () => {
      it('returns empty array for unknown event types', () => {
        expect(normalizeGitHubCopilotLogRecord(createRecord('custom.unknown', {}), baseContext)).toHaveLength(0);
      });

      it('returns empty array for assistant.message with empty content', () => {
        expect(
          normalizeGitHubCopilotLogRecord(
            createRecord('assistant.message', { messageId: 'm1', content: '' }),
            baseContext,
          ),
        ).toHaveLength(0);
      });
    });
  });
});
