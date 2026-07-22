/**
 * Client hook response contribution contracts.
 *
 * Defines the two typed contribution lanes that extensions use to respond to
 * client hook events:
 *
 * 1. **Canonical effects** — portable, provider-agnostic effects like
 *    `context.append` that any extension can contribute without knowing the
 *    active provider.
 *
 * 2. **Provider contribution envelopes** — opaque containers keyed by
 *    `clientId` and `contractId` that only provider-owned typed builders can
 *    fill with provider-specific effects.
 *
 * Extensions declare contributors via
 * {@link MakaioExtension.clientHookResponses}, which supplies a
 * {@link ContributorActivationContext} and returns
 * {@link ContributorDefinition} instances validated at activation time.
 * @packageDocumentation
 */

import type { ExtensionContext } from '../extension/extension-context.js';

// ---------------------------------------------------------------------------
// Canonical Effects
// ---------------------------------------------------------------------------

/**
 * A canonical `context.append` effect — a simple string-append that works
 * across all providers.
 *
 * This is the minimum portable contribution any extension can make. The
 * runtime appends the value to the hook event's context payload without
 * provider-specific serialization.
 */
export interface CanonicalAppendEffect {
  /** Discriminant identifying this as a canonical append effect. */
  readonly kind: 'context.append';
  /** The string value to append to the hook event context. */
  readonly value: string;
}

/**
 * Union of all canonical effects.
 *
 * Currently contains only `context.append`. New canonical effects are added
 * to this union as the framework evolves.
 */
export type CanonicalEffect = CanonicalAppendEffect;

/**
 * Create a canonical `context.append` effect.
 * @param value - The string value to append.
 * @returns A frozen {@link CanonicalAppendEffect}.
 */
export function createAppendEffect(value: string): CanonicalAppendEffect {
  return Object.freeze({ kind: 'context.append', value });
}

// ---------------------------------------------------------------------------
// Provider Contribution Envelope
// ---------------------------------------------------------------------------

/**
 * Opaque provider contribution envelope keyed by client and contract identity.
 *
 * Contracts defines the shape; providers fill it via typed builders (not
 * defined in this file). The `effects` record is intentionally typed as
 * `Record<string, unknown>` — concrete effect shapes are constructible only
 * through provider-owned builders that narrow the generic at build time.
 * @typeParam TEffects - Concrete effects record type, narrowed by
 *   provider-owned builders. Defaults to `Record<string, unknown>` for
 *   contract-level usage.
 */
export interface ProviderContributionEnvelope<TEffects extends Record<string, unknown> = Record<string, unknown>> {
  /** Client identifier this contribution targets (e.g. `'claude-code'`). */
  readonly clientId: string;
  /**
   * Versioned contract identifier from the provider contract catalog
   * (e.g. `'anthropic.tool-response@1'`).
   */
  readonly contractId: string;
  /** Provider-specific effects, opaque at the contracts layer. */
  readonly effects: TEffects;
}

// ---------------------------------------------------------------------------
// Provider Contract Catalog
// ---------------------------------------------------------------------------

/**
 * Blockability metadata for a single interaction within a provider contract.
 *
 * Used at activation time to validate whether a contributor may declare
 * `failurePolicy: 'closed'` for a given interaction.
 */
export interface InteractionBlockability {
  /** Interaction name (matches hook event name or capability). */
  readonly interaction: string;
  /**
   * Whether this interaction can block or deny execution.
   *
   * When `false`, contributors must not declare `failurePolicy: 'closed'`
   * for this interaction — doing so is an activation-time validation error.
   */
  readonly blockable: boolean;
}

/**
 * Generic interface for provider contract catalog entries.
 *
 * Used by clients-core to register provider contracts. Concrete effect
 * schemas live in provider packages, not here.
 * @typeParam TValidationContext - Context type passed to the validation
 *   hook. Defaults to `Record<string, unknown>` for contract-level usage.
 */
export interface ProviderContractCatalogEntry<
  TValidationContext extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Client identifier this contract targets (e.g. `'claude-code'`). */
  readonly clientId: string;
  /** Stable contract identifier (e.g. `'anthropic.tool-response'`). */
  readonly contractId: string;
  /** Semantic version of the contract (e.g. `'1.0.0'`). */
  readonly version: string;
  /** Interactions this contract supports. */
  readonly supportedInteractions: readonly string[];
  /** Blockability metadata for each supported interaction. */
  readonly blockability: readonly InteractionBlockability[];
  /**
   * Runtime validation hook called to validate contributor callback output
   * against this contract's schema.
   *
   * Returns `true` when the output is valid, or a string describing the
   * validation error. Every provider contract must supply a validator so
   * native output is never accepted unchecked at runtime.
   * @param output - The callback output to validate.
   * @param ctx - Provider-specific validation context.
   * @returns `true` on success, or an error description string.
   */
  readonly validate: (output: unknown, ctx: TValidationContext) => true | string;
}

