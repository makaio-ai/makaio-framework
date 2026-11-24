import type { IMakaioBus } from '@makaio/bus-core';
import { matchesAnySubscription } from '@makaio/bus-core';
import { assertCallCarrier, busContextOf } from '@makaio/bus-core/kernel-api';
import type { CallContext, ContributionName, ExtensionName, PartyRef } from '@makaio/core';
import { CoreDenialPlace, HostOnlyRightsError } from '@makaio/contracts/access';
import type { AccessDeniedError, DenialPlace } from '@makaio/contracts/access';
import { createRefusingRightsCapability, RightsResolveRequestSchema, RightsSubjects } from '@makaio/contracts/rights';
import type { JsonValue } from '@makaio/contracts/shared';
import type {
  HandlerContext,
  RightAnswer,
  RightDirectoryEntry,
  RightFromData,
  RightName,
  RightQuestion,
  RightsCapability,
  RightsChanged,
  RightsSourceContribution,
} from '@makaio/contracts/rights';
import type { KernelMakaioExtension } from '../extension/types.js';
import { createDenialEmitter, deny } from './deny.js';
import type { Denial, DenialEmitter } from './deny.js';
import { createRightsCache } from './rights-cache.js';
import { CORE_RIGHTS_OWNER, coreRightContributions, createRightsDirectory } from './rights-directory.js';
import type { RightsDirectory } from './rights-directory.js';
import { resolveRight } from './resolve-right.js';
import type { ResolveRightOptions } from './resolve-right.js';

/** Options of {@link createRightsHub}. */
export interface RightsHubOptions {
  /** Bus the hub mints its own emission contexts from and sends its announcements on. */
  readonly bus: IMakaioBus;
}

/**
 * The one resolution place of the host process:
 * resolves rights, builds and announces denials, binds a per-extension
 * capability, and processes the `rights`/`rightsSources` contribution fields
 * during extension activation.
 */
export interface RightsHub {
  /**
   * Resolves a right for a call context. The one place that resolves a right;
   * see {@link resolveRight}.
   * @param question - The right and context the question is about, with the asking party's call context.
   * @param options - `connection` folds the connection the question travels on into the cache key.
   * @returns The combined answer.
   */
  resolve(question: RightQuestion, options?: ResolveRightOptions): Promise<RightAnswer>;

  /**
   * Builds and announces one denial (see {@link deny}); the caller decides whether to throw the result.
   * @param place - The place where the denial arose.
   * @param denial - What is known of the denial; see {@link Denial}.
   * @returns The error the denied caller gets.
   */
  deny(place: DenialPlace, denial: Denial): AccessDeniedError;

  /**
   * Binds a {@link RightsCapability} to one extension; the extension never
   * names itself as the owner of a declaration or source, this binds it.
   *
   * The owner moves through one small lifecycle (`pending` -\> `activating` -\> `active`
   * -\> `closed`; see {@link OwnerLifecycle}): each activation attempt begins with
   * {@link beginActivation}, which starts the owner at a fresh `pending` record; while
   * `pending`, a declaration or a source the capability reports is validated
   * immediately but only staged, so nothing becomes visible to a right question
   * before the owner activates; {@link activate} throws immediately, before touching the
   * owner's record, for an owner that is bound and not `pending` (`activating`, `active`,
   * or `closed` all throw: there is no running `pending` attempt for it to commit) — then
   * holds the owner `activating` for the exact duration of its directory commit — while
   * `activating`, `declareRightsFromData`, `registerRightsSource`, and `sourceChanged`
   * throw (a reentrant mutation reached from inside that very commit, for example a
   * context schema getter evaluated while compiling, is a bug), and {@link deactivate} of
   * the same, still-`activating` owner throws too (closing it mid-commit, only for the
   * commit to finish and revive it, would resurrect a closed owner), but `resolve` still
   * works — then switches the owner to
   * `active`, where the capability applies every call directly, as it always did, and
   * publishes the commit's announcements only once `activate` returns (see
   * {@link createRightsHub}'s invariant); {@link deactivate} switches the owner to
   * `closed`, where every capability method throws. Calling this again for an owner that
   * is not yet
   * `closed` returns a capability bound to that same, still-live lifecycle (so the
   * context rebuilt for each contribution processor during one activation keeps
   * seeing what an earlier context staged). A capability requested after closing
   * also points at that closed record. Only `beginActivation` opens a new attempt.
   * @param owner - Extension the capability acts as the owner for.
   * @param carrier - Extension's own carrier; every `resolve` call checks that
   * `ask`'s call context may be used by this carrier before resolving.
   * @returns The capability, reachable only through the extension context.
   */
  capabilityFor(owner: ExtensionName, carrier: PartyRef): RightsCapability;

