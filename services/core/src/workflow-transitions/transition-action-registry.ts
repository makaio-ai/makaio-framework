import type { IMakaioBus } from '@makaio/bus-core';
import { evaluateSync, type ExpressionContext } from '@makaio/expression';
import type {
  JsonValue,
  TransitionActionFactory,
  TransitionActionHandler,
  TransitionActionInvocation,
  TransitionEvaluationContext,
  WorkflowExecutionScope,
} from '@makaio/contracts';
import { JsonValueSchema, WorkflowSubjects } from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Built-in actions
// ─────────────────────────────────────────────────────────────

/**
 * Built-in action type identifier for starting a workflow via the bus.
 *
 * Input fields (all optional):
 * - `workflowId` — required workflow ID
 * - `input` — workflow input payload
 * - `inputExpression` — jexl expression resolving workflow input from the transition context
 * - `config` — workflow config overrides
 * - `artifactRef` — explicit artifact binding target
 * - `scope` — execution scope override
 */
export const WORKFLOW_START_ACTION_TYPE = 'workflow.start';

/**
 * Create the built-in `workflow.start` action factory.
 *
 * The factory wraps the bus request so the pipeline can invoke it without
 * importing bus subjects directly.
 * @param bus - Bus instance used for dispatching `workflow.start` requests.
 * @returns Factory that creates a handler for the `workflow.start` action type.
 */
function createWorkflowStartFactory(bus: IMakaioBus): TransitionActionFactory {
  return (): TransitionActionHandler => ({
    async execute(invocation: TransitionActionInvocation, context: TransitionEvaluationContext): Promise<void> {
      const { input = {}, executionHints } = invocation;
      const { workflowId } = input;

      if (typeof workflowId !== 'string' || workflowId.length === 0) {
        throw new Error(
          `[TransitionActionRegistry] 'workflow.start' action requires a non-empty 'input.workflowId' string`,
        );
      }

      await bus.request(WorkflowSubjects.start, {
        workflowId,
        input: resolveWorkflowStartInput(input, context),
        config: input['config'] as Record<string, unknown> | undefined,
        artifactRef: input['artifactRef'] as { readonly kind: string; readonly id: string } | undefined,
        scope: input['scope'] as WorkflowExecutionScope | undefined,
        triggerPayload: {
          _transitionRuleId: context._transition.ruleId,
          _transitionDepth: context._transition.depth,
          _transitionEventType: context._transition.eventType,
        },
        executionHints,
      });
    },
  });
}

/**
 * Resolve the downstream workflow input for the built-in `workflow.start`
 * transition action.
 *
 * Static `input` preserves the existing direct payload path. `inputExpression`
 * is evaluated against the artifact transition context and wins when present,
 * matching the documented rule-authoring form for artifact-derived workflow
 * inputs.
 * @param input - Action-specific input object from the transition rule.
 * @param context - Transition evaluation context for the triggering artifact event.
 * @returns JSON-safe workflow input payload, or `undefined` when omitted.
 */
