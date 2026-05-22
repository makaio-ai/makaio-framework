import type { IMakaioBus } from '@makaio/bus-core';
import { matchesSubscription, matchesFilter } from '@makaio/bus-core';
import type { WildcardSubjectDefinition, WildcardUnifiedHandler, PayloadFilter } from '@makaio/core';
import type { WorkflowDefinition } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { compile, type CompiledExpression } from '@makaio/expression';
import { WorkflowStorageSubjects } from './storage/namespace.js';

// ─────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────

/**
 * A single indexed trigger entry for fast matching.
 */
interface TriggerEntry {
  /** ID of the workflow that owns this trigger. */
  workflowId: string;
  /**
   * Bus subject pattern to match against incoming events.
   * May be exact ('git.worktree') or wildcard ('git.*').
   */
  subject: string;
  /**
   * Optional structural payload filter.
   * Supports equality, `$in`, `$ne`, `$exists`, `$startsWith`, `$endsWith`.
   * All conditions must match (AND logic).
   */
  filter?: PayloadFilter;
  /**
   * Pre-compiled jexl expression for complex filter conditions.
   * Evaluated after `filter` passes (AND semantics).
   * Compiled once at index time and reused across all evaluations.
   */
  compiledFilterExpr?: CompiledExpression;
}

/**
 * Compile filter expression once; return undefined on invalid expression.
 * @param expression - JEXL filter expression from trigger definition
 * @param workflowId - Workflow ID for logging context
 * @returns Compiled expression or undefined when compilation fails
 */
function tryCompileFilter(expression: string, workflowId: string): CompiledExpression | undefined {
  try {
    return compile(expression);
  } catch (error) {
    console.error(
      `[BusEventTriggerEvaluator] Invalid trigger.filterExpression for workflow "${workflowId}": "${expression}"`,
      error,
    );
    return undefined;
  }
}

/**
 * Test-only snapshot of evaluator internals.
 */
export interface BusEventTriggerEvaluatorTestState {
  initialized: boolean;
  cleanupFns: Array<() => void>;
  subscribedNamespaces: Set<string>;
}

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

/**
 * Extract the namespace prefix from a bus subject pattern.
 *
 * The namespace is the segment before the first dot or colon.
 * For 'git.worktree' → 'git', for 'github.*' → 'github'.
 * @param subject - Bus subject pattern (e.g., 'git.worktree', 'github.*')
 * @returns The namespace prefix string
 */
function extractNamespace(subject: string): string {
  const dotIdx = subject.indexOf('.');
  const colonIdx = subject.indexOf(':');
  const splitIdx = dotIdx === -1 ? colonIdx : colonIdx === -1 ? dotIdx : Math.min(dotIdx, colonIdx);
  return splitIdx === -1 ? subject : subject.slice(0, splitIdx);
}

/**
 * Build a synthetic WildcardSubjectDefinition for a namespace-level wildcard.
 *
 * Constructs a `{namespace}.*` wildcard that the bus `on()` method
 * accepts for intercepting all events in that namespace.
 * @param namespace - Namespace prefix to match (e.g., 'git')
 * @returns WildcardSubjectDefinition for the given namespace
 */
function makeNamespaceWildcard(namespace: string): WildcardSubjectDefinition {
  return {
    subject: '*',
    $meta: { namespace, isRequest: false },
  } as WildcardSubjectDefinition;
}

