import type { IMakaioBus } from '@makaio/bus-core';
import type {
  AutomationTriggerChangedPayload,
  AutomationTriggerListener,
  AutomationTriggerSubscription,
  WorkflowAutomationTriggerBinding,
  WorkflowDefinition,
} from '@makaio/contracts';
import {
  AutomationTriggerSubjects,
  CRON_AUTOMATION_TRIGGER_KIND,
  WorkflowAutomationTriggerBindingSchema,
  WorkflowSubjects,
} from '@makaio/contracts';
import type { AutomationTriggerBindingRuntime } from '@makaio/services-core/automation-trigger';
import { SerialLane } from '@makaio/utils';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import {
  compileWorkflowTriggerBindingFilter,
  assertWorkflowTriggerPayload,
  type WorkflowTriggerPayloadPredicate,
} from './workflow-trigger-binding-consumer.js';

// ─────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────

/** Log prefix for reconciler diagnostics. */
const LOG_PREFIX = '[WorkflowTriggerReconciler]';

/**
 * One consumer of a declarative trigger binding, indexed by its stable consumer
 * key (`workflowId` plus the binding's position in the definition's trigger
 * array).
 *
 * Record **identity** is the reconciler's designation of which listener may
 * start the workflow for this consumer key. That is what keeps the
 * acquire-before-release overlap — during which two listeners of the same
 * consumer are briefly attached — from turning one event into two starts.
 */
interface ConsumerRecord {
  /** Schema-validated binding this consumer subscribes to. */
  readonly binding: WorkflowAutomationTriggerBinding;
  /** Compiled `filter` + `filterExpression` predicate. */
  readonly matches: WorkflowTriggerPayloadPredicate;
  /**
   * Handle released when the consumer is refreshed or dropped.
   *
   * `undefined` only while a brand-new consumer's first acquisition is in
   * flight; a record that survives its lane operation always carries a handle.
   *
   * The handle carries its own issuing runtime inside `detach`, so a handle that
   * outlived the runtime that issued it still releases against that runtime —
   * which is why a runtime restart needs no bookkeeping here.
   */
  subscription: AutomationTriggerSubscription | undefined;
}

/**
 * What a failed acquisition means for the consumer that was being refreshed.
 *
 * - `keep-last-good` — a definition refresh failed to activate. The workflow's
 *   previous subscriptions stay live, because a workflow that cannot express its
 *   new trigger must not silently lose the trigger it already had.
 * - `drop-unavailable` — a registry change made the contributing trigger type
 *   unresolvable. The stale handle is released and forgotten, so no executable
 *   closure survives a deregistration and nothing can start the workflow until
 *   the type is registered again.
 */
type AcquisitionFailurePolicy = 'keep-last-good' | 'drop-unavailable';

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

/**
 * Validates a definition's trigger array and compiles its filters as one batch.
 *
 * Batch-atomic on purpose: a single unusable binding invalidates a refresh
 * before any subscription is touched, which lets the caller keep a workflow's
 * last-good subscriptions. A cold start may then retry bindings individually,
 * because it has no prior batch to preserve.
 * @param triggers - Persisted trigger bindings of one workflow definition.
 * @returns Prepared bindings in declaration order.
 * @throws When any binding fails schema validation or carries an
 *   `filterExpression` that cannot be compiled.
 */
function prepareBindings(triggers: readonly WorkflowAutomationTriggerBinding[]): readonly ConsumerRecord[] {
  return triggers.map(prepareBinding);
}

/**
 * Validates and compiles one declarative binding.
 * @param trigger - Persisted trigger binding to prepare.
 * @returns The subscription record to use for that binding.
 * @throws When the binding or its `filterExpression` is invalid.
 */
function prepareBinding(trigger: WorkflowAutomationTriggerBinding): ConsumerRecord {
  const binding = WorkflowAutomationTriggerBindingSchema.parse(trigger);
  return { binding, matches: compileWorkflowTriggerBindingFilter(binding), subscription: undefined };
}

/**
 * Prepares one definition's bindings under the reconciler's failure policy.
 *
 * A refresh with live consumers is batch-atomic and returns `undefined` when any
 * binding is invalid, signalling that the caller must retain every last-good
 * consumer. A cold start has no last-good batch, so it prepares each binding
 * independently and leaves only invalid siblings inactive.
 * @param workflow - Definition whose bindings are being reconciled.
 * @param hasLiveConsumers - Whether this workflow already owns consumers.
 * @param kinds - Optional changed-kind scope. Bindings outside it are not
 *   prepared and are represented by `undefined` at their stable array index.
 * @returns Prepared bindings, with invalid cold-start siblings represented by
 *   `undefined`; or `undefined` for a rejected last-good refresh.
 */
