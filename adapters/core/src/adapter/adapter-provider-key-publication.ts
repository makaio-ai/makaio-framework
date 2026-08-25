/**
 * The one gate a provider session passes before it leaves this adapter.
 *
 * **A provider key has one publisher per attempt: the party that claims it.**
 * For a start or rehydrate the adapter owns, that is the adapter — it announces
 * the movement and stamps the key on what it emits, and the movement observer
 * settles the currency. For a **caller-owned** one it is the caller: it reserved
 * the provider session before dispatching, and it settles the key its connector
 * confirms, under a generation token it minted and can give back. Until that
 * caller has been handed the key, nothing here may put it where somebody else
 * can act on it — an event field a consumer writes onto a session row, a durable
 * row write, an announcement the observer turns into a second generation.
 *
 * The rule was enforced per route before this module: the row write knew it, the
 * `agent.added` field knew it, enrichment knew it, and each new route had to be
 * found by a reviewer before it learned it. Two were missed that way. So the
 * question moves here, and every route asks it the same way — by taking the key
 * it publishes from {@link publishedProviderKey} rather than from the connector,
 * the registry or the start result.
 *
 * The gate stays closed after the successful dispatch response. It opens only
 * when the caller returns the adapter-minted acknowledgement token after its
 * durable ownership settlement. That makes the previously unobservable region
 * between response and settlement part of this adapter's lifecycle contract.
 */

/**
 * Whether this attempt may publish the provider session it confirmed.
 *
 * Mutable, with exactly one writer — {@link releaseProviderKeyPublication}, in
 * the successful acknowledgement path. A caller-owned start or rehydrate carries
 * the same gate from dispatch through durable settlement.
 */
export interface ProviderKeyPublication {
  /** Whether the key is still the caller's to publish first. */
  deferred: boolean;
}

/**
 * Build the publication state an attempt runs under.
 *
 * `callerOwnsAgentRow` is the whole question: a caller that supplied the agent
 * identity reserved the provider session and settles what the connector
 * confirms. An **ephemeral** attempt is never deferred — it is one-shot, nobody
 * settles for it, and the seam that publishes its key is the only one it has.
 * @param attempt - Whether the caller owns the row, and whether the agent is ephemeral.
 * @returns The publication state to carry for the attempt's duration.
 */
export function providerKeyPublicationFor(attempt: {
  readonly callerOwnsAgentRow: boolean;
  readonly ephemeral?: boolean;
}): ProviderKeyPublication {
  return { deferred: attempt.callerOwnsAgentRow && attempt.ephemeral !== true };
}

/**
 * The provider session this attempt may publish, or nothing.
 *
 * **Every route that puts a provider key outside this adapter reads it from
 * here** — the two lifecycle events a start emits, the runtime row a rehydrate
 * writes, the identity enrichment stamps on an event, the movement the tracker
 * announces. Taking the key from the connector, the registry entry or the start
 * result instead is what made each new route a new place to remember the rule.
 * @param publication - The attempt's publication state, or `undefined` where an attempt has none.
 * @param adapterSessionId - Provider session the attempt confirmed, when it confirmed one.
 * @returns The key to publish, or `undefined` while it is not this adapter's to publish.
 */
export function publishedProviderKey(
  publication: ProviderKeyPublication | undefined,
  adapterSessionId: string | undefined,
): string | undefined {
  if (publication?.deferred === true) return undefined;
  return adapterSessionId;
}

/**
 * Whether this attempt's provider key may be published at all.
 *
 * The predicate form of {@link publishedProviderKey}, for the two routes that
 * decide *whether* to speak rather than *what* to carry: the identity
 * enrichment stamps on an emitted event, and the movement the tracker announces.
 * Same question, same answer, one place.
 * @param publication - The attempt's publication state, or `undefined` where an attempt has none.
 * @returns Whether the key is this adapter's to publish yet.
 */
export function providerKeyIsPublishable(publication: ProviderKeyPublication | undefined): boolean {
  return publication?.deferred !== true;
}

/**
 * Acknowledge the hand-over: from here on this generation's key may be published.
 *
 * Called only after the caller's durable settlement is acknowledged. There is
 * nothing to release for an attempt that was never deferred, and calling it then
 * is a no-op by construction.
 * @param publication - The attempt's publication state.
 */
export function releaseProviderKeyPublication(publication: ProviderKeyPublication): void {
  publication.deferred = false;
}