// ─────────────────────────────────────────────────────────────
// Evaluator service
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates bus events against registered workflow triggers.
 *
 * On init, loads all workflow definitions that carry `bus-event` triggers,
 * subscribes to the relevant bus namespaces, and fires
 * `WorkflowSubjects.start` when an incoming event matches a trigger's
 * subject pattern, optional payload filter, and optional jexl expression.
 *
 * Keeps the trigger index live by listening for workflow CRUD events.
 *
 * ## Subscription strategy
 *
 * The bus does not provide a global (cross-namespace) wildcard in production
 * (`__onAny` is disabled for `NODE_ENV=production`). Instead, the evaluator
 * derives the namespace prefix from each trigger subject and subscribes to a
 * synthetic `{namespace}.*` SubjectDefinition. When a new namespace is
 * encountered after init (via CRUD events), the evaluator subscribes on demand.
 *
 * ## Filter evaluation order
 *
 * 1. Subject pattern matching (`matchesSubscription`)
 * 2. Structural `filter` via `matchesFilter` from `@makaio/bus-core`
 * 3. `filterExpression` jexl evaluation (compiled once, reused per entry)
 *
 * All conditions are ANDed together.
 * @example
 * ```typescript
 * const evaluator = new BusEventTriggerEvaluator(bus);
 * await evaluator.init();
 * // ... bus events matching registered triggers will fire workflows
 * evaluator.destroy();
 * ```
 */
export class BusEventTriggerEvaluator {
  private readonly cleanupFns: Array<() => void> = [];
  private initialized = false;

  /**
   * Trigger entries keyed by workflowId.
   * Each workflow may have multiple bus-event triggers.
   */
  private readonly triggerIndex = new Map<string, TriggerEntry[]>();

  /**
   * Namespaces already subscribed, to avoid duplicate wildcard listeners.
   */
  private readonly subscribedNamespaces = new Set<string>();

  /**
   * @param bus - The shared bus instance
   */
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Initialize the evaluator.
   *
   * Idempotent: calling init() on an already-initialized evaluator is a no-op.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Subscribe to workflow CRUD events to keep trigger index fresh.
      this.cleanupFns.push(
        this.bus.on(WorkflowSubjects.definition.created, (ctx) => {
          this.indexWorkflow(ctx.payload);
        }),
        this.bus.on(WorkflowSubjects.definition.updated, (ctx) => {
          this.removeWorkflow(ctx.payload.id);
          this.indexWorkflow(ctx.payload);
        }),
        this.bus.on(WorkflowSubjects.definition.deleted, (ctx) => {
          this.removeWorkflow(ctx.payload.id);
        }),
      );

      // Index all existing workflows that carry bus-event triggers.
      await this.loadExistingTriggers();

