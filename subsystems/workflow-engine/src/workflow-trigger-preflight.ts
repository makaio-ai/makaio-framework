/**
 * Activation preflight of declarative workflow trigger bindings.
 *
 * Prepares a trigger binding for activation — resolving it against the binding
 * runtime and compiling its `when` condition against the trigger's event schema —
 * and checks every `when` condition of a refresh before any existing consumer is
 * replaced, so one unusable condition rejects the whole refresh and the workflow
 * keeps its last-good consumers.
 *
 * Internal to the workflow engine: used by the trigger reconciler, deliberately
 * not part of the package index. This module owns the types both sides share, so
 * imports stay one-directional (reconciler → preflight).
 */
import type { WorkflowAutomationTriggerBinding, WorkflowDefinition } from '@makaio/contracts';
import { CRON_AUTOMATION_TRIGGER_KIND } from '@makaio/contracts';
import type {
  AutomationTriggerBindingRuntime,
  PreparedAutomationTriggerBinding,
} from '@makaio/services-core/automation-trigger';
import {
  compileWorkflowTriggerCondition,
  type WorkflowTriggerConditionEvaluator,
} from './workflow-trigger-binding-consumer.js';

/** Log prefix for reconciler diagnostics. */
export const LOG_PREFIX = '[WorkflowTriggerReconciler]';

/**
 * A schema-validated binding that is not yet checked against its trigger's event
 * schema. That check needs the binding runtime, so it runs at activation, where
 * the consumer record is built. A refresh with live consumers runs the
 * condition part of it ahead of time as a batch (see
 * {@link preflightConditions}); every other activation failure is per binding.
 */
export interface PreparedBinding {
  /** Schema-validated binding. */
  readonly binding: WorkflowAutomationTriggerBinding;
}

/**
 * What a failed acquisition means for the consumer that was being refreshed.
 *
 * - `keep-last-good` — a definition refresh failed to activate. The workflow's
 *   previous subscriptions stay live, because a workflow that cannot express its
 *   new trigger must not silently lose the trigger it already had. Two scopes:
 *   a binding that fails schema validation or whose `when` condition does not
 *   compile against its event schema rejects the whole refresh of a workflow with
 *   live consumers, so no consumer is touched; an unregistered kind, bad
 *   parameters, a non-object payload or a rejected subscription keep only that
 *   one binding's last-good consumer while its siblings are refreshed.
 * - `drop-unavailable` — a registry change made the contributing trigger type
 *   unresolvable. The stale handle is released and forgotten, so no executable
 *   closure survives a deregistration and nothing can start the workflow until
 *   the type is registered again.
 */
export type AcquisitionFailurePolicy = 'keep-last-good' | 'drop-unavailable';

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
export function isEligibleConsumer(workflow: WorkflowDefinition, binding: WorkflowAutomationTriggerBinding): boolean {
  return workflow.scope.type !== 'global' || binding.kind !== CRON_AUTOMATION_TRIGGER_KIND;
}

/**
 * What a binding resolves to once the binding runtime has seen it: the prepared
 * runtime binding and its compiled `when` condition.
 */
export interface ActivationPlan {
  /** Runtime-side binding that subscribes the listener. */
  readonly preparedBinding: PreparedAutomationTriggerBinding;
  /** Compiled evaluator of the binding's `when` condition. */
  readonly matches: WorkflowTriggerConditionEvaluator;
  /** Non-blocking findings of the condition check. */
  readonly warnings: ReturnType<typeof compileWorkflowTriggerCondition>['warnings'];
}

/**
 * Outcome of preparing one binding ahead of a refresh: either a plan, or the
 * per-binding failure of `runtime.prepareBinding`, which the per-binding refresh
 * rethrows under its own policy.
 */
export type PreflightEntry = ActivationPlan | { readonly failure: unknown };

/**
 * Asks the runtime to prepare a binding for this workflow's consumer.
 * @param runtime - Live binding runtime.
 * @param binding - Schema-validated binding.
 * @returns The prepared runtime binding.
 * @throws When the kind is not registered, its parameters are invalid, or it
 *   does not emit an object-root payload.
 */
