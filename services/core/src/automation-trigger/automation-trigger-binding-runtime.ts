import type {
  AutomationTriggerActivationContext,
  AutomationTriggerBinding,
  AutomationTriggerCleanup,
  AutomationTriggerEvent,
  AutomationTriggerListener,
  AutomationTriggerSubscription,
  AutomationTriggerType,
  JsonValue,
} from '@makaio/contracts';
import { JsonRecordSchema, JsonValueSchema, createAutomationTriggerDescriptor } from '@makaio/contracts';
import { SerialLane } from '@makaio/utils';
import { canonicalizeJsonRecord, createCanonicalBindingKey } from './canonical-binding-key.js';

// ---------------------------------------------------------------------------
// Collaborator seam
// ---------------------------------------------------------------------------

/**
 * Minimal resolution surface the binding runtime needs from a trigger registry.
 *
 * Declaring the dependency structurally keeps the runtime free of the registry's
 * bus lifecycle: any owner-aware catalog that can resolve a kind to its owner and
 * executable trigger can drive the runtime.
 */
export interface AutomationTriggerResolver {
  /**
   * Resolves a trigger kind to its owning extension and executable type.
   * @param kind - Canonical trigger kind to resolve.
   * @returns The owner and trigger type, or `undefined` when not registered.
   */
  resolveRegistration(kind: string): { readonly owner: string; readonly type: AutomationTriggerType } | undefined;
}

/**
 * Schema-validated binding admission prepared for one registration snapshot.
 *
 * The capability keeps parsed parameters private while exposing the canonical
 * key a caller needs for its own handover decision. Calling {@link subscribe}
 * consumes that exact parsed snapshot, so a transforming parameter schema can
 * never produce one key for inspection and a different activation input.
 */
