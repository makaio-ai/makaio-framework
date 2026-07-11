import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { Turn } from './entities/turn.js';
import { MessageStorageSubjects } from './messages/namespace.js';

/** Pending waiter for one completing turn. */
interface PersistenceWaiter {
  /** Settle the barrier and release its completion promise. */
  settle: () => void;
}

/**
 * Coordinates SessionBridge persistence decisions before turn completion emits.
 *
 * The barrier is bus-mediated: it resolves turns through the owning manager
 * instead of retaining its own turn registry.
 */
export class AssistantPersistenceBarrier {
  private readonly settledPairs = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, PersistenceWaiter>();
  private readonly cleanup: () => void;
  private destroyed = false;

  /**
   * @param bus - Bus carrying storage probes and persistence-settlement events.
   * @param resolveTurn - Resolver for active or finalizing turns by identifier.
   * @param timeoutMs - Upper bound for a missing persistence-settlement signal.
   */
  public constructor(
    private readonly bus: IMakaioBus,
    private readonly resolveTurn: (turnId: string) => Turn | undefined,
    private readonly timeoutMs: number,
  ) {
    this.cleanup = bus.on(SessionSubjects.turn.assistantPersistenceSettled, (ctx) => {
      if (this.destroyed) return;
      const { sessionId, turnId, messageId, agentId } = ctx.payload;
      const turn = this.resolveTurn(turnId);
      if (!turn || turn.sessionId !== sessionId || !turn.hasAdmittedPair(messageId, agentId)) return;

      const pairs = this.settledPairs.get(turnId) ?? new Set<string>();
      pairs.add(this.pairKey(messageId, agentId));
      this.settledPairs.set(turnId, pairs);
      if (this.isSettled(turn)) this.waiters.get(turnId)?.settle();
    });
  }

  /**
   * Wait for every participating agent's persistence decision when storage is present.
   * @param turn - Finalizing turn whose assistant persistence must settle.
   */
  public async waitFor(turn: Turn): Promise<void> {
    if (this.destroyed || turn.agentIds.length === 0 || this.isSettled(turn)) return;

    const probe = await this.bus.requestOptional(MessageStorageSubjects.getByTurn, { turnId: turn.turnId });
    if (this.destroyed || !probe.handled) return;

    await new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.waiters.delete(turn.turnId);
        resolve();
      };
      const timer = setTimeout(settle, this.timeoutMs);
      this.waiters.set(turn.turnId, { settle });
      if (this.isSettled(turn)) settle();
    });
  }

  /**
   * Clear state retained for a terminal or discarded turn.
   * @param turnId - Turn identifier whose barrier state is released.
   */
  public clear(turnId: string): void {
    this.waiters.get(turnId)?.settle();
    this.settledPairs.delete(turnId);
  }

  /** Cancel the subscription and settle every pending waiter. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanup();
    for (const waiter of [...this.waiters.values()]) waiter.settle();
    this.waiters.clear();
    this.settledPairs.clear();
  }

  /**
   * Determine whether every participating agent has settled.
   * @param turn - Turn whose participant settlements are checked.
   * @returns Whether every participating agent has settled.
   */
  private isSettled(turn: Turn): boolean {
    if (turn.admittedPairs.length === 0) return true;
    const pairs = this.settledPairs.get(turn.turnId);
    return (
      pairs !== undefined &&
      turn.admittedPairs.every(({ messageId, agentId }) => pairs.has(this.pairKey(messageId, agentId)))
    );
  }

  private pairKey(messageId: string, agentId: string): string {
    return JSON.stringify([messageId, agentId]);
  }
}
