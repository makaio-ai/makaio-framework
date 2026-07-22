/**
 * Registry of contributor definitions for client hook responses.
 *
 * Validates contributor batches against active provider contracts at
 * activation time, installs them atomically by extension, and returns
 * immutable priority-ordered snapshots filtered by event name.
 *
 * The registry is a plain class (not a bus handler). It depends on a
 * {@link ClientHookProviderContractRegistry} for provider contract lookups
 * during activation validation.
 * @packageDocumentation
 */

import type {
  ActivationValidationError,
  ContributorDefinition,
  InteractionSelector,
  ProviderContractCatalogEntry,
} from '@makaio/contracts/client';
import { isValidContributorId, isValidTimeoutMs, validateClosedPolicy } from '@makaio/contracts/client';
import type { ClientHookProviderContractRegistry } from './client-hook-provider-contract-registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Registered contributor with runtime metadata assigned during installation.
 *
 * Extends the original {@link ContributorDefinition} with a namespaced
 * identifier and a stable insertion ordinal used for deterministic ordering.
 */
export interface RegisteredContributor {
  /**
   * Globally unique contributor identifier, namespaced by extension.
   *
   * Formed as `${extensionId}/${definition.id}`.
   */
  readonly namespacedId: string;
  /** Extension that owns this contributor. */
  readonly extensionId: string;
  /** Stable insertion ordinal assigned during atomic batch installation. */
  readonly ordinal: number;
  /** The original contributor definition. */
  readonly definition: ContributorDefinition;
}

/**
 * Result of an atomic contributor batch installation attempt.
 *
 * When validation succeeds, `errors` is empty and contributors are installed.
 * When validation fails, `errors` is non-empty and no mutation occurs.
 */