  /**
   * Starts a fresh activation attempt for an owner: replaces its record with a new
   * `pending` one, dropping anything an earlier attempt staged and making every
   * capability bound to that earlier record stale (its methods throw via the
   * existing `live()` identity check, same as a `closed` owner). Called exactly
   * once per activation attempt, at the moment the entry enters `initializing`,
   * before any extension context of that attempt is built — so a failed attempt
   * (a throw in `create`/`init`, a failing contribution processor, a storage
   * failure, or a cancelled start) can never leave a source staged for a later
   * attempt of the same owner to commit, and a late async task still holding the
   * failed attempt's capability can no longer stage into the live record.
   * @param owner - Extension beginning a new activation attempt.
   * @throws Error when the owner's current record is `active`: an activation
   * cannot begin for an owner that is already active, since there is no running
   * attempt to end first; this is a coordinator bug, not a recoverable state.
   */
  beginActivation(owner: ExtensionName): void;

  /**
   * Commits an activated extension's `rights` and `rightsSources` contribution
   * fields, together with whatever its {@link capabilityFor} capability staged
   * while `pending`, into the directory, and switches the owner to `active`.
   * The runner calls this as the last step of an activation — after every
   * contribution processor has run — so it applies whether or not the
   * package's manifest declares `rights` or `rightsSources`, because a
   * capability can stage a contribution purely through `declareRightsFromData`
   * or `registerRightsSource` during `create`/`init`.
   * @param owner - Extension that just activated.
   * @param pkg - The extension's `rights` and `rightsSources` contribution fields; a
   *   full {@link KernelMakaioExtension} manifest satisfies this, since only these two
   *   fields are read.
   *
   * Enforced before anything of the owner's record is touched: a bound owner whose state is
   * not `pending` makes this call throw immediately (see {@link OwnerLifecycle}'s table) —
   * there is no running `pending` attempt for it to commit. An unbound owner activates as a
   * fresh `pending` one, same as calling {@link beginActivation} first.
   *
   * The staged data rights and sources are taken out of the owner's record — with the
   * staged arrays emptied — and the record held `activating` for the exact duration of
   * `directory.activate`: while `activating`, the capability's `declareRightsFromData`,
   * `registerRightsSource`, and `sourceChanged` throw, so a reentrant mutation reached
   * from inside the commit itself (for example a context schema getter evaluated while a
   * right's schema compiles) can neither stage into the already-emptied arrays a second
   * time nor commit straight to a directory that has not finished committing; `resolve`
   * still works throughout. On success the record switches to `active`; the commit's
   * announcements are published only once this call returns (see {@link createRightsHub}'s
   * invariant), so a listener of them already finds the owner `active` — its
   * {@link capabilityFor} capability then applies `registerRightsSource`/
   * `declareRightsFromData` straight to the directory, the same path every other `active`
   * owner uses. When `directory.activate` throws, the owner is restored to `pending` with
   * the taken arrays put back, exactly as before the attempt, and nothing was committed,
   * so nothing is announced.
   * @throws Error when the owner is bound and its state is not `pending` (see above).
   *   Also throws when a right or source violates the directory's ownership
   *   rules: the directory validates everything first and throws on the first
   *   violation without mutating itself or notifying, so the owner's record
   *   stays `pending` with its staged contribution intact and the activation
   *   this is the last step of rolls back. Also throws when a reentrant call reaches
   *   the owner's own capability while it is still `activating`.
   * @returns `true` when `pkg.rights` or `pkg.rightsSources` was non-empty but this hub
   *   discarded it instead of committing it (only ever `true` for the refused composition's
   *   hub, see {@link createRefusedRightsHub}: this hub's own `activate` always commits what
   *   it is given, so it always returns `false`). The caller uses this to make an otherwise
   *   silent discard visible (see `contribution-processor-runner.ts`).
   */
  activate(owner: ExtensionName, pkg: Pick<KernelMakaioExtension, 'rights' | 'rightsSources'>): boolean;

  /**
   * Switches an owner to `closed`, where every capability bound to it throws, before
   * removing its committed `rights` and `rightsSources` contribution from the directory.
   * Closing first means a listener of the directory's removal announcement (including a
   * listener that still holds the owner's old capability) can never add anything through
   * it: the capability already throws by the time the announcement goes out — which,
   * like every other mutating entry point, is published only once this call returns (see
   * {@link createRightsHub}'s invariant), never from inside the directory's own commit.
   * The runner calls this as the first step of a stop, mirroring {@link activate} being
   * the last step of an activation.
   *
   * Enforced before anything of the owner's record is touched: an owner that is
   * `activating` makes this call throw instead, rather than closing an owner whose own
   * `activate` commit, already in progress, would otherwise finish moments later and
   * switch it to `active` again — reviving what this call was supposed to have closed for
   * good (see {@link OwnerLifecycle}'s table).
   * @param owner - Extension being stopped.
   * @throws Error when the owner's current record is `activating`.
   */
  deactivate(owner: ExtensionName): void;

