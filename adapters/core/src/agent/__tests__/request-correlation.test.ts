import { describe, expect, it } from 'vitest';
import {
  bindProviderRequestCorrelation,
  buildFactoryUsageCorrelationHeaders,
  FactoryUsageCorrelationHeaders,
} from '../request-correlation.js';

describe('provider request correlation', () => {
  it('lets runtime-owned session and message IDs override orchestrator values', () => {
    expect(
      bindProviderRequestCorrelation(
        {
          sessionId: 'stale-session',
          turnId: 'turn-1',
          messageId: 'stale-message',
          executionId: 'execution-1',
          frameId: 'frame-1',
        },
        { sessionId: 'runtime-session', messageId: 'runtime-message', llmCallId: 'call-1' },
      ),
    ).toEqual({
      sessionId: 'runtime-session',
      turnId: 'turn-1',
      messageId: 'runtime-message',
      llmCallId: 'call-1',
      executionId: 'execution-1',
      frameId: 'frame-1',
    });
  });

  it('projects exactly the Factory Gateway header allowlist', () => {
    expect(
      buildFactoryUsageCorrelationHeaders({
        sessionId: 'session-1',
        turnId: 'turn-1',
        messageId: 'message-1',
        llmCallId: 'call-1',
        executionId: 'execution-1',
        frameId: 'frame-1',
      }),
    ).toEqual({
      [FactoryUsageCorrelationHeaders.sessionId]: 'session-1',
      [FactoryUsageCorrelationHeaders.turnId]: 'turn-1',
      [FactoryUsageCorrelationHeaders.messageId]: 'message-1',
      [FactoryUsageCorrelationHeaders.llmCallId]: 'call-1',
      [FactoryUsageCorrelationHeaders.executionId]: 'execution-1',
      [FactoryUsageCorrelationHeaders.frameId]: 'frame-1',
    });
  });

  it('rejects arbitrary or invalid identifiers before building headers', () => {
    expect(() =>
      buildFactoryUsageCorrelationHeaders({
        llmCallId: 'call-1',
        executionId: 'x'.repeat(513),
      }),
    ).toThrow();
  });
});
