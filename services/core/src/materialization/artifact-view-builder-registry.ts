import type { ExtensionServiceLifecycle } from '@makaio/contracts';
import type { ArtifactViewBuilder } from '@makaio/contracts/materialization';

/* -------------------------------------------------------------------------- */
/*  Canonical key helper                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Produce the canonical registry key for a `kind + schemaVersion` pair.
 *
 * Both `kind` and `schemaVersion` are unconstrained strings, so delimiter
 * concatenation would be ambiguous (`kind: 'a@b', version: 'c'` versus
 * `kind: 'a', version: 'b@c'`). Encoding the pair as a JSON tuple keeps
 * the key deterministic and collision-free for every string combination.
 * @param kind - Artifact kind discriminator.
 * @param schemaVersion - Artifact schema version.
 * @returns A deterministic string key.
 */
function builderKey(kind: string, schemaVersion: string): string {
  return JSON.stringify([kind, schemaVersion]);
}

/* -------------------------------------------------------------------------- */
/*  Registration snapshot helper                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create a detached, frozen copy of a builder registration limited to the
 * contract fields.
 *
 * Builders carry a `build` function, so `structuredClone` is not an option.
 * Picking exactly the contract fields and freezing the copy guarantees that
 * mutating the caller's object after registration cannot desynchronize the
 * owner lists and the global index.
 * @param builder - Caller-supplied builder registration.
 * @returns A frozen shallow copy carrying exactly the contract fields.
 */
function freezeBuilder(builder: ArtifactViewBuilder<string>): ArtifactViewBuilder<string> {
  return Object.freeze({
    kind: builder.kind,
    schemaVersion: builder.schemaVersion,
    version: builder.version,
    build: builder.build,
  });
}

/* -------------------------------------------------------------------------- */
/*  Error class                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when a builder replacement would introduce a key collision across
 * owners, or when an owner's incoming builder set contains duplicate keys.
 */