// ---------------------------------------------------------------------------
// Interaction Selectors
// ---------------------------------------------------------------------------

/**
 * Selector that matches hook events by event name.
 */
export interface EventNameSelector {
  /** Discriminant identifying this as an event-name selector. */
  readonly kind: 'event-name';
  /** Hook event name to match (e.g. `'PreToolUse'`). */
  readonly name: string;
}

/**
 * Selector that matches hook events by response capability.
 */
export interface CapabilitySelector {
  /** Discriminant identifying this as a capability selector. */
  readonly kind: 'capability';
  /** Response capability to match (e.g. `'context.append'`). */
  readonly capability: string;
}

/**
 * Union of interaction selectors that determine which hook events a
 * contributor responds to.
 */
export type InteractionSelector = EventNameSelector | CapabilitySelector;

// ---------------------------------------------------------------------------
// Contributor Callback Context
// ---------------------------------------------------------------------------

/**
 * Context supplied to a contributor's callback when a matching hook event
 * fires.
 *
 * Provides deadline-aware execution metadata and an abort signal for
 * cooperative cancellation.
 */
export interface ContributorCallbackContext {
  /** Client receiving the hook event. */
  readonly clientId: string;
  /**
   * Absolute deadline timestamp (epoch milliseconds) by which the callback
   * must complete.
   */
  readonly deadline: number;
  /**
   * Remaining time budget in milliseconds, computed from the deadline at
   * context creation time.
   *
   * Consumers should treat this as an approximate upper bound — actual
   * remaining time decreases as the callback executes.
   */
  readonly remainingBudgetMs: number;
  /**
   * Abort signal that fires when the deadline is reached or the hook
   * invocation is cancelled by the runtime.
   */
  readonly signal: AbortSignal;
  /** The hook event name that triggered this callback. */
  readonly eventName: string;
  /** The hook event payload, opaque at the contracts layer. */
  readonly eventPayload: unknown;
}

// ---------------------------------------------------------------------------
// Contributor Definition
// ---------------------------------------------------------------------------

/**
 * Failure policy determining how the runtime handles contributor failures.
 *
 * - `'open'` — on failure (timeout, rejection, error), omit this
 *   contributor's result and record the failure, but do not block the
 *   overall hook event response. This is the default.
 * - `'closed'` — on failure, discard all contributor results for this
 *   hook event and render a blocking response. Only valid for interactions
 *   whose provider contract declares the interaction as blockable.
 */
export type FailurePolicy = 'open' | 'closed';

/** Default failure policy applied when none is specified. */
export const DEFAULT_FAILURE_POLICY: FailurePolicy = 'open';

/**
 * Contributor definition declared by an extension via
 * {@link MakaioExtension.clientHookResponses}.
 *
 * Each contributor represents a single extension callback that responds to
 * matching hook events with canonical or provider-specific effects.
 */
interface ContributorDefinitionBase {
  /**
   * Unique contributor identifier, namespaced by extension.
   *
   * Must be a non-empty string. The runtime prefixes this with the extension
   * name during registration to ensure global uniqueness.
   */
  readonly id: string;
  /**
   * Priority determining execution order. Higher values execute earlier in
   * the reduction pipeline.
   */
  readonly priority: number;
  /**
   * Callback timeout in milliseconds. Must be a positive number.
   *
   * When the callback exceeds this timeout, the failure policy determines
   * the outcome.
   */
  readonly timeoutMs: number;
  /**
   * Failure policy for this contributor.
   *
   * Defaults to `'open'` when omitted. `'closed'` is only valid for
   * interactions whose provider contract declares the interaction as
   * blockable; this is validated at activation time.
   * @defaultValue `'open'`
   */
  readonly failurePolicy?: FailurePolicy;
  /**
   * Interaction selectors determining which hook events this contributor
   * responds to.
   *
   * At least one selector must be provided. A contributor is invoked when
   * any selector matches the incoming hook event.
   */
  readonly selectors: readonly [InteractionSelector, ...InteractionSelector[]];
  /**
   * Contributor callback invoked when a matching hook event fires.
   *
   * Returns effects for this contributor's declared lane.
   * Returning `undefined` or an empty result is a valid no-op.
   * @param ctx - Deadline-aware callback context.
   * @returns Contribution result, `undefined` for a no-op, or a promise
   *   resolving to either.
   */
  readonly respond: (
    ctx: ContributorCallbackContext,
  ) => ContributorResponse | undefined | Promise<ContributorResponse | undefined>;
}