function resolveWorkflowStartInput(
  input: Record<string, JsonValue>,
  context: TransitionEvaluationContext,
): JsonValue | undefined {
  const expression = input['inputExpression'];
  if (typeof expression !== 'string') {
    return input['input'] as JsonValue | undefined;
  }

  const scope = buildTransitionExpressionScope(context);
  const value = evaluateSync(expression, scope);
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[TransitionActionRegistry] 'workflow.start' inputExpression for rule '${context._transition.ruleId}' ` +
        `must resolve to a JSON value`,
    );
  }
  return parsed.data;
}

/**
 * Build the jexl scope used by transition action expressions.
 * @param context - Transition evaluation context.
 * @returns Expression package-compatible variable map with top-level and `ctx.*` aliases.
 */
function buildTransitionExpressionScope(context: TransitionEvaluationContext): ExpressionContext {
  const scope: ExpressionContext = { ...context };
  return {
    ...scope,
    ctx: scope,
  };
}

// ─────────────────────────────────────────────────────────────
// TransitionActionRegistry
// ─────────────────────────────────────────────────────────────

/**
 * Registry for executable transition action factories.
 *
 * Manages built-in actions (seeded at construction) and extension-contributed
 * actions. Duplicate action type keys hard-fail registration. Source keys
 * support clean deregistration on extension stop.
 *
 * Unlike rules, actions are executable (factory-based), not static. Each
 * dispatch call creates a fresh handler via the registered factory.
 */
export class TransitionActionRegistry {
  /** All factories indexed by action type string. */
  private readonly factories = new Map<string, TransitionActionFactory>();
  /** Factories indexed by source key for deregistration. */
  private readonly factoriesBySource = new Map<string, string[]>();

  /**
   * @param bus - Bus instance forwarded to the built-in `workflow.start` factory.
   */
  public constructor(bus: IMakaioBus) {
    this.factories.set(WORKFLOW_START_ACTION_TYPE, createWorkflowStartFactory(bus));
    this.factoriesBySource.set('__builtin__', [WORKFLOW_START_ACTION_TYPE]);
  }

  /**
   * Register custom action factories from a source (extension name).
   *
   * Source keys and type keys are checked for collisions before any mutations.
   * Built-in action types (`workflow.start`) may not be overridden.
   * @param sourceKey - Stable source identifier (extension name).
   * @param actions - Map of action type string to factory.
   * @throws If the source or any action type collides with an existing registration.
   */
  public register(sourceKey: string, actions: Readonly<Record<string, TransitionActionFactory>>): void {
    const keys = Object.keys(actions);
    if (keys.length === 0) return;

    if (this.factoriesBySource.has(sourceKey)) {
      throw new Error(`TransitionActionRegistry: duplicate source '${sourceKey}'`);
    }

    for (const key of keys) {
      if (this.factories.has(key)) {
        throw new Error(`TransitionActionRegistry: duplicate action type '${key}' from source '${sourceKey}'`);
      }
    }

    for (const key of keys) {
      this.factories.set(key, actions[key]!);
    }
    this.factoriesBySource.set(sourceKey, keys);
  }

  /**
   * Deregister all action factories contributed by a source.
   *
   * Built-in actions (`__builtin__`) cannot be deregistered.
   * No-op when the source has no registered factories.
   * @param sourceKey - Source identifier previously passed to {@link register}.
   */
  public deregister(sourceKey: string): void {
    if (sourceKey === '__builtin__') return;
    const keys = this.factoriesBySource.get(sourceKey);
    if (!keys) return;
    for (const key of keys) {
      this.factories.delete(key);
    }
    this.factoriesBySource.delete(sourceKey);
  }

  /**
   * Resolve and invoke the action handler for the given invocation.
   *
   * Creates a fresh handler via the registered factory, then delegates
   * execution to the handler's `execute` method.
   * @param invocation - Action invocation descriptor from the matched rule.
   * @param context - Evaluation context from the triggering artifact event.
   * @throws If no factory is registered for `invocation.type`.
   */
  public async dispatch(invocation: TransitionActionInvocation, context: TransitionEvaluationContext): Promise<void> {
    const factory = this.factories.get(invocation.type);
    if (!factory) {
      throw new Error(
        `TransitionActionRegistry: unknown action type '${invocation.type}'. ` +
          `Registered types: ${[...this.factories.keys()].join(', ')}`,
      );
    }
    const handler = factory();
    await handler.execute(invocation, context);
  }

  /**
   * Check whether an action type is registered.
   * @param actionType - Action type identifier to check.
   * @returns `true` when the type has a registered factory.
   */
  public has(actionType: string): boolean {
    return this.factories.has(actionType);
  }

  /**
   * List all registered action type strings.
   * @returns Array of registered action type identifiers.
   */
  public listTypes(): string[] {
    return [...this.factories.keys()];
  }
}