function prepareDefinitionBindings(
  workflow: WorkflowDefinition,
  hasLiveConsumers: boolean,
  kinds?: ReadonlySet<string>,
): readonly (ConsumerRecord | undefined)[] | undefined {
  const triggers = workflow.triggers ?? [];
  try {
    if (kinds === undefined) return prepareBindings(triggers);
    return triggers.map((trigger) => (kinds.has(trigger.kind) ? prepareBinding(trigger) : undefined));
  } catch (error) {
    if (hasLiveConsumers) {
      console.error(
        `${LOG_PREFIX} keeping last-good triggers for workflow "${workflow.id}": its trigger bindings are invalid`,
        error,
      );
      return undefined;
    }

    return triggers.map((trigger, triggerIndex) => {
      if (kinds !== undefined && !kinds.has(trigger.kind)) return undefined;
      try {
        return prepareBinding(trigger);
      } catch (bindingError) {
        console.error(
          `${LOG_PREFIX} leaving invalid trigger ${triggerIndex} of workflow "${workflow.id}" inactive`,
          bindingError,
        );
        return undefined;
      }
    });
  }
}

/**
 * Whether this workflow scope may consume the prepared trigger binding.
 *
 * Cron bindings on global definitions are deliberately inactive: there is no
 * single-host authority for a global schedule, so activating one in every
 * workflow-engine host would start the same workflow multiple times. Other
 * trigger kinds remain eligible at global scope because their sources already
 * define their own delivery authority.
 * @param workflow - Workflow definition that declares the binding.
 * @param binding - Prepared trigger binding to evaluate.
 * @returns `true` when the reconciler should attach a consumer.
 */
function isEligibleConsumer(workflow: WorkflowDefinition, binding: WorkflowAutomationTriggerBinding): boolean {
  return workflow.scope.type !== 'global' || binding.kind !== CRON_AUTOMATION_TRIGGER_KIND;
}

/**
 * Releases consumers whose declaration disappeared or became ineligible.
 *
 * During a changed-kind-scoped registry replay, declarations outside the exact
 * affected set are deliberately ignored so their last-good consumers remain
 * untouched.
 * @param workflow - Definition currently being reconciled.
 * @param prepared - Prepared bindings indexed by declaration position.
 * @param kinds - Optional exact changed-kind scope of the reconciliation.
 * @param consumers - Existing consumer records, when the workflow has any.
 * @returns Resolves after every required detach settles.
 */
async function detachOutdatedConsumers(
  workflow: WorkflowDefinition,
  prepared: readonly (ConsumerRecord | undefined)[],
  kinds: ReadonlySet<string> | undefined,
  consumers: Map<number, ConsumerRecord> | undefined,
): Promise<void> {
  if (consumers === undefined) return;
  for (const [triggerIndex, current] of Array.from(consumers)) {
    const declared = workflow.triggers?.[triggerIndex];
    if (declared !== undefined && kinds !== undefined && !kinds.has(declared.kind)) continue;
    const next = prepared[triggerIndex];
    if (next !== undefined && isEligibleConsumer(workflow, next.binding)) continue;
    consumers.delete(triggerIndex);
    await detachQuietly(current.subscription);
  }
}

/**
 * Detaches one subscription, logging rather than propagating failures.
 *
 * Detaching a handle whose activation was already stopped is a no-op in the
 * binding runtime, so teardown of a stale handle is always safe.
 * @param subscription - Handle to release, or `undefined` for a consumer whose
 *   first acquisition never settled.
 * @returns Resolves once the release has settled.
 */
async function detachQuietly(subscription: AutomationTriggerSubscription | undefined): Promise<void> {
  if (subscription === undefined) return;
  try {
    await subscription.detach();
  } catch (error) {
    console.error(`${LOG_PREFIX} detach failed for '${subscription.bindingKey}':`, error);
  }
}

// ─────────────────────────────────────────────────────────────
// Reconciler
// ─────────────────────────────────────────────────────────────

