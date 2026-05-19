import { describe, it, expect, beforeEach } from 'bun:test';
import { actionRegistry } from '../action-registry.js';
import { resetBuiltInActionsRegistration } from '../actions/index.js';
import { executePipeline } from '../pipeline-executor.js';
import type { SessionMessage } from '@makaio/contracts';
import type { SessionEditorAction } from '../../../session-editor/types.js';

describe('executePipeline', () => {
  beforeEach(() => {
    actionRegistry.reset();
    resetBuiltInActionsRegistration();
  });

  const mockMessages: SessionMessage[] = [
    {
      messageId: 'msg-1',
      sessionId: 'sess-1',
      turnId: null,
      role: 'user',
      contentText: 'Hello world',
      blocks: [{ type: 'text', content: 'Hello world' }],
      timestamp: Date.now(),
    },
    {
      messageId: 'msg-2',
      sessionId: 'sess-1',
      turnId: null,
      role: 'assistant',
      contentText: 'Hi there!',
      blocks: [{ type: 'text', content: 'Hi there!' }],
      timestamp: Date.now(),
    },
  ];

  it('executes empty pipeline returning original messages', async () => {
    const result = await executePipeline(mockMessages, []);

    expect(result.messages).toEqual(mockMessages);
    expect(result.contextJson).toBeUndefined();
  });

  it('executes single action transforming messages', async () => {
    const filterAction: SessionEditorAction = {
      id: 'test-filter',
      label: 'Test Filter',
      description: 'Filters to user messages only',
      category: 'transformation',
      execute: async (msgs) => ({
        kind: 'messages',
        messages: msgs.filter((m) => m.role === 'user'),
      }),
    };

    actionRegistry.register(filterAction);

    const result = await executePipeline(mockMessages, [{ actionId: 'test-filter' }]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('executes action producing context JSON', async () => {
    const summarizeAction: SessionEditorAction = {
      id: 'test-summarize',
      label: 'Test Summarize',
      description: 'Produces context JSON',
      category: 'compression',
      execute: async (msgs) => ({
        kind: 'context',
        json: { summary: 'Test summary', messageCount: msgs.length },
        tokenEstimate: 100,
      }),
    };

    actionRegistry.register(summarizeAction);

    const result = await executePipeline(mockMessages, [{ actionId: 'test-summarize' }]);

    expect(result.messages).toHaveLength(0);
    expect(result.contextJson).toEqual({
      summary: 'Test summary',
      messageCount: 2,
    });
    expect(result.tokenEstimate).toBe(100);
  });

  it('throws on unknown action', async () => {
    await expect(executePipeline(mockMessages, [{ actionId: 'unknown' }])).rejects.toThrow('Unknown action: unknown');
  });
});