      this.initialized = true;
    } catch (error) {
      this.cleanupFns.forEach((fn) => fn());
      this.cleanupFns.length = 0;
      this.triggerIndex.clear();
      this.subscribedNamespaces.clear();
      throw error;
    }
  }

  /**
   * Destroy the evaluator, removing all subscriptions and clearing state.
   *
   * Idempotent: calling destroy() on a non-initialized evaluator is a no-op.
   */
  public destroy(): void {
    if (!this.initialized) return;
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns.length = 0;
    this.triggerIndex.clear();
    this.subscribedNamespaces.clear();
    this.initialized = false;
  }

  /**
   * Test-only view of evaluator internals.
   * Returns snapshots to avoid tests mutating runtime state directly.
   * @returns Internal state snapshots for deterministic testing
   */
  public getTestState(): BusEventTriggerEvaluatorTestState {
    return {
      initialized: this.initialized,
      cleanupFns: [...this.cleanupFns],
      subscribedNamespaces: new Set(this.subscribedNamespaces),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Load all existing workflow definitions and index their bus-event triggers.
   */
  private async loadExistingTriggers(): Promise<void> {
    const { workflows } = await this.bus.request(WorkflowStorageSubjects.list, {});
    for (const workflow of workflows) {
      this.indexWorkflow(workflow);
    }
  }

  /**
   * Add all bus-event triggers from a workflow definition to the index.
   *
   * Also subscribes to any new namespaces discovered in trigger subjects.
   * Filter expressions are compiled once here and reused on every evaluation.
   * @param workflow - Workflow definition to index
   */
  private indexWorkflow(workflow: WorkflowDefinition): void {
    const triggers = workflow.triggers ?? [];
    const entries: TriggerEntry[] = [];

    for (const trigger of triggers) {
      if (trigger.type !== 'bus-event') continue;
      const compiledFilterExpr =
        typeof trigger.filterExpression === 'string'
          ? tryCompileFilter(trigger.filterExpression, workflow.id)
          : undefined;
      if (typeof trigger.filterExpression === 'string' && compiledFilterExpr === undefined) {
        // Invalid expressions are skipped so they cannot accidentally match as "no expression".
        continue;
      }

      entries.push({
        workflowId: workflow.id,
        subject: trigger.subject,
        filter: trigger.filter as PayloadFilter | undefined,
        compiledFilterExpr,
      });

      this.ensureNamespaceSubscribed(extractNamespace(trigger.subject));
    }

    if (entries.length > 0) {
      this.triggerIndex.set(workflow.id, entries);
    }
  }

  /**
   * Remove all trigger entries for a given workflow from the index.
   * @param workflowId - Workflow identifier to remove
   */
  private removeWorkflow(workflowId: string): void {
    this.triggerIndex.delete(workflowId);
  }

  /**
   * Subscribe to the namespace-level wildcard for the given namespace,
   * if not already subscribed.
   *
   * A synthetic `{namespace}.*` SubjectDefinition is constructed so that
   * the bus routes all events in that namespace to our handler.
   * The `EventContext.subject` field already holds the full subject key
   * (e.g., `'git.worktree'`), so no reconstruction is needed.
   * @param namespace - Namespace prefix to subscribe (e.g., 'git')
   */
  private ensureNamespaceSubscribed(namespace: string): void {
    if (this.subscribedNamespaces.has(namespace)) return;

    const wildcardSubject = makeNamespaceWildcard(namespace);
    const handler: WildcardUnifiedHandler = (ctx) => {
      if (ctx.isRequest) return; // Skip requests — only match events
      // ctx.subject is the full subject key (e.g., 'git.worktree').
      const normalizedPayload =
        typeof ctx.payload === 'object' && ctx.payload !== null ? (ctx.payload as Record<string, unknown>) : {};
      this.handleBusEvent(ctx.subject, normalizedPayload);
    };
    const cleanup = this.bus.on(wildcardSubject, handler);

    this.cleanupFns.push(cleanup);
    this.subscribedNamespaces.add(namespace);
  }

  /**
   * Evaluate an incoming bus event against all registered trigger entries.
   *
   * For each matching trigger, fires `WorkflowSubjects.start` with the event
   * payload forwarded as `triggerPayload`.
   *
   * Matching order: subject pattern → structural filter → jexl expression (AND).
   * @param fullSubject - Full bus subject key (e.g., 'git.worktree')
   * @param payload - Incoming event payload
   */
  private handleBusEvent(fullSubject: string, payload: Record<string, unknown>): void {
    for (const entries of this.triggerIndex.values()) {
      for (const entry of entries) {
        if (!matchesSubscription(fullSubject, entry.subject)) continue;
        if (entry.filter && !matchesFilter(payload, entry.filter)) continue;
        if (entry.compiledFilterExpr) {
          let result: unknown;
          try {
            result = entry.compiledFilterExpr.evalSync({ payload });
          } catch (error) {
            console.error(
              `[BusEventTriggerEvaluator] filterExpression eval failed for workflow "${entry.workflowId}" on subject "${fullSubject}" payload keys: [${Object.keys(payload).join(', ')}]`,
              error,
            );
            continue;
          }
          if (!result) continue;
        }

        // Fire and forget — workflow start is async but we don't block event dispatch.
        this.bus
          .request(WorkflowSubjects.start, {
            workflowId: entry.workflowId,
            triggerPayload: payload,
          })
          .catch((error: unknown) => {
            console.error(
              `[BusEventTriggerEvaluator] Failed to start workflow "${entry.workflowId}" ` +
                `triggered by "${fullSubject}":`,
              error,
            );
          });
      }
    }
  }
}
