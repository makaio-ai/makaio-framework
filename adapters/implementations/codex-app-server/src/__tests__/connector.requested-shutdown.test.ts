/**
 * A shutdown this connector requested must not lose the turn it interrupted.
 *
 * The transport withholds such an exit from the error channel, which is the
 * whole of the suppression. That withholding is only safe because the exit is
 * still routed into local finalisation — otherwise a pending turn would be left
 * with a handle nobody ever settles, and the suppression would have quietly
 * specified a lost turn instead of an honest classification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { requestedShutdownExitError } from '../connector/connector-shutdown.js';
import { createConnectorTestContext, cleanupConnectorTestContext, type ConnectorTestContext } from './shared.js';

describe('CodexAppServerConnector - requested shutdown finalisation', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('names the requested shutdown as the cause rather than an unexpected death', () => {
    expect(requestedShutdownExitError(null).message).toContain('by signal');
    expect(requestedShutdownExitError(0).message).toContain('with code 0');
    for (const code of [null, 0, 7]) {
      expect(requestedShutdownExitError(code).message).toContain('requested');
    }
  });

  it('completes a turn that was pending across the shutdown', async () => {
    const handle = await ctx.connector.sendMessage({
      role: 'user',
      message: 'in flight when the shutdown was requested',
      blocks: [{ type: 'text', content: 'in flight when the shutdown was requested' }],
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: { id: 'turn-shutdown', status: 'inProgress' },
    });

    expect(handle.state).not.toBe('completed');

    // This is the exact call the transport's exit observation makes once the
    // marker is set: the exit reaches local finalisation and nothing else.
    ctx.connector.handleError(requestedShutdownExitError(null), true);

    expect(handle.state).toBe('completed');
    // The handle is settled, not merely marked: a caller awaiting it is released
    // with the shutdown as the reason instead of waiting forever.
    await expect(handle.waitForCompletion()).resolves.toMatchObject({ outcome: 'error' });
  });

  it('leaves a connector with no pending turn unharmed', () => {
    // The finalisation is not a failure report: with nothing in flight there is
    // nothing to settle, and reaching it must not manufacture a turn outcome.
    expect(() => ctx.connector.handleError(requestedShutdownExitError(0), true)).not.toThrow();
  });
});
