import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  ArtifactKindRegistrationSchema,
  type ArtifactKindRegistration,
  type RelationTypeRegistration,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { assertKindDataSchema } from './assert-kind-data-schema.js';

/**
 * Core relation types registered with every artifact schema registry at
 * initialisation time. Extensions may add further types via the bus RPC.
 */
const CORE_RELATION_TYPES: readonly RelationTypeRegistration[] = [
  { type: 'supersedes', symmetry: 'asymmetric' },
  { type: 'contradicts', symmetry: 'symmetric' },
  { type: 'derives_from', symmetry: 'asymmetric' },
  { type: 'responds_to', symmetry: 'asymmetric' },
  { type: 'contains', symmetry: 'asymmetric' },
  { type: 'refines', symmetry: 'asymmetric' },
  { type: 'scopes', symmetry: 'asymmetric' },
  { type: 'references', symmetry: 'asymmetric' },
  { type: 'evidenced_by', symmetry: 'asymmetric' },
];

/**
 * Identifies the provenance tier of a kind contributor.
 *
 * - `'extension'` — registered by a runtime extension; highest priority
 * - `'factory-repo'` — declared in a factory-owned repository; medium priority
 * - `'target-repo'` — declared in a target/application repository; lowest priority
 */
export type ArtifactKindRegistrationSource = 'extension' | 'factory-repo' | 'target-repo';

/**
 * Identifies the entity that owns a batch of kind registrations.
 *
 * `ownerKey` is an opaque, owner-defined string that uniquely distinguishes
 * one owner from all others at the same source tier (e.g. the extension
 * name, or the repository slug).
 */
export interface ArtifactKindRegistrationOwner {
  /** Provenance tier of the contributing entity. */
  readonly source: ArtifactKindRegistrationSource;
  /** Stable identifier for this specific owner within its source tier. */
  readonly ownerKey: string;
}

/**
 * Numeric priority for each provenance tier.
 *
 * Lower values win. Extensions always override factory-repo contributions,
 * which in turn override target-repo contributions.
 */
const KIND_SOURCE_PRIORITY: Record<ArtifactKindRegistrationSource, number> = {
  extension: 0,
  'factory-repo': 1,
  'target-repo': 2,
};

/**
 * Default owner applied to registrations that arrive over the bus RPC
 * (i.e. registrations without an explicit owner context).
 */
const EXTENSION_BUS_OWNER: ArtifactKindRegistrationOwner = {
  source: 'extension',
  ownerKey: 'extension:bus',
};

/** A single owned contribution to a kind slot. */
interface OwnedArtifactKindContribution {
  readonly owner: ArtifactKindRegistrationOwner;
  readonly registration: ArtifactKindRegistration;
  /** Monotone insertion counter used to break ties within the same tier. */
  readonly order: number;
}

/**
 * Computes a stable string identifier for an owner.
 * @param owner - The owner to identify.
 * @returns A composite string key.
 */
function ownerId(owner: ArtifactKindRegistrationOwner): string {
  return `${owner.source}:${owner.ownerKey}`;
}

/**
 * Returns `true` when both owners refer to the same contributing entity.
 * @param a - First owner.
 * @param b - Second owner.
 * @returns Whether `a` and `b` represent the same owner.
 */
function sameOwner(a: ArtifactKindRegistrationOwner, b: ArtifactKindRegistrationOwner): boolean {
  return a.source === b.source && a.ownerKey === b.ownerKey;
}

/**
 * Clone a registry record at API boundaries so external mutation cannot
 * rewrite in-memory registrations.
 * @param value - Registry value to clone.
 * @returns A detached copy of the registry value.
 */
function cloneRegistration<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Composite key used to deduplicate kind registrations.
 * @param kind - Kind discriminator string.
 * @param schemaVersion - Positive schema version.
 * @returns A stable composite key.
 */
function kindKey(kind: string, schemaVersion: number): string {
  return `${kind}@${schemaVersion}`;
}