export interface PreparedAutomationTriggerBinding {
  /** Canonical key derived from the prepared, schema-parsed parameters. */
  readonly bindingKey: string;
  /** Whether this trigger's event output has an object root suitable for workflows. */
  readonly workflowCompatible: boolean;
  /**
   * Attaches a listener using this prepared registration and parameter snapshot.
   * @param listener - Listener invoked for every validated emitted event.
   * @returns A handle whose `detach` releases this listener's reference.
   */
  subscribe(listener: AutomationTriggerListener): Promise<AutomationTriggerSubscription>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * One live activation of a canonically keyed binding, shared by every
 * subscription whose parsed parameters produce the same key.
 */
interface ActiveBinding {
  /** Canonical sharing key this activation is indexed under. */
  readonly bindingKey: string;
  /** Canonical trigger kind that produced this activation. */
  readonly kind: string;
  /** Owner captured from the registry at activation time. */
  readonly owner: string;
  /**
   * Registered trigger this activation was built from.
   *
   * Held for identity comparison, not for re-invocation: the registry publishes a
   * fresh snapshot object for every registration, so `type !== resolved type` is
   * exactly the statement "this activation belongs to a registration that has
   * since been replaced". See {@link AutomationTriggerBindingRuntime} invariant 4.
   */
  readonly type: AutomationTriggerType;
  /** Abort controller handed to the activation, aborted before cleanup. */
  readonly controller: AbortController;
  /** Listeners attached to this activation, keyed by subscription id. */
  readonly listeners: Map<string, AutomationTriggerListener>;
  /**
   * Shared outcome of the single `activate` call for this entry.
   *
   * Started once when the entry is installed and awaited **outside** the
   * lifecycle lane by everyone who needs it: every subscriber joining this key,
   * and teardown when it needs the cleanup function. Reference counting never
   * waits on extension code because of this indirection.
   */
  readonly activated: Promise<AutomationTriggerCleanup>;
}

/**
 * Internal identity behind a public {@link AutomationTriggerSubscription}.
 *
 * The listener id alone identifies the subscription runtime-wide: ids come from a
 * monotonic counter and each one is inserted into exactly one activation, so a
 * handle can never address a listener slot it did not create — not even after its
 * activation was retired and the same canonical key re-activated.
 */
interface SubscriptionRecord {
  /** Canonical key of the activation this subscription is attached to. */
  readonly bindingKey: string;
  /** Unique id of this subscription's listener within the activation. */
  readonly subscriptionId: string;
}

/**
 * Result of the lane-internal admission step of an acquisition.
 *
 * Admission installs (or joins) the activation entry and allocates the listener
 * slot; awaiting the activation itself happens after the lane is released.
 */
interface Admission {
  /** Entry the listener was attached to. */
  readonly entry: ActiveBinding;
  /** Listener id allocated for this subscription. */
  readonly subscriptionId: string;
  /**
   * Activation this admission superseded, when it displaced a stale one.
   *
   * Retirement already happened on the lane; the cleanup it produced must be
   * awaited outside the lane like every other cleanup.
   */
  readonly retired?: ActiveBinding;
}

/** Private state captured behind a prepared binding capability. */
interface PreparedBindingState {
  /** Canonical trigger kind being acquired. */
  readonly kind: string;
  /** Owner resolved when the binding was prepared. */
  readonly owner: string;
  /** Trigger registration whose schema parsed the parameters. */
  readonly type: AutomationTriggerType;
  /** Canonical parameters handed unchanged to activation. */
  readonly params: Record<string, JsonValue>;
  /** Canonical sharing key derived from {@link params}. */
  readonly bindingKey: string;
}

/** Log prefix for runtime diagnostics. */
const LOG_PREFIX = '[AutomationTriggerBindingRuntime]';

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * Reference-counted activation runtime for automation trigger bindings.
 *
 * Four invariants define this runtime:
 *
 * 1. **Canonical sharing.** A binding is identified by
 *    `<kind>:<canonical-json(parsed params)>`. Parameters are parsed through the
 *    trigger's `paramsSchema` first and then canonicalized, so defaults and
 *    normalizing transforms are applied before the key is computed and the
 *    values handed to `activate` are exactly the values the key was derived
 *    from; two bindings that mean the same thing therefore share exactly one
 *    live activation, reference-counted by listener.
 * 2. **Lane-serialized state, lane-free extension code.** Every internal state
 *    transition — indexing, reference counting, retirement, abort — runs on a
 *    single FIFO lane, so no two activations, teardowns, or replacements can
 *    interleave their bookkeeping. Extension-owned promises (`activate` and the
 *    cleanup it returns) and listener delivery are awaited **outside** the lane
 *    and reconciled against the entry's map identity when they settle.
 *    Callers keep their ordering guarantees — `detach()` still resolves only once
 *    the cleanup has settled — while extension code can never block the lane.
 *    That is what makes a listener free to subscribe or detach during delivery,
 *    lets {@link close} abort an `activate` that only settles on abort, and lets
 *    a cleanup mutate the runtime.
 * 3. **Map identity is the single liveness signal.** Retiring an activation
 *    unindexes it, clears its listeners, and aborts its signal — always together,
 *    always in one lane step. An entry is therefore live exactly while it is the
 *    indexed activation for its key: an emit from a source that outlived its
 *    cleanup is discarded, and a late-completing activation cannot be
 *    resurrected — its cleanup runs and nothing else. No separate disposed flag
 *    or generation counter is needed to distinguish a superseded activation from
 *    the live one.
 *
 * 4. **Registration identity gates sharing.** An activation records the
 *    registered trigger it was built from. Sharing a live activation is only
 *    correct while that registration is still the current one: an owner that
 *    re-registers a kind replaces `activate`, `paramsSchema`, and `eventSchema`
 *    wholesale, so joining the previous activation would run new subscribers
 *    against an implementation discovery no longer advertises. A join whose
 *    captured trigger is no longer the resolved one therefore retires the stale
 *    activation and builds a fresh one.
 *
 *    Listeners on the retired activation are silenced rather than migrated. That
 *    is the same semantic as {@link stopKind}, and for the same reason: their
 *    consumers recover by re-subscribing on `automation-triggers.changed`, which
 *    the replacing registration necessarily emitted before this join could be
 *    admitted. Migrating them instead would hand them an activation whose
 *    `activate` may still fail, with their own `subscribe` already resolved and
 *    no error path left to report it on.
 *
 * The runtime deliberately does not extend `BaseService`: it owns no bus subjects
 * and no bus lifecycle. It is a plain collaborator constructed with a resolver,
 * so hosts can compose it into whatever lifecycle owns it and call
 * {@link close} on teardown.
 */
export class AutomationTriggerBindingRuntime {
  /** Live activations indexed by canonical binding key. */
  private readonly bindings = new Map<string, ActiveBinding>();
  /** Maps issued public handles back to their internal identity. */
  private readonly records = new WeakMap<AutomationTriggerSubscription, SubscriptionRecord>();
  /**
   * The single FIFO state-transition lane.
   *
   * Operations placed on it must not await extension-owned promises or deliver
   * events — that is the invariant which keeps the lane free of deadlocks.
   */
  private readonly lane = new SerialLane();
  /** Monotonic subscription id source. */
  private subscriptionCounter = 0;
  /** Set by {@link close}; rejects further acquisitions. */
  private closed = false;

