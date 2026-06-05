import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ArtifactRef,
  ArtifactRevision,
  TransitionEvaluationContext,
  TransitionEventType,
} from '@makaio/contracts';
import { ArtifactSubjects } from '@makaio/contracts';
import { evaluate } from '@makaio/rules';
import { BaseService } from '@makaio/service-base';
import type { TransitionActionRegistry } from './transition-action-registry.js';
import type { PreparedTransitionRule, TransitionRuleRegistry } from './transition-rule-registry.js';
import {
  TransitionActionRegistry as ActionRegistryImpl,
  WORKFLOW_START_ACTION_TYPE,
} from './transition-action-registry.js';
import { TransitionRuleRegistry as RuleRegistryImpl } from './transition-rule-registry.js';

/** Maximum transition depth to prevent infinite artifact → workflow → artifact cycles. */
const MAX_TRANSITION_DEPTH = 10;

/**
 * How long (ms) to retain a depth counter after the last `workflow.start` dispatch
 * for a given artifact. Entries are pruned lazily on the next event for that artifact.
 */
const DEPTH_ENTRY_TTL_MS = 60_000;

// ─────────────────────────────────────────────────────────────
// TransitionPipelineService
// ─────────────────────────────────────────────────────────────

/**
 * Service that watches artifact bus events and fires transition rules.
 *
 * On initialization the service subscribes to the three artifact lifecycle
 * events (`artifact.created`, `artifact.revised`, `artifact.status.changed`).
 * For each incoming event it evaluates the registered rules for that event type
 * using `@makaio/rules`, then dispatches the matching rule's action through the
 * {@link TransitionActionRegistry}.
 *
 * Loop protection: the service maintains an in-memory depth counter keyed by
 * `${kind}:${id}` for each artifact. Each time a `workflow.start` action is
 * dispatched for an artifact the counter is incremented. Incoming events for an
 * artifact whose counter has reached {@link MAX_TRANSITION_DEPTH} are silently
 * dropped. Counters are pruned after {@link DEPTH_ENTRY_TTL_MS} to prevent
 * unbounded growth.
 */
export class TransitionPipelineService extends BaseService {
  /** Registry of serializable transition rules. */
  public readonly ruleRegistry: TransitionRuleRegistry;
  /** Registry of executable action factories. */
  public readonly actionRegistry: TransitionActionRegistry;

  /**
   * In-memory depth tracker keyed by `${kind}:${id}`.
   *
   * Counts how many `workflow.start` actions have been dispatched for each
   * artifact in the current execution chain. Entries expire after
   * {@link DEPTH_ENTRY_TTL_MS}.
   */
  private readonly depthMap = new Map<string, { count: number; expiresAt: number }>();

