/**
 * The ACP handshake is bounded per round trip, asserted on elapsed time.
 *
 * A peer that accepts the connection and then goes quiet is the case that used
 * to hang a start forever — and with it every teardown queued behind that start.
 * The bound is asserted on the clock, because an error message cannot tell a
 * bounded wait from an unbounded one.
 *
 * The silent peer is the counterparty, not the seam under test: the budget, the
 * race and the failure text all come from the real handshake code.
 */

import { describe, expect, it } from 'vitest';

import { performAcpHandshake, type AcpHandshakePeer } from '../acp-handshake.js';

/** A promise that models a peer which accepted the connection and never replies. */
function neverAnswers<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * Build a peer that answers only the chosen phases.
 * @param options - Which phases resolve; unset phases never answer.
 * @returns Peer usable by {@link performAcpHandshake}.
 */
function peerAnswering(options: { initialize?: boolean; newSession?: boolean }): AcpHandshakePeer {
  return {
    initialize: async () => (options.initialize === true ? {} : neverAnswers<unknown>()),
    newSession: async () =>
      options.newSession === true ? { sessionId: 'session-1' } : neverAnswers<{ sessionId: string }>(),
  };
}

/**
 * Measure how long a rejecting handshake took.
 * @param run - The handshake invocation.
 * @returns Elapsed milliseconds and the thrown message.
 */
async function timeRejection(run: () => Promise<unknown>): Promise<{ elapsedMs: number; message: string }> {
  const startedAt = Date.now();
  try {
    await run();
    throw new Error('handshake resolved but was expected to reject');
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const BUDGET_MS = 250;

describe('performAcpHandshake', () => {
  it('completes when the peer answers both phases', async () => {
    await expect(
      performAcpHandshake(peerAnswering({ initialize: true, newSession: true }), {
        cwd: '/tmp',
        mcpServers: [],
        budgetMs: 5_000,
      }),
    ).resolves.toEqual({ sessionId: 'session-1' });
  });

  it('fails at the budget when the peer never answers initialize', async () => {
    const { elapsedMs, message } = await timeRejection(() =>
      performAcpHandshake(peerAnswering({}), { cwd: '/tmp', mcpServers: [], budgetMs: BUDGET_MS }),
    );

    expect(message).toContain('initialize');
    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS * 0.5);
    expect(elapsedMs).toBeLessThan(BUDGET_MS * 4);
  });

  it('fails at the budget when the peer never answers newSession', async () => {
    // The second phase carries its own budget: a peer that answers the handshake
    // and then stalls on the session is the same hang one step later.
    const { elapsedMs, message } = await timeRejection(() =>
      performAcpHandshake(peerAnswering({ initialize: true }), {
        cwd: '/tmp',
        mcpServers: [],
        budgetMs: BUDGET_MS,
      }),
    );

    expect(message).toContain('newSession');
    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS * 0.5);
    expect(elapsedMs).toBeLessThan(BUDGET_MS * 4);
  });
});