  /**
   * @param resolver - Registry surface used to resolve kinds to executable
   *   triggers and their owning extension.
   */
  public constructor(private readonly resolver: AutomationTriggerResolver) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attaches a listener to the binding, activating the trigger if needed.
   *
   * Parameters are validated through the trigger's `paramsSchema` and then
   * checked for JSON compatibility before anything is activated, so an invalid
   * binding never reaches extension code. When an activation already exists for
   * the canonical key — including one that is still activating — the listener
   * joins it and no second activation occurs, provided that activation still
   * belongs to the current registration of the kind (invariant 4).
   *
   * Three phases: a lane-internal admission that installs or joins the entry, an
   * out-of-lane await of the shared activation promise, and a lane-internal
   * commit that issues the handle only while the admitted listener is still live.
   *
   * A caller that swaps one binding for another does so by subscribing the
   * replacement and only then detaching the previous handle. That ordering is the
   * caller's, deliberately: it keeps a shared source from being torn down and
   * re-activated, it leaves the previous subscription fully intact when the
   * acquisition fails, and it leaves the window between the two steps — where a
   * caller with its own delivery bookkeeping has to settle which of the two
   * attached listeners acts — under that caller's control.
   * @param binding - Trigger kind plus JSON parameters to activate.
   * @param listener - Listener invoked for every validated emitted event.
   * @returns A handle whose `detach` releases this listener's reference.
   * @throws When the runtime is closed, the kind is not registered, the
   *   parameters fail validation, the activation itself fails, or a lifecycle
   *   operation retires the admission before activation completes.
   */
  public async subscribe(
    binding: AutomationTriggerBinding,
    listener: AutomationTriggerListener,
  ): Promise<AutomationTriggerSubscription> {
    const prepared = this.prepareBinding(binding);
    if (prepared === undefined) {
      throw new Error(`Automation trigger kind '${binding.kind}' is not registered`);
    }
    return prepared.subscribe(listener);
  }

