declare const reactionRuleRefBrand: unique symbol;

/**
 * Identifier for a single Reaction invocation.
 *
 * Minted by the dispatching runtime for every host dispatch. Invocations are
 * independent: there is no ordering, deduplication, or exactly-once promise
 * attached to this identifier — it exists for logging, outcome correlation,
 * and cancellation bookkeeping only.
 */
export type ReactionInvocationId = string;

/**
 * Opaque host-supplied reference to whatever caused a Reaction dispatch.
 *
 * Rule systems are consumer-owned: a host that evaluates rules attaches its
 * own rule reference here so it can recognize the invocation in logs and
 * outcomes. The framework never interprets this value — it is a branded
 * marker type that deliberately imports no domain definition or persistence
 * model. Hosts mint refs via {@link createReactionRuleRef}.
 */
export interface ReactionRuleRef {
  /** Opaque brand preventing accidental structural construction. */
  readonly [reactionRuleRefBrand]: true;
}

/**
 * Brands a host-owned reference as a {@link ReactionRuleRef}.
 *
 * The host keeps full access to its own reference value via the intersection
 * return type; framework code only ever sees the opaque brand and passes the
 * value through untouched. References may be primitives or objects.
 * @typeParam TRef - Host-owned reference value being branded.
 * @param ref - Host-owned reference value to brand.
 * @returns The same value typed as `TRef & ReactionRuleRef`.
 */
export function createReactionRuleRef<TRef>(ref: TRef): TRef & ReactionRuleRef {
  return ref as TRef & ReactionRuleRef;
}

/**
 * Frozen execution envelope supplied to a Reaction handler.
 *
 * The runtime captures and freezes the envelope's top-level fields at dispatch
 * time. The handler therefore observes the same `eventKind`, event payload,
 * and host-composed context that the host used to evaluate its rule and
 * resolve parameters. The framework does not compose or detach domain values:
 * `eventPayload`, `hostContext`, and `ruleRef` are opaque host-owned
 * references passed through unchanged. They may be shared and mutable. A host
 * that requires deeper isolation must detach those values before invocation.
 *
 * Every host dispatch has a separate envelope and independent cancellation
 * and deadline controls. Host-owned values are not thereby isolated or
 * ordered across invocations.
 */
export interface ReactionExecutionContext {
  /** Runtime-minted identifier for this invocation. */
  readonly invocationId: ReactionInvocationId;
  /**
   * Opaque host-supplied reference to the rule that caused this dispatch.
   *
   * `undefined` when the host dispatched without a rule system — rule systems
   * are consumer-owned and not required for dispatch.
   */
  readonly ruleRef: ReactionRuleRef | undefined;
  /** Event kind string the host evaluated when deciding to dispatch. */
  readonly eventKind: string;
  /**
   * Event payload the host evaluated, supplied verbatim.
   *
   * Opaque to the framework; it remains a host-owned reference and handlers
   * narrow it with host-specific knowledge.
   */
  readonly eventPayload: unknown;
  /**
   * Host-composed context available during rule evaluation and parameter
   * resolution, supplied verbatim.
   *
   * Opaque to the framework; it remains a host-owned reference and handlers
   * narrow it with host-specific knowledge.
   */
  readonly hostContext: unknown;
  /**
   * Bus correlation identifier propagated from the triggering message, when
   * one exists.
   */
  readonly correlationId: string | undefined;
  /**
   * Runtime-controlled cancellation signal for this invocation.
   *
   * Handlers should pass this to long-running operations so they cancel
   * promptly when the runtime aborts the invocation. Cancellation is
   * cooperative: a handler that ignores the signal and resolves still
   * yields a success outcome.
   */
  readonly signal: AbortSignal;
  /**
   * Absolute deadline hint for this invocation as epoch milliseconds, or
   * `undefined` when the host imposed no deadline.
   *
   * The dispatcher guarantees only that an invocation which is already
   * aborted or already past this deadline never enters handler code; it does
   * not promise an exact-instant abort. Handlers may consult the deadline
   * proactively to budget their own work, but must treat {@link signal} as
   * the sole source of truth for cancellation.
   */
  readonly deadlineEpochMs: number | undefined;
}