/**
 * Portable contributor lane.
 *
 * Canonical contributors produce provider-agnostic effects. When `clientIds`
 * is omitted, they are eligible for every active client; otherwise they are
 * eligible only for the listed clients.
 */
export interface CanonicalContributorDefinition extends ContributorDefinitionBase {
  /** Discriminant selecting the portable canonical lane. */
  readonly lane: 'canonical';
  /** Optional client allow-list for this portable contributor. */
  readonly clientIds?: readonly string[];
}

/**
 * Provider-specific contributor lane.
 *
 * Provider contributors are eligible only for the exact client and contract
 * pair declared here.
 */
export interface ProviderContributorDefinition extends ContributorDefinitionBase {
  /** Discriminant selecting the provider-specific lane. */
  readonly lane: 'provider';
  /** Exact client this provider contribution targets. */
  readonly clientId: string;
  /** Exact active provider contract this contribution targets. */
  readonly contractId: string;
}

/**
 * Contributor definition declared by an extension.
 *
 * The lane discriminant makes client targeting explicit: portable canonical
 * contributors may target multiple clients, while provider contributors are
 * bound to one exact provider contract.
 */
export type ContributorDefinition = CanonicalContributorDefinition | ProviderContributorDefinition;

/**
 * Response returned by a contributor callback.
 *
 * A contributor may produce canonical effects, a provider envelope, or a
 * no-op. The runtime rejects responses that mix the two lanes.
 */
export interface ContributorResponse {
  /** Canonical effects to apply, if any. */
  readonly canonicalEffects?: readonly CanonicalEffect[];
  /** Provider-specific contribution envelope, if any. */
  readonly providerEnvelope?: ProviderContributionEnvelope;
}

// ---------------------------------------------------------------------------
// Contributor Activation Context
// ---------------------------------------------------------------------------

/**
 * Context supplied to the `createContributors` factory during extension
 * activation.
 *
 * Provides the extension identity and a lookup for active provider contracts
 * so the factory can validate contributor selectors and failure policies.
 */
export interface ContributorActivationContext<THostContext extends ExtensionContext = ExtensionContext> {
  /** Name of the activating extension. */
  readonly extensionName: string;
  /**
   * Per-extension host context from the activating runtime.
   *
   * Contributor factories can capture the bus, service lookup, shutdown
   * signal, and other host-scoped resources from this context rather than
   * relying on module-global mutable state. The context belongs to the
   * same extension activation as the manifest being processed.
   */
  readonly extensionContext: THostContext;
  /**
   * Look up a provider contract catalog entry by its exact client and
   * contract identifiers.
   * @param clientId - Client identifier that owns the contract.
   * @param contractId - The contract ID to look up.
   * @returns The catalog entry, or `undefined` when no matching contract is registered.
   */
  readonly getProviderContract: (clientId: string, contractId: string) => ProviderContractCatalogEntry | undefined;
}

/**
 * Client hook response contribution surface declared by an extension.
 *
 * Added to {@link MakaioExtension.clientHookResponses}. The runtime calls
 * `createContributors` once during extension activation; the returned batch
 * is validated before installation.
 */
export interface ExtensionClientHookResponsesContribution<THostContext extends ExtensionContext = ExtensionContext> {
  /**
   * Factory that produces contributor definitions for this extension.
   *
   * Called once during extension activation. The returned contributors are
   * validated against the active provider contract catalog before being
   * installed in the hook response pipeline.
   * @param ctx - Activation context supplying extension identity,
   *   host extension context, and provider contract lookup.
   * @returns Contributor definitions or a promise resolving to them.
   */
  readonly createContributors: (
    ctx: ContributorActivationContext<THostContext>,
  ) => ContributorDefinition[] | Promise<ContributorDefinition[]>;
}

// ---------------------------------------------------------------------------
// Error Modeling
// ---------------------------------------------------------------------------

/**
 * Activation-time validation error codes.
 *
 * These errors are detected when validating contributor definitions during
 * extension activation, before any runtime hook event is fired.
 */