  /**
   * Parses a binding once for both canonical-key inspection and subscription.
   *
   * The returned capability captures the registration that performed the parse.
   * Its subscription rejects if that registration is replaced before admission,
   * rather than re-parsing through a different schema under a stale key.
   * Preparation does not activate anything and does not require the runtime to
   * be open.
   * @param binding - Trigger kind plus JSON parameters to prepare.
   * @returns A prepared capability, or `undefined` when the kind is unregistered.
   * @throws When the parameters fail the trigger's schema or are not
   *   JSON-compatible.
   */
  public prepareBinding(binding: AutomationTriggerBinding): PreparedAutomationTriggerBinding | undefined {
    const registration = this.resolver.resolveRegistration(binding.kind);
    if (registration === undefined) return undefined;

    const params = parseBindingParams(registration.type, binding);
    const state: PreparedBindingState = {
      kind: binding.kind,
      owner: registration.owner,
      type: registration.type,
      params,
      bindingKey: createCanonicalBindingKey(binding.kind, params),
    };

    return {
      bindingKey: state.bindingKey,
      workflowCompatible: createAutomationTriggerDescriptor(registration.type).workflowCompatible,
      subscribe: (listener) => this.subscribePrepared(state, listener),
    };
  }

  /**
   * Acquires one prepared binding without parsing its parameters again.
   * @param prepared - Private registration and parameter snapshot.
   * @param listener - Listener to attach.
   * @returns A detachable subscription handle.
   */
  private async subscribePrepared(
    prepared: PreparedBindingState,
    listener: AutomationTriggerListener,
  ): Promise<AutomationTriggerSubscription> {
    const { entry, subscriptionId, retired } = await this.lane.run(() => this.admitWithinLane(prepared, listener));

    // Outside the lane: both of these are extension-owned. The superseded
    // activation's cleanup is awaited first so that a source which cannot hold two
    // live activations of one key has released the old one before this call
    // reports success.
    if (retired !== undefined) await this.runCleanup(retired);

    try {
      // `activate` is extension-owned and may not settle until its signal aborts,
      // which is itself a lane operation.
      await entry.activated;
    } catch (error) {
      await this.lane.run(async () => {
        this.retireWithinLane(entry);
      });
      throw error;
    }

    return this.lane.run(async () => {
      if (this.bindings.get(entry.bindingKey) !== entry || !entry.listeners.has(subscriptionId)) {
        throw new Error(`Automation trigger acquisition for '${entry.bindingKey}' was retired before it completed`);
      }

      return this.issueHandle({ bindingKey: entry.bindingKey, subscriptionId });
    });
  }

  /**
   * Computes the canonical sharing key a binding would activate under.
   *
   * Exists so a caller that indexes its own bookkeeping by binding key — a
   * reconciler diffing stored bindings, for instance — derives that key through
   * the same resolution and parsing the runtime itself uses, instead of
   * re-implementing the schema parse and canonicalization and drifting from it.
   *
   * Does not activate anything and does not require the runtime to be open.
   * @param binding - Trigger kind plus JSON parameters.
   * @returns The canonical key, or `undefined` when the kind is not registered.
   * @throws When the parameters fail the trigger's `paramsSchema` or are not
   *   JSON-compatible — the same rejection {@link subscribe} would produce.
   */
  public resolveBindingKey(binding: AutomationTriggerBinding): string | undefined {
    return this.prepareBinding(binding)?.bindingKey;
  }

  /**
   * Tears down every activation contributed by one owner.
   *
   * Only activations whose owner was captured as `owner` at activation time are
   * removed, so other owners keep emitting. Handles pointing at a stopped
   * activation stay safely detachable — their `detach` becomes a no-op.
   * @param owner - Owning extension whose activations should stop.
   * @returns Resolves once every matching cleanup has settled.
   */
  public stopOwner(owner: string): Promise<void> {
    return this.retireMatching((entry) => entry.owner === owner);
  }

