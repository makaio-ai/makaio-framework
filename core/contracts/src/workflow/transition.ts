import { z } from 'zod';
import type { ArtifactRevision } from '../artifact/schemas.js';
import { JsonValueSchema } from '../shared/json-value.js';

// ─────────────────────────────────────────────────────────────
// Transition Event Types
// ─────────────────────────────────────────────────────────────

/**
 * The set of artifact bus events that can trigger a transition rule.
 *
 * - `artifact.created` — fires when a new artifact is created
 * - `artifact.revised` — fires when an existing artifact receives a new revision
 * - `artifact.status.changed` — fires when a tracked status field changes
 */
export const TransitionEventTypeSchema = z.enum(['artifact.created', 'artifact.revised', 'artifact.status.changed']);

export type TransitionEventType = z.infer<typeof TransitionEventTypeSchema>;

// ─────────────────────────────────────────────────────────────
// Transition Condition
// ─────────────────────────────────────────────────────────────

/**
 * Serializable condition evaluated against an artifact event payload.
 *
 * Stored as an opaque JSON record in the contracts layer. The pipeline
 * service interprets this using `@makaio/rules` at evaluation time,
 * supporting field comparisons, `$and`/`$or`/`$not` combinators, and
 * `$expr` jexl expression strings.
 *
 * Evaluation context shape:
 * - `artifact` — the `ArtifactRevision` involved in the event
 * - `previous` — the previous `ArtifactRef` for `artifact.revised` events
 * - `previousArtifact` — the resolved previous `ArtifactRevision` for
 *   `artifact.revised` events when the artifact store can provide it
 * - `path` — the status path for `artifact.status.changed` events
 * - `current` — the new status value for `artifact.status.changed` events
 */
export const TransitionConditionSchema = z.record(z.string(), JsonValueSchema);

export type TransitionCondition = z.infer<typeof TransitionConditionSchema>;

// ─────────────────────────────────────────────────────────────
// Transition Action Invocation
// ─────────────────────────────────────────────────────────────

/**
 * Invocation descriptor for the action to execute when a transition rule fires.
 *
 * `type` selects the registered action handler; `input` supplies the
 * action-specific payload.
 *
 * Built-in action type:
 * - `'workflow.start'` — start a workflow execution via the bus
 */
export const TransitionActionInvocationSchema = z.object({
  /**
   * Registered action type identifier.
   *
   * Must match an entry in `TransitionActionRegistry`.
   * Built-in value: `'workflow.start'`.
   */
  type: z.string().min(1),
  /**
   * Action-specific input payload.
   *
   * For `workflow.start`, this object is merged into the `workflow.start`
   * bus request. Required fields per action type are validated by the
   * action handler at dispatch time.
   */
  input: z.record(z.string(), JsonValueSchema).optional(),
});

export type TransitionActionInvocation = z.infer<typeof TransitionActionInvocationSchema>;

// ─────────────────────────────────────────────────────────────
// Transition Rule Definition
// ─────────────────────────────────────────────────────────────

/**
 * Declarative rule that watches artifact events and triggers workflow actions.
 *
 * Transition rules are purely serializable — no functions. The pipeline service
 * evaluates the `when` condition against the incoming artifact event payload and
 * dispatches the `action` through the `TransitionActionRegistry` when the
 * condition matches.
 *
 * ID namespacing:
 * - Bundle-contributed rules: `'<bundleId>.<localId>'`
 * - Extension-contributed rules: `'<extensionName>.<localId>'`
 *
 * Duplicate IDs across all sources hard-fail activation.
 */
export const TransitionRuleDefinitionSchema = z.object({
  /**
   * Unique transition rule identifier.
   *
   * Must be non-empty. Prefixed with the contributing bundle or extension
   * name to prevent collisions. Duplicate IDs hard-fail activation.
   */
  id: z.string().min(1),
  /**
   * Human-readable description for diagnostics and tooling display.
   */
  description: z.string().optional(),
  /**
   * Artifact event type that triggers evaluation of this rule.
   */
  on: TransitionEventTypeSchema,
  /**
   * Structural condition evaluated against the event context.
   *
   * When present and the condition evaluates falsy, the action is not dispatched.
   * When omitted, the rule fires for every matching event type.
   *
   * The condition is an opaque JSON record interpreted by `@makaio/rules`
   * at evaluation time. See {@link TransitionConditionSchema} for the
   * supported operator vocabulary.
   */
  when: TransitionConditionSchema.optional(),
  /**
   * Action to dispatch when the rule matches.
   */
  action: TransitionActionInvocationSchema,
  /**
   * Whether this rule is active.
   *
   * Disabled rules are skipped during pipeline evaluation.
   * Defaults to `true`.
   */
  enabled: z.boolean().default(true),
});

