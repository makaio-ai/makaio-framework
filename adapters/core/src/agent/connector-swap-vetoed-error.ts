/**
 * The typed refusal a connector replacement receives at the arbitration door.
 * @packageDocumentation
 */

/** Why a replacement was refused before it produced any effect. */
export type ConnectorSwapVetoReason =
  /** A teardown of this agent was already in flight when the door was reached. */
  | 'teardown-in-flight'
  /**
   * The agent holds no connector runtime any more.
   *
   * Permanent rather than transient: the runtime reference is cleared before the
   * teardown's close is awaited, and only a start or a published replacement ever
   * sets it — so "the runtime is gone" is exactly the fact a post-teardown
   * replacement must not proceed on.
   */
  | 'no-runtime';

/**
 * A connector replacement refused by the arbitration door.
 *
 * **Typed because the distinction it carries is not derivable from anything
 * else.** The door refuses before any replacement effect has occurred, so the
 * one path with a modelled answer for that — a warm rehydrate — may report
 * `not-dispatched` instead of leaving its caller uncertain. An untyped throw
 * lands in the generic replacement rollback and becomes "something failed,
 * possibly after reaching the provider", which is the strictly worse answer the
 * door exists to avoid.
 *
 * A compound failure is **never** this type. When a producer's own rollback also
 * fails, the veto is known but whether a replacement connector actually closed is
 * not, so that case stays an aggregate and keeps the uncertain classification.
 */
export class ConnectorSwapVetoedError extends Error {
  /**
   * Build the refusal.
   * @param agentId - Agent whose replacement was refused
   * @param reason - Which of the door's two preconditions failed
   */
  public constructor(
    public readonly agentId: string,
    public readonly reason: ConnectorSwapVetoReason,
  ) {
    super(
      reason === 'teardown-in-flight'
        ? `Connector replacement for agent ${agentId} refused: a teardown is already in flight.`
        : `Connector replacement for agent ${agentId} refused: the agent holds no connector runtime.`,
    );
    this.name = 'ConnectorSwapVetoedError';
  }
}
