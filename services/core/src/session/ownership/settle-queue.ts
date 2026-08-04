/**
 * Tail of each agent's settle chain, keyed by agent.
 *
 * An entry exists only while that agent has settles outstanding; the chain
 * deletes itself when it drains, so the map does not grow with the number of
 * agents the process has ever seen.
 */
const settleChains = new Map<string, Promise<void>>();

/**
 * Serialize one agent's movement settlements, in receipt order.
 *
 * `bus.emit` runs handlers concurrently across independent producer chains —
 * payload enrichment, connector-swap completion and turn-dispatch rotation all
 * announce without a shared lock — so two movements for one agent otherwise
 * interleave between the authority's revision read and its transaction, and
 * both burn their single `currency-changed` retry against each other. Chaining
 * per agent makes settle order equal receipt order, which is the strongest
 * ordering an observation seam can offer: it does not claim producer order,
 * only that what this process received first is settled first.
 *
 * The chain is keyed per agent rather than globally because two agents' currency
 * rows share nothing — a global queue would serialize independent work and turn
 * one slow settle into everyone's latency.
 * @param agentId - Agent whose settles are being ordered.
 * @param settle - The settle to run once every settle received earlier for this
 *   agent has finished.
 * @returns A promise for this settle's own completion. It rejects if `settle`
 *   rejects; the chain itself absorbs the failure so queued successors still run.
 */
export function enqueueAgentSettle(agentId: string, settle: () => Promise<void>): Promise<void> {
  const previous = settleChains.get(agentId) ?? Promise.resolve();
  const settled = previous.then(settle);
  // The stored link never rejects. A rejected chain head would cancel every
  // settle queued behind it, turning one failed movement into a silently
  // dropped tail — and this seam re-announces, so successors are exactly the
  // announcements that would have repaired the failure.
  const link = settled.then(
    () => undefined,
    () => undefined,
  );
  settleChains.set(agentId, link);
  void link.then(() => {
    // Identity-checked so a chain that has already been extended is not dropped.
    if (settleChains.get(agentId) === link) settleChains.delete(agentId);
  });
  return settled;
}