  /**
   * Lists the declared rights, delegating to the directory.
   * @returns The declared rights, sorted by `right`.
   */
  list(): RightDirectoryEntry[];

  /**
   * Check the owner's committed contribution lifetime.
   * @param owner - Extension whose subjects are being considered.
   * @returns Whether the extension's rights activation is committed.
   */
  isOwnerActive(owner: ExtensionName): boolean;
}

/**
 * Expands a {@link RightsChanged} announcement into the literal right names
 * the cache must drop.
 *
 * `RightsDirectory.sourcesFor` matches a source's `rights` as patterns
 * (`matchesAnySubscription`, reused from `@makaio/bus-core`), not as literal
 * right names (see `rights-directory.ts`'s `sourcesFor`). A `'declared'`
 * change already names the affected rights literally (the directory's
 * `declare`/`declareFromData` notify with `right` values straight off the
 * contributions). A `'source-registered'` or `'source-changed'` change
 * instead carries the source's own patterns, so every right the directory
 * currently has declared that those patterns cover must be invalidated too —
 * otherwise a cached answer for a right the changed source now covers (or no
 * longer covers) would survive the change.
 * @param directory - Directory the currently declared rights are read from.
 * @param change - The announcement to expand.
 * @returns The literal right names to invalidate in the cache.
 */
function invalidatedRightsOf(directory: RightsDirectory, change: RightsChanged): readonly RightName[] {
  if (change.reason === 'declared') return change.rights;
  const declared = directory.list().map((entry) => entry.right);
  return declared.filter((right) => matchesAnySubscription(right, change.rights));
}

/**
 * The one small lifecycle an owner's rights contribution moves through, tracked by
 * one `state` field on {@link OwnerRecord} (one state table, not a flag per transition):
 *
 * | State        | Entered by                                        | `declareRightsFromData` / `registerRightsSource` / `sourceChanged` | `resolve` | `beginActivation` | `activate` | `deactivate` |
 * |--------------|----------------------------------------------------|----------------------------------------------------------------------|-----------|--------------------|------------|--------------|
 * | `pending`    | {@link RightsHub.beginActivation}                  | validated immediately, but only staged (invisible to a question)     | works     | starts a fresh one | runs       | runs         |
 * | `activating` | {@link RightsHub.activate}, for its own commit only | throws: a reentrant mutation from inside that very commit is a bug   | works     | n/a (bug)          | n/a (bug)  | throws       |
 * | `active`     | `activate` committing successfully                 | applied straight to the directory                                    | works     | throws             | throws     | runs         |
 * | `closed`     | {@link RightsHub.deactivate}                       | throws                                                                | throws    | starts a fresh one | throws     | throws       |
 *
 * `activating` lasts only for the duration of `directory.activate` inside `activate`: on
 * success the owner moves to `active`; on a thrown validation it moves back to `pending`
 * with its staged contribution restored, exactly as before the attempt. `activate` and
 * `deactivate` are the two entry points that enforce this table against an owner's own
 * state, both checked before either touches the owner's record: {@link RightsHub.activate}
 * throws for a bound owner whose state is not `pending` (an unbound owner activates as a
 * fresh `pending` one, same as today), and {@link RightsHub.deactivate} throws for an owner
 * that is `activating` — the one transition a reentrant mutation could otherwise reach from
 * inside the owner's own `activate` commit, closing it only for that same commit to finish
 * and revive it to `active`, resurrecting what `deactivate` was supposed to have closed.
 */
type OwnerLifecycle = 'pending' | 'activating' | 'active' | 'closed';

/**
 * Per-owner record backing every {@link RightsCapability} `capabilityFor` hands out
 * for that owner. The same record is shared by every capability bound to one
 * continuous lifecycle — the context built for the owner's `create`/`init`, and the
 * context rebuilt for each contribution processor during the same activation, all
 * resolve to this one record — so staging survives being asked for again before
 * activation. A fresh record replaces it only once the previous one reached
 * `'closed'`, or once {@link RightsHub.beginActivation} starts a new attempt, both
 * genuine rebinds that make every capability bound to the previous record stale.
 */
interface OwnerRecord {
  state: OwnerLifecycle;
  /** Rights from data staged by `declareRightsFromData` while `pending`; replaced whole on each call, like `declareFromData` itself. */
  dataRights: readonly RightFromData[];
  /** Answer sources staged by `registerRightsSource` while `pending`; appended one at a time. */
  sources: readonly RightsSourceContribution[];
}