export interface ContributorInstallResult {
  /** Validation errors encountered during activation. Empty on success. */
  readonly errors: readonly ActivationValidationError[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a namespaced contributor identifier.
 * @param extensionId - Owning extension identifier.
 * @param contributorId - Local contributor identifier.
 * @returns Namespaced identifier in the form `extensionId/contributorId`.
 */
function buildNamespacedId(extensionId: string, contributorId: string): string {
  return `${extensionId}/${contributorId}`;
}

/**
 * Determine whether a selector matches a given event.
 *
 * Event-name selectors match when the name equals the event name.
 * Capability selectors match when the event's declared response
 * capabilities include the selector's capability string.
 * @param selector - The interaction selector to evaluate.
 * @param eventName - The hook event name to match against.
 * @param eventCapabilities - The event's declared response capabilities.
 * @returns `true` when the selector matches the event.
 */
function selectorMatchesEvent(
  selector: InteractionSelector,
  eventName: string,
  eventCapabilities: readonly string[],
): boolean {
  switch (selector.kind) {
    case 'event-name':
      return selector.name === eventName;
    case 'capability':
      return eventCapabilities.includes(selector.capability);
  }
}

/**
 * Compare registered contributors for snapshot ordering.
 *
 * Primary sort: priority descending (higher priority executes first).
 * Secondary sort: ordinal ascending (earlier registration executes first
 * within the same priority tier).
 * @param a - First contributor.
 * @param b - Second contributor.
 * @returns Negative when `a` should appear before `b`.
 */
function compareRegistered(a: RegisteredContributor, b: RegisteredContributor): number {
  const priorityDiff = b.definition.priority - a.definition.priority;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  return a.ordinal - b.ordinal;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Test whether every selector has a complete runtime shape.
 * @param selectors - Selector value received at the extension boundary.
 * @returns Whether the value is a non-empty selector tuple.
 */
function hasValidSelectors(selectors: ContributorDefinition['selectors']): boolean {
  return (
    Array.isArray(selectors) &&
    selectors.length > 0 &&
    selectors.every((selector) => {
      if (typeof selector !== 'object' || selector === null) {
        return false;
      }
      if (selector.kind === 'event-name') {
        return typeof selector.name === 'string' && selector.name.trim().length > 0;
      }
      return (
        selector.kind === 'capability' &&
        typeof selector.capability === 'string' &&
        selector.capability.trim().length > 0
      );
    })
  );
}

/**
 * Test whether a contributor has a complete lane identity.
 * @param contributor - Contributor received at the extension boundary.
 * @returns Whether the lane discriminant and target fields are valid.
 */
function hasValidLane(contributor: ContributorDefinition): boolean {
  if (contributor.lane === 'canonical') {
    return (
      contributor.clientIds === undefined ||
      (Array.isArray(contributor.clientIds) &&
        contributor.clientIds.length > 0 &&
        contributor.clientIds.every((clientId) => typeof clientId === 'string' && clientId.trim().length > 0))
    );
  }
  if (contributor.lane === 'provider') {
    return (
      typeof contributor.clientId === 'string' &&
      contributor.clientId.trim().length > 0 &&
      typeof contributor.contractId === 'string' &&
      contributor.contractId.trim().length > 0
    );
  }
  return false;
}

/**
 * Validate the provider-independent runtime shape of one contributor.
 * @param extensionId - Owning extension identifier.
 * @param contributor - Contributor received at the extension boundary.
 * @returns The first shape error, or `undefined` when the shape is valid.
 */
function validateContributorShape(
  extensionId: string,
  contributor: ContributorDefinition,
): ActivationValidationError | undefined {
  if (typeof contributor !== 'object' || contributor === null || Array.isArray(contributor)) {
    return {
      code: 'invalid-contributor-lane',
      message: 'Contributor definition must be an object',
      extensionName: extensionId,
    };
  }
  const base = {
    ...(typeof contributor.id === 'string' && { contributorId: contributor.id }),
    extensionName: extensionId,
  };
  if (!Number.isFinite(contributor.priority)) {
    return {
      ...base,
      code: 'invalid-priority',
      message: `Contributor '${contributor.id}' priority must be a finite number`,
    };
  }
  if (!hasValidSelectors(contributor.selectors)) {
    return {
      ...base,
      code: 'invalid-selectors',
      message: `Contributor '${contributor.id}' requires non-empty valid selectors`,
    };
  }
  if (typeof contributor.respond !== 'function') {
    return { ...base, code: 'invalid-respond', message: `Contributor '${contributor.id}' respond must be a function` };
  }
  if (!hasValidLane(contributor)) {
    return {
      ...base,
      code: 'invalid-contributor-lane',
      message: `Contributor '${contributor.id}' has an invalid lane or target identity`,
    };
  }
  if (!isValidContributorId(contributor.id)) {
    return { ...base, code: 'invalid-contributor-id', message: 'Contributor ID is empty or invalid' };
  }
  if (!isValidTimeoutMs(contributor.timeoutMs)) {
    return {
      ...base,
      code: 'invalid-timeout-ms',
      message:
        `Contributor '${contributor.id}' has an invalid timeoutMs: ` +
        `${String(contributor.timeoutMs)}; must be a positive finite number`,
    };
  }
  return undefined;
}

/**
 * Validate a full batch of contributor definitions for a single extension.
 *
 * Checks:
 * 1. Each contributor has a valid (non-empty) ID.
 * 2. Each contributor has a valid (positive, finite) timeout.
 * 3. No duplicate namespaced IDs within the batch or against existing
 *    registrations from other extensions.
 * 4. Capability selectors reference supported interactions in active
 *    provider contracts.
 * 5. `failurePolicy: 'closed'` is only used with blockable interactions
 *    (validated via {@link validateClosedPolicy}).
 * @param extensionId - Owning extension identifier.
 * @param contributors - The batch of contributor definitions to validate.
 * @param contractRegistry - Provider contract registry for lookups.
 * @param existingIds - Lookup of namespaced IDs already registered (from
 *   all extensions, including the current one). Only `.has()` is used,
 *   so both `Set` and `Map` satisfy the contract.
 * @returns Array of validation errors; empty when the batch is valid.
 */
function validateBatch(
  extensionId: string,
  contributors: readonly ContributorDefinition[],
  contractRegistry: ClientHookProviderContractRegistry,
  existingIds: { has(key: string): boolean },
): ActivationValidationError[] {
  const errors: ActivationValidationError[] = [];
  const batchIds = new Set<string>();

  for (const contributor of contributors) {
    const shapeError = validateContributorShape(extensionId, contributor);
    if (shapeError) {
      errors.push(shapeError);
      continue;
    }

    const nsId = buildNamespacedId(extensionId, contributor.id);
    if (batchIds.has(nsId)) {
      errors.push({
        code: 'invalid-contributor-id',
        message: `Duplicate contributor ID '${contributor.id}' within the same ` + `extension batch '${extensionId}'`,
        contributorId: contributor.id,
        extensionName: extensionId,
      });
      continue;
    }

    if (existingIds.has(nsId)) {
      errors.push({
        code: 'invalid-contributor-id',
        message: `Contributor ID '${contributor.id}' is already registered by ` + `extension '${extensionId}'`,
        contributorId: contributor.id,
        extensionName: extensionId,
      });
      continue;
    }
    batchIds.add(nsId);

    validateSelectors(extensionId, contributor, contractRegistry, errors);
  }

  return errors;
}

/**
 * Validate a contributor's selectors against active provider contracts.
 *
 * Capability selectors must reference interactions declared in at least one
 * active provider contract. When `failurePolicy` is `'closed'`, each
 * selected interaction must be declared as blockable in the contract's
 * blockability metadata.
 *
 * Event-name selectors are always valid (they match hook events directly),
 * but closed-policy validation still applies when a matching contract
 * declares the interaction as non-blockable.
 * @param extensionId - Owning extension identifier.
 * @param contributor - Contributor definition to validate.
 * @param contractRegistry - Provider contract registry for lookups.
 * @param errors - Accumulator for validation errors.
 */
function validateSelectors(
  extensionId: string,
  contributor: ContributorDefinition,
  contractRegistry: ClientHookProviderContractRegistry,
  errors: ActivationValidationError[],
): void {
  const failurePolicy = contributor.failurePolicy ?? 'open';

  if (contributor.lane === 'provider') {
    const catalog = contractRegistry.getProviderContract(contributor.clientId, contributor.contractId);
    if (!catalog) {
      errors.push({
        code: 'inactive-provider-contract',
        message:
          `Provider contributor requires active contract '${contributor.contractId}' ` +
          `for client '${contributor.clientId}'`,
        contributorId: contributor.id,
        extensionName: extensionId,
      });
      return;
    }

    validateSelectorsAgainstContracts(extensionId, contributor, [catalog], failurePolicy, errors);
    return;
  }

  const catalogs = contributor.clientIds
    ? contributor.clientIds.flatMap((clientId) => contractRegistry.getProviderContractsByClient(clientId))
    : contractRegistry.getAllProviderContracts();
  validateSelectorsAgainstContracts(extensionId, contributor, catalogs, failurePolicy, errors);
}

/**
 * Validate a contributor's selectors against every contract eligible for its
 * lane. Canonical closed contributors require blockability from every active
 * matching contract; provider contributors pass their one exact contract.
 * @param extensionId - Owning extension identifier.
 * @param contributor - Contributor being validated.
 * @param catalogs - Eligible active provider contracts.
 * @param failurePolicy - Effective contributor failure policy.
 * @param errors - Accumulator for validation errors.
 */
function validateSelectorsAgainstContracts(
  extensionId: string,
  contributor: ContributorDefinition,
  catalogs: readonly ProviderContractCatalogEntry[],
  failurePolicy: 'open' | 'closed',
  errors: ActivationValidationError[],
): void {
  for (const selector of contributor.selectors) {
    const interaction = selector.kind === 'capability' ? selector.capability : selector.name;
    const matchingCatalogs = catalogs.filter((catalog) => catalog.supportedInteractions.includes(interaction));

    if ((contributor.lane === 'provider' || selector.kind === 'capability') && matchingCatalogs.length === 0) {
      errors.push({
        code: 'unsupported-interaction',
        message: `Interaction '${interaction}' is not supported by an eligible active ` + `provider contract`,
        contributorId: contributor.id,
        extensionName: extensionId,
      });
      continue;
    }

    if (failurePolicy === 'closed') {
      if (matchingCatalogs.length === 0) {
        errors.push({
          code: 'closed-policy-on-non-blockable',
          message:
            `Closed failure policy requires blockability proof for interaction ` +
            `'${interaction}', but no contract declares it for an eligible active client`,
          contributorId: contributor.id,
          extensionName: extensionId,
        });
        continue;
      }

      for (const catalog of matchingCatalogs) {
        for (const message of validateClosedPolicy([selector], catalog)) {
          errors.push({
            code: 'closed-policy-on-non-blockable',
            message,
            contributorId: contributor.id,
            extensionName: extensionId,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry of contributor definitions for client hook responses.
 *
 * Validates contributor batches against active provider contracts during
 * activation, installs them atomically by extension, and provides immutable
 * priority-ordered snapshots filtered by event name.
 * @example
 * ```ts
 * const registry = new ClientHookResponseRegistry(contractRegistry);
 *
 * const result = registry.installContributors('ext-my-extension', [
 *   {
 *     lane: 'canonical',
 *     id: 'append-context',
 *     priority: 100,
 *     timeoutMs: 5000,
 *     selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
 *     respond: (ctx) => ({
 *       canonicalEffects: [createAppendEffect('hello')],
 *     }),
 *   },
 * ]);
 *
 * if (result.errors.length > 0) {
 *   // Handle validation errors — no mutation occurred.
 * }
 *
 * const snapshot = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
 * // snapshot is an immutable, priority-ordered array of RegisteredContributor.
 * ```
 */
export class ClientHookResponseRegistry {
  private readonly contractRegistry: ClientHookProviderContractRegistry;

  /**
   * All registered contributors, keyed by namespaced ID.
   */
  private readonly contributors = new Map<string, RegisteredContributor>();

  /**
   * Index from extension ID to the set of namespaced contributor IDs it
   * owns. Used for atomic removal.
   */
  private readonly extensionIndex = new Map<string, Set<string>>();

  /**
   * Monotonically increasing ordinal counter for stable insertion order.
   */
  private nextOrdinal = 1;

  /**
   * Create a response registry backed by a provider contract registry.
   * @param contractRegistry - Provider contract registry used during
   *   activation validation.
   */
  public constructor(contractRegistry: ClientHookProviderContractRegistry) {
    this.contractRegistry = contractRegistry;
  }

  /**
   * Validate and atomically install a batch of contributor definitions for
   * a single extension.
   *
   * The entire batch is validated before any mutation occurs. If validation
   * fails, no contributors are installed and the errors are returned. On
   * success, each contributor is assigned a stable insertion ordinal and
   * registered under the extension's ownership.
   *
   * An extension that already has contributors registered must call
   * {@link removeContributors} before re-installing to avoid ID collisions.
   * @param extensionId - Extension that owns these contributors.
   * @param contributors - The batch of contributor definitions to install.
   * @returns Installation result with any validation errors.
   */
  public installContributors(
    extensionId: string,
    contributors: readonly ContributorDefinition[],
  ): ContributorInstallResult {
    // Validate against existing namespaced IDs. An extension must call
    // removeContributors before re-installing — attempting to install a
    // contributor whose namespaced ID is already registered (even by the
    // same extension) is a validation error. The Map satisfies the
    // { has } interface directly, avoiding an intermediate Set copy.
    const errors = validateBatch(extensionId, contributors, this.contractRegistry, this.contributors);

    if (errors.length > 0) {
      return { errors };
    }

    // Validation passed — mutate atomically.
    const ownedIds = this.extensionIndex.get(extensionId) ?? new Set<string>();

    for (const definition of contributors) {
      const nsId = buildNamespacedId(extensionId, definition.id);
      // Deep-clone, freeze each selector, and freeze the definition in a
      // single spread so that external mutation after installation cannot
      // affect snapshots.
      const frozenDefinition: ContributorDefinition = Object.freeze({
        ...definition,
        selectors: Object.freeze(
          definition.selectors.map((s) => Object.freeze({ ...s })),
        ) as ContributorDefinition['selectors'],
      });
      const registered: RegisteredContributor = Object.freeze({
        namespacedId: nsId,
        extensionId,
        ordinal: this.nextOrdinal,
        definition: frozenDefinition,
      });
      this.nextOrdinal += 1;
      this.contributors.set(nsId, registered);
      ownedIds.add(nsId);
    }

    this.extensionIndex.set(extensionId, ownedIds);
    return { errors: [] };
  }

  /**
   * Remove all contributors owned by the given extension.
   *
   * Only removes contributors registered under the specified extension ID.
   * Contributors from other extensions are never affected.
   * @param extensionId - Extension whose contributors should be removed.
   */
  public removeContributors(extensionId: string): void {
    const ownedIds = this.extensionIndex.get(extensionId);
    if (!ownedIds) {
      return;
    }

    for (const nsId of ownedIds) {
      this.contributors.delete(nsId);
    }

    this.extensionIndex.delete(extensionId);
  }

  /**
   * Return an immutable snapshot of registered contributors matching a
   * given event name and its declared response capabilities.
   *
   * The snapshot is a frozen copy ordered by priority descending, then by
   * insertion ordinal ascending (stable insertion order within the same
   * priority). Subsequent register/remove operations do not affect
   * previously returned snapshots.
   * @param clientId - Client receiving the hook event.
   * @param contractId - Active provider contract handling the hook event.
   * @param eventName - Hook event name to filter contributors by.
   * @param eventCapabilities - The event's declared response capabilities.
   *   Capability selectors match against this array. Defaults to an empty
   *   array for backward compatibility.
   * @returns Frozen array of matching registered contributors.
   */
  public snapshot(
    clientId: string,
    contractId: string,
    eventName: string,
    eventCapabilities: readonly string[] = [],
  ): ReadonlyArray<RegisteredContributor> {
    const matching: RegisteredContributor[] = [];

    for (const registered of this.contributors.values()) {
      const { definition } = registered;
      if (
        (definition.lane === 'provider' &&
          (definition.clientId !== clientId || definition.contractId !== contractId)) ||
        (definition.lane === 'canonical' &&
          definition.clientIds !== undefined &&
          !definition.clientIds.includes(clientId))
      ) {
        continue;
      }
      const matches = registered.definition.selectors.some((selector) =>
        selectorMatchesEvent(selector, eventName, eventCapabilities),
      );
      if (matches) {
        matching.push(registered);
      }
    }

    matching.sort(compareRegistered);
    return Object.freeze(matching);
  }

  /**
   * Remove all registered contributors and reset the ordinal counter.
   */
  public clear(): void {
    this.contributors.clear();
    this.extensionIndex.clear();
    this.nextOrdinal = 1;
  }
}