/**
 * In-process registry for artifact kind definitions and relation type vocabulary.
 *
 * Exposes bus RPCs for kind and relation-type registration and listing, and
 * emits `artifact.kind.changed` events when a kind registration is stored,
 * updated, or removed. Core relation vocabulary is seeded during `init()`.
 *
 * Extensions register artifact kinds through this service directly or via
 * {@link ArtifactSubjects}; the registry rejects conflicting duplicate
 * relation type definitions.
 *
 * ### Ownership and priority
 *
 * Each kind slot may have multiple contributing owners. The active registration
 * is the one from the highest-priority owner. Priority order (highest → lowest):
 * `extension` → `factory-repo` → `target-repo`.
 *
 * Within the `extension` tier, the most recently registered owner wins (LIFO).
 * Within `factory-repo` and `target-repo`, the first registration wins (FIFO),
 * and a same-tier duplicate from a different owner is rejected with a warning.
 *
 * When the winning owner deregisters, the next-highest owner automatically
 * becomes active without requiring a re-registration.
 */
export class ArtifactSchemaRegistry extends BaseService {
  /**
   * Winner cache: the currently active registration for each kind key.
   * Kept in sync with `kindContributions` via `recomputeKindWinner`.
   */
  private readonly kinds = new Map<string, ArtifactKindRegistration>();

  /**
   * All contributions indexed by `kindKey → ownerId → contribution`.
   * The winner cache is derived from this map.
   */
  private readonly kindContributions = new Map<string, Map<string, OwnedArtifactKindContribution>>();

  /** Monotone counter for contribution insertion order. */
  private nextKindContributionOrder = 0;

  private readonly relationTypes = new Map<string, RelationTypeRegistration>();

  /**
   * @param bus - Bus instance used for handler registration and event emission.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Service initialisation hook.
   *
   * Seeds core relation vocabulary and registers bus handlers for the
   * artifact kind and relation-type RPCs.
   */
  protected async onInit(): Promise<void> {
    for (const relationType of CORE_RELATION_TYPES) {
      this.relationTypes.set(relationType.type, relationType);
    }

    this.registerHandler(ArtifactSubjects.kind.register, (ctx) => {
      this.registerKind(ctx.payload);
      ctx.setResult({ registered: true });
    });

    this.registerHandler(ArtifactSubjects.kind.list, (ctx) => {
      const { kind } = ctx.payload;
      const kinds = [...this.kinds.values()].filter((entry) => !kind || entry.kind === kind).map(cloneRegistration);
      ctx.setResult({ kinds });
    });

    this.registerHandler(ArtifactSubjects['relation-type'].register, (ctx) => {
      this.storeRelationType(ctx.payload);
      ctx.setResult({ registered: true });
    });

    this.registerHandler(ArtifactSubjects['relation-type'].list, (ctx) => {
      const { type } = ctx.payload;
      const relationTypes = [...this.relationTypes.values()]
        .filter((entry) => !type || entry.type === type)
        .map(cloneRegistration);
      ctx.setResult({ relationTypes });
    });
  }

  /**
   * Compares two contributions to determine their relative priority.
   *
   * Returns a negative number when `a` should rank above `b` (win), positive
   * when `b` should rank above `a`, and zero when they are equivalent.
   *
   * Within the `extension` tier, the most recently registered contribution
   * wins (descending order). For all other tiers, the earliest registration
   * wins (ascending order).
   * @param a - First contribution.
   * @param b - Second contribution.
   * @returns Sort comparator value.
   */
  private compareKindContributions(a: OwnedArtifactKindContribution, b: OwnedArtifactKindContribution): number {
    const priorityDelta = KIND_SOURCE_PRIORITY[a.owner.source] - KIND_SOURCE_PRIORITY[b.owner.source];
    if (priorityDelta !== 0) return priorityDelta;
    // Same tier: extensions use LIFO (latest wins), repo tiers use FIFO (earliest wins).
    return a.owner.source === 'extension' ? b.order - a.order : a.order - b.order;
  }

  /**
   * Find an existing same-tier repo contribution that owns a kind slot.
   *
   * Repo-sourced kinds are first-wins within their tier; this helper keeps
   * single registration and owner-batch replacement on the same collision rule.
   * @param contributions - Current contributions for the kind slot.
   * @param owner - Candidate owner being registered.
   * @param candidateOrder - Ordering value the candidate would retain or receive.
   * @returns Conflicting contribution, or `undefined` when the candidate can register.
   */
  private findSameTierRepoConflict(
    contributions: ReadonlyMap<string, OwnedArtifactKindContribution>,
    owner: ArtifactKindRegistrationOwner,
    candidateOrder: number,
  ): OwnedArtifactKindContribution | undefined {
    return [...contributions.values()].find(
      (entry) =>
        !sameOwner(entry.owner, owner) &&
        entry.owner.source === owner.source &&
        owner.source !== 'extension' &&
        entry.order <= candidateOrder,
    );
  }