/**
 * Builds a fresh `pending` {@link OwnerRecord} with nothing staged yet.
 * @returns A new, empty `pending` record.
 */
function freshPendingRecord(): OwnerRecord {
  return { state: 'pending', dataRights: [], sources: [] };
}

/**
 * Builds the error every capability method of a `closed` or stale owner throws.
 * @param owner - Extension whose capability is being used.
 * @returns The error, naming the extension.
 */
function closedOwnerError(owner: ExtensionName): Error {
  return new Error(`Extension "${owner}" has stopped; its rights capability can no longer be used.`);
}

/**
 * Builds the error the capability's `declareRightsFromData`, `registerRightsSource`, and
 * `sourceChanged` throw for an owner currently `activating`: reaching back into the
 * directory from inside the very commit that is putting the owner's own contribution into
 * it — for example a context schema getter evaluated while a right's schema compiles, or a
 * listener that ran before `activate` even returned — is a reentrancy bug, not a
 * recoverable state.
 * @param owner - Extension whose capability is being used.
 * @returns The error, naming the extension.
 */
function reentrantActivationError(owner: ExtensionName): Error {
  return new Error(
    `Extension "${owner}" is activating; its rights capability cannot declare, register, or report a source change until activation finishes.`,
  );
}

/**
 * The announcement scheduler one rights hub instance owns: queues the batches of
 * {@link RightsChanged} changes committed by the directory, in commit order, and decides when
 * it is safe to publish them. See {@link createRightsHub}'s own doc comment for the reentrancy
 * invariant this defends (nested mutations only ever publish once the outermost one returns,
 * and only one drain loop ever runs at a time).
 */
interface AnnouncementScheduler {
  /**
   * Queues one committed mutation's changes for publication, in the order the directory's
   * `onChanged` listener delivered them.
   * @param changes - The batch to queue.
   */
  enqueue(changes: readonly RightsChanged[]): void;
  /**
   * Wraps one mutating hub entry point so whatever it queues is only published once every
   * nested entry point on the call stack has returned and no drain is already running; see
   * {@link createRightsHub}'s doc comment for the full invariant.
   * @param fn - The mutating operation to run.
   * @returns Whatever `fn` returns.
   */
  withAnnouncements<T>(fn: () => T): T;
}

/**
 * Builds the announcement scheduler for one rights hub instance, carrying every reentrancy
 * guarantee described in {@link createRightsHub}'s own doc comment.
 * @param bus - Bus every queued change is eventually emitted on, each with a fresh
 *   `bus.own('observer')` context.
 * @returns The scheduler.
 */
