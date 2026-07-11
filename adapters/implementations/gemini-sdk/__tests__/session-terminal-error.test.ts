import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { AuthenticationError, RateLimitError } from '@makaio/core';
import { MessageHandle } from '@makaio/ai-adapters-core';
import { GeminiConnectorNamespace } from '../src/namespaces/index.js';
import { GeminiConnectorSession } from '../src/session.js';

async function createSession(handleError: (error: Error, terminate: boolean) => void): Promise<GeminiConnectorSession> {
  return new GeminiConnectorSession({
    bus: await GeminiConnectorNamespace.scopedBus(),
    globalBus: createBusInstance(),
    adapterId: 'adapter-test',
    adapterName: 'gemini-sdk',
    agentId: 'agent-test',
    cwd: process.cwd(),
    model: 'gemini-2.5-flash',
    env: {},
    geminiConfig: {
      getSessionId: () => 'session-test',
      getModel: () => 'gemini-2.5-flash',
    } as never,
    geminiChat: {
      getHistory: () => [],
      setHistory: () => {},
    } as never,
    emitSdkEvent: async () => {},
    handleError,
    requestToolApproval: async () => ({ action: 'allow' }) as AgentToolApproveResponse,
  });
}

describe('GeminiConnectorSession terminal errors', () => {
  it.each([
    ['rate limit', new RateLimitError('provider rate limited')],
    ['authentication', new AuthenticationError('provider authentication failed')],
  ])('preserves a classified %s error on the message handle', async (_label, classifiedError) => {
    const handledErrors: Error[] = [];
    const session = await createSession((error) => {
      handledErrors.push(error);
    });
    const handle = new MessageHandle(
      `message-${classifiedError.code}`,
      { role: 'user', blocks: [{ type: 'text', content: 'hello' }] },
      'enqueue',
    );
    const runTurn = vi.fn(async () => {
      throw classifiedError;
    });
    Reflect.set(session, 'runTurn', runTurn);
    const startNewTurn = Reflect.get(session, 'startNewTurn') as ((handle: MessageHandle) => Promise<void>) | undefined;
    if (startNewTurn === undefined) {
      throw new Error('Expected GeminiConnectorSession to expose its turn-start seam');
    }

    await startNewTurn.call(session, handle);

    await expect(handle.waitForCompletion()).resolves.toEqual({
      outcome: 'error',
      error: classifiedError,
    });
    await vi.waitFor(() => {
      expect(handledErrors).toEqual([classifiedError]);
    });
  });
});