  /**
   * Recomputes the winner for a kind slot from its current contributions and
   * emits a `kind.changed` event when the active registration changes.
   * @param key - Composite kind key produced by {@link kindKey}.
   */
  private recomputeKindWinner(key: string): void {
    const contributions = this.kindContributions.get(key);
    const previous = this.kinds.get(key);

    if (contributions === undefined || contributions.size === 0) {
      this.kindContributions.delete(key);
      this.kinds.delete(key);
      this.emitKindChangedFromKey(key, previous);
      return;
    }

    let winner: OwnedArtifactKindContribution | undefined;
    for (const contribution of contributions.values()) {
      if (winner === undefined || this.compareKindContributions(contribution, winner) < 0) {
        winner = contribution;
      }
    }
    // `contributions` is non-empty (size === 0 is guarded above), so winner is always defined.
    const resolvedWinner = winner!;

    this.kinds.set(key, cloneRegistration(resolvedWinner.registration));
    if (JSON.stringify(previous) !== JSON.stringify(resolvedWinner.registration)) {
      void this.bus.emit(ArtifactSubjects.kind.changed, {
        kind: resolvedWinner.registration.kind,
        schemaVersion: resolvedWinner.registration.schemaVersion,
      });
    }
  }

  /**
   * Emits a `kind.changed` event derived from a composite key, but only
   * when there was a previous registration to signal the change against.
   * @param key - Composite kind key produced by {@link kindKey}.
   * @param previous - The registration that was previously active, if any.
   */
  private emitKindChangedFromKey(key: string, previous: ArtifactKindRegistration | undefined): void {
    if (previous === undefined) return;
    void this.bus.emit(ArtifactSubjects.kind.changed, {
      kind: previous.kind,
      schemaVersion: previous.schemaVersion,
    });
  }

  /**
   * Store a kind registration attributed to `owner`, applying source-priority
   * resolution when multiple owners contribute the same kind slot.
   *
   * Bus RPC registrations (without an explicit owner) are attributed to
   * {@link EXTENSION_BUS_OWNER} and treated as extension-tier contributions.
   *
   * Same-tier repo conflicts (two distinct factory-repo or target-repo owners
   * for the same slot) are rejected with a console warning; the first owner
   * registered at that tier retains ownership.
   * @param registration - Kind registration payload.
   * @param owner - Owner identity. Defaults to the extension bus owner.
   */
  public registerKind(
    registration: ArtifactKindRegistration,
    owner: ArtifactKindRegistrationOwner = EXTENSION_BUS_OWNER,
  ): void {
    registration = ArtifactKindRegistrationSchema.parse(registration);
    assertKindDataSchema(registration);
    const key = kindKey(registration.kind, registration.schemaVersion);
    const contributions = this.kindContributions.get(key) ?? new Map<string, OwnedArtifactKindContribution>();
    const id = ownerId(owner);
    const existingContribution = contributions.get(id);
    const candidateOrder =
      owner.source === 'extension'
        ? this.nextKindContributionOrder
        : (existingContribution?.order ?? this.nextKindContributionOrder);

    const existingSameTierRepoContribution = this.findSameTierRepoConflict(contributions, owner, candidateOrder);

    if (existingSameTierRepoContribution !== undefined) {
      console.warn(
        `[ArtifactSchemaRegistry] Artifact kind '${key}' is already registered by '${existingSameTierRepoContribution.owner.ownerKey}' at the same priority; keeping the existing owner.`,
      );
      return;
    }

    contributions.set(id, {
      owner,
      registration: cloneRegistration(registration),
      order:
        owner.source === 'extension' || existingContribution === undefined
          ? this.nextKindContributionOrder++
          : existingContribution.order,
    });
    this.kindContributions.set(key, contributions);
    this.recomputeKindWinner(key);
  }

  /**
   * Remove a kind registration by `kind + schemaVersion` for the given owner.
   *
   * If the deregistered owner was the active winner, the next-highest owner
   * automatically becomes active. Bus RPC callers without an explicit owner
   * are attributed to {@link EXTENSION_BUS_OWNER}.
   * @param kind - Kind discriminator string.
   * @param schemaVersion - Positive schema version.
   * @param owner - Owner identity. Defaults to the extension bus owner.
   */
  public deregisterKind(
    kind: string,
    schemaVersion: number,
    owner: ArtifactKindRegistrationOwner = EXTENSION_BUS_OWNER,
  ): void {
    const key = kindKey(kind, schemaVersion);
    const contributions = this.kindContributions.get(key);
    if (contributions === undefined) return;
    contributions.delete(ownerId(owner));
    this.recomputeKindWinner(key);
  }

