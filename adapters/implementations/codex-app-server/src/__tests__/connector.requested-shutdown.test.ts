/**
 * A shutdown this connector requested must not lose the turn it interrupted.
 *
 * The transport reports such an end with cause `requested` and keeps it off its
 * error channel, which is the whole of the suppression. That withholding is only
 * safe because the end is still routed into local finalisation — otherwise a
 * pending turn would be left with a handle nobody ever settles, and the
 * suppression would have quietly specified a lost turn instead of an honest
 * classification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { requestedShutdownError } from '../connector/connector-shutdown.js';
import {
  createConnectorTestContext,
  createFakeAppServerTransport,
  cleanupConnectorTestContext,
  transportEnd,
  type ConnectorTestContext,
} from './shared.js';

/**
 * Send a message and let the app-server start its turn.
 * @param context - Connector test context.
 * @returns The pending message handle.
 */
async function startPendingTurn(context: ConnectorTestContext): Promise<{
  readonly state: string;
  waitForCompletion(): Promise<unknown>;
}> {
  const handle = await context.connector.sendMessage({
    role: 'user',
    message: 'in flight when the shutdown was requested',
    blocks: [{ type: 'text', content: 'in flight when the shutdown was requested' }],
  });
  await context.mockJsonRpcClient.receiveNotification('turn/started', {
    threadId: 'thread-123',
    turn: { id: 'turn-shutdown', status: 'inProgress' },
  });
  return handle;
}

describe('CodexAppServerConnector - requested shutdown finalisation', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('names the requested shutdown as the cause rather than an unexpected death', () => {
    expect(requestedShutdownError(transportEnd('requested')).message).toBe(
      'codex app-server stopped on request: exited with signal SIGTERM',
    );
    expect(
      requestedShutdownError(transportEnd('requested', { kind: 'exited', code: 0, signal: null })).message,
    ).toContain('exited with code 0');
    expect(
      requestedShutdownError(transportEnd('requested', { kind: 'unobserved', reason: 'observation-timeout' })).message,
    ).toContain('exit not observed (observation-timeout)');
  });

  it('completes a turn that was pending across the shutdown', async () => {
    const handle = await startPendingTurn(ctx);

    expect(handle.state).not.toBe('completed');

    // This is the exact call the evaluation of a requested end makes: the end
    // reaches local finalisation and nothing else.
    ctx.connector.handleError(requestedShutdownError(transportEnd('requested')), true);

    expect(handle.state).toBe('completed');
    // The handle is settled, not merely marked: a caller awaiting it is released
    // with the shutdown as the reason instead of waiting forever.
    await expect(handle.waitForCompletion()).resolves.toMatchObject({ outcome: 'error' });
  });

  it.each([
    ['requested', 'codex app-server stopped on request: exited with signal SIGTERM'],
    ['unexpected', 'codex app-server ended unexpectedly: exited with signal SIGTERM'],
  ] as const)('evaluates a %s end of its transport once, through the supervision wired at construction', async (cause, message) => {
    const fake = createFakeAppServerTransport();
    const wired = await createConnectorTestContext({ transport: fake.transport });
    try {
      const handleError = vi.spyOn(wired.connector, 'handleError');
      const handle = await startPendingTurn(wired);

      fake.publishEnd(transportEnd(cause));

      await expect(handle.waitForCompletion()).resolves.toMatchObject({
        outcome: 'error',
        error: expect.objectContaining({ message }),
      });
      expect(handleError).toHaveBeenCalledOnce();
      expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message }), true);
    } finally {
      cleanupConnectorTestContext(wired);
    }
  });

  it('resolves close() only after the requested end was finalised, not on the exit alone', async () => {
    // The transport observes the exit first and reports the end after draining
    // the rest of stdout; the exit alone is evidence, not completion.
    const fake = createFakeAppServerTransport();
    const wired = await createConnectorTestContext({ transport: fake.transport });
    try {
      const handle = await startPendingTurn(wired);
      let closed = false;
      const closing = wired.connector.close().then((report) => {
        closed = true;
        return report;
      });

      fake.publishExit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      expect(handle.state).not.toBe('completed');

      fake.publishEnd(transportEnd('requested'));
      await expect(closing).resolves.toEqual({ evidence: 'exited' });
      // Finalised by the time close() returned, not merely soon after.
      expect(handle.state).toBe('completed');
    } finally {
      cleanupConnectorTestContext(wired);
    }
  });

  it('leaves a connector with no pending turn unharmed', () => {
    // The finalisation is not a failure report: with nothing in flight there is
    // nothing to settle, and reaching it must not manufacture a turn outcome.
    expect(() => ctx.connector.handleError(requestedShutdownError(transportEnd('requested')), true)).not.toThrow();
  });
});
