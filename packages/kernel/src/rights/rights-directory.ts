import { z } from 'zod';
import { ContributionNameSchema, localContributionName } from '@makaio/core';
import type { ContributionName, ExtensionName } from '@makaio/core';
import { compileJsonSchemaCheck, zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import type { JsonSchemaCheck } from '@makaio/contracts/shared';
import {
  RightDirectoryEntrySchema,
  SUBJECT_HANDLE_RIGHT,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  SubjectHandleRightContextSchema,
  SubjectSendRightContextSchema,
  SubjectSubscribeRightContextSchema,
} from '@makaio/contracts/rights';
import type {
  RightContribution,
  RightDirectoryEntry,
  RightFromData,
  RightName,
  RightsChanged,
  RightsChangedReason,
  RightsSourceContribution,
} from '@makaio/contracts/rights';
import { matchesAnySubscription } from '@makaio/bus-core';
import { deepFreeze } from '@makaio/utils';

/**
 * Owner prefix of the rights the core itself declares.
 */
export const CORE_RIGHTS_OWNER = 'makaio' satisfies ExtensionName;

/** One stored right, with the owner and origin the public projection drops. */
interface RightEntry {
  /** Extension that declared the right. */
  readonly owner: ExtensionName;
  /** Whether the right came from the extension's code or from data of its host. */
  readonly origin: 'static' | 'data';
  /** The right as declared. */
  readonly contribution: RightContribution;
  /** Compiled check of the right's context schema, compiled once during planning. */
  readonly contextCheck: JsonSchemaCheck;
}

/** One stored answer source, with the owner the public surface never returns. */
interface SourceEntry {
  /** Extension that registered the source. */
  readonly owner: ExtensionName;
  /** The source as registered. */
  readonly source: RightsSourceContribution;
}

/**
 * Directory of declared rights and their answer sources, kept as the sum of
 * the declarations of the active extensions.
 *
 * The directory knows no meaning of a right: it only tracks who declared it,
 * whether it came from code or from data, and which sources answer for it.
 *
 * **Parse, then check, then commit.** Declaring a right, a data right, or registering a
 * source first parses the contribution: a right or a data right (`right`, `description`,
 * `context`, `suggestedFor`) against the contract's {@link RightDirectoryEntrySchema} (see
 * {@link copyRightContribution}/{@link copyRightFromData}) — its `context` is
 * `JsonSchemaRecordSchema`, so a non-JSON value such as a `Date`, an `undefined` hole, or a
 * function anywhere inside it is rejected, never silently dropped or coerced; a source's data
 * fields (`source`, `rights`, `payloadIndependent`, `description`) against this file's own
 * {@link RightsSourceDataSchema} (see {@link copySourceContribution}), whose `rights` and
 * `payloadIndependent` are arrays of non-empty strings, so a sparse array or a non-string
 * pattern is rejected the same way. A parse failure throws a clear error naming the owner and
 * the right or source, before anything is checked or written. The parsed result — the Zod
 * parse's own fresh value, needing no further copy — is deep-frozen ({@link deepFreeze}); the
 * only thing kept from the extension's own object outside the parse is a source's `answer`
 * function, bound so it still runs with its original `this`. This parsed, frozen value is what
 * the directory stores and ever hands back — `list()`, a consumer's cache invalidation — so a
 * caller that mutates its own array or object after declaring does not change what the
 * directory holds, and a caller of {@link RightsDirectory.list} that mutates a nested value of
 * a returned entry finds the mutation rejected.
 *
 * Every mutating method parses its whole input first, then checks the parsed copies against
 * ownership, duplicate-name and origin rules (and compiles each right's context schema)
 * against the directory's current tables, then commits: nothing is written until the whole
 * batch has checked out, so {@link activate}'s batch of rights, data rights and sources commits
 * as one unit or not at all (a conflict anywhere in the batch leaves the directory unchanged).
 * {@link RightsDirectoryImpl.stageRights} and {@link RightsDirectoryImpl.stageSources} are the
 * one checking step each; `commitRights` and `commitSources` are the one committing step each.
 */
export interface RightsDirectory {
  /**
   * Declares static rights of an extension, in effect from its activation.
   * @param owner - Extension that declares the rights; must own every right name.
   * @param rights - The rights to declare.
   * @throws Error when a right name is not owned by `owner`, is already declared
   * by a different owner, or is already declared from data by the same owner.
   */
  declare(owner: ExtensionName, rights: readonly RightContribution[]): void;

  /**
   * Replaces the whole set of rights `owner` declares from data of its host.
   * @param owner - Extension that declares the rights; must own every right name.
   * @param rights - The complete new set of rights from data; replaces the previous one.
   * @throws Error when a right name is not owned by `owner`, is already declared
   * by a different owner, or is already declared statically by the same owner.
   */
  declareFromData(owner: ExtensionName, rights: readonly RightFromData[]): void;

  /**
   * Registers an answer source, in effect from registration.
   * @param owner - Extension that registers the source; must own the source name.
   * @param source - The answer source to register.
   * @throws Error when the source name is not owned by `owner` or a source of
   * the same name is already registered.
   */
  registerSource(owner: ExtensionName, source: RightsSourceContribution): void;

  /**
   * Reports that a registered source changed the content it answers from.
   * @param owner - Extension that owns the source.
   * @param source - Name of the source whose content changed.
   * @throws Error when `source` is not registered by `owner`.
   */
  sourceChanged(owner: ExtensionName, source: ContributionName): void;

  /**
   * Removes everything `owner` declared: its static rights, its rights from
   * data, and its answer sources. Called when the extension stops.
   * @param owner - Extension whose declarations are removed.
   */
  removeOwner(owner: ExtensionName): void;

  /**
   * Activates an extension's rights contribution as one unit: validates every right (static and from data) and source
   * first, throws on the first violation without mutating the directory or
   * notifying, then commits everything and notifies only for what was
   * actually committed.
   * @param owner - Extension that declares the rights and registers the sources; must own every name.
   * @param contribution - The static rights, the rights declared from data of the extension's host, and the answer
   * sources the extension's package declares.
   * @throws Error when any right or source fails the same checks {@link declare}, {@link declareFromData}, and
   * {@link registerSource} enforce, including a duplicate inside `contribution` itself, or the same right name
   * declared both statically and from data in the same activation.
   */
  activate(
    owner: ExtensionName,
    contribution: {
      rights: readonly RightContribution[];
      dataRights: readonly RightFromData[];
      sources: readonly RightsSourceContribution[];
    },
  ): void;

  /**
   * Validates a batch of rights declared from data without committing them, reusing the
   * exact checks {@link activate} performs on its `dataRights`. Lets a caller stage a
   * contribution before it is ready to activate.
   * @param owner - Extension that will declare the rights.
   * @param rights - The complete set of rights from data to validate.
   * @returns The directory's own frozen copies of `rights`, once every right in the batch
   * validated, in the same order; a caller that stages this result and activates later
   * reactivates it unchanged (the extension's own objects are never read again).
   * @throws Error when a right fails the same checks {@link declareFromData} enforces,
   * or two rights in the batch share a name.
   */
  planDataRights(owner: ExtensionName, rights: readonly RightFromData[]): readonly RightFromData[];

  /**
   * Validates a batch of answer sources without committing them, reusing the exact
   * checks {@link activate} performs on its `sources`. A caller staging sources one at a
   * time passes the complete set staged so far, including the one just added, so a
   * duplicate across calls is caught here and not only within one call.
   * @param owner - Extension that will register the sources.
   * @param sources - The complete set of sources staged so far.
   * @returns The directory's own frozen copies of `sources`, once every source in the batch
   * validated, in the same order; a caller that stages this result and activates later
   * reactivates it unchanged (the extension's own objects are never read again).
   * @throws Error when a source fails the same checks {@link registerSource} enforces,
   * or two sources in the batch share a name.
   */
  planAnswerSources(
    owner: ExtensionName,
    sources: readonly RightsSourceContribution[],
  ): readonly RightsSourceContribution[];

  /**
   * Validates one new answer source against an owner's already-staged sources, for a caller
   * staging sources one at a time (see {@link RightsHub}'s per-owner capability's
   * `registerRightsSource`, pending branch). Parses `source`, appends it to `currentlyStaged`,
   * and checks the combined list the same way {@link planAnswerSources} checks a whole batch.
   * @param owner - Extension that will register the sources.
   * @param source - The new source to parse and validate.
   * @param currentlyStaged - The owner's already-owned staged sources.
   * @returns The directory's own frozen copies of `currentlyStaged` plus `source`, in that
   * order; the same reactivate-unchanged guarantee {@link planAnswerSources} documents.
   * @throws Error when `source` fails the same checks {@link registerSource} enforces, or
   * shares a name with one already in `currentlyStaged`.
   */
  planAnswerSource(
    owner: ExtensionName,
    source: RightsSourceContribution,
    currentlyStaged: readonly RightsSourceContribution[],
  ): readonly RightsSourceContribution[];

  /**
   * Looks up the declared right.
   * @param right - Name of the right.
   * @returns The declaration, or `undefined` when no active extension declares it.
   */
  lookup(right: RightName): RightContribution | undefined;

  /**
   * Looks up the compiled context check of a declared right, compiled once
   * during the planning that admitted the right.
   * @param right - Name of the right.
   * @returns The compiled check, or `undefined` when no active extension declares the right.
   */
  contextCheckFor(right: RightName): JsonSchemaCheck | undefined;

  /**
   * Finds the answer sources whose pattern covers a right.
   * @param right - Name of the right.
   * @returns The matching sources, in registration order.
   */
  sourcesFor(right: RightName): readonly RightsSourceContribution[];

  /**
   * Lists every declared right as a plain projection, without its owner or origin.
   * @returns The declared rights, sorted by `right`.
   */
  list(): RightDirectoryEntry[];

  /**
   * Subscribes to every change of the directory.
   *
   * Called once per committed mutation, with every change that mutation produced, in
   * the order they happened (for example {@link activate} commits a `'declared'` change
   * and a `'source-registered'` change as one unit, and both are delivered together,
   * declared first). A mutation that produced no change at all (nothing to declare,
   * nothing to register) never calls the listener.
   *
   * A listener must not call back into the directory synchronously from here: the
   * directory is still mid-commit (this mutation's rights and sources are already
   * stored, but the call that triggered it has not returned yet). {@link createRightsHub}'s
   * own listener only invalidates its cache and queues the changes for later publication
   * here — it never mutates the directory or emits from inside this call.
   * @param listener - Called with every change of one committed mutation.
   * @returns Unsubscribe function.
   */
  onChanged(listener: (changes: readonly RightsChanged[]) => void): () => void;
}

/** Empty exclusion set for {@link RightsDirectoryImpl.planInsert}, used where nothing is being replaced. */
const NO_EXCLUDED_RIGHTS: ReadonlySet<RightName> = new Set();

/**
 * Sorts and deduplicates a collection of right or pattern names for a {@link RightsChanged} announcement.
 * @param names - Names to normalize.
 * @returns The names, deduplicated and sorted ascending.
 */
function sortedUniqueNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

/**
 * Validates the plain data fields of an answer source — everything except `answer`, which is
 * bound separately and never passes through a schema (see {@link copySourceContribution}).
 * `rights` and `payloadIndependent` are arrays of non-empty strings: a sparse array (a hole
 * parses as `undefined`, which `z.string()` rejects) or a non-string pattern fails to parse,
 * before any write.
 */
const RightsSourceDataSchema = z
  .object({
    /** Name of the answer source, owned by the contributing extension. */
    source: ContributionNameSchema,
    /** What the source decides, for people. */
    description: z.string(),
    /** Patterns over names of rights the source answers for. */
    rights: z.array(z.string().min(1)),
    /** Patterns whose answer does not depend on the payload in the context. */
    payloadIndependent: z.array(z.string().min(1)).optional(),
    requiresPayload: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Parses and deep-freezes a static right's data fields against the contract's
 * {@link RightDirectoryEntrySchema} — its `context` is `JsonSchemaRecordSchema`, so a
 * non-JSON value (a `Date`, an `undefined` hole, a function) anywhere inside it fails to
 * parse. The parse's own result, already a fresh value, is what is frozen ({@link deepFreeze})
 * and stored; nothing downstream of a commit ever sees the original contribution.
 * @param owner - Extension that declares the right; named in the error when parsing fails.
 * @param contribution - The right as authored by the extension.
 * @returns A frozen, parsed copy owned by the directory, structurally a {@link RightContribution}.
 * @throws Error when `contribution` fails to parse against {@link RightDirectoryEntrySchema}.
 */
function copyRightContribution(owner: ExtensionName, contribution: RightContribution): RightContribution {
  const parsed = RightDirectoryEntrySchema.safeParse(contribution);
  if (!parsed.success) {
    throw new Error(`Extension '${owner}' declares right '${contribution.right}' with data that failed to parse`, {
      cause: parsed.error,
    });
  }
  return deepFreeze(parsed.data);
}

/**
 * Parses and deep-freezes a right-from-data's data fields, the same way
 * {@link copyRightContribution} does for a static right, minus `suggestedFor` (a right from
 * data never carries one; see {@link RightFromData}).
 * @param owner - Extension that declares the right from data; named in the error when parsing fails.
 * @param contribution - The right as authored by the extension's host data.
 * @returns A frozen, parsed copy owned by the directory, structurally a {@link RightFromData}.
 * @throws Error when `contribution` fails to parse against {@link RightDirectoryEntrySchema}.
 */
function copyRightFromData(owner: ExtensionName, contribution: RightFromData): RightFromData {
  const parsed = RightDirectoryEntrySchema.safeParse(contribution);
  if (!parsed.success) {
    throw new Error(`Extension '${owner}' declares right '${contribution.right}' from data that failed to parse`, {
      cause: parsed.error,
    });
  }
  const { right, description, context } = parsed.data;
  return deepFreeze({ right, description, context });
}

/**
 * Parses and deep-freezes an answer source's data fields against this file's own
 * {@link RightsSourceDataSchema}; the only thing kept from the extension's own object outside
 * the parse is its `answer` function, bound so it still runs with its original `this` —
 * freezing the copy does not freeze (or otherwise affect) the function itself, only the
 * container holding it. Nothing downstream of a commit ever sees the original contribution.
 * @param owner - Extension that registers the source; named in the error when parsing fails.
 * @param source - The answer source as registered.
 * @returns A frozen, parsed copy owned by the directory, structurally a {@link RightsSourceContribution}.
 * @throws Error when `source`'s data fields fail to parse against {@link RightsSourceDataSchema}.
 */
function copySourceContribution(owner: ExtensionName, source: RightsSourceContribution): RightsSourceContribution {
  const { source: name, description, rights, payloadIndependent, requiresPayload, answer } = source;
  const parsed = RightsSourceDataSchema.safeParse({
    source: name,
    description,
    rights,
    payloadIndependent,
    requiresPayload,
  });
  if (!parsed.success) {
    throw new Error(`Extension '${owner}' registers answer source '${name}' with data that failed to parse`, {
      cause: parsed.error,
    });
  }
  return deepFreeze({ ...parsed.data, answer: answer.bind(source) });
}

/**
 * Implementation of {@link RightsDirectory}: one table per concept, so
 * static and data rights share the same insertion path and sources are kept
 * independently of the rights they cover.
 */
class RightsDirectoryImpl implements RightsDirectory {
  private readonly rights = new Map<RightName, RightEntry>();
  private readonly sources = new Map<ContributionName, SourceEntry>();
  /**
   * One monotonic revision counter for the whole directory, shared by every owner: only ever
   * increases, bumped once per change actually produced by any owner's mutation (see
   * {@link buildChanges}), and never reset — removing an owner ({@link removeOwner}) must not
   * make a later revision of its re-declaration collide with one already observed before removal.
   */
  private revision = 0;
  private readonly listeners = new Set<(changes: readonly RightsChanged[]) => void>();

  public declare(owner: ExtensionName, rights: readonly RightContribution[]): void {
    const copies = rights.map((contribution) => copyRightContribution(owner, contribution));
    const staged = this.stageRights(owner, 'static', copies, NO_EXCLUDED_RIGHTS);
    this.commitRights(staged);
    this.notifyAll(this.buildChanges(owner, [[sortedUniqueNames(staged.keys()), 'declared']]));
  }

  public declareFromData(owner: ExtensionName, rights: readonly RightFromData[]): void {
    const copies = rights.map((contribution) => copyRightFromData(owner, contribution));
    const previousData = new Set<RightName>();
    for (const [name, entry] of this.rights) {
      if (entry.owner === owner && entry.origin === 'data') previousData.add(name);
    }
    const staged = this.stageRights(owner, 'data', copies, previousData);
    for (const name of previousData) this.rights.delete(name);
    this.commitRights(staged);
    this.notifyAll(this.buildChanges(owner, [[sortedUniqueNames([...previousData, ...staged.keys()]), 'declared']]));
  }

  public registerSource(owner: ExtensionName, source: RightsSourceContribution): void {
    const copies = [copySourceContribution(owner, source)];
    const staged = this.stageSources(owner, copies);
    this.commitSources(staged);
    const rights = sortedUniqueNames([...staged.values()].flatMap((entry) => entry.source.rights));
    this.notifyAll(this.buildChanges(owner, [[rights, 'source-registered']]));
  }

  public activate(
    owner: ExtensionName,
    contribution: {
      rights: readonly RightContribution[];
      dataRights: readonly RightFromData[];
      sources: readonly RightsSourceContribution[];
    },
  ): void {
    const { rights, dataRights, sources } = contribution;
    // Parse every input of the whole activation — static rights, data rights, and sources
    // together — before any of them is checked, then check everything against the live tables,
    // then commit: a violation anywhere throws before anything is committed, so the activation
    // is all-or-nothing.
    const rightCopies = rights.map((contribution) => copyRightContribution(owner, contribution));
    const dataRightCopies = dataRights.map((contribution) => copyRightFromData(owner, contribution));
    const sourceCopies = sources.map((entry) => copySourceContribution(owner, entry));

    const stagedRights = this.stageRights(owner, 'static', rightCopies, NO_EXCLUDED_RIGHTS);
    const stagedDataRights = this.stageRights(owner, 'data', dataRightCopies, NO_EXCLUDED_RIGHTS);
    for (const name of stagedDataRights.keys()) {
      if (stagedRights.has(name)) {
        throw new Error(
          `Right '${name}' is declared both statically and from data by extension '${owner}' in the same activation`,
        );
      }
    }
    const stagedSources = this.stageSources(owner, sourceCopies);

    this.commitRights(stagedRights);
    this.commitRights(stagedDataRights);
    this.commitSources(stagedSources);
    const declaredNames = sortedUniqueNames([...stagedRights.keys(), ...stagedDataRights.keys()]);
    const registeredSourceNames = sortedUniqueNames(
      [...stagedSources.values()].flatMap((entry) => entry.source.rights),
    );
    this.notifyAll(
      this.buildChanges(owner, [
        [declaredNames, 'declared'],
        [registeredSourceNames, 'source-registered'],
      ]),
    );
  }

  public planDataRights(owner: ExtensionName, rights: readonly RightFromData[]): readonly RightFromData[] {
    const copies = rights.map((contribution) => copyRightFromData(owner, contribution));
    this.stageRights(owner, 'data', copies, NO_EXCLUDED_RIGHTS); // nothing to commit
    return copies;
  }

  public planAnswerSources(
    owner: ExtensionName,
    sources: readonly RightsSourceContribution[],
  ): readonly RightsSourceContribution[] {
    const copies = sources.map((entry) => copySourceContribution(owner, entry));
    this.stageSources(owner, copies); // nothing to commit
    return copies;
  }

  public planAnswerSource(
    owner: ExtensionName,
    source: RightsSourceContribution,
    currentlyStaged: readonly RightsSourceContribution[],
  ): readonly RightsSourceContribution[] {
    const copy = copySourceContribution(owner, source);
    const combined = [...currentlyStaged, copy];
    this.stageSources(owner, combined); // nothing to commit
    return combined;
  }

  public sourceChanged(owner: ExtensionName, source: ContributionName): void {
    const entry = this.sources.get(source);
    if (entry === undefined || entry.owner !== owner) {
      throw new Error(`Answer source '${source}' is not registered by extension '${owner}'`);
    }
    this.notifyAll(this.buildChanges(owner, [[sortedUniqueNames(entry.source.rights), 'source-changed']]));
  }

  public removeOwner(owner: ExtensionName): void {
    // Affected are the owner's own rights and every declared right one of its
    // removed sources answered for: those answers change once the source is gone.
    const affected: RightName[] = [];
    for (const [name, entry] of this.sources) {
      if (entry.owner !== owner) continue;
      for (const right of this.rights.keys()) {
        if (matchesAnySubscription(right, entry.source.rights)) affected.push(right);
      }
      this.sources.delete(name);
    }
    for (const [name, entry] of this.rights) {
      if (entry.owner === owner) {
        affected.push(name);
        this.rights.delete(name);
      }
    }
    this.notifyAll(this.buildChanges(owner, [[sortedUniqueNames(affected), 'declared']]));
  }

  public lookup(right: RightName): RightContribution | undefined {
    return this.rights.get(right)?.contribution;
  }

  public contextCheckFor(right: RightName): JsonSchemaCheck | undefined {
    return this.rights.get(right)?.contextCheck;
  }

  public sourcesFor(right: RightName): readonly RightsSourceContribution[] {
    const matching: RightsSourceContribution[] = [];
    for (const { source } of this.sources.values()) {
      if (matchesAnySubscription(right, source.rights)) matching.push(source);
    }
    return matching;
  }

  public list(): RightDirectoryEntry[] {
    const entries: RightDirectoryEntry[] = [...this.rights.entries()].map(([right, { contribution }]) => ({
      right,
      description: contribution.description,
      context: contribution.context,
      ...(contribution.suggestedFor === undefined ? {} : { suggestedFor: [...contribution.suggestedFor] }),
    }));
    return entries.sort((left, right) => (left.right < right.right ? -1 : left.right > right.right ? 1 : 0));
  }

  public onChanged(listener: (changes: readonly RightsChanged[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Validates one already-parsed right before it is stored, without mutating the table.
   * @param owner - Extension that declares the right.
   * @param origin - Whether this declaration is static or from data.
   * @param contribution - The directory's own copy of the right to validate.
   * @param ignore - Right names of the owner's own prior declaration of this
   * origin, excluded from the "already declared" checks because they are
   * about to be replaced by this same call.
   * @returns The name and entry to store once every right of the batch validated.
   * @throws Error when the ownership or origin rule is violated, or when the right's context schema fails to compile.
   */
  private planInsert(
    owner: ExtensionName,
    origin: 'static' | 'data',
    contribution: RightContribution,
    ignore: ReadonlySet<RightName>,
  ): readonly [RightName, RightEntry] {
    if (localContributionName(owner, contribution.right) === undefined) {
      throw new Error(`Right '${contribution.right}' is not owned by extension '${owner}'`);
    }
    const existing = ignore.has(contribution.right) ? undefined : this.rights.get(contribution.right);
    if (existing !== undefined && existing.owner !== owner) {
      throw new Error(`Right '${contribution.right}' is already declared by extension '${existing.owner}'`);
    }
    if (existing !== undefined && existing.origin !== origin) {
      throw new Error(`Extension '${owner}' declares right '${contribution.right}' both statically and from data`);
    }
    // Compiled from the parsed copy, not from the extension's own object.
    let contextCheck: JsonSchemaCheck;
    try {
      contextCheck = compileJsonSchemaCheck(contribution.context);
    } catch (cause) {
      throw new Error(
        `Right '${contribution.right}' of extension '${owner}' has a context schema that failed to compile`,
        { cause },
      );
    }
    return [contribution.right, { owner, origin, contribution, contextCheck }];
  }

  /**
   * Checks a batch of already-parsed rights with {@link planInsert}, including a check that
   * no two rights of the batch itself share a name — the one place {@link declare},
   * {@link declareFromData}, {@link activate}, and {@link planDataRights} share for this check.
   * @param owner - Extension that declares the rights.
   * @param origin - Whether this declaration is static or from data.
   * @param copies - The directory's own copies of the rights to validate.
   * @param ignore - Right names excluded from the "already declared" checks, see {@link planInsert}.
   * @returns The validated rights, keyed by name, in batch order; the directory's own copies.
   * @throws Error when {@link planInsert} throws, or when the batch declares a right name twice.
   */
  private stageRights(
    owner: ExtensionName,
    origin: 'static' | 'data',
    copies: readonly RightContribution[],
    ignore: ReadonlySet<RightName>,
  ): Map<RightName, RightEntry> {
    const staged = new Map<RightName, RightEntry>();
    for (const contribution of copies) {
      if (staged.has(contribution.right)) {
        throw new Error(
          `Right '${contribution.right}' is declared more than once by extension '${owner}' in the same call`,
        );
      }
      const [name, entry] = this.planInsert(owner, origin, contribution, ignore);
      staged.set(name, entry);
    }
    return staged;
  }

  /**
   * Commits a batch of rights {@link RightsDirectoryImpl.stageRights} already validated.
   * @param staged - The validated rights, keyed by name.
   */
  private commitRights(staged: ReadonlyMap<RightName, RightEntry>): void {
    for (const [name, entry] of staged) this.rights.set(name, entry);
  }

  /**
   * Validates one already-parsed answer source before it is stored, without mutating the
   * table.
   * @param owner - Extension that registers the source.
   * @param source - The directory's own copy of the source to validate.
   * @returns The name and entry to store once the source validated.
   * @throws Error when the source name is not owned by `owner` or a source of the same name is already registered.
   */
  private planSource(owner: ExtensionName, source: RightsSourceContribution): readonly [ContributionName, SourceEntry] {
    if (localContributionName(owner, source.source) === undefined) {
      throw new Error(`Answer source '${source.source}' is not owned by extension '${owner}'`);
    }
    if (this.sources.has(source.source)) {
      throw new Error(`Answer source '${source.source}' is already registered`);
    }
    return [source.source, { owner, source }];
  }

  /**
   * Checks a batch of already-parsed answer sources with {@link planSource}, including a
   * check that no two sources of the batch itself share a name — the one place
   * {@link registerSource}, {@link activate}, and {@link planAnswerSources} share for this
   * check.
   * @param owner - Extension that registers the sources.
   * @param copies - The directory's own copies of the sources to validate.
   * @returns The validated sources, keyed by name, in batch order; the directory's own copies.
   * @throws Error when {@link planSource} throws, or when the batch registers a source name twice.
   */
  private stageSources(
    owner: ExtensionName,
    copies: readonly RightsSourceContribution[],
  ): Map<ContributionName, SourceEntry> {
    const staged = new Map<ContributionName, SourceEntry>();
    for (const source of copies) {
      if (staged.has(source.source)) {
        throw new Error(
          `Answer source '${source.source}' is registered more than once by extension '${owner}' in the same call`,
        );
      }
      const [name, entry] = this.planSource(owner, source);
      staged.set(name, entry);
    }
    return staged;
  }

  /**
   * Commits a batch of answer sources {@link RightsDirectoryImpl.stageSources} already validated.
   * @param staged - The validated sources, keyed by name.
   */
  private commitSources(staged: ReadonlyMap<ContributionName, SourceEntry>): void {
    for (const [name, entry] of staged) this.sources.set(name, entry);
  }

  /**
   * Builds the changes of one committed mutation, bumping the directory's one shared revision
   * counter once per change actually produced. An entry whose `rights` is empty produced no
   * change (nothing was declared or registered) and is dropped, so a mutation that affected
   * nothing yields an empty list.
   * @param owner - Extension whose declaration changed.
   * @param entries - One entry per kind of change the mutation may produce, in the order
   * they should be delivered; `rights` already sorted and deduplicated.
   * @returns The changes to deliver together, in `entries` order.
   */
  private buildChanges(
    owner: ExtensionName,
    entries: ReadonlyArray<readonly [rights: readonly string[], reason: RightsChangedReason]>,
  ): RightsChanged[] {
    const changes: RightsChanged[] = [];
    for (const [rights, reason] of entries) {
      if (rights.length === 0) continue;
      this.revision += 1;
      changes.push({ owner, revision: this.revision, rights: [...rights], reason });
    }
    return changes;
  }

  /**
   * Notifies every listener once with the changes of one committed mutation.
   * @param changes - The changes {@link buildChanges} produced; a call is skipped entirely
   * when this is empty, so a mutation that changed nothing never reaches a listener.
   */
  private notifyAll(changes: readonly RightsChanged[]): void {
    if (changes.length === 0) return;
    for (const listener of this.listeners) listener(changes);
  }
}

/**
 * Builds the right contribution of a core right from its context schema.
 * @param right - Name of the core right.
 * @param description - What the right allows, for people.
 * @param contextSchema - Zod schema of the question context.
 * @returns The contribution, ready to go through the same `declare` path as an extension's.
 */
function coreRightContribution(right: RightName, description: string, contextSchema: z.ZodType): RightContribution {
  return { right, description, context: zodSchemaToJsonRecord(contextSchema) };
}

/**
 * Builds the core subject rights under {@link CORE_RIGHTS_OWNER}.
 *
 * Declared by the rights hub through its own announcement path, after it attached its directory
 * change handler to the empty directory {@link createRightsDirectory} returns.
 * @returns The core right contributions, ready to go through `declare` like an extension's.
 */
export function coreRightContributions(): RightContribution[] {
  return [
    coreRightContribution(SUBJECT_SEND_RIGHT, 'Send a subject on the bus.', SubjectSendRightContextSchema),
    coreRightContribution(
      SUBJECT_SUBSCRIBE_RIGHT,
      'Subscribe to or receive an event on the bus.',
      SubjectSubscribeRightContextSchema,
    ),
    coreRightContribution(
      SUBJECT_HANDLE_RIGHT,
      'Advertise a request handler or receive a request to handle on the bus.',
      SubjectHandleRightContextSchema,
    ),
  ];
}

/**
 * Creates a rights directory with nothing declared yet, not even the core's own rights: the
 * rights hub declares those through its own announcement path (see {@link coreRightContributions}).
 * @returns The directory, empty.
 */
export function createRightsDirectory(): RightsDirectory {
  return new RightsDirectoryImpl();
}