  /**
   * Tears down every activation of one trigger kind.
   *
   * Exists for the case where a *service an activation depends on* goes away
   * while the trigger contributing the kind stays registered: the kind is still
   * resolvable and still legitimately contributed, but every live activation of
   * it is now backed by a dead collaborator. Retiring them unindexes them, which
   * is what makes the next `subscribe` for that kind build a fresh activation
   * against the live collaborator instead of joining a permanently inert one.
   *
   * Narrower than {@link stopOwner} on purpose: an owner commonly contributes
   * several kinds with unrelated backing services, and stopping all of them would
   * silence bindings that were never affected.
   *
   * The kind stays registered — this runtime holds no registrations. Handles
   * pointing at a stopped activation stay safely detachable.
   * @param kind - Canonical trigger kind whose activations should stop.
   * @returns Resolves once every matching cleanup has settled.
   */
  public stopKind(kind: string): Promise<void> {
    return this.retireMatching((entry) => entry.kind === kind);
  }

  /**
   * Disposes every activation and permanently closes the runtime.
   *
   * Delegates to {@link close}; exists so the runtime satisfies the
   * `ExtensionServiceLifecycle` contract from `@makaio/contracts` and the
   * coordinator can call `service.destroy?.()` on package teardown.
   * @returns Resolves once every cleanup has settled.
   */
  public destroy(): Promise<void> {
    return this.close();
  }

