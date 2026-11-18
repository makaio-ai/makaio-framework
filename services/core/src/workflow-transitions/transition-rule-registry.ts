import {
  TransitionRuleDefinitionSchema,
  type TransitionEventType,
  type TransitionRuleDefinition,
} from '@makaio/contracts';
import type { Condition } from '@makaio/rules';
import { ConditionSchema } from '@makaio/rules';
import type { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────

type TransitionRuleDefinitionInput = z.input<typeof TransitionRuleDefinitionSchema>;

interface SourceSnapshot {
  ruleIds: readonly string[];
}

/**
 * A {@link TransitionRuleDefinition} with its optional `when` condition
 * pre-parsed at registration time so the pipeline avoids re-parsing on
 * every incoming artifact event.
 */
export interface PreparedTransitionRule {
  /** The original serializable rule definition. */
  readonly rule: TransitionRuleDefinition;
  /**
   * Pre-parsed condition produced by `ConditionSchema.parse(rule.when)`.
   * `undefined` when the rule has no `when` clause — it always matches.
   */
  readonly condition: Condition | undefined;
}

// ─────────────────────────────────────────────────────────────
// TransitionRuleRegistry
// ─────────────────────────────────────────────────────────────

/**
 * Registry for serializable transition rules contributed by workflow bundles
 * and extensions.
 *
 * Rules are stored under a stable source key (bundle ID or extension name) and
 * indexed by event type for fast pipeline evaluation. Duplicate rule IDs
 * hard-fail registration across all sources. Source keys support clean
 * deregistration and atomic replacement.
 *
 * Rules are purely static and serializable — no functions.
 */
export class TransitionRuleRegistry {
  /** All rules indexed by source key. */
  private readonly rulesBySource = new Map<string, PreparedTransitionRule[]>();
  /** Index: event type → flat list of prepared rules across all sources. */
  private readonly rulesByEventType = new Map<TransitionEventType, PreparedTransitionRule[]>();
  /** All registered rule IDs for collision detection. */
  private readonly ruleIdSet = new Set<string>();

  /**
   * Register transition rules from a new source (bundle or extension).
   *
   * Registration is atomic: either all rules from the source are added or none
   * are. See {@link replace} for the validation applied before any mutation.
   * @param sourceKey - Stable identifier for the contributing source (bundle ID or extension name).
   * @param rules - Rule definitions to register. IDs must not collide with existing registrations.
   * @throws If the source is already registered, if any rule ID collides, or if any rule definition or condition is invalid.
   */
  public register(sourceKey: string, rules: readonly TransitionRuleDefinitionInput[]): void {
    if (rules.length === 0) return;

    if (this.rulesBySource.has(sourceKey)) {
      throw new Error(`TransitionRuleRegistry: duplicate source '${sourceKey}'`);
    }

    this.replace(sourceKey, rules);
  }

  /**
   * Atomically replace all rules contributed by a source.
   *
   * The replacement is validated as in {@link validateReplacement} before the
   * source's current rules are touched. A rejected replacement therefore keeps
   * the source's previous rules live (keep-last-good): a source that cannot
   * express its new rules must not silently lose the rules it already had. An
   * empty replacement deregisters the source.
   * @param sourceKey - Stable identifier for the contributing source (bundle ID or extension name).
   * @param rules - Complete replacement set. IDs may reuse the source's own current IDs but must not collide with other sources.
   * @throws If any rule ID is duplicated within the batch or owned by another source, or if any rule definition or condition is invalid.
   */
  public replace(sourceKey: string, rules: readonly TransitionRuleDefinitionInput[]): void {
    const prepared = this.prepareReplacement(sourceKey, rules);

    this.deregister(sourceKey);
    if (prepared.length === 0) return;

    for (const preparedRule of prepared) {
      const { rule } = preparedRule;
      this.ruleIdSet.add(rule.id);
      const bucket = this.rulesByEventType.get(rule.on) ?? [];
      bucket.push(preparedRule);
      this.rulesByEventType.set(rule.on, bucket);
    }

    this.rulesBySource.set(sourceKey, prepared);
  }

  /**
   * Check that {@link replace} would accept a replacement set, without
   * mutating the registry.
   *
   * Rule definitions, conditions, and rule IDs (within the batch and against
   * every other source) are checked. A source whose rules depend on state it
   * publishes elsewhere (for example the workflow definitions its rules start)
   * validates first, so a rejected update can be abandoned before that state
   * changes, and calls {@link replace} once the dependent state is published.
   * @param sourceKey - Stable identifier for the contributing source (bundle ID or extension name).
   * @param rules - Complete replacement set, as it would be passed to {@link replace}.
   * @throws If any rule ID is duplicated within the batch or owned by another source, or if any rule definition or condition is invalid.
   */
  public validateReplacement(sourceKey: string, rules: readonly TransitionRuleDefinitionInput[]): void {
    this.prepareReplacement(sourceKey, rules);
  }

  /**
   * Deregister all rules contributed by a source.
   *
   * No-op when the source has no registered rules.
   * @param sourceKey - Source identifier previously passed to {@link register} or {@link replace}.
   */
  public deregister(sourceKey: string): void {
    const prepared = this.rulesBySource.get(sourceKey);
    if (!prepared) return;

    for (const { rule } of prepared) {
      this.ruleIdSet.delete(rule.id);

      const bucket = this.rulesByEventType.get(rule.on);
      if (bucket) {
        const next = bucket.filter((p) => p.rule.id !== rule.id);
        if (next.length > 0) {
          this.rulesByEventType.set(rule.on, next);
        } else {
          this.rulesByEventType.delete(rule.on);
        }
      }
    }

    this.rulesBySource.delete(sourceKey);
  }

  /**
   * Return all enabled prepared rules matching the given event type.
   *
   * Returns a shallow copy of the internal bucket to prevent external mutation.
   * Each entry carries the original rule definition alongside its pre-parsed
   * condition so the pipeline avoids re-parsing per event.
   * @param eventType - Artifact event type to query.
   * @returns Enabled prepared rules registered for the event type.
   */
  public getRulesForEvent(eventType: TransitionEventType): PreparedTransitionRule[] {
    const bucket = this.rulesByEventType.get(eventType);
    if (!bucket) return [];
    return bucket.filter((p) => p.rule.enabled);
  }

  /**
   * Snapshot the current rule IDs registered under a source.
   *
   * Used for diagnostics and deduplication checks.
   * @param sourceKey - Source identifier.
   * @returns Snapshot of registered rule IDs, or `undefined` if the source has no rules.
   */
  public snapshotSource(sourceKey: string): SourceSnapshot | undefined {
    const prepared = this.rulesBySource.get(sourceKey);
    if (!prepared) return undefined;
    return { ruleIds: prepared.map((p) => p.rule.id) };
  }

  /**
   * Parse and check a replacement set for a source without mutating the registry.
   * @param sourceKey - Source whose current rule IDs may be reused by the replacement.
   * @param rules - Complete replacement set.
   * @returns Prepared rules ready to be indexed.
   * @throws If any rule ID is duplicated within the batch or owned by another source, or if any rule definition or condition is invalid.
   */
  private prepareReplacement(
    sourceKey: string,
    rules: readonly TransitionRuleDefinitionInput[],
  ): PreparedTransitionRule[] {
    const ownRuleIds = new Set(this.rulesBySource.get(sourceKey)?.map(({ rule }) => rule.id));
    const pendingRuleIds = new Set<string>();
    const prepared: PreparedTransitionRule[] = [];
    for (const rawRule of rules) {
      const rule = TransitionRuleDefinitionSchema.parse(rawRule);
      if (pendingRuleIds.has(rule.id)) {
        throw new Error(`TransitionRuleRegistry: duplicate rule ID '${rule.id}' within source '${sourceKey}'`);
      }
      if (this.ruleIdSet.has(rule.id) && !ownRuleIds.has(rule.id)) {
        throw new Error(`TransitionRuleRegistry: duplicate rule ID '${rule.id}' from source '${sourceKey}'`);
      }
      pendingRuleIds.add(rule.id);
      prepared.push({
        rule,
        condition: rule.when !== undefined ? ConditionSchema.parse(rule.when) : undefined,
      });
    }
    return prepared;
  }
}