  /**
   * @param bus - Bus instance used for artifact event subscriptions and workflow.start dispatch.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
    this.ruleRegistry = new RuleRegistryImpl();
    this.actionRegistry = new ActionRegistryImpl(bus);
  }

  /**
   * Subscribe to all three artifact lifecycle event types.
   */
  protected onInit(): void {
    this.registerHandler(ArtifactSubjects.created, async (ctx) => {
      await this.handleArtifactEvent('artifact.created', { artifact: ctx.payload.artifact });
    });

    this.registerHandler(ArtifactSubjects.revised, async (ctx) => {
      await this.handleArtifactEvent('artifact.revised', {
        artifact: ctx.payload.artifact,
        previous: ctx.payload.previous,
      });
    });

    this.registerHandler(ArtifactSubjects.status.changed, async (ctx) => {
      const artifact = await this.resolveStatusChangedArtifact(ctx.payload.artifact);
      if (artifact === undefined) return;

      await this.handleArtifactEvent('artifact.status.changed', {
        artifact,
        path: ctx.payload.path,
        previous: ctx.payload.previous,
        current: ctx.payload.current,
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Evaluate all enabled rules for the event type, then dispatch matching actions.
   * @param eventType - The artifact event type that fired.
   * @param contextBase - Partial evaluation context built from the event payload.
   */
  private async handleArtifactEvent(
    eventType: TransitionEventType,
    contextBase: Omit<TransitionEvaluationContext, '_transition'>,
  ): Promise<void> {
    const artifactKey = this.artifactKey(contextBase.artifact);
    const incomingDepth = this.readDepth(artifactKey);

    if (incomingDepth >= MAX_TRANSITION_DEPTH) {
      console.warn(
        `[TransitionPipelineService] Transition depth limit (${MAX_TRANSITION_DEPTH}) reached for event '${eventType}' ` +
          `on artifact '${artifactKey}'. Loop protection active — skipping rule evaluation.`,
      );
      return;
    }

    const prepared = this.ruleRegistry.getRulesForEvent(eventType);
    if (prepared.length === 0) return;

    for (const entry of prepared) {
      await this.evaluateAndDispatch(entry, eventType, contextBase, artifactKey, incomingDepth);
    }
  }

  /**
   * Resolve a status-change artifact ref into the exact revision that emitted
   * the event before rule evaluation.
   * @param ref - Revisioned artifact reference from the status.changed event.
   * @returns Full artifact revision, or `undefined` when the artifact store cannot provide it.
   */
  private async resolveStatusChangedArtifact(ref: ArtifactRef): Promise<ArtifactRevision | undefined> {
    const result = await this.bus.requestOptional(ArtifactSubjects.resolve, { ref });
    if (!result.handled) {
      console.warn(
        `[TransitionPipelineService] No artifact resolver is registered for status transition ` +
          `on artifact '${this.artifactKey(ref)}'. Skipping rule evaluation.`,
      );
      return undefined;
    }

    if (result.data.artifact === null) {
      console.warn(
        `[TransitionPipelineService] Could not resolve status transition artifact '${this.artifactKey(ref)}'. ` +
          `Skipping rule evaluation.`,
      );
      return undefined;
    }

    return result.data.artifact;
  }

  /**
   * Evaluate a single prepared rule condition and dispatch its action if the condition matches.
   *
   * The condition is pre-parsed at registration time, so this method only evaluates it
   * against the current event context — no schema parsing overhead per event.
   *
   * When dispatch succeeds and the action type is `workflow.start`, the in-memory
   * depth counter for the artifact is incremented so subsequent events in the same
   * execution chain are correctly depth-checked.
   * @param entry - The prepared rule (definition + pre-parsed condition) to evaluate.
   * @param eventType - The artifact event type.
   * @param contextBase - Partial evaluation context from the event payload.
   * @param artifactKey - Composite `${kind}:${id}` key for depth tracking.
   * @param incomingDepth - Current loop-protection depth for this artifact.
   */
  private async evaluateAndDispatch(
    entry: PreparedTransitionRule,
    eventType: TransitionEventType,
    contextBase: Omit<TransitionEvaluationContext, '_transition'>,
    artifactKey: string,
    incomingDepth: number,
  ): Promise<void> {
    const { rule, condition } = entry;
    const context: TransitionEvaluationContext = {
      ...contextBase,
      _transition: {
        ruleId: rule.id,
        eventType,
        depth: incomingDepth + 1,
      },
    };

    if (condition !== undefined) {
      // Build a plain evaluation record for the rules engine. Spreading the typed context
      // into a plain Record<string, unknown> is intentional: `evaluate()` needs an
      // index-signature type that the typed interface cannot satisfy structurally.
      const evalContext: Record<string, unknown> = { ...context };
      let matches: boolean;
      try {
        matches = evaluate(condition, evalContext);
      } catch (error) {
        console.error(`[TransitionPipelineService] Condition evaluation error for rule '${rule.id}':`, error);
        return;
      }
      if (!matches) return;
    }

    try {
      await this.actionRegistry.dispatch(rule.action, context);
      // Increment the depth counter after a successful workflow.start dispatch so
      // later events on the same artifact are aware of the nesting level.
      if (rule.action.type === WORKFLOW_START_ACTION_TYPE) {
        this.incrementDepth(artifactKey);
      }
    } catch (error) {
      console.error(
        `[TransitionPipelineService] Action dispatch error for rule '${rule.id}' (action type '${rule.action.type}'):`,
        error,
      );
    }
  }

  /**
   * Derive the composite artifact key used for depth tracking.
   * @param artifact - Artifact ref or revision from the event payload.
   * @returns A `${kind}:${id}` string, falling back to `'unknown:unknown'` when
   * the artifact lacks these fields.
   */
  private artifactKey(artifact: { readonly kind?: unknown; readonly id?: unknown }): string {
    const kind = typeof artifact.kind === 'string' ? artifact.kind : 'unknown';
    const id = typeof artifact.id === 'string' ? artifact.id : 'unknown';
    return `${kind}:${id}`;
  }

  /**
   * Read the current dispatch depth for the given artifact key.
   *
   * Prunes stale entries lazily on each read so the map does not grow
   * unboundedly when artifacts are no longer active.
   * @param key - Composite `${kind}:${id}` key.
   * @returns Current dispatch count, or `0` when absent or expired.
   */
  private readDepth(key: string): number {
    const entry = this.depthMap.get(key);
    if (entry === undefined) return 0;
    if (Date.now() > entry.expiresAt) {
      this.depthMap.delete(key);
      return 0;
    }
    return entry.count;
  }

  /**
   * Increment the dispatch depth counter for the given artifact key and reset its TTL.
   * @param key - Composite `${kind}:${id}` key.
   */
  private incrementDepth(key: string): void {
    const existing = this.depthMap.get(key);
    this.depthMap.set(key, {
      count: existing !== undefined ? existing.count + 1 : 1,
      expiresAt: Date.now() + DEPTH_ENTRY_TTL_MS,
    });
  }
}