  /**
   * Disposes every activation and permanently closes the runtime.
   *
   * Idempotent, and safe to call while an activation is still in flight. The
   * lane carries only state transitions, so this call is never queued behind
   * extension-owned code: a pending acquisition is admitted first (the lane is
   * FIFO) and its activation is then retired here like any other. Retirement
   * aborts the activation signal immediately, which is what lets an `activate`
   * that only settles on abort settle at all — its cleanup then runs and this
   * call resolves. Handles issued before close remain safely detachable.
   * @returns Resolves once every cleanup has settled.
   */
  public close(): Promise<void> {
    return this.retireMatching(
      () => true,
      () => {
        this.closed = true;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  /**
   * Installs a new activation entry or joins an existing one. Lane-internal.
   *
   * Starts the single `activate` call for a new entry but never awaits it: the
   * outcome is published on {@link ActiveBinding.activated} for the acquirer and
   * for teardown to await after the lane is released.
   *
   * An existing entry is joined only when it was built from the registration this
   * admission just resolved. Otherwise it is retired here and replaced — see
   * {@link AutomationTriggerBindingRuntime} invariant 4.
   * @param prepared - Once-parsed binding and registration snapshot to admit.
   * @param listener - Listener to attach.
   * @returns The entry joined, the allocated listener id, and any activation this
   *   admission superseded.
   * @throws When the runtime is closed, the kind is unknown, or its registration
   *   changed after preparation.
   */
  private async admitWithinLane(
    prepared: PreparedBindingState,
    listener: AutomationTriggerListener,
  ): Promise<Admission> {
    if (this.closed) {
      throw new Error(`Automation trigger binding runtime is closed; cannot activate '${prepared.kind}'`);
    }

    const registration = this.resolver.resolveRegistration(prepared.kind);
    if (registration === undefined) {
      throw new Error(`Automation trigger kind '${prepared.kind}' is not registered`);
    }
    if (registration.owner !== prepared.owner || registration.type !== prepared.type) {
      throw new Error(`Automation trigger registration for '${prepared.kind}' changed after binding preparation`);
    }

    this.subscriptionCounter += 1;
    const subscriptionId = `s${this.subscriptionCounter}`;

    // An indexed entry is live by definition, so joining it is always safe,
    // including while it is still activating.
    const existing = this.bindings.get(prepared.bindingKey);
    if (existing?.type === registration.type) {
      existing.listeners.set(subscriptionId, listener);
      return { entry: existing, subscriptionId };
    }

    // Same key, superseded registration: the entry's `activate`, `paramsSchema`,
    // and `eventSchema` all belong to an implementation the registry has replaced.
    // Retiring it here — on the lane, before the replacement is indexed — is what
    // keeps "one live activation per key" true while still refusing to join a
    // source discovery no longer advertises.
    const retired = existing === undefined ? undefined : this.retireWithinLane(existing);

    const activation = Promise.withResolvers<AutomationTriggerCleanup>();
    const entry: ActiveBinding = {
      bindingKey: prepared.bindingKey,
      kind: prepared.kind,
      owner: registration.owner,
      type: registration.type,
      controller: new AbortController(),
      listeners: new Map([[subscriptionId, listener]]),
      activated: activation.promise,
    };

    // Index before activating so a trigger that emits synchronously inside
    // `activate` already reaches its first listener. The lane guarantees no other
    // state transition can observe the half-built entry.
    this.bindings.set(prepared.bindingKey, entry);
    // The shared promise must stay handled at all times: joiners attach their
    // handlers a microtask later, and an activation that fails immediately must
    // not surface as an unhandled rejection in between.
    void entry.activated.catch(() => undefined);
    void this.startActivation(entry, registration.type, prepared.params, activation);

    return { entry, subscriptionId, ...(retired === undefined ? {} : { retired }) };
  }

  /**
   * Runs the single `activate` call for an entry and publishes its outcome.
   *
   * Deliberately not awaited by its caller: the lane must never contain
   * extension-owned promises. `activate` is still entered synchronously, so a
   * trigger that emits inside `activate` reaches its first listener immediately.
   * @param entry - Entry being activated.
   * @param type - Registered trigger providing the activation implementation.
   * @param params - Canonical, schema-parsed activation parameters.
   * @param deferred - Shared outcome slot every awaiter of this entry observes.
   * @returns Resolves once the outcome has been published.
   */
  private async startActivation(
    entry: ActiveBinding,
    type: AutomationTriggerType,
    params: Record<string, JsonValue>,
    deferred: PromiseWithResolvers<AutomationTriggerCleanup>,
  ): Promise<void> {
    try {
      deferred.resolve(await type.activate(this.createContext(entry), params));
    } catch (error) {
      deferred.reject(error);
    }
  }

  // -------------------------------------------------------------------------
  // Release and teardown
  // -------------------------------------------------------------------------

  /**
   * Releases one listener reference, tearing the activation down when it was the
   * last.
   *
   * A no-op when the handle was already detached, when its activation was
   * superseded, or when the activation was removed by {@link stopOwner} or
   * {@link close}.
   * @param handle - Subscription handle to release.
   * @returns Resolves once any resulting cleanup has settled.
   * @throws When the handle was not issued by this runtime.
   */
  private async release(handle: AutomationTriggerSubscription): Promise<void> {
    const doomed = await this.lane.run(() => this.releaseWithinLane(handle));
    if (doomed !== undefined) await this.runCleanup(doomed);
  }

  /**
   * Decides the outcome of a detach and applies its state transition.
   * Lane-internal.
   * @param handle - Subscription handle to release.
   * @returns The entry whose cleanup must now run, or `undefined` when the
   *   activation survives or was already retired.
   * @throws When the handle was not issued by this runtime.
   */
  private async releaseWithinLane(handle: AutomationTriggerSubscription): Promise<ActiveBinding | undefined> {
    const record = this.records.get(handle);
    if (record === undefined) {
      throw new Error(`${LOG_PREFIX} subscription handle was not issued by this runtime`);
    }

    // The listener id is enough on its own: ids are unique runtime-wide and each
    // one lives in exactly one activation, so a handle whose activation was retired
    // — including one displaced by a re-registration of the same key — simply finds
    // nothing to delete in whichever activation now holds the key.
    const entry = this.bindings.get(record.bindingKey);
    if (entry === undefined) return undefined;
    if (!entry.listeners.delete(record.subscriptionId)) return undefined;
    if (entry.listeners.size > 0) return undefined;

    return this.retireWithinLane(entry);
  }

  /**
   * Retires every activation matching a predicate and awaits their cleanups.
   *
   * The single teardown sweep behind {@link stopOwner}, {@link stopKind}, and
   * {@link close}. Two parts must not diverge between them: selecting entries from
   * a snapshot while collecting only first-time retirements, and awaiting the
   * resulting cleanups outside the lane.
   * @param matches - Selects the activations to retire.
   * @param beforeSweep - Optional state transition applied on the lane
   *   immediately before the sweep, for a caller that must change runtime state
   *   atomically with it. Must not await anything.
   * @returns Resolves once every matching cleanup has settled.
   */
  private async retireMatching(matches: (entry: ActiveBinding) => boolean, beforeSweep?: () => void): Promise<void> {
    const doomed = await this.lane.run(async () => {
      beforeSweep?.();

      const retired: ActiveBinding[] = [];
      for (const entry of Array.from(this.bindings.values())) {
        if (!matches(entry)) continue;
        const entryToClean = this.retireWithinLane(entry);
        if (entryToClean !== undefined) retired.push(entryToClean);
      }
      return retired;
    });

    await Promise.all(doomed.map((entry) => this.runCleanup(entry)));
  }

  /**
   * Unindexes an activation, silences it, and aborts its signal. Lane-internal.
   *
   * Returning the entry only on the first retirement is what makes cleanup run
   * exactly once: every teardown path decides on the lane and only the winning
   * decision receives an entry to clean up.
   *
   * This is the sole remover from the index. That is what establishes invariant
   * 3 of {@link AutomationTriggerBindingRuntime}: map identity alone answers "is
   * this activation still live" and makes a second retirement a no-op.
   * @param entry - Activation to retire.
   * @returns The entry when this call retired it, `undefined` when it was
   *   already retired.
   */
  private retireWithinLane(entry: ActiveBinding): ActiveBinding | undefined {
    if (this.bindings.get(entry.bindingKey) !== entry) return undefined;
    this.bindings.delete(entry.bindingKey);
    entry.listeners.clear();
    entry.controller.abort();
    return entry;
  }

  /**
   * Awaits a retired activation's cleanup. Runs outside the lane.
   *
   * Waits for the shared activation outcome first, so an entry retired while it
   * was still activating is still cleaned up once `activate` settles — its
   * signal was already aborted by the retirement, which is what lets an
   * abort-driven activation settle at all.
   *
   * Cleanup failures are logged rather than propagated: teardown must stay
   * idempotent for callers and must never abandon the remaining activations in a
   * {@link stopOwner} or {@link close} sweep.
   * @param entry - Retired activation to tear down.
   * @returns Resolves once the cleanup has settled.
   */
  private async runCleanup(entry: ActiveBinding): Promise<void> {
    let cleanup: AutomationTriggerCleanup;
    try {
      cleanup = await entry.activated;
    } catch {
      // Activation failed: there is no cleanup to run, and the failure is
      // surfaced to the subscriber whose acquisition started it.
      return;
    }

    try {
      await cleanup();
    } catch (error) {
      console.error(`${LOG_PREFIX} cleanup failed for '${entry.bindingKey}':`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Handles and activation context
  // -------------------------------------------------------------------------

  /**
   * Creates a public subscription handle bound to an internal record.
   * @param record - Internal identity of the subscription.
   * @returns The public handle; its `detach` decides on the lane and is
   *   idempotent.
   */
  private issueHandle(record: SubscriptionRecord): AutomationTriggerSubscription {
    const handle: AutomationTriggerSubscription = {
      bindingKey: record.bindingKey,
      detach: () => this.release(handle),
    };
    this.records.set(handle, record);
    return handle;
  }

  /**
   * Builds the activation context handed to a trigger's `activate`.
   *
   * The returned `emit` validates every payload against the schema captured at
   * activation time before any listener runs, and is inert once the activation has
   * been retired or superseded.
   * @param entry - Activation the context belongs to.
   * @returns The activation context for this activation only.
   */
  private createContext(entry: ActiveBinding): AutomationTriggerActivationContext<unknown> {
    return {
      bindingKey: entry.bindingKey,
      signal: entry.controller.signal,
      emit: (payload, metadata) => this.dispatch(entry, payload, metadata?.correlationId),
    };
  }

  /**
   * Validates and delivers one emitted payload to an activation's listeners.
   *
   * Never runs while the state-transition lane is held, so a listener is free to
   * subscribe or detach during delivery — including for an emit made from inside
   * `activate`.
   * @param entry - Activation that emitted.
   * @param payload - Raw payload supplied by the trigger.
   * @param correlationId - Optional correlation id propagated by the source.
   * @returns Resolves once every listener has settled.
   * @throws When the payload fails the activation's captured `eventSchema` or is
   *   not JSON-compatible.
   */
  private async dispatch(entry: ActiveBinding, payload: unknown, correlationId: string | undefined): Promise<void> {
    // Late emit from a retired or superseded activation: silently ignored so a
    // source that outlives its cleanup cannot resurrect listeners or bleed into a
    // newer activation of the same canonical key. One check covers both cases —
    // see invariant 3.
    if (this.bindings.get(entry.bindingKey) !== entry) return;

    let validated: JsonValue;
    try {
      // The JSON projection is not redundant for an arbitrary event schema: a
      // permissive one such as `z.any()` accepts a Date, Map, or `undefined`, none
      // of which belong in an event envelope that listeners may persist or send
      // over the bus. It *is* redundant when the trigger declared
      // `JsonValueSchema` or `JsonRecordSchema` itself, which the identity check
      // skips — either schema already produced a JSON value, and re-parsing it
      // would walk the whole payload a second time on every emit.
      const parsed = entry.type.eventSchema.parse(payload);
      validated =
        entry.type.eventSchema === JsonValueSchema || entry.type.eventSchema === JsonRecordSchema
          ? parsed
          : JsonValueSchema.parse(parsed);
    } catch (error) {
      // Logged as well as rethrown: triggers commonly emit fire-and-forget, so the
      // log is the only signal a schema violation would otherwise produce.
      console.error(`${LOG_PREFIX} rejected invalid payload from '${entry.kind}':`, error);
      throw error;
    }

    const event: AutomationTriggerEvent = {
      kind: entry.kind,
      payload: validated,
      observedAt: Date.now(),
      ...(correlationId === undefined ? {} : { correlationId }),
    };

    // Snapshot the listeners so a listener that subscribes or detaches during
    // delivery cannot mutate the set mid-iteration.
    // The async wrapper is load-bearing: a listener that throws synchronously
    // would otherwise throw out of `map` before `allSettled` could isolate it,
    // taking down the emitting source along with its sibling listeners.
    const listeners = Array.from(entry.listeners.values());
    const results = await Promise.allSettled(listeners.map(async (listener) => listener(event)));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`${LOG_PREFIX} listener failed for '${entry.kind}':`, result.reason);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Parses, JSON-validates, and canonicalizes a binding's parameters.
 *
 * Runs the trigger's own `paramsSchema` first so defaults and normalizing
 * transforms apply, then projects the result through the shared JSON record
 * schema, then canonicalizes it. The projection is what makes the canonical key
 * trustworthy, and the canonicalization is what makes the activation input
 * identical to the key's source: a schema whose output is not JSON-compatible is
 * rejected before any extension code runs, and `activate` can never observe
 * parameters that disagree with the key they produced.
 * @param type - Registered trigger whose schema validates the parameters.
 * @param binding - Binding carrying the raw parameters.
 * @returns The parsed, JSON-validated, canonical parameter record.
 * @throws When the parameters fail `paramsSchema` or are not JSON-compatible.
 */
function parseBindingParams(type: AutomationTriggerType, binding: AutomationTriggerBinding): Record<string, JsonValue> {
  const parsed = type.paramsSchema.parse(binding.params);
  return canonicalizeJsonRecord(JsonRecordSchema.parse(parsed));
}
