import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { RateLimitError } from '@makaio/core';
import { AgentSubjects } from '@makaio/contracts';
import { createTestableAgent, MockConnector } from './helpers/mock-agent.js';

function makeMockConnectorFactory(): (config: { model: string; cwd: string }) => MockConnector {
  return (config) => new MockConnector(config.model, config.cwd);
}

describe('AIAgent terminal error categories', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('derives a typed error category from the terminal message result', async () => {
    const agent = createTestableAgent({
      agentId: 'test-agent-terminal-error-category',
      mockConnectorFactory: makeMockConnectorFactory(),
      sessionId: 'session-terminal-error-category',
    });
    const completion = new Promise<{ messageId: string; error?: string; errorCategory?: string }>((resolve) => {
      const cleanup = MakaioBus.on(AgentSubjects.complete, (ctx) => {
        cleanup();
        resolve({
          messageId: ctx.payload.messageId,
          error: ctx.payload.error,
          errorCategory: ctx.payload.errorCategory,
        });
      });
    });

    try {
      const startResult = await agent.start('trigger a terminal error');
      startResult.messageHandle.markCompleted({
        outcome: 'error',
        error: new RateLimitError('provider rate limited'),
      });

      await expect(completion).resolves.toEqual({
        messageId: startResult.messageHandle.messageId,
        error: 'provider rate limited',
        errorCategory: 'rate_limit',
      });
    } finally {
      await agent.close();
    }
  });
});
