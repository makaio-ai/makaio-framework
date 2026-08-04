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
 * ## What the window is
 *
 * It opens with the attempt and closes when the adapter has **handed the key
 * over**: for a start, the last act of the start itself, after which the key
 * travels in the response and the caller settles it; for a rehydrate, the whole
 * call, since its answer *is* the hand-over. A caller-owned attempt that
 * confirms no key hands over nothing and still closes its window, because
 * nothing is waiting to be settled and the movement observer is that agent's
 * only publisher from then on.
 *
 * ## What it does not cover
 *
 * The window ends where the adapter's knowledge does. Between the hand-over and
 * the caller's settlement the adapter has no way to observe that the generation
 * exists — `startAgent`'s contract carries no settlement signal back — so a key
 * published in that gap is published before it is claimed. The gap is a few
 * statements of the caller's own (nothing fallible runs between a live connector
 * and its settlement), and closing it needs an adapter-contract change, which
 * this wave does not make.
 */

/**
 * Whether this attempt may publish the provider session it confirmed.
 *
 * Mutable, with exactly one writer — {@link releaseProviderKeyPublication}, at
 * the point the attempt hands its key over. A start carries one of these for its
 * whole duration; a rehydrate builds one that never opens, because its response
 * is the hand-over and there is nothing after it.
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
 * Hand the key over: from here on this attempt's key may be published.
 *
 * Called once, where the attempt has done everything it publishes and the key is
 * on its way to the caller. For a start that is after its own lifecycle events
 * and its hand-over to the tracker; there is nothing to release for an attempt
 * that was never deferred, and calling it then is a no-op by construction.
 * @param publication - The attempt's publication state.
 */
export function releaseProviderKeyPublication(publication: ProviderKeyPublication): void {
  publication.deferred = false;
}