  /**
   * Atomically replace all kind registrations for a single owner.
   *
   * All existing contributions from `owner` are removed across every kind
   * slot before the new registrations are applied. Kind slots affected by
   * the replacement recompute their winner after all changes are applied.
   *
   * Other owners' contributions are unaffected.
   * @param owner - The owner whose registrations are being replaced.
   * @param registrations - The new set of kind registrations for this owner.
   */
  public replaceKindRegistrationsForOwner(
    owner: ArtifactKindRegistrationOwner,
    registrations: readonly ArtifactKindRegistration[],
  ): void {
    const validated = registrations.map((registration) => ArtifactKindRegistrationSchema.parse(registration));
    for (const registration of validated) assertKindDataSchema(registration);
    const touched = new Set<string>();
    const id = ownerId(owner);
    const previousOrders = new Map<string, number>();

    for (const [key, contributions] of this.kindContributions.entries()) {
      const existingContribution = contributions.get(id);
      if (existingContribution !== undefined) {
        previousOrders.set(key, existingContribution.order);
        contributions.delete(id);
        touched.add(key);
      }
    }

    for (const registration of validated) {
      const key = kindKey(registration.kind, registration.schemaVersion);
      const contributions = this.kindContributions.get(key) ?? new Map<string, OwnedArtifactKindContribution>();
      const preservedOrder = owner.source === 'extension' ? undefined : previousOrders.get(key);
      const candidateOrder = preservedOrder ?? this.nextKindContributionOrder;
      const existingSameTierRepoContribution = this.findSameTierRepoConflict(contributions, owner, candidateOrder);
      if (existingSameTierRepoContribution !== undefined) {
        console.warn(
          `[ArtifactSchemaRegistry] Artifact kind '${key}' is already registered by '${existingSameTierRepoContribution.owner.ownerKey}' at the same priority; keeping the existing owner.`,
        );
        continue;
      }
      contributions.set(id, {
        owner,
        registration: cloneRegistration(registration),
        order: preservedOrder ?? this.nextKindContributionOrder++,
      });
      this.kindContributions.set(key, contributions);
      touched.add(key);
    }

    for (const key of touched) {
      this.recomputeKindWinner(key);
    }
  }

  /**
   * Store a relation type registration.
   *
   * An identical re-registration (same type and symmetry) is silently accepted.
   * A registration that differs only in symmetry is rejected with an error.
   * @param registration - Relation type registration payload received from the bus RPC.
   * @throws If a conflicting registration for the same type already exists.
   */
  private storeRelationType(registration: RelationTypeRegistration): void {
    const existing = this.relationTypes.get(registration.type);
    if (existing) {
      if (existing.symmetry !== registration.symmetry) {
        throw new Error(
          `Relation type '${registration.type}' is already registered with different symmetry` +
            ` (existing: '${existing.symmetry}', new: '${registration.symmetry}')`,
        );
      }
      // Identical re-registration is a no-op.
      return;
    }
    this.relationTypes.set(registration.type, cloneRegistration(registration));
  }

  /**
   * Look up a kind registration by kind string and schema version.
   * @param kind - Kind discriminator string.
   * @param schemaVersion - Positive schema version.
   * @returns The registration record, or `undefined` if not found.
   */
  public getKind(kind: string, schemaVersion: number): ArtifactKindRegistration | undefined {
    const registration = this.kinds.get(kindKey(kind, schemaVersion));
    return registration ? cloneRegistration(registration) : undefined;
  }

  /**
   * Look up a relation type registration by type string.
   * @param type - Relation type string.
   * @returns The registration record, or `undefined` if not found.
   */
  public getRelationType(type: string): RelationTypeRegistration | undefined {
    const registration = this.relationTypes.get(type);
    return registration ? cloneRegistration(registration) : undefined;
  }

  /**
   * Service teardown hook.
   *
   * Clears all in-memory registrations so the instance can be garbage-collected
   * without retaining large schema maps.
   */
  protected override onDestroy(): void {
    this.kinds.clear();
    this.kindContributions.clear();
    this.relationTypes.clear();
    this.nextKindContributionOrder = 0;
  }
}