/**
 * Keeps declarative workflow triggers subscribed to the automation trigger
 * binding runtime.
 *
 * The reconciler is the workflow engine's only consumer of automation triggers.
 * It owns no trigger sources and no timers: every persisted
 * {@link WorkflowAutomationTriggerBinding} becomes one listener on the shared
 * runtime, and the runtime decides how many live sources that requires.
 *
 * Four invariants define it:
 *
 * 1. **Storage is the source of truth.** Reconciliation always reads the
 *    persisted definitions. Workflow CRUD events and
 *    `automation-triggers.changed` events are refresh *signals*, never the state
 *    itself, which is why an extension re-enable restores a binding with no
 *    workflow CRUD event of its own.
 * 2. **Stable consumer keys.** A consumer is identified by `workflowId` plus the
 *    binding's index in the definition's `triggers` array, so a refresh replaces
 *    exactly the consumer it belongs to and leaves that workflow's other
 *    bindings untouched.
 * 3. **Acquire, designate, release.** Every refresh of a live consumer subscribes
 *    the replacement **before** releasing the previous handle, so a source both
 *    bindings share is never torn down and re-activated, and a failed acquisition
 *    cannot leave a gap. Re-acquiring an unchanged binding is deliberately not
 *    special-cased: canonical sharing means it joins the activation it already
 *    holds, so the refresh is churn-free by construction. Because the overlap
 *    leaves two listeners of the same consumer briefly attached, exactly one of
 *    them is *designated* — see {@link ConsumerRecord} — so one event still
 *    produces exactly one workflow start. Which one is designated during the
 *    overlap follows from whether the replacement resolves to the activation its
 *    predecessor's handle already holds, not from timing: a replacement that
 *    shares its predecessor's activation
 *    stays undesignated until it is live (the outgoing listener is already on
 *    that activation and covers every event), while a replacement targeting a
 *    *different* activation is designated **before** `subscribe` — its new source
 *    may emit from inside `activate`, and the outgoing listener cannot cover an
 *    event of an activation it is not attached to. Either way designation moves
 *    strictly **before** the previous handle is released, so the release — whose
 *    extension-owned cleanup may take arbitrarily long — can never leave a window
 *    in which the outgoing listener is already detached while the incoming one is
 *    not yet allowed to start. One residual window remains, and is theoretical
 *    rather than reachable through storage: for a *changed* binding, events the
 *    outgoing source emits between the early designation and the completed
 *    acquisition are dropped. They belong to the binding the definition just
 *    replaced, so dropping them is the intended reading of a changed binding; if
 *    the acquisition then fails, `keep-last-good` restores that designation and
 *    the outgoing listener resumes starting the workflow.
 *    Acquiring the replacement through {@link AutomationTriggerBindingRuntime}'s
 *    `subscribe`/`detach` pair rather than a single combined swap is what makes
 *    that ordering expressible, and it is also what lets a refresh survive a
 *    runtime restart: the previous handle is released against the runtime that
 *    issued it, while the replacement is acquired from the one resolved now.
 * 4. **Availability is probed, not tracked.** The reconciler keeps no record of
 *    which trigger kinds are currently registered. A kind that has gone away
 *    surfaces as a failed acquisition during the refresh that the registry's
 *    `changed` event triggers, and the consumer is dropped there — which is also
 *    what guarantees no executable closure survives a deregistration. Probing is
 *    scoped by the exact old/new kind union the event carries: only bindings
 *    whose registration may have changed are re-acquired. Owner prefixes are
 *    deliberately not used as identity because owner names may overlap.
 */
export class WorkflowTriggerReconciler {
  /** Live consumers: workflow id → trigger index → subscription record. */
  private readonly consumers = new Map<string, Map<number, ConsumerRecord>>();
  /** Bus subscription cleanups registered by {@link init}. */
  private readonly cleanupFns: Array<() => void> = [];
  /** Records whether a completed initialization is currently live. */
  private initialized = false;
  /** Shared in-flight initialization, cleared after success or rollback. */
  private initialization: Promise<void> | undefined;
  /**
   * FIFO reconciliation lane.
   *
   * Refresh signals arrive concurrently — a CRUD event can land while a registry
   * change is still acquiring — and reconciliation is asynchronous because
   * activation is. Serializing every mutation keeps the consumer index and the
   * runtime's reference counts consistent.
   */
  private readonly lane = new SerialLane();
  /**
   * Registry `changed` events whose reconciliation is still pending.
   *
   * A registry change identifies the exact union of one owner's old and new
   * batches, and a contributor replay emits one such event per owner within a
   * single turn. Collecting the events here and flushing on a trailing microtask
   * turns that burst into one pass over the union of their kinds — one storage
   * read instead of one per event. Retaining the complete payload also keeps the
   * owner and revision visible in reconciliation diagnostics.
   *
   * Non-empty exactly while a flush is scheduled, which is also what lets
   * {@link teardown} cancel a pending flush by clearing it.
   */
  private readonly pendingChanges: AutomationTriggerChangedPayload[] = [];