export function resolveRuntimeBinding(
  runtime: AutomationTriggerBindingRuntime,
  binding: WorkflowAutomationTriggerBinding,
): PreparedAutomationTriggerBinding {
  const preparedBinding = runtime.prepareBinding(binding);
  if (preparedBinding === undefined) {
    throw new Error(`Automation trigger kind '${binding.kind}' is not registered`);
  }
  if (!preparedBinding.workflowCompatible) {
    throw new Error(`Automation trigger kind '${binding.kind}' does not emit an object-root payload`);
  }
  return preparedBinding;
}

/**
 * Compiles a binding's `when` condition against an already prepared runtime
 * binding.
 * @param binding - Schema-validated binding.
 * @param preparedBinding - Runtime binding supplying the event schema.
 * @returns The activation plan.
 * @throws When the condition does not fit the event schema or has a syntax error.
 */
export function compileActivationPlan(
  binding: WorkflowAutomationTriggerBinding,
  preparedBinding: PreparedAutomationTriggerBinding,
): ActivationPlan {
  const { matches, warnings } = compileWorkflowTriggerCondition(binding, preparedBinding.eventSchema);
  return { preparedBinding, matches, warnings };
}

/**
 * Prepares and compiles every in-scope, eligible binding of a refresh before any
 * consumer is touched.
 *
 * Only the condition check is batch-atomic: it throws, which rejects the whole
 * refresh. A failure of `runtime.prepareBinding` itself stays per binding and is
 * returned as a failure entry for the per-binding refresh to handle.
 * @param runtime - Live binding runtime.
 * @param workflow - Definition being reconciled.
 * @param prepared - Prepared bindings indexed by declaration position.
 * @param kinds - Optional exact changed-kind scope of the reconciliation.
 * @returns Entries by trigger index.
 * @throws When any binding's `when` condition cannot be compiled.
 */
function preflightConditions(
  runtime: AutomationTriggerBindingRuntime,
  workflow: WorkflowDefinition,
  prepared: readonly (PreparedBinding | undefined)[],
  kinds: ReadonlySet<string> | undefined,
): ReadonlyMap<number, PreflightEntry> {
  const entries = new Map<number, PreflightEntry>();
  for (const [triggerIndex, next] of prepared.entries()) {
    if (next === undefined || !isEligibleConsumer(workflow, next.binding)) continue;
    if (kinds !== undefined && !kinds.has(next.binding.kind)) continue;
    let preparedBinding: PreparedAutomationTriggerBinding;
    try {
      preparedBinding = resolveRuntimeBinding(runtime, next.binding);
    } catch (failure) {
      entries.set(triggerIndex, { failure });
      continue;
    }
    entries.set(triggerIndex, compileActivationPlan(next.binding, preparedBinding));
  }
  return entries;
}

/**
 * Runs {@link preflightConditions} when the refresh must be batch-atomic, and
 * turns a condition failure into the last-good log of a rejected refresh.
 *
 * Only a `keep-last-good` refresh of a workflow with live consumers and a
 * resolvable runtime preflights; a cold start and `drop-unavailable` stay per
 * binding.
 * @param runtime - Live binding runtime, when one is available.
 * @param onFailure - Policy applied when a consumer cannot be acquired.
 * @param existing - Existing consumer records of the workflow, when any.
 * @param workflow - Definition being reconciled.
 * @param prepared - Prepared bindings indexed by declaration position.
 * @param kinds - Optional exact changed-kind scope of the reconciliation.
 * @returns The preflight entries, `undefined` when no preflight applies, or `'rejected'` after logging that the
 *   workflow keeps every last-good consumer.
 */
export function preflightOrReject(
  runtime: AutomationTriggerBindingRuntime | undefined,
  onFailure: AcquisitionFailurePolicy,
  existing: ReadonlyMap<number, unknown> | undefined,
  workflow: WorkflowDefinition,
  prepared: readonly (PreparedBinding | undefined)[],
  kinds: ReadonlySet<string> | undefined,
): ReadonlyMap<number, PreflightEntry> | 'rejected' | undefined {
  if (runtime === undefined || onFailure !== 'keep-last-good' || (existing?.size ?? 0) === 0) return undefined;
  try {
    return preflightConditions(runtime, workflow, prepared, kinds);
  } catch (error) {
    console.error(
      `${LOG_PREFIX} keeping last-good triggers for workflow "${workflow.id}": a trigger condition cannot be compiled`,
      error,
    );
    return 'rejected';
  }
}
