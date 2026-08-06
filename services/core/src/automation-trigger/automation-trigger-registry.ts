import type { IMakaioBus } from '@makaio/bus-core';
import type { AutomationTriggerDescriptor, AutomationTriggerType } from '@makaio/contracts';
import {
  AutomationTriggerLocalNameSchema,
  AutomationTriggerSubjects,
  createAutomationTriggerDescriptor,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { deepFreeze, SerialLane } from '@makaio/utils';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Defensive snapshot of a contributed automation trigger type.
 *
 * Captures the executable fields (`paramsSchema`, `eventSchema`, `activate`)
 * and presentation fields at registration time, so later mutation of the
 * caller-owned definition object cannot change active registry behavior.
 * `defineAutomationTrigger` freezes its result, but plain
 * {@link AutomationTriggerType} objects may not be — the snapshot is the
 * registry's guard against both.
 *
 * `categories` is spread into a new array so callers cannot mutate the
 * registered copy by holding a reference to the original.
 */
interface RegisteredAutomationTrigger {
  /** Owner that contributed this trigger. */
  readonly owner: string;
  /**
   * Defensive snapshot of the contributed trigger's executable and
   * presentation fields, captured at registration time.
   */
  readonly type: AutomationTriggerType;
  /**
   * Pre-computed, deep-frozen descriptor snapshot.
   *
   * Derived during batch validation so that discovery calls never execute
   * extension code or fail post-registration. It always describes the same
   * observation as `type`.
   *
   * The value it is derived from is already a detached clone, so freezing it here
   * is what lets {@link AutomationTriggerRegistry.list} hand the same object to
   * every caller instead of cloning per call.
   */
  readonly descriptor: AutomationTriggerDescriptor;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Owner-aware registry and bus catalog for automation triggers contributed by
 * extensions.
 *
 * Registration is keyed by the owning extension: every trigger kind must carry
 * the canonical `<owner>.` prefix, kinds are globally unique across owners, and
 * a registration batch is atomic — the complete incoming batch (including every
 * descriptor snapshot) is validated before either index changes, so a failing
 * batch leaves no partial registration.
 *
 * The registry supports dot-qualified owner names such as `makaio.clients-core`:
 * a trigger kind must start with `<owner>.` (with a trailing dot), which
 * permits `makaio.clients-core.profile-changed` for owner `makaio.clients-core`.
 * Npm-scoped owners use that same exact-prefix rule: `@acme/review.review-posted`
 * belongs to owner `@acme/review`, not a prefix-matching variant.
 *
 * Whole-batch replacement: each `register` call replaces that owner's entire
 * previously registered batch atomically. An empty batch removes the owner's
 * entries. Conflicts with another owner's kinds are rejected with an error that
 * names both the kind and the requesting owner.
 *
 * Bus catalog: `onInit()` registers the `automation-triggers.list` RPC handler
 * so callers can query the current trigger catalog without a direct reference to
 * this service. The `automation-triggers.changed` event is emitted on every
 * successful registration or deregistration. Registry state commits before the
 * event is emitted, so an observer failure cannot undo a change sibling
 * observers may already have consumed.
 */
export class AutomationTriggerRegistry extends BaseService {
  /** Registered triggers grouped by owning extension. */
  private typesByOwner: Map<string, readonly RegisteredAutomationTrigger[]> = new Map();
  /** Global kind index for collision checks and resolution lookup. */
  private typesByKind: Map<string, RegisteredAutomationTrigger> = new Map();
  /**
   * Monotonically increasing revision counter.
   *
   * Starts at 0 and increments on every successful `register` or `deregister`
   * call. Included in the `automation-triggers.changed` event so subscribers
   * can detect missed events.
   */
  private revision = 0;
  /**
   * FIFO mutation lane.
   *
   * `register` and `deregister` mutate and then await notification settlement.
   * Serializing them gives each committed change a unique revision and keeps
   * notifications in committed revision order.
   */
  private readonly mutations = new SerialLane();
  /**
   * Memoized {@link list} result, keyed on the kind index it was derived from.
   *
   * Keying on the Map identity rather than on an explicit invalidation call is
   * what makes the memo unconditionally correct: every index mutation publishes a
   * **new** Map, so a stale memo can never match the live index and no mutation
   * path can forget to invalidate it.
   */
  private catalog:
    | {
        readonly source: ReadonlyMap<string, RegisteredAutomationTrigger>;
        readonly value: readonly AutomationTriggerDescriptor[];
      }
    | undefined;

  /**
   * @param bus - Bus instance used for the service lifecycle and catalog RPC.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Initialize the service by registering the `automation-triggers.list` RPC
   * handler.
   *
   * Only discovery is exposed over the bus. Trigger activation and deactivation
   * are in-process operations not accessible via bus subjects in this phase.
   */
  protected onInit(): void {
    this.registerHandler(AutomationTriggerSubjects.list, (ctx) => {
      // Copy into a mutable array: the RPC result type is mutable while
      // `list()` intentionally returns a readonly view of the registry.
      ctx.setResult({ triggers: [...this.list()] });
    });
  }

  /**
   * Clears all in-memory registrations on teardown so handler closure
   * references held by the kind index are released.
   *
   * Assigns fresh Maps rather than clearing in place, preserving the invariant
   * that every index mutation publishes a new Map and invalidates any memoized
   * catalog by identity.
   */
  protected override onDestroy(): void {
    this.typesByOwner = new Map();
    this.typesByKind = new Map();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Atomically registers the complete automation trigger batch for an owner.
   *
   * Each call replaces that owner's previous batch entirely. The whole incoming
   * batch — including every descriptor snapshot — is validated before either
   * index changes, so a failing batch leaves the prior registration intact.
   * Kinds owned by another owner still collide; an empty batch removes this
   * owner's current registrations.
   *
   * Emits `automation-triggers.changed` with `reason: 'registered'` (or
   * `'deregistered'` for an empty batch that removes a prior batch). Notification
   * payloads identify the exact union of the previous and replacement batch's
   * kinds. Failures are reported but do not alter the committed registry state.
   *
   * Serialized against every other registry mutation: validation, index
   * replacement, and notification settlement complete before the next mutation
   * starts.
   *
   * A no-op (no emit, no state change) when `definitions` is empty and the
   * owner had no prior registrations.
   * @param owner - The extension contributing the complete batch.
   * @param definitions - Complete automation trigger types to register.
   * @returns Resolves when registration commits and changed-event notification
   * settles.
   * @throws When a kind is not namespaced by `<owner>.`, has an empty local
   *   name, duplicates another incoming kind, or belongs to another owner.
   */
  public register(owner: string, definitions: readonly AutomationTriggerType[]): Promise<void> {
    return this.mutations.run(() => this.registerWithinLane(owner, definitions));
  }

  /**
   * Applies one registration batch. Mutation-lane internal.
   * @param owner - The extension contributing the complete batch.
   * @param definitions - Complete automation trigger types to register.
   * @returns Resolves when registration commits and changed-event notification
   * settles.
   * @throws When batch validation fails.
   */
  private async registerWithinLane(owner: string, definitions: readonly AutomationTriggerType[]): Promise<void> {
    const batch = this.validateBatch(owner, definitions);

    const priorBatch = this.typesByOwner.get(owner);
    if (batch.length === 0 && priorBatch === undefined) return;

    const nextByOwner = new Map(this.typesByOwner);
    if (batch.length === 0) {
      nextByOwner.delete(owner);
    } else {
      nextByOwner.set(owner, batch);
    }

    this.typesByOwner = nextByOwner;
    this.typesByKind = reindexOwner(this.typesByKind, priorBatch ?? [], batch);
    this.revision += 1;

    const reason: 'registered' | 'deregistered' = batch.length > 0 ? 'registered' : 'deregistered';
    const kinds = Array.from(
      new Set([...(priorBatch ?? []).map(({ type }) => type.kind), ...batch.map(({ type }) => type.kind)]),
    );
    await this.bus
      .emit(AutomationTriggerSubjects.changed, {
        owner,
        revision: this.revision,
        kinds,
        reason,
      })
      .catch((error: unknown) => {
        console.error('[AutomationTriggerRegistry] Failed to emit automation-triggers.changed:', error);
      });
  }

  /**
   * Deregisters all automation triggers contributed by an owner.
   *
   * Idempotent — a no-op (no emit) when the owner has no registered triggers.
   * Emits `automation-triggers.changed` with `reason: 'deregistered'` on
   * success. Notification failures are reported but do not alter the committed
   * registry state.
   *
   * Serialized against every other registry mutation.
   * @param owner - The extension to remove.
   * @returns Resolves when deregistration commits and changed-event notification
   * settles.
   */
  public deregister(owner: string): Promise<void> {
    // Deregistration *is* whole-batch replacement with an empty batch: that path
    // already skips a no-op, removes the owner from both indexes, bumps the
    // revision, and emits `reason: 'deregistered'`.
    // Keeping a second copy of it here is how the two would drift.
    return this.mutations.run(() => this.registerWithinLane(owner, []));
  }

  /**
   * Resolves a trigger kind to its owning extension and registered type
   * snapshot.
   *
   * Used internally by the activation runtime to look up executable trigger
   * fields without bus indirection. Returns `undefined` for unknown kinds so
   * callers can gate gracefully on extension deregistration.
   * @param kind - Canonical trigger kind to resolve, e.g. `demo.assignment`.
   * @returns The owner and defensive type snapshot, or `undefined` when not
   *   registered.
   */
  public resolveRegistration(
    kind: string,
  ): { readonly owner: string; readonly type: AutomationTriggerType } | undefined {
    const entry = this.typesByKind.get(kind);
    if (entry === undefined) return undefined;
    return { owner: entry.owner, type: entry.type };
  }

  /**
   * Returns serializable descriptor snapshots for all registered automation
   * triggers.
   *
   * Descriptors are detached clones deep-frozen at registration time, so the same
   * objects are shared across calls: a caller cannot mutate the stored discovery
   * snapshot, and the catalog RPC does not pay a deep clone of the whole catalog
   * per query. The array itself is memoized per index revision. Descriptor
   * derivation runs only during successful batch validation; listing never
   * executes extension code.
   * @returns Frozen descriptor snapshots for every registered trigger.
   */
  public list(): readonly AutomationTriggerDescriptor[] {
    const index = this.typesByKind;
    if (this.catalog?.source === index) return this.catalog.value;

    const value = Object.freeze(Array.from(index.values(), ({ descriptor }) => descriptor));
    this.catalog = { source: index, value };
    return value;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validates a complete registration batch without mutating registry state.
   *
   * Builds defensive type snapshots and pre-computes descriptor snapshots for
   * every trigger in the batch. If any trigger fails validation the entire
   * batch is rejected — no partial snapshots are returned.
   * @param owner - Owner of the proposed definitions.
   * @param definitions - Trigger types to validate.
   * @returns Array of registered entries with snapshotted types and descriptors.
   * @throws When namespace, duplicate-kind, or cross-owner invariants are
   *   violated, or when a trigger's schemas cannot be projected to JSON Schema.
   */
  private validateBatch(
    owner: string,
    definitions: readonly AutomationTriggerType[],
  ): readonly RegisteredAutomationTrigger[] {
    const prefix = `${owner}.`;
    const pendingKinds = new Set<string>();
    // Kinds the current owner already owns — needed to allow replacement without
    // triggering a false cross-owner collision.
    const ownedKinds = new Set(this.typesByOwner.get(owner)?.map((entry) => entry.type.kind));

    const registered: RegisteredAutomationTrigger[] = [];

    for (const definition of definitions) {
      const localName = definition.kind.startsWith(prefix) ? definition.kind.slice(prefix.length) : undefined;
      if (localName === undefined || !AutomationTriggerLocalNameSchema.safeParse(localName).success) {
        throw new Error(`Automation trigger kind '${definition.kind}' must be namespaced by owner '${prefix}'`);
      }
      if (pendingKinds.has(definition.kind)) {
        throw new Error(`Duplicate automation trigger kind '${definition.kind}' in batch from '${owner}'`);
      }
      if (this.typesByKind.has(definition.kind) && !ownedKinds.has(definition.kind)) {
        throw new Error(
          `Automation trigger kind '${definition.kind}' is already registered; owner '${owner}' cannot claim it`,
        );
      }
      pendingKinds.add(definition.kind);

      // Defensive snapshot: spread categories into a new array so mutations to
      // the original definition cannot silently change the registered copy.
      // Zod schemas and the activate closure are function-carrying values
      // captured by reference — the snapshot holds its own reference, so
      // reassigning the field on the original object does not affect the
      // registry entry even when the original is unfrozen.
      const snapshotType: AutomationTriggerType = {
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        categories: [...definition.categories],
        paramsSchema: definition.paramsSchema,
        eventSchema: definition.eventSchema,
        activate: definition.activate,
      };

      // Pre-validate the descriptor so subsequent list() calls cannot fail or
      // execute extension code. The factory returns a detached clone, which this
      // entry owns exclusively and freezes for shared reads.
      //
      // Derived from `definition` when the definition is frozen: the descriptor
      // cache is keyed on object identity and `defineAutomationTrigger` freezes its
      // result *and* warms that cache on it, so the fresh snapshot would be a
      // guaranteed miss and re-derive what is already known. A frozen definition
      // also cannot drift from the snapshot taken from it, which is what makes the
      // cache hit safe. An unfrozen definition can drift between two
      // registrations, so its descriptor is derived from the snapshot instead —
      // descriptor and type must always describe the same observation.
      const descriptorSource = Object.isFrozen(definition) ? definition : snapshotType;
      const descriptor = deepFreeze(createAutomationTriggerDescriptor(descriptorSource));
      registered.push({ owner, type: snapshotType, descriptor });
    }

    return registered;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Applies one owner's batch replacement to the global kind index.
 *
 * Always returns a **new** Map and never mutates the previous one, keeping
 * catalog memoization correct through Map identity.
 *
 * Only the replaced owner's kinds are touched, rather than rebuilding from every
 * owner's entries, because a batch's kinds can collide with nothing but that same
 * owner's prior kinds: cross-owner collisions are rejected during validation.
 * Removing the prior kinds before adding the batch's is therefore enough to leave
 * the index exactly as a full rebuild would.
 * @param previous - Kind index in force before this mutation.
 * @param priorBatch - The owner's entries being replaced, empty when it had none.
 * @param batch - The owner's new entries, empty when the owner is being removed.
 * @returns A new kind-to-entry Map covering all registered triggers.
 */
function reindexOwner(
  previous: ReadonlyMap<string, RegisteredAutomationTrigger>,
  priorBatch: readonly RegisteredAutomationTrigger[],
  batch: readonly RegisteredAutomationTrigger[],
): Map<string, RegisteredAutomationTrigger> {
  const byKind = new Map(previous);
  for (const entry of priorBatch) {
    byKind.delete(entry.type.kind);
  }
  for (const entry of batch) {
    byKind.set(entry.type.kind, entry);
  }
  return byKind;
}