  /**
   * @param bus - Shared runtime bus.
   * @param resolveRuntime - Resolves the currently live binding runtime.
   *   Consulted per reconciliation rather than captured, so a runtime that
   *   restarts is picked up by the next refresh instead of leaving the engine
   *   holding a dead reference.
   */
  public constructor(
    private readonly bus: IMakaioBus,
    private readonly resolveRuntime: () => AutomationTriggerBindingRuntime | undefined,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribes to refresh signals and reconciles the persisted definitions.
   *
   * Idempotent across concurrent and completed calls. A failure while loading
   * the persisted definitions rolls back the signal subscriptions so a later
   * attempt can initialize from a clean state.
   * @returns Resolves once the initial reconciliation has settled.
   * @throws When the persisted definitions cannot be loaded.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    if (this.initialization !== undefined) return this.initialization;

    const initialization = this.initialize();
    this.initialization = initialization;
    void initialization.then(
      () => this.clearInitialization(initialization),
      () => this.clearInitialization(initialization),
    );

    return initialization;
  }

  /**
   * Clears the matching completed initialization attempt.
   * @param initialization - Initialization attempt whose completion is being cleared.
   */
  private clearInitialization(initialization: Promise<void>): void {
    if (this.initialization === initialization) this.initialization = undefined;
  }

  /**
   * Performs one initialization attempt after {@link init} has made it exclusive.
   * @returns Resolves once the initial reconciliation has settled.
   * @throws When the persisted definitions cannot be loaded.
   */
  private async initialize(): Promise<void> {
    try {
      // Every definition subject is the same refresh signal for the workflow it
      // names, deletion included: the refresh re-reads storage and forgets a
      // workflow it no longer finds there. The three registrations stay separate
      // because `deleted` carries a narrower payload than the other two, so one
      // handler over a subject union would lose its contextual typing.
      const onDefinitionSignal = ({ payload }: { readonly payload: { readonly id: string } }): void => {
        this.onSignal(`refresh of workflow "${payload.id}"`, () => this.refreshDefinition(payload.id));
      };

      this.cleanupFns.push(
        this.bus.on(WorkflowSubjects.definition.created, onDefinitionSignal),
        this.bus.on(WorkflowSubjects.definition.updated, onDefinitionSignal),
        this.bus.on(WorkflowSubjects.definition.deleted, onDefinitionSignal),
        this.bus.on(AutomationTriggerSubjects.changed, (ctx) => {
          this.scheduleRegistryReconcile(ctx.payload);
        }),
      );

      await this.reconcileStored('keep-last-good');
      this.initialized = true;
    } catch (error) {
      await this.teardown();
      throw error;
    }
  }

  /**
   * Detaches every consumer subscription and stops listening for refreshes.
   *
   * Idempotent, and safe to call on a reconciler that never initialized.
   * @returns Resolves once every detach has settled.
   */
  public async destroy(): Promise<void> {
    await this.teardown();
    this.initialized = false;
  }

  /**
   * Number of live consumer subscriptions across all workflows.
   *
   * Consumer count, not activation count: two workflows sharing one source
   * report two consumers.
   * @returns Count of live consumers.
   */
  public activeConsumerCount(): number {
    let total = 0;
    for (const workflowConsumers of this.consumers.values()) total += workflowConsumers.size;
    return total;
  }

  // -------------------------------------------------------------------------
  // Refresh signals
  // -------------------------------------------------------------------------

  /**
   * Runs one refresh signal detached from the bus handler that raised it.
   *
   * Bus handlers must not be delayed by reconciliation, and a reconciliation that
   * fails must not surface as a failure of the emitter that signalled it — so the
   * work is detached and its failure logged here, in the one place every signal
   * passes through.
   * @param describe - What was being reconciled, used in the failure log.
   * @param operation - Reconciliation to run.
   */
  private onSignal(describe: string, operation: () => Promise<void>): void {
    void operation().catch((error: unknown) => {
      console.error(`${LOG_PREFIX} ${describe} failed:`, error);
    });
  }