export type TransitionRuleDefinition = z.infer<typeof TransitionRuleDefinitionSchema>;

// ─────────────────────────────────────────────────────────────
// Extension Contribution Types
// ─────────────────────────────────────────────────────────────

/**
 * Transition rule contribution surface for extension packages.
 *
 * Declarative static rules contributed by an extension. Processed by
 * `TransitionContributionProcessor` during extension activation.
 */
export interface ExtensionTransitionRulesContribution {
  /**
   * Transition rule definitions contributed by this extension.
   *
   * All IDs must be prefixed with `'<extensionName>.'` (enforced by the
   * contribution processor). Duplicate IDs hard-fail activation.
   */
  readonly rules: readonly TransitionRuleDefinition[];
}

/**
 * Callable transition action handler.
 *
 * Invoked by the pipeline when a matching rule fires. Receives the resolved
 * invocation and the artifact event context so it can read artifact data when
 * building downstream bus requests.
 */
export interface TransitionActionHandler {
  /**
   * Execute the action.
   * @param invocation - Resolved action invocation descriptor.
   * @param context - Evaluation context built from the triggering artifact event.
   * @returns Promise that resolves when the action dispatch completes.
   */
  readonly execute: (invocation: TransitionActionInvocation, context: TransitionEvaluationContext) => Promise<void>;
}

/**
 * Factory that creates a {@link TransitionActionHandler} for a given action type.
 *
 * Factories are registered at contribution time and instantiated lazily by the
 * pipeline service.
 */
export type TransitionActionFactory = () => TransitionActionHandler;

/**
 * Transition action factory contribution surface for extension packages.
 *
 * Extensions that need custom action semantics beyond the built-in
 * `workflow.start` action register their handler factories here.
 */
export interface ExtensionTransitionActionsContribution {
  /**
   * Map of action type strings to action handler factories.
   *
   * Each key is a registered action `type` string as declared in
   * {@link TransitionActionInvocationSchema}. Values are factories
   * called once per rule dispatch to produce a fresh handler.
   *
   * All keys must be prefixed with `'<extensionName>.'`.
   */
  readonly actions: Readonly<Record<string, TransitionActionFactory>>;
}

// ─────────────────────────────────────────────────────────────
// Evaluation Context
// ─────────────────────────────────────────────────────────────

/**
 * Context object passed to condition evaluation and action dispatch.
 *
 * The pipeline builds this from the incoming artifact event payload so
 * that rules can reference `artifact`, `previous`, `path`, and `current`
 * fields using dot-notation in their `when` conditions.
 */
export interface TransitionEvaluationContext {
  /**
   * The artifact revision involved in the event.
   *
   * The transition pipeline resolves ref-oriented artifact events, such as
   * `artifact.status.changed`, before evaluating rules so authoring sees a
   * consistent full-revision context.
   */
  readonly artifact: ArtifactRevision;
  /**
   * Previous value from the artifact event. For `artifact.revised` this is the
   * previous artifact ref; for `artifact.status.changed` this is the previous
   * status value.
   */
  readonly previous?: unknown;
  /**
   * Resolved previous artifact revision for `artifact.revised` events.
   *
   * This preserves `previous` as the original event value while giving rules a
   * full before/after snapshot when they need to detect semantic deltas.
   */
  readonly previousArtifact?: ArtifactRevision;
  /**
   * JSON Pointer path to the status field that changed.
   * Present only for `artifact.status.changed` events.
   */
  readonly path?: string;
  /**
   * Current status value after the change.
   * Present only for `artifact.status.changed` events.
   */
  readonly current?: unknown;
  /**
   * Loop-protection metadata injected by the pipeline.
   *
   * Downstream actions can inspect this to detect and break
   * artifact-triggered → workflow → artifact cycles.
   */
  readonly _transition: {
    /**
     * The transition rule ID that fired this action.
     */
    readonly ruleId: string;
    /**
     * The artifact event type that matched the rule.
     */
    readonly eventType: TransitionEventType;
    /**
     * Depth counter tracking recursive transition invocations.
     *
     * The pipeline increments this on each nested trigger level.
     * Action handlers that re-emit artifact events must propagate this
     * metadata so the pipeline can reject invocations that exceed the
     * configured maximum depth.
     */
    readonly depth: number;
  };
}