export type ActivationErrorCode =
  /** Contributor ID is empty or otherwise invalid. */
  | 'invalid-contributor-id'
  /** Contributor timeout value is non-positive, non-finite, or otherwise invalid. */
  | 'invalid-timeout-ms'
  /** Contributor priority is not a finite number. */
  | 'invalid-priority'
  /** Contributor lane or its target identity is invalid. */
  | 'invalid-contributor-lane'
  /** Contributor selectors are missing or malformed. */
  | 'invalid-selectors'
  /** Contributor callback is not callable. */
  | 'invalid-respond'
  /** The referenced provider contract is not registered or not active. */
  | 'inactive-provider-contract'
  /** A selector references an interaction not supported by the provider contract. */
  | 'unsupported-interaction'
  /**
   * A contributor declares `failurePolicy: 'closed'` for an interaction
   * that is not blockable according to the provider contract catalog.
   */
  | 'closed-policy-on-non-blockable';

/**
 * Activation-time validation error raised when a contributor definition
 * fails validation during extension activation.
 */
export interface ActivationValidationError {
  /** Error code identifying the class of validation failure. */
  readonly code: ActivationErrorCode;
  /** Human-readable error message. */
  readonly message: string;
  /** Contributor ID that caused the error, when available. */
  readonly contributorId?: string;
  /** Extension name that owns the contributor. */
  readonly extensionName: string;
}

/**
 * Runtime outcome codes for contributor callback execution.
 *
 * These outcomes are recorded after a hook event fires and a contributor
 * callback completes (or fails to complete).
 */
export type RuntimeOutcomeCode =
  /** The callback completed within the deadline and returned a valid response. */
  | 'success'
  /** The callback exceeded its timeout. */
  | 'timeout'
  /** The callback threw an error or returned an invalid response. */
  | 'rejection'
  /**
   * Closed failure: all contributors' results for this hook event are
   * discarded, and a blocking response is rendered.
   */
  | 'closed-failure';

/**
 * Runtime outcome record for a single contributor callback execution.
 */
export interface RuntimeOutcome {
  /** Outcome code. */
  readonly code: RuntimeOutcomeCode;
  /** Contributor ID that produced this outcome. */
  readonly contributorId: string;
  /** Human-readable detail message, if any. */
  readonly detail?: string;
  /** Duration of the callback execution in milliseconds. */
  readonly durationMs?: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a contributor definition has a non-empty ID.
 * @param id - The contributor ID to validate.
 * @returns `true` when the ID is a non-empty string.
 */
export function isValidContributorId(id: string): boolean {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * Validate that a timeout value is a positive finite number.
 * @param timeoutMs - The timeout in milliseconds.
 * @returns `true` when the timeout is positive and finite.
 */
export function isValidTimeoutMs(timeoutMs: number): boolean {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
}

/**
 * Validate that a `failurePolicy: 'closed'` declaration is permitted for
 * the given interaction selectors against a provider contract catalog entry.
 *
 * For each selector, the function first verifies that the interaction is
 * listed in the catalog's `supportedInteractions`. If it is not, an
 * "unsupported interaction" error is produced instead of the more specific
 * "not blockable" error — this avoids misleading diagnostics when the
 * interaction simply does not exist in the contract.
 *
 * Returns an array of validation errors. An empty array means the policy
 * is valid.
 * @param selectors - The contributor's interaction selectors.
 * @param catalog - The provider contract catalog entry to validate against.
 * @returns Array of validation error messages; empty when valid.
 */
export function validateClosedPolicy(
  selectors: readonly InteractionSelector[],
  catalog: ProviderContractCatalogEntry,
): string[] {
  const errors: string[] = [];
  for (const selector of selectors) {
    const interactionName = selector.kind === 'event-name' ? selector.name : selector.capability;

    // First verify the interaction is supported by the contract at all.
    if (!catalog.supportedInteractions.includes(interactionName)) {
      errors.push(
        `Interaction '${interactionName}' is not a supported interaction ` +
          `in contract '${catalog.contractId}'; failurePolicy 'closed' ` +
          `is not permitted`,
      );
      continue;
    }

    // The interaction is supported — now check blockability.
    const blockabilityEntry = catalog.blockability.find((b) => b.interaction === interactionName);
    if (!blockabilityEntry || !blockabilityEntry.blockable) {
      errors.push(
        `Interaction '${interactionName}' is not blockable in contract ` +
          `'${catalog.contractId}'; failurePolicy 'closed' is not permitted`,
      );
    }
  }
  return errors;
}
