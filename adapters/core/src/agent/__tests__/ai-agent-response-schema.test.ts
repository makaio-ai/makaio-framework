import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type StructuredOutputValidation } from '@makaio/contracts';
import { createTestableAgent, MockConnector } from './helpers/mock-agent.js';
import { UserMessageQueue } from '../../session/user-message-queue.js';
import type { ConnectorSendMessageOptions } from '../types.js';
import { markCompletedWithFinalResult, type MessageHandle, type MessageResult } from '../../message-handle/index.js';
import type { NormalizedMessageInput } from '../../utils/index.js';

function makeMockConnectorFactory(): (config: { model: string; cwd: string }) => MockConnector {
  return (config) => new MockConnector(config.model, config.cwd);
}

class QueueingMockConnector extends MockConnector {
  public readonly queue = new UserMessageQueue();

  public override async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    const handle = await super.sendMessage(message, options);
    this.queue.enqueue(handle);
    return handle;
  }
}

class RawCachingMockConnector extends MockConnector {
  private lastCanonicalResult: MessageResult | null = null;

  public async providerComplete(handle: MessageHandle, result: MessageResult): Promise<void> {
    await markCompletedWithFinalResult(handle, result, (_handle, finalResult) => {
      this.lastCanonicalResult = finalResult;
    });
  }

  public async complete(): Promise<MessageResult | null> {
    return this.lastCanonicalResult;
  }
}

function makeQueueingMockConnectorFactory(): (config: { model: string; cwd: string }) => QueueingMockConnector {
  return (config) => new QueueingMockConnector(config.model, config.cwd);
}

function makeRawCachingMockConnectorFactory(): (config: { model: string; cwd: string }) => RawCachingMockConnector {
  return (config) => new RawCachingMockConnector(config.model, config.cwd);
}

async function waitForCompleteEvents(
  count: number,
): Promise<Array<{ messageId: string; validation?: StructuredOutputValidation }>> {
  const events: Array<{ messageId: string; validation?: StructuredOutputValidation }> = [];

  await new Promise<void>((resolve) => {
    const cleanup = MakaioBus.on(AgentSubjects.complete, (ctx) => {
      events.push({
        messageId: ctx.payload.messageId,
        validation: ctx.payload.structuredOutputValidation,
      });
      if (events.length === count) {
        cleanup();
        resolve();
      }
    });
  });

  return events;
}