  /**
   * Records one registry `changed` event and schedules the coalesced pass.
   *
   * The flush runs on a trailing microtask, so every kind named within the turn
   * that raised the first event is reconciled by one pass — see
   * {@link pendingChanges}.
   * @param change - Exact changed-kind scope plus owner/revision diagnostics.
   */
  private scheduleRegistryReconcile(change: AutomationTriggerChangedPayload): void {
    const flushScheduled = this.pendingChanges.length > 0;
    this.pendingChanges.push(change);
    if (flushScheduled) return;

    queueMicrotask(() => {
      // Empty only when `teardown` cleared the queue, which cancels this flush: a
      // reconciliation running after teardown would re-subscribe what it released.
      if (this.pendingChanges.length === 0) return;
      const changes = this.pendingChanges.splice(0);
      const kinds = new Set(changes.flatMap(({ kinds: changedKinds }) => changedKinds));
      const sources = changes.map(({ owner, revision }) => `${owner}@${revision}`).join(', ');

      this.onSignal(`reconciliation after trigger registry changes (${sources})`, () =>
        this.reconcileStored('drop-unavailable', kinds),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconciles the persisted workflow definitions and forgets consumers whose
   * workflow no longer exists.
   * @param onFailure - Policy applied when a consumer cannot be acquired.
   * @param kinds - When given, restricts reconciliation to the exact trigger
   *   kinds whose registration may have changed; a workflow declaring none of
   *   them is left untouched. Omitted at startup, where every binding still has
   *   to be acquired.
   * @returns Resolves once every workflow in scope has been reconciled.
   * @throws When the persisted definitions cannot be listed.
   */
  private async reconcileStored(onFailure: AcquisitionFailurePolicy, kinds?: ReadonlySet<string>): Promise<void> {
    await this.lane.run(async () => {
      // Read inside the lane: a snapshot taken before entering it can be
      // arbitrarily old by the time the lane drains, which would let a
      // reconciliation resurrect a workflow deleted meanwhile or forget one
      // created meanwhile.
      const { workflows } = await this.bus.request(WorkflowStorageSubjects.list, {});
      const stored = new Set(workflows.map((workflow) => workflow.id));

      for (const workflow of workflows) {
        const triggers = workflow.triggers ?? [];
        if (kinds !== undefined && !triggers.some((trigger) => kinds.has(trigger.kind))) continue;
        await this.applyDefinitionWithinLane(workflow, onFailure, kinds);
      }
      // Unscoped on purpose: a workflow storage no longer holds declares no
      // bindings at all, so no changed-kind scope can claim it and releasing its
      // consumers costs nothing but the detaches it owes.
      for (const workflowId of Array.from(this.consumers.keys())) {
        if (!stored.has(workflowId)) await this.forgetWorkflowWithinLane(workflowId);
      }
    });
  }

  /**
   * Reconciles one workflow against storage after a CRUD event named it.
   *
   * The event supplies identity only. The definition is re-read inside the lane,
   * so what is applied is the workflow as it stands when the refresh actually
   * runs — which is also why a deletion needs no separate signal path: a workflow
   * storage no longer holds is simply forgotten.
   * @param workflowId - Workflow named by the event.
   * @returns Resolves once the refresh has settled.
   * @throws When the definition cannot be read.
   */
  private async refreshDefinition(workflowId: string): Promise<void> {
    await this.lane.run(async () => {
      const { workflow } = await this.bus.request(WorkflowStorageSubjects.get, { id: workflowId });
      if (workflow === null) {
        await this.forgetWorkflowWithinLane(workflowId);
        return;
      }
      await this.applyDefinitionWithinLane(workflow, 'keep-last-good');
    });
  }

  /**
   * Brings one workflow's consumers in line with its definition. Lane-internal.
   * @param workflow - Definition to apply.
   * @param onFailure - Policy applied when a consumer cannot be acquired.
   * @param kinds - When given, only consumers whose binding has an exact kind in
   *   this changed set are refreshed. Bindings outside the scope keep the
   *   subscriptions they hold — nothing about them changed.
   * @returns Resolves once every consumer of this workflow in scope has settled.
   */
  private async applyDefinitionWithinLane(
    workflow: WorkflowDefinition,
    onFailure: AcquisitionFailurePolicy,
    kinds?: ReadonlySet<string>,
  ): Promise<void> {
    const prepared = prepareDefinitionBindings(workflow, (this.consumers.get(workflow.id)?.size ?? 0) > 0, kinds);
    if (prepared === undefined) return;

    // Eligibility is a consumer concern and is evaluated after preparation so
    // malformed bindings still follow the same last-good policy. Remove an
    // existing consumer before resolving a runtime: its subscription owns its
    // issuing runtime, so an external → global scope transition must detach even
    // while no replacement runtime is available.
    const existingConsumers = this.consumers.get(workflow.id);
    await detachOutdatedConsumers(workflow, prepared, kinds, existingConsumers);
    if (existingConsumers?.size === 0) this.consumers.delete(workflow.id);

    const hasEligibleConsumer = prepared.some(
      (next) =>
        next !== undefined &&
        isEligibleConsumer(workflow, next.binding) &&
        (kinds === undefined || kinds.has(next.binding.kind)),
    );
    if (!hasEligibleConsumer) return;

    const runtime = this.resolveRuntime();
    if (runtime === undefined) {
      if (prepared.length > 0) {
        console.warn(
          `${LOG_PREFIX} no automation trigger binding runtime is available; ` +
            `declarative triggers of workflow "${workflow.id}" stay inactive`,
        );
      }
      return;
    }

    // Indexed before any consumer is touched: the listener gate resolves a record
    // through this map, so a trigger that emits inside `activate` must already be
    // able to find its own consumer.
    let consumers = this.consumers.get(workflow.id);
    if (consumers === undefined) {
      consumers = new Map<number, ConsumerRecord>();
      this.consumers.set(workflow.id, consumers);
    }

    for (const [triggerIndex, next] of prepared.entries()) {
      if (next === undefined) continue;
      if (!isEligibleConsumer(workflow, next.binding)) continue;
      if (kinds !== undefined && !kinds.has(next.binding.kind)) continue;
      await this.refreshConsumerWithinLane(runtime, workflow.id, triggerIndex, next, consumers, onFailure);
    }

    if (consumers.size === 0) this.consumers.delete(workflow.id);
  }

  /**
   * Acquires or replaces one consumer subscription. Lane-internal.
   * @param runtime - Live binding runtime.
   * @param workflowId - Workflow owning this consumer.
   * @param triggerIndex - Position of the binding in the definition.
   * @param next - Prepared consumer record to install.
   * @param consumers - Mutable consumer index of this workflow.
   * @param onFailure - Policy applied when the acquisition fails.
   * @returns Resolves once the consumer has settled.
   */
  private async refreshConsumerWithinLane(
    runtime: AutomationTriggerBindingRuntime,
    workflowId: string,
    triggerIndex: number,
    next: ConsumerRecord,
    consumers: Map<number, ConsumerRecord>,
    onFailure: AcquisitionFailurePolicy,
  ): Promise<void> {
    const current = consumers.get(triggerIndex);
    const listener = this.createListener(workflowId, triggerIndex, next);

    // Who may start this workflow while the acquisition is in flight, decided
    // structurally rather than by timing, by asking the runtime which activation
    // the replacement resolves to and comparing it with the one the live handle
    // holds:
    //
    // - No live predecessor, or a predecessor on a *different* activation:
    //   designate the incoming record now. Its listener is attached the moment
    //   `subscribe` indexes the new activation, which is before `activate`
    //   returns — so a trigger that emits inside `activate` reaches a designated
    //   listener instead of being dropped by the identity gate. The outgoing
    //   listener cannot cover that event: it belongs to a different activation,
    //   whose emissions are stale by definition. An unresolvable replacement
    //   counts as different — a binding whose kind is gone shares nothing.
    // - A predecessor on the *same* activation: keep it designated until the
    //   replacement is live. `subscribe` joins the activation both share, so the
    //   outgoing listener already receives every event on it — designating early
    //   would gain nothing and designating both would double-start.
    try {
      const liveKey = current?.subscription?.bindingKey;
      const preparedBinding = runtime.prepareBinding(next.binding);
      if (preparedBinding === undefined) {
        throw new Error(`Automation trigger kind '${next.binding.kind}' is not registered`);
      }
      if (!preparedBinding.workflowCompatible) {
        throw new Error(`Automation trigger kind '${next.binding.kind}' does not emit an object-root payload`);
      }
      const designateBeforeSubscribe = liveKey === undefined || liveKey !== preparedBinding.bindingKey;
      if (designateBeforeSubscribe) consumers.set(triggerIndex, next);

      next.subscription = await preparedBinding.subscribe(listener);
      // Designated before the release below, not after it: the release awaits
      // extension-owned cleanup, and a designation that waited for it would drop
      // every event delivered to the new listener while that cleanup ran.
      consumers.set(triggerIndex, next);
      // Released against whichever runtime issued it, which is what carries a
      // consumer across a binding-runtime restart: the handle is dead to the
      // runtime resolved above, and `detachQuietly` tolerates that.
      await detachQuietly(current?.subscription);
      return;
    } catch (error) {
      // Restore the designation an early swap took away, so `keep-last-good`
      // really does keep the last good listener able to start the workflow. A
      // no-op when nothing was swapped: the map already holds `current`.
      if (current === undefined) consumers.delete(triggerIndex);
      else consumers.set(triggerIndex, current);

      if (onFailure === 'keep-last-good') {
        console.error(
          `${LOG_PREFIX} keeping last-good trigger ${triggerIndex} of workflow "${workflowId}": ` +
            `binding '${next.binding.kind}' could not be activated`,
          error,
        );
        return;
      }

      console.warn(
        `${LOG_PREFIX} dropping trigger ${triggerIndex} of workflow "${workflowId}": ` +
          `binding '${next.binding.kind}' is no longer available`,
        error,
      );
      consumers.delete(triggerIndex);
      await detachQuietly(current?.subscription);
    }
  }

  /**
   * Releases every consumer of one workflow. Lane-internal.
   * @param workflowId - Workflow to forget.
   * @returns Resolves once every detach has settled.
   */
  private async forgetWorkflowWithinLane(workflowId: string): Promise<void> {
    const consumers = this.consumers.get(workflowId);
    if (consumers === undefined) return;
    this.consumers.delete(workflowId);
    for (const record of consumers.values()) await detachQuietly(record.subscription);
  }

  // -------------------------------------------------------------------------
  // Event delivery
  // -------------------------------------------------------------------------

  /**
   * Builds the listener that turns one trigger event into a workflow start.
   *
   * The listener first checks that its own record is still the designated one for
   * this consumer key, so a listener that has been superseded or dropped can
   * neither double-start a workflow during a refresh overlap nor start one after
   * its trigger type went away. Consumer-owned filters run next, then the payload
   * is projected onto the `triggerPayload` contract.
   *
   * Every failure is logged against this consumer's identity and swallowed: a
   * listener rejection would otherwise surface as a failure of the unrelated
   * source that emitted the event.
   * @param workflowId - Workflow to start on a match.
   * @param triggerIndex - Consumer position, used in diagnostics.
   * @param record - Consumer record this listener belongs to.
   * @returns Listener to attach to the binding runtime.
   */
  private createListener(workflowId: string, triggerIndex: number, record: ConsumerRecord): AutomationTriggerListener {
    const describe = `trigger ${triggerIndex} ('${record.binding.kind}') of workflow "${workflowId}"`;

    return async (event) => {
      if (this.consumers.get(workflowId)?.get(triggerIndex) !== record) return;

      let matched: boolean;
      try {
        matched = record.matches(event.payload);
      } catch (error) {
        console.error(`${LOG_PREFIX} filter evaluation failed for ${describe}:`, error);
        return;
      }
      if (!matched) return;

      try {
        await this.bus.request(WorkflowSubjects.start, {
          workflowId,
          triggerPayload: assertWorkflowTriggerPayload(event.payload),
        });
      } catch (error) {
        console.error(`${LOG_PREFIX} failed to start workflow "${workflowId}" from ${describe}:`, error);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Removes signal subscriptions, cancels a pending coalesced pass, and releases
   * every consumer.
   * @returns Resolves once every detach has settled.
   */
  private async teardown(): Promise<void> {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns.length = 0;
    this.pendingChanges.length = 0;

    await this.lane.run(async () => {
      for (const workflowId of Array.from(this.consumers.keys())) {
        await this.forgetWorkflowWithinLane(workflowId);
      }
    });
  }
}
