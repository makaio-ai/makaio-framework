/**
 * Tests for event normalizers
 *
 * Tests transformation from app-server protocol events to canonical AgentSubjects.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAppServerEvent, type NormalizationContext } from '../event-normalizers.js';
import type { ServerNotification } from '../protocol/generated/ServerNotification.js';
import { AgentSubjects } from '@makaio/contracts';

const mockContext: NormalizationContext = {
  adapterId: 'test-adapter',
  adapterName: 'codex-app-server',
  agentId: 'test-agent',
  adapterSessionId: 'test-thread-id',
};

describe('event-normalizers', () => {
  describe('normalizeAppServerEvent', () => {
    describe('agent message delta', () => {
      it('should normalize item/agentMessage/delta to message_delta', () => {
        const notification: ServerNotification = {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'Hello world',
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          subject: AgentSubjects.message_delta,
          payload: {
            ...mockContext,
            text: 'Hello world',
          },
        });
      });
    });

    describe('item started', () => {
      it('should normalize item/started for agentMessage to message_started', () => {
        const notification: ServerNotification = {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'agentMessage',
              id: 'item-1',
              text: '',
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0].subject).toBe(AgentSubjects.message_delta);
      });

      it('should normalize item/started for commandExecution to tool.started', () => {
        const notification: ServerNotification = {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'item-1',
              command: 'ls -la',
              cwd: '/home/user',
              processId: 'proc-1',
              status: 'inProgress',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          subject: AgentSubjects.tool.started,
          payload: {
            ...mockContext,
            toolName: 'bash',
            toolCallId: 'item-1',
          },
        });
      });

      it('should normalize item/started for fileChange to tool.started', () => {
        const notification: ServerNotification = {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'fileChange',
              id: 'item-1',
              changes: [],
              status: 'inProgress',
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          subject: AgentSubjects.tool.started,
          payload: {
            ...mockContext,
            toolName: 'patch',
            toolCallId: 'item-1',
          },
        });
      });

      it('should return empty array for unhandled item types', () => {
        const notification: ServerNotification = {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'imageView',
              id: 'item-1',
              path: '/path/to/image.png',
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(0);
      });
    });

    describe('command execution output delta', () => {
      it('should normalize item/commandExecution/outputDelta to tool.output', () => {
        const notification: ServerNotification = {
          method: 'item/commandExecution/outputDelta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'output line 1',
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          subject: AgentSubjects.tool.output,
          payload: {
            ...mockContext,
            output: 'output line 1',
            toolCallId: 'item-1',
          },
        });
      });
    });

    describe('reasoning delta', () => {
      it('should normalize item/reasoning/textDelta to reasoning_delta', () => {
        const notification: ServerNotification = {
          method: 'item/reasoning/textDelta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'Thinking...',
            contentIndex: 0,
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          subject: AgentSubjects.reasoning_delta,
          payload: {
            ...mockContext,
            content: 'Thinking...',
          },
        });
      });
    });

    describe('token usage', () => {
      it('should normalize thread/tokenUsage/updated to usage', () => {
        const notification: ServerNotification = {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            tokenUsage: {
              total: {
                totalTokens: 1000,
                inputTokens: 500,
                cachedInputTokens: 100,
                outputTokens: 400,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: 200,
                inputTokens: 100,
                cachedInputTokens: 20,
                outputTokens: 80,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 200000,
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          subject: AgentSubjects.usage,
          payload: {
            ...mockContext,
            granularity: 'provider-call',
            provider: 'openai',
            model: 'gpt-5.1-codex-mini',
            inputTokens: 100,
            inputCachedTokens: 20,
            outputTokens: 80,
            reasoningTokens: 0,
            totalTokens: 200,
            costUnits: 200,
            costUnitType: 'tokens',
          },
        });
      });

      it('should use model from context if provided', () => {
        const notification: ServerNotification = {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            tokenUsage: {
              total: {
                totalTokens: 1000,
                inputTokens: 500,
                cachedInputTokens: 100,
                outputTokens: 400,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: 200,
                inputTokens: 100,
                cachedInputTokens: 20,
                outputTokens: 80,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 200000,
            },
          },
        };

        const contextWithModel: NormalizationContext = {
          ...mockContext,
          model: 'claude-3-5-sonnet-20240620',
        };

        const result = normalizeAppServerEvent(notification, contextWithModel);

        expect(result[0].payload.model).toBe('claude-3-5-sonnet-20240620');
        expect(result[0].payload.provider).toBe('anthropic');
      });

      it('should pass through nonzero reasoning tokens', () => {
        const notification: ServerNotification = {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            tokenUsage: {
              total: {
                totalTokens: 1000,
                inputTokens: 500,
                cachedInputTokens: 100,
                outputTokens: 400,
                reasoningOutputTokens: 150,
              },
              last: {
                totalTokens: 200,
                inputTokens: 100,
                cachedInputTokens: 20,
                outputTokens: 80,
                reasoningOutputTokens: 42,
              },
              modelContextWindow: 200000,
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          payload: expect.objectContaining({
            reasoningTokens: 42,
          }),
        });
      });
    });

    describe('turn completed', () => {
      it('leaves turn/completed to the correlated MessageHandle completion path', () => {
        const notification: ServerNotification = {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              items: [],
              status: 'completed',
              error: null,
            },
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toEqual([]);
      });
    });

    describe('unhandled notifications', () => {
      it('should return empty array for unknown methods', () => {
        const notification: ServerNotification = {
          method: 'account/updated',
          params: {
            authMode: null,
          },
        };

        const result = normalizeAppServerEvent(notification, mockContext);

        expect(result).toHaveLength(0);
      });
    });
  });
});
