import { ownsCanonicalContributionName } from '@makaio/core';

/**
 * How a {@link ContributionRegistryCore} decides whether an owner may claim a
 * given contribution name.
 *
 * By default the name must be canonical and have the owner prefix. A core instance whose contribution
 * name coincides with the owner's own name (for example a rule block, which
 * is registered under the contributing extension's own name) supplies a
 * looser predicate instead.
 * @param owner - Extension claiming the name.
 * @param name - Candidate contribution name.
 * @returns Whether `owner` may claim `name`.
 */
export type ContributionOwnershipPredicate = (owner: string, name: string) => boolean;

/**
 * Error-message builders for the three validation failures
 * {@link ContributionRegistryCore.validateBatch} can throw.
 *
 * Every contribution kind shares the same three checks, but existing kinds
 * (for example automation triggers) may already have an observable wording
 * other code or tests depend on. Defaults give every new contribution kind a
 * consistent wording; a core instance wrapping an existing kind overrides
 * only the templates that must match its prior wording.
 */
export interface ContributionRegistryCoreMessages {
  /**
   * An owner tried to claim a name the ownership predicate rejects.
   * @param owner - Extension that attempted the registration.
   * @param name - Rejected contribution name.
   * @returns The error message.
   */
  readonly namespaceViolation: (owner: string, name: string) => string;
  /**
   * A name repeats within the same incoming batch.
   * @param owner - Extension contributing the batch.
   * @param name - Repeated contribution name.
   * @returns The error message.
   */
  readonly duplicateInBatch: (owner: string, name: string) => string;
  /**
   * A name is already registered under a different owner.
   * @param owner - Extension that attempted the registration.
   * @param name - Contested contribution name.
   * @returns The error message.
   */
  readonly crossOwnerCollision: (owner: string, name: string) => string;
}

/**
 * Builds the default message set for a given label, e.g. `'Reaction'` or `'Trigger'`.
 * @param label - Human-readable label used in every default message.
 * @returns Default message builders for {@link ContributionRegistryCoreMessages}.
 */
function defaultMessages(label: string): ContributionRegistryCoreMessages {
  return {
    namespaceViolation: (owner, name) => `${label} '${name}' must be namespaced by extension '${owner}.'`,
    duplicateInBatch: (owner, name) => `${label} name collision: '${name}' appears twice in batch from '${owner}'`,
    crossOwnerCollision: (_owner, name) => `${label} name collision: '${name}' is already registered`,
  };
}

/**
 * Options for {@link ContributionRegistryCore}.
 * @typeParam TEntry - Registered entry type this core instance indexes.
 */
export interface ContributionRegistryCoreOptions<TEntry> {
  /** Human-readable label used in the default error messages, e.g. `'Reaction'`, `'Automation trigger'`. */
  readonly label: string;
  /**
   * Extracts the canonical contribution name from a registered entry.
   * @param entry - Registered entry.
   * @returns The entry's canonical contribution name.
   */
  readonly nameOf: (entry: TEntry) => string;
  /** Ownership predicate for this core instance. Defaults to canonical names with the owner prefix. */
  readonly ownsName?: ContributionOwnershipPredicate;
  /**
   * Overrides for one or more of the three default validation messages.
   * Unset templates fall back to {@link defaultMessages} for `label`.
   */
  readonly messages?: Partial<ContributionRegistryCoreMessages>;
}

/**
 * Generic owner-aware registry core shared by every contribution kind that
 * registers a batch of named entries per extension.
 *
 * Owns exactly three things, once, for every contribution kind built on it:
 * - the global name index (one entry per canonical contribution name),
 * - the owner check (a name owned by another extension is rejected), and
 * - the per-extension batch lifecycle (atomic replace, empty batch removes
 *   the owner's entries).
 *
 * A core instance never derives kind-specific data (descriptors, schemas,
 * …); callers validate and shape their own entries, then call
 * {@link validateBatch} before mutating anything and {@link commitBatch} to
 * apply a batch that already passed validation. Splitting the two steps lets
 * a caller run its own kind-specific validation (for example deriving a
 * serializable descriptor) in between, so a failure at either step leaves the
 * registry untouched.
 * @typeParam TEntry - Registered entry type this core instance indexes.
 */
export class ContributionRegistryCore<TEntry> {
  /** Registered entries grouped by owning extension. */
  private entriesByOwner = new Map<string, readonly TEntry[]>();
  /** Global name index for collision checks and lookup. */
  private entriesByName = new Map<string, TEntry>();
  /** Extracts the canonical contribution name from a registered entry. */
  private readonly nameOf: (entry: TEntry) => string;
  /** Ownership predicate deciding whether an owner may claim a given name. */
  private readonly ownsName: ContributionOwnershipPredicate;
  /** Resolved error-message builders for this core instance. */
  private readonly messages: ContributionRegistryCoreMessages;