function createAnnouncementScheduler(bus: IMakaioBus): AnnouncementScheduler {
  // Batches awaiting publication, in commit order; each entry is one committed mutation's
  // changes, in the order `directory.onChanged` delivered them. Only `drainAnnouncements`
  // reads or removes from this queue, and only `withAnnouncements` calls it.
  const announcementQueue: Array<readonly RightsChanged[]> = [];
  // Depth of mutating entry points currently nested on the call stack; see `withAnnouncements`.
  let depth = 0;
  // Whether `drainAnnouncements`'s loop is currently running; see `withAnnouncements`. Depth
  // alone is not enough to guarantee a single drainer: a synchronous listener a batch's own
  // `bus.emit` invokes can run a nested mutation whose own `withAnnouncements` call also finds
  // `depth` back at zero (the outer call's `finally` already decremented it before calling this
  // function), so without this flag that nested call would start a second, concurrent drain
  // loop racing the one already iterating the same queue — emitting a later-queued batch before
  // the running loop finishes the one it is on. Guarded by `drainAnnouncements` itself.
  let draining = false;

  /**
   * Publishes every batch currently queued, in commit order, each batch's changes in order.
   * Only ever called by `withAnnouncements` once `depth` has returned to zero; see this
   * module's own doc comments and {@link createRightsHub}'s invariant for the full reentrancy
   * argument. Each change's emission is isolated: a synchronous throw from `bus.emit` itself is
   * caught and logged exactly like a rejected promise, so one failing emission never stops the
   * rest of its batch or the batches still queued after it.
   */
  function drainAnnouncements(): void {
    draining = true;
    try {
      let batch: readonly RightsChanged[] | undefined;
      while ((batch = announcementQueue.shift()) !== undefined) {
        for (const change of batch) {
          try {
            void bus.emit(bus.own('observer'), RightsSubjects.changed, change).catch((err: unknown) => {
              console.error('[RightsHub] makaio:rights.changed emission failed:', err);
            });
          } catch (err) {
            console.error('[RightsHub] makaio:rights.changed emission failed:', err);
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(changes) {
      announcementQueue.push(changes);
    },
    withAnnouncements(fn) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
        if (depth === 0 && !draining) drainAnnouncements();
      }
    },
  };
}

/**
 * Builds the {@link HandlerContext} a capability's own `handlerContext` method returns for
 * one call. Thin layer over the capability's own `resolve`: the carrier check, the
 * closed-owner check, and the request schema parse all stay in that one place, never a second
 * resolution path. A denial is additionally announced here, at `makaio.handler`, because this
 * is the one place a handler's own "no" would otherwise stay invisible: `resolve` itself never
 * announces, so the handler announces each denial once.
 * @param call - The call context the returned handler context is bound to.
 * @param resolveCapability - The owning capability's own `resolve` method.
 * @param emitDenial - Sink a denial is announced to; see {@link createRightsHub}'s own `emitDenial`.
 * @returns The handler context.
 */
function buildHandlerContext(
  call: CallContext,
  resolveCapability: (call: CallContext, ask: { right: RightName; context: JsonValue }) => Promise<RightAnswer>,
  emitDenial: DenialEmitter,
): HandlerContext {
  return {
    call,
    async hasRight(right, context) {
      const answer = await resolveCapability(call, { right, context });
      if (!answer.granted) {
        deny(emitDenial, CoreDenialPlace.handler, { call, right, reason: answer.reason, by: answer.by });
      }
      return answer;
    },
  };
}

/**
 * Builds the {@link RightsCapability} `capabilityFor` hands out for one owner, bound to its
 * current {@link OwnerRecord}.
 * @param owner - Extension the capability acts as the owner for.
 * @param carrier - Extension's own carrier; every `ask` call context is checked against it
 *   before a question resolves.
 * @param busContext - Bus context the extension's own call contexts were minted on (the
 *   hub's bus, shared by the extension's carrier bus); checked alongside `carrier`.
 * @param record - The owner's current record, live for as long as `ownerRecords` still maps
 *   `owner` to this exact object (see `live` below).
 * @param ownerRecords - The hub's owner records, read to detect a rebind to a fresh record.
 * @param directory - The rights directory every committed mutation applies to.
 * @param resolve - Resolves a right question against the directory and cache.
 * @param withAnnouncements - Wraps a mutating entry point so its announcements are only
 *   published once every nested entry point on the call stack has returned.
 * @param emitDenial - Sink a denial of `handlerContext(call).hasRight(...)` is announced to;
 *   see {@link createRightsHub}'s own `emitDenial`. The plain `resolve` method never announces
 *   through it: only the handler-context path does (see {@link HandlerContext.hasRight}), since
 *   the core has no other place that makes a denied `hasRight` visible.
 * @returns The capability.
 */
function buildRightsCapability(
  owner: ExtensionName,
  carrier: PartyRef,
  busContext: object,
  record: OwnerRecord,
  ownerRecords: ReadonlyMap<ExtensionName, OwnerRecord>,
  directory: RightsDirectory,
  resolve: (question: RightQuestion, resolveOptions?: ResolveRightOptions) => Promise<RightAnswer>,
  withAnnouncements: <T>(fn: () => T) => T,
  emitDenial: DenialEmitter,
): RightsCapability {
  // Live as long as `owner` still maps to this exact record: `capabilityFor`
  // only ever replaces the map entry with a different record once this one
  // reached `'closed'`, so this check also catches that rebind for every
  // capability still holding the superseded record.
  const live = (): OwnerRecord => {
    if (ownerRecords.get(owner) !== record || record.state === 'closed') throw closedOwnerError(owner);
    return record;
  };

  const capability: RightsCapability = {
    async resolve(call, ask) {
      assertCallCarrier(call, carrier, busContext);
      live();
      const { right, context } = RightsResolveRequestSchema.parse(ask);
      return resolve({ call, right, context });
    },
    handlerContext(call: CallContext): HandlerContext {
      return buildHandlerContext(call, capability.resolve, emitDenial);
    },
    sourceChanged(source: ContributionName) {
      const current = live();
      // Not yet announced: the directory does not know this source, so there is
      // nothing of it to invalidate.
      if (current.state === 'pending') return;
      if (current.state === 'activating') throw reentrantActivationError(owner);
      withAnnouncements(() => directory.sourceChanged(owner, source));
    },
    declareRightsFromData(rights) {
      const current = live();
      if (current.state === 'pending') {
        // Staging commits nothing of its own, but still goes through the same wrapper as
        // every other mutating entry point, so a nested mutation reached while planning
        // (for example reaching another, already-active owner's capability) publishes only
        // once this staging call has returned. This call replaces the whole staged set,
        // like `declareFromData` itself.
        withAnnouncements(() => {
          current.dataRights = directory.planDataRights(owner, rights);
        });
        return;
      }
      if (current.state === 'activating') throw reentrantActivationError(owner);
      withAnnouncements(() => directory.declareFromData(owner, rights));
    },
    registerRightsSource(source) {
      const current = live();
      if (current.state === 'pending') {
        // See `declareRightsFromData`'s pending branch: staging goes through the wrapper
        // too. Unlike that call, this one appends to `current.sources` rather than
        // replacing it.
        withAnnouncements(() => {
          current.sources = directory.planAnswerSource(owner, source, current.sources);
        });
        return;
      }
      if (current.state === 'activating') throw reentrantActivationError(owner);
      withAnnouncements(() => directory.registerSource(owner, source));
    },
  };
  return capability;
}

/**
 * Commits one owner's pending activation attempt: enforced before anything of the owner's
 * record is touched (a bound owner that is not `pending` has no running attempt for this call
 * to commit — `activating` is this same owner's own commit already in progress, a reentrant
 * `activate`, a bug; `active` and `closed` have nothing staged for this call to commit at all;
 * an unbound owner activates as a fresh `pending` one) — then, wrapped in `withAnnouncements`,
 * takes the record's staged data rights and sources, holds it `activating` for the exact
 * duration of `directory.activate` (so a reentrant mutation reached from inside that very
 * commit must throw instead of staging into the now-emptied arrays a second time, or
 * committing straight to a directory that has not finished committing), and on success switches
 * it to `active` — publication deferred to `withAnnouncements`'s own `finally`, so a listener of
 * this activation's announcements always finds the owner already `active`. When
 * `directory.activate` throws, the record is restored to `pending` with what was taken put
 * back, exactly as before the attempt, so nothing was committed and nothing is announced.
 * See {@link RightsHub.activate}'s own doc comment for the full contract.
 * @param name - Extension committing its activation.
 * @param pkg - The extension's `rights` and `rightsSources` contribution fields.
 * @param ownerRecords - The hub's owner records, read and written for `name`.
 * @param directory - The rights directory the commit applies to.
 * @param withAnnouncements - Wraps the mutation so its announcements publish only once nesting
 *   on the call stack returns to zero.
 * @returns `false`: a real hub's commit always applies what it is given, it never discards it
 *   (see {@link RightsHub.activate}'s own doc comment).
 * @throws Error when the owner is bound and its state is not `pending`, or when
 *   `directory.activate` rejects the committed rights/sources.
 */
function runActivate(
  name: ExtensionName,
  pkg: Pick<KernelMakaioExtension, 'rights' | 'rightsSources'>,
  ownerRecords: Map<ExtensionName, OwnerRecord>,
  directory: RightsDirectory,
  withAnnouncements: <T>(fn: () => T) => T,
): boolean {
  const existing = ownerRecords.get(name);
  if (existing !== undefined && existing.state !== 'pending') {
    throw new Error(`Extension "${name}" is ${existing.state}; activate can only commit a pending activation attempt.`);
  }
  withAnnouncements(() => {
    const record = existing ?? freshPendingRecord();
    ownerRecords.set(name, record);
    const stagedDataRights = record.dataRights;
    const stagedSources = record.sources;
    record.dataRights = [];
    record.sources = [];
    record.state = 'activating';
    try {
      directory.activate(name, {
        rights: pkg.rights ?? [],
        dataRights: stagedDataRights,
        sources: [...(pkg.rightsSources ?? []), ...stagedSources],
      });
      record.state = 'active';
    } catch (err) {
      record.state = 'pending';
      record.dataRights = stagedDataRights;
      record.sources = stagedSources;
      throw err;
    }
  });
  return false;
}

/**
 * Creates the rights hub, composing a fresh {@link RightsDirectory} and
 * rights cache with {@link resolveRight} and {@link deny}.
 *
 * **The one reentrancy invariant this hub holds to:** the
 * directory never calls out while it mutates except through its one change notification
 * ({@link RightsDirectory.onChanged}), and this hub's only listener of it does exactly two
 * things, synchronously: invalidates the cache for the whole committed batch (expanded
 * from a source's patterns where needed, so a cached answer the batch made stale can never
 * survive it — using only the directory's own copies, by {@link RightsDirectory.list} and
 * {@link RightsDirectory.sourcesFor}, never the extension's own contribution object, which
 * is never read again once the directory has planned it), and appends the batch to an
 * announcement queue. It never emits there — emitting from inside a directory commit is
 * exactly how a `makaio:rights.changed` listener, or a context schema getter evaluated
 * while compiling, used to call back into the hub while the directory was still
 * mid-mutation. This listener is attached to an empty directory before anything — including
 * the core's own subject rights, below — is ever declared, so every declaration, the core's
 * included, goes through this same path.
 *
 * Every mutating entry point — {@link RightsHub.activate}, {@link RightsHub.deactivate}, the
 * per-owner capability's `declareRightsFromData`, `registerRightsSource`, and `sourceChanged`
 * whether they apply straight to an `active` owner or only stage onto a `pending` one, and the
 * core's own subject rights declared below — runs through one small wrapper (`withAnnouncements`)
 * that tracks how many such entry points are currently nested on the call stack (`depth`,
 * incremented on entry and decremented in a `finally`) and drains the announcement queue only
 * once `depth` returns to zero *and* no drain is already running (`draining`, set only inside
 * `drainAnnouncements`'s own call) — never while an outer entry point, or an already-running
 * drain, is still active. A nested mutation reached from inside an outer one (for example a
 * schema getter of owner A's own activation that reaches owner B's already-active capability,
 * or one reached while a still-`pending` owner's own data or source is only being staged, not
 * yet committed) therefore commits and queues immediately, like any other mutation, but its
 * announcement is only published once the outermost operation's `withAnnouncements` call
 * returns, after the outer operation's own announcement is queued — so observers always see
 * revisions in commit order, and an announcement is only ever published once the owner state
 * it describes has actually been committed (or, for a still-pending owner, staged). A listener
 * a batch's own `bus.emit` invokes synchronously can likewise make another mutation while
 * `drainAnnouncements`'s loop is running; that mutation's own `withAnnouncements` call also
 * finds `depth` back at zero once it returns, but `draining` is still `true`, so it defers
 * draining its own queued batch to the loop already running rather than starting a second,
 * concurrent one that could race it and publish out of commit order (`drainAnnouncements`'s
 * `while` condition picks up what was just queued on its own next iteration). Each change's
 * `bus.emit` is wrapped on its own, so a synchronous throw from one change — for example a bus
 * whose emission logic itself throws — is caught and logged exactly like the existing
 * rejection handler, and the loop continues with the next change and the next batch instead of
 * abandoning the rest of an already-committed, already-queued batch.
 *
 * Every bus emission the hub makes uses its own context, minted fresh per emission from
 * `bus.own('observer')` — the same purpose `extension-health-runner.ts` uses for a core
 * notification that reports an observed state change rather than a lifecycle action the
 * host itself is performing (`'start'`/`'stop'`) or scheduled work. The hub never emits
 * with a call context received from an extension, and never on another carrier's bus
 * (`options.bus` is the only bus it ever sends on).
 * @param options - The bus the hub emits on.
 * @returns The hub.
 */
export function createRightsHub(options: RightsHubOptions): RightsHub {
  const { bus } = options;
  const directory = createRightsDirectory();
  const cache = createRightsCache();
  const ownerRecords = new Map<ExtensionName, OwnerRecord>();

  // Rights already logged for the silent "no source → grant" default (see `resolveRight`'s
  // own doc comment), so the log fires at most once per right for this hub's whole lifetime.
  const noSourceGrantsLogged = new Set<RightName>();
  const onNoSourceGrant = (right: RightName): void => {
    if (noSourceGrantsLogged.has(right)) return;
    noSourceGrantsLogged.add(right);
    console.info(`[RightsHub] Right "${right}" has no answer source; every question about it is granted by default.`);
  };

  const resolve = (question: RightQuestion, resolveOptions?: ResolveRightOptions): Promise<RightAnswer> =>
    resolveRight({ directory, cache, onNoSourceGrant }, question, resolveOptions);

  // See `createDenialEmitter`'s own doc comment for the reentrant-publication guard it holds.
  const emitDenial = createDenialEmitter(bus);

  // Owns the announcement queue and the depth/draining bookkeeping; see `createAnnouncementScheduler`
  // and `createRightsHub`'s own doc comment for the reentrancy invariant.
  const scheduler = createAnnouncementScheduler(bus);
  const { withAnnouncements } = scheduler;

  // Attached to the directory before anything is ever declared in it — including the core's
  // own subject rights, declared through `withAnnouncements` just below — so every declaration
  // this hub ever makes is invalidated, queued and, once its `withAnnouncements` call
  // returns, published exactly like an extension's.
  directory.onChanged((changes) => {
    // One committed mutation is one unit for the cache: every right any change of it
    // affects is invalidated immediately, before the batch is even queued, so a reentrant
    // mutation reached while draining can never read a cached answer this same mutation
    // made stale (for example `activate` committing a right plus a source that restricts
    // it: `declared` must not still answer from the pre-restriction cache). Nothing is
    // emitted here — see this function's own doc comment for the invariant.
    const invalidated = new Set<RightName>();
    for (const change of changes) {
      for (const right of invalidatedRightsOf(directory, change)) invalidated.add(right);
    }
    cache.invalidate([...invalidated]);
    scheduler.enqueue(changes);
  });

  // The core's own subject rights go through the same path as an extension's: the directory
  // change handler above is already attached, so this declaration is invalidated, queued,
  // and published by `withAnnouncements` exactly like any other mutation.
  withAnnouncements(() => directory.declare(CORE_RIGHTS_OWNER, coreRightContributions()));

  return {
    resolve,

    deny: (place, denial) => deny(emitDenial, place, denial),

    capabilityFor(owner: ExtensionName, carrier: PartyRef): RightsCapability {
      // A bound owner's record — whatever its state, `closed` included — is returned exactly
      // as is, never replaced with a fresh `pending` one here: only `beginActivation` starts
      // the next attempt. Between `deactivate` closing an owner's record (the first step of a
      // stop) and a real restart's own `beginActivation`, some other in-process read can still
      // rebuild this same owner's extension context (for example `forExtension`/
      // `forEachActiveExtension` iterating entries whose `state` has not yet left `'active'` in
      // that same narrow window) and call this again; every capability it gets in that window
      // must stay bound to the same closed record and refuse like any other `closed` owner's
      // capability (see `live()` in `buildRightsCapability`), never silently resurrect a record
      // this hub already closed. An unbound owner (never bound at all) is the one case that
      // still gets a fresh `pending` record here, for a first call reached outside the normal
      // `beginActivation`-first sequence.
      const existing = ownerRecords.get(owner);
      const record: OwnerRecord = existing ?? freshPendingRecord();
      if (existing === undefined) ownerRecords.set(owner, record);
      return buildRightsCapability(
        owner,
        carrier,
        busContextOf(bus),
        record,
        ownerRecords,
        directory,
        resolve,
        withAnnouncements,
        emitDenial,
      );
    },

    beginActivation(owner: ExtensionName): void {
      const existing = ownerRecords.get(owner);
      if (existing?.state === 'active') {
        throw new Error(`Extension "${owner}" is already active; beginActivation cannot start a new attempt for it.`);
      }
      ownerRecords.set(owner, freshPendingRecord());
    },

    activate(name, pkg) {
      return runActivate(name, pkg, ownerRecords, directory, withAnnouncements);
    },

    deactivate(name) {
      // Enforced before anything is touched: an `activating` owner is mid-commit, inside its
      // own `activate` call above — closing it now, only for that same commit to finish and
      // switch it to `active` moments later, would resurrect an owner this call was supposed
      // to have closed for good (see the lifecycle table above {@link OwnerLifecycle}).
      const record = ownerRecords.get(name);
      if (record?.state === 'activating') {
        throw new Error(`Extension "${name}" is activating; it cannot be deactivated until that attempt finishes.`);
      }
      withAnnouncements(() => {
        // Closed before the directory removal is announced: a listener of that
        // announcement (for example one that calls `declareRightsFromData` through the
        // capability it still holds) must find the owner already stopped, not add
        // anything through a capability whose removal is only now being reported.
        if (record !== undefined) record.state = 'closed';
        directory.removeOwner(name);
      });
    },

    list: () => directory.list(),
    isOwnerActive: (owner) => ownerRecords.get(owner)?.state === 'active',
  };
}

/**
 * Builds the rights of a composition that runs outside the host process: no
 * {@link RightsDirectory}, cache, or owner bookkeeping is created, and every
 * owner's capability is the one refusing capability from
 * {@link createRefusingRightsCapability} regardless of who asks for it.
 *
 * `beginActivation` and `deactivate` are no-ops — there is no owner record for them to
 * touch — so the activation lifecycle every start path drives (see
 * {@link RightsHub.beginActivation}'s own doc comment) runs unchanged whether a composition
 * has a real hub or this refusal. `activate` is not a no-op: it reports whether `pkg` declared
 * any `rights`/`rightsSources` it is about to discard (see {@link RightsHub.activate}'s own
 * doc comment), so the caller can make that discard visible instead of silently dropping an
 * extension's declared contribution. `resolve` rejects and `deny` throws the same host-process
 * refusal as the capability: nothing in this process is ever positioned to ask a question or
 * receive a denial through the hub surface directly, since every extension's `ctx.rights` is
 * already the refusing capability. `list` returns an empty array: no right is ever declared
 * here, so there is nothing to report.
 * @returns The refusal.
 */
export function createRefusedRightsHub(): RightsHub {
  const capability = createRefusingRightsCapability();
  return {
    resolve: async () => {
      throw new HostOnlyRightsError();
    },
    deny: () => {
      throw new HostOnlyRightsError();
    },
    capabilityFor: () => capability,
    beginActivation: () => undefined,
    activate: (_owner, pkg) => (pkg.rights?.length ?? 0) > 0 || (pkg.rightsSources?.length ?? 0) > 0,
    deactivate: () => undefined,
    list: () => [],
    isOwnerActive: () => false,
  };
}