describe('AIAgent responseSchema scoping', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('validates only turns that carry a responseSchema on their message handle', async () => {
    const agent = createTestableAgent({
      agentId: 'test-agent-response-schema-scope',
      mockConnectorFactory: makeMockConnectorFactory(),
      sessionId: 'session-response-schema-scope',
    });
    const completeEvents = waitForCompleteEvents(2);

    try {
      const startResult = await agent.start('return json', {
        responseSchema: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          name: 'ok_schema',
        },
      });
      startResult.messageHandle.markCompleted({ outcome: 'completed', result: { message: '{"ok":true}' } });

      await MakaioBus.request(AgentSubjects.sendMessage, {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        message: 'ordinary follow-up',
        messageId: 'plain-follow-up',
      });
      const [followUpHandle] = agent.currentConnector.sentHandles;
      expect(followUpHandle).toBeDefined();
      if (!followUpHandle) {
        throw new Error('Expected connector to record the follow-up message handle');
      }

      followUpHandle.markCompleted({
        outcome: 'completed',
        result: { message: 'plain text is allowed without a schema' },
      });

      await expect(completeEvents).resolves.toEqual([
        { messageId: startResult.messageHandle.messageId, validation: { status: 'passed' } },
        { messageId: 'plain-follow-up', validation: undefined },
      ]);
    } finally {
      await agent.close();
    }
  });

  it('injects fallback structured-output context through the AIAgent sendMessage path', async () => {
    const agent = createTestableAgent({
      agentId: 'test-agent-response-schema-injection',
      mockConnectorFactory: makeMockConnectorFactory(),
      sessionId: 'session-response-schema-injection',
    });
    const completeEvents = waitForCompleteEvents(1);

    try {
      await agent.initialize();

      const schema = {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      } as const;
      const sendResult = await MakaioBus.request(AgentSubjects.sendMessage, {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        message: 'return json',
        messageId: 'structured-send-message',
        responseSchema: { schema, name: 'ok_schema' },
      });

      const [sentHandle] = agent.currentConnector.sentHandles;
      expect(sendResult).toEqual({ messageId: 'structured-send-message' });
      expect(sentHandle).toBeDefined();
      if (!sentHandle) {
        throw new Error('Expected connector to record the structured-output message handle');
      }
      expect(sentHandle.responseSchema).toEqual({ schema, name: 'ok_schema' });
      expect(sentHandle.turnContext?.structuredOutput).toEqual(expect.stringContaining('Respond ONLY with valid JSON'));
      expect(sentHandle.turnContext?.structuredOutput).toEqual(expect.stringContaining('"ok"'));

      sentHandle.markCompleted({ outcome: 'completed', result: { message: '{"ok":true}' } });

      await expect(completeEvents).resolves.toEqual([
        { messageId: 'structured-send-message', validation: { status: 'passed' } },
      ]);
    } finally {
      await agent.close();
    }
  });

  it('prioritizes structured-output retries ahead of already queued user turns', async () => {
    const agent = createTestableAgent({
      agentId: 'test-agent-response-schema-retry-priority',
      mockConnectorFactory: makeQueueingMockConnectorFactory(),
      sessionId: 'session-response-schema-retry-priority',
    });
    const cleanupRetryPolicy = MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
      ctx.setResult({ maxRetries: 1 });
    });
    const completeEvents = waitForCompleteEvents(1);

    try {
      const startResult = await agent.start('return json', {
        sessionContext: {
          requestCorrelation: {
            turnId: 'turn-structured-retry',
            executionId: 'execution-structured-retry',
            frameId: 'frame-structured-retry',
          },
        },
        responseSchema: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          name: 'ok_schema',
        },
      });
      const connector = agent.currentConnector as QueueingMockConnector;

      await MakaioBus.request(AgentSubjects.sendMessage, {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        message: 'queued follow-up',
        messageId: 'queued-follow-up',
      });

      startResult.messageHandle.markCompleted({ outcome: 'completed', result: { message: 'invalid json' } });

      await vi.waitFor(() => {
        expect(connector.sentHandles).toHaveLength(2);
      });
      const retryHandle = connector.sentHandles.find((handle) =>
        handle.messageId.includes(':structured-output-retry:1'),
      );
      expect(retryHandle).toBeDefined();
      if (!retryHandle) {
        throw new Error('Expected structured-output retry handle');
      }

      expect(retryHandle.requestCorrelation).toEqual({
        sessionId: 'session-response-schema-retry-priority',
        turnId: 'turn-structured-retry',
        messageId: retryHandle.messageId,
        executionId: 'execution-structured-retry',
        frameId: 'frame-structured-retry',
      });

      expect(connector.queue.dequeue()).toBe(retryHandle);
      expect(connector.queue.dequeue()?.messageId).toBe('queued-follow-up');

      retryHandle.markCompleted({ outcome: 'completed', result: { message: '{"ok":true}' } });

      await expect(completeEvents).resolves.toEqual([
        { messageId: startResult.messageHandle.messageId, validation: { status: 'passed' } },
      ]);
    } finally {
      cleanupRetryPolicy();
      await agent.close();
    }
  });

  it('returns enforced structured-output results through handles and agent completion', async () => {
    const agent = createTestableAgent({
      agentId: 'test-agent-response-schema-direct-results',
      mockConnectorFactory: makeRawCachingMockConnectorFactory(),
      sessionId: 'session-response-schema-direct-results',
    });
    const cleanupRetryPolicy = MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
      ctx.setResult({ maxRetries: 0 });
    });
    const cleanupEnforce = MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      ctx.setResult({ enforced: true, output: '{"ok":true}' });
    });

    try {
      const startResult = await agent.start('return json', {
        responseSchema: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          name: 'ok_schema',
        },
      });
      const connector = agent.currentConnector as RawCachingMockConnector;
      await connector.providerComplete(startResult.messageHandle, {
        outcome: 'completed',
        result: { message: 'invalid json' },
      });

      const handleResult = await startResult.messageHandle.waitForCompletion();
      expect(handleResult).toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
        structuredOutputValidation: { status: 'enforced' },
      });
      await expect(connector.complete()).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
        structuredOutputValidation: { status: 'enforced' },
      });
      await expect(agent.complete()).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
        structuredOutputValidation: { status: 'enforced' },
      });
    } finally {
      cleanupRetryPolicy();
      cleanupEnforce();
      await agent.close();
    }
  });
});