  /**
   * @param options - Label, name extraction, ownership predicate, and message
   *   overrides for this core instance.
   */
  public constructor(options: ContributionRegistryCoreOptions<TEntry>) {
    this.nameOf = options.nameOf;
    this.ownsName = options.ownsName ?? ownsCanonicalContributionName;
    this.messages = { ...defaultMessages(options.label), ...options.messages };
  }

  /**
   * Resolves a registered entry by its canonical contribution name.
   * @param name - Canonical contribution name.
   * @returns The registered entry, or `undefined` when no entry is registered under that name.
   */
  public get(name: string): TEntry | undefined {
    return this.entriesByName.get(name);
  }

  /**
   * Lists every registered entry across every owner.
   * @returns A live snapshot array of every registered entry.
   */
  public list(): readonly TEntry[] {
    return Array.from(this.entriesByName.values());
  }

  /**
   * Lists registered entries alongside their contributing extensions.
   * @returns A snapshot of the live registrations and their owners.
   */
  public listOwned(): ReadonlyArray<{ extension: string; entry: TEntry }> {
    return Array.from(this.entriesByOwner).flatMap(([extension, entries]) =>
      entries.map((entry) => ({ extension, entry })),
    );
  }

  /**
   * Returns the live name index, for callers that memoize derived data keyed
   * on index identity (every mutation publishes a new `Map`, so a stale memo
   * can never match the live index).
   * @returns The current name-to-entry index.
   */
  public get nameIndex(): ReadonlyMap<string, TEntry> {
    return this.entriesByName;
  }

  /**
   * Returns the batch currently registered by one owner, if any.
   * @param owner - Extension to look up.
   * @returns The owner's current batch, or `undefined` when it has none.
   */
  public ownerBatch(owner: string): readonly TEntry[] | undefined {
    return this.entriesByOwner.get(owner);
  }

  /**
   * Validates a complete registration batch without mutating registry state.
   *
   * Checks, for every entry: the name is owned by `owner` (per this core's
   * ownership predicate), the name does not repeat within the batch, and the
   * name is not already owned by a different extension. A name already owned
   * by `owner` itself is allowed, so a batch may re-declare the owner's own
   * prior names.
   * @param owner - Extension contributing the batch.
   * @param entries - Candidate entries to validate.
   * @throws If a name is not owned by `owner`, duplicates another name in the
   *   same batch, or is already registered under a different owner.
   */
  public validateBatch(owner: string, entries: readonly TEntry[]): void {
    const pendingNames = new Set<string>();
    const ownedNames = new Set((this.entriesByOwner.get(owner) ?? []).map((entry) => this.nameOf(entry)));
    for (const entry of entries) {
      const name = this.nameOf(entry);
      if (!this.ownsName(owner, name)) {
        throw new TypeError(this.messages.namespaceViolation(owner, name));
      }
      if (pendingNames.has(name)) {
        throw new Error(this.messages.duplicateInBatch(owner, name));
      }
      if (this.entriesByName.has(name) && !ownedNames.has(name)) {
        throw new Error(this.messages.crossOwnerCollision(owner, name));
      }
      pendingNames.add(name);
    }
  }

  /**
   * Commits a batch that already passed {@link validateBatch} for the same
   * `owner` and `entries`, atomically replacing the owner's previous batch.
   *
   * An empty batch removes the owner's entries entirely. A no-op (no new Map
   * published) when the batch is empty and the owner had no prior entries,
   * which keeps {@link nameIndex} identity-stable for memoized consumers.
   * @param owner - Extension the batch belongs to.
   * @param entries - Validated entries to commit; empty removes the owner.
   */
  public commitBatch(owner: string, entries: readonly TEntry[]): void {
    const priorBatch = this.entriesByOwner.get(owner);
    if (entries.length === 0 && priorBatch === undefined) return;

    const nextByOwner = new Map(this.entriesByOwner);
    if (entries.length === 0) {
      nextByOwner.delete(owner);
    } else {
      nextByOwner.set(owner, entries);
    }
    this.entriesByOwner = nextByOwner;

    const nextByName = new Map(this.entriesByName);
    for (const priorEntry of priorBatch ?? []) {
      nextByName.delete(this.nameOf(priorEntry));
    }
    for (const entry of entries) {
      nextByName.set(this.nameOf(entry), entry);
    }
    this.entriesByName = nextByName;
  }

  /**
   * Removes every registered entry, from every owner.
   *
   * Assigns fresh `Map`s rather than clearing in place, preserving the
   * invariant that every mutation publishes a new `Map` and invalidates any
   * identity-keyed memo derived from {@link nameIndex}.
   */
  public clear(): void {
    this.entriesByOwner = new Map();
    this.entriesByName = new Map();
  }
}