export class ArtifactViewBuilderCollisionError extends Error {
  /**
   * @param key - The colliding canonical key.
   * @param incomingOwner - Owner attempting the registration.
   * @param existingOwner - Owner that already holds the key (may equal
   *   `incomingOwner` for intra-owner duplicates).
   */
  public constructor(
    public readonly key: string,
    public readonly incomingOwner: string,
    public readonly existingOwner: string,
  ) {
    const message =
      incomingOwner === existingOwner
        ? `Duplicate builder key '${key}' within owner '${incomingOwner}'`
        : `Builder key '${key}' from owner '${incomingOwner}' collides with owner '${existingOwner}'`;
    super(message);
    this.name = 'ArtifactViewBuilderCollisionError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Registry implementation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * In-process, owner-scoped registry for live artifact view builders.
 *
 * Maintains a per-owner builder list and a global index keyed by
 * `kind + schemaVersion`. All mutations go through
 * {@link replaceBuildersForOwner}, which atomically validates the
 * incoming set, constructs a candidate global index, rejects cross-owner
 * collisions, and swaps state only after the full candidate validates.
 *
 * The registry does not extend `BaseService` because it requires no bus
 * handlers. It implements {@link ExtensionServiceLifecycle} directly so the
 * extension coordinator can manage it: no `init` work is needed and
 * `destroy` clears all registrations.
 */
export class ArtifactViewBuilderRegistry implements ExtensionServiceLifecycle {
  /**
   * Per-owner builder lists. Each entry is the authoritative set of
   * builders contributed by that owner. Values are detached, frozen
   * copies of the caller-supplied registrations.
   */
  private readonly owners = new Map<string, readonly ArtifactViewBuilder<string>[]>();

  /**
   * Global index from canonical key to `{ owner, builder }`. Rebuilt
   * atomically on every {@link replaceBuildersForOwner} or
   * {@link removeBuildersForOwner} call.
   */
  private globalIndex = new Map<string, { readonly owner: string; readonly builder: ArtifactViewBuilder<string> }>();

  // --------------------------------------------------------------------------
  // Lookup
  // --------------------------------------------------------------------------

  /**
   * Look up a builder by exact `kind + schemaVersion`.
   * @param kind - Artifact kind discriminator.
   * @param schemaVersion - Artifact schema version.
   * @returns The matching builder, or `undefined` if none is registered.
   */
  public getBuilder(kind: string, schemaVersion: string): ArtifactViewBuilder<string> | undefined {
    return this.globalIndex.get(builderKey(kind, schemaVersion))?.builder;
  }

  // --------------------------------------------------------------------------
  // Owner-scoped mutation
  // --------------------------------------------------------------------------

  /**
   * Atomically replace all builders for a given owner.
   *
   * Validation steps:
   * 1. Every builder must have a positive integer `version`.
   * 2. The incoming set must not contain duplicate keys.
   * 3. The candidate global index must not have cross-owner collisions.
   *
   * If any step fails, state is unchanged and the error is thrown.
   *
   * The registry stores detached, frozen copies of the contract fields, so
   * mutating a caller's builder object after registration has no effect.
   * Replacing with an empty set removes the owner entirely — equivalent to
   * {@link removeBuildersForOwner}, so {@link getBuildersForOwner} returns
   * `undefined` afterwards.
   * @param ownerKey - Stable owner identifier (typically the extension name).
   * @param builders - Builder registrations to install for this owner.
   * @throws {@link ArtifactViewBuilderCollisionError} on duplicate or cross-owner collision.
   * @throws Error on non-positive builder version.
   */
  public replaceBuildersForOwner(ownerKey: string, builders: readonly ArtifactViewBuilder<string>[]): void {
    // --- Step 1: Validate versions -------------------------------------------
    for (const builder of builders) {
      if (!Number.isInteger(builder.version) || builder.version < 1) {
        throw new Error(
          `Builder for '${builderKey(builder.kind, builder.schemaVersion)}' from owner '${ownerKey}' has non-positive version ${String(builder.version)}`,
        );
      }
    }

    // --- Step 2: Check intra-owner duplicates --------------------------------
    // Frozen contract-field copies are stored from here on; the caller's
    // objects never enter registry state.
    const incomingKeys = new Map<string, ArtifactViewBuilder<string>>();
    for (const builder of builders) {
      const key = builderKey(builder.kind, builder.schemaVersion);
      if (incomingKeys.has(key)) {
        throw new ArtifactViewBuilderCollisionError(key, ownerKey, ownerKey);
      }
      incomingKeys.set(key, freezeBuilder(builder));
    }

    // --- Step 3: Validate cross-owner collisions -----------------------------
    for (const key of incomingKeys.keys()) {
      const existing = this.globalIndex.get(key);
      if (existing && existing.owner !== ownerKey) {
        throw new ArtifactViewBuilderCollisionError(key, ownerKey, existing.owner);
      }
    }

    // --- Step 4: Atomically swap state ---------------------------------------
    // An empty replacement set deletes the owner key so replace-to-empty and
    // removeBuildersForOwner leave identical state.
    if (incomingKeys.size === 0) {
      this.owners.delete(ownerKey);
    } else {
      this.owners.set(ownerKey, [...incomingKeys.values()]);
    }
    this.rebuildGlobalIndex();
  }

  /**
   * Remove all builders registered by a given owner.
   *
   * After removal the global index is rebuilt from remaining owners.
   * No-op if the owner has no registrations.
   * @param ownerKey - Owner to remove.
   */
  public removeBuildersForOwner(ownerKey: string): void {
    if (!this.owners.has(ownerKey)) return;

    this.owners.delete(ownerKey);
    this.rebuildGlobalIndex();
  }

  /**
   * Return a read-only snapshot of all builders for an owner.
   *
   * The returned array is detached from internal state; its entries are the
   * frozen registered copies.
   * @param ownerKey - Owner to query.
   * @returns Builder list, or `undefined` if the owner has no registrations.
   */
  public getBuildersForOwner(ownerKey: string): readonly ArtifactViewBuilder<string>[] | undefined {
    const owned = this.owners.get(ownerKey);
    if (!owned) return undefined;
    return [...owned];
  }

  /**
   * Clear all registrations. Primarily for testing and shutdown.
   */
  public clear(): void {
    this.owners.clear();
    this.globalIndex.clear();
  }

  // --------------------------------------------------------------------------
  // Extension service lifecycle
  // --------------------------------------------------------------------------

  /**
   * Service teardown hook.
   *
   * Clears all registrations so the instance can be garbage-collected
   * without retaining builder maps.
   */
  public destroy(): void {
    this.clear();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Rebuild the global index from all current owner registrations.
   *
   * Called after owner removal. Cross-owner collisions are impossible at
   * this point because the index was collision-free before removal.
   */
  private rebuildGlobalIndex(): void {
    const next = new Map<string, { readonly owner: string; readonly builder: ArtifactViewBuilder<string> }>();
    for (const [owner, builders] of this.owners) {
      for (const builder of builders) {
        const key = builderKey(builder.kind, builder.schemaVersion);
        next.set(key, { owner, builder });
      }
    }
    this.globalIndex = next;
  }
}
