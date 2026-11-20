/**
 * Registry for declarative span enricher rules.
 *
 * Stores {@link SpanEnricherRule} entries and evaluates them against a
 * {@link SpanDraft} using the shared rules engine. Rules are evaluated in
 * descending priority order (highest first).
 * @packageDocumentation
 */

import { zodSchemaToJsonRecord } from '@makaio/contracts';
import { assertValidCondition, evaluateRules } from '@makaio/rules';
import type { SpanDraft, SpanEnricherRule } from '../contracts/index.js';
import { SpanDraftSchema } from '../contracts/index.js';

/**
 * Span draft fields that {@link SpanEnricherRuleRegistry.evaluate} passes to the
 * rules engine as the condition context. Single source for the evaluated object
 * and for the schema a rule is checked against at registration.
 */
const EVALUATION_CONTEXT_KEYS = {
  spanId: true,
  executionId: true,
  frameId: true,
  sessionId: true,
  namespace: true,
  subject: true,
  name: true,
  kind: true,
  status: true,
  attributes: true,
} as const;

/** JSON Schema of the evaluation context, derived from {@link SpanDraftSchema}. */
const EVALUATION_CONTEXT_JSON_SCHEMA = zodSchemaToJsonRecord(SpanDraftSchema.pick(EVALUATION_CONTEXT_KEYS));

/**
 * In-process registry of declarative span enricher rules.
 *
 * Rules are stored by their stable {@link SpanEnricherRule.id} and evaluated
 * against a {@link SpanDraft} context in descending priority order when
 * {@link evaluate} is called.
 */
export class SpanEnricherRuleRegistry {
  private readonly rules = new Map<string, SpanEnricherRule>();
  /** Rules in descending priority order; cleared whenever the rule set changes. */
  private sortedRules: SpanEnricherRule[] | undefined;

  /**
   * Register a span enricher rule.
   *
   * If a rule with the same {@link SpanEnricherRule.id} is already registered,
   * it is replaced. The condition is checked against the schema of the
   * evaluation context first; expressions that only fail at run time still
   * surface in {@link evaluate}.
   * @param rule - Rule to register
   * @returns Cleanup function that unregisters the rule
   * @throws When the condition has error findings (broken expression, unknown
   * field, unguarded negation); the message names the rule id.
   */
  public register(rule: SpanEnricherRule): () => void {
    const warnings = assertValidCondition(
      { condition: rule.condition, context: EVALUATION_CONTEXT_JSON_SCHEMA },
      `Invalid span enricher rule condition in '${rule.id}'`,
    );
    for (const finding of warnings) {
      console.warn(
        `Span enricher rule '${rule.id}': condition warning ${finding.code} at '${finding.path}': ${finding.message}`,
      );
    }
    this.rules.set(rule.id, rule);
    this.sortedRules = undefined;
    return () => this.unregister(rule.id);
  }

  /**
   * Unregister a previously registered rule by its identifier.
   *
   * No-op if no rule with that id is registered.
   * @param ruleId - Stable identifier of the rule to remove
   */
  public unregister(ruleId: string): void {
    this.rules.delete(ruleId);
    this.sortedRules = undefined;
  }

  /**
   * Evaluate all registered rules against the supplied span draft.
   *
   * Rules are sorted by {@link SpanEnricherRule.priority} in descending order
   * before evaluation so the highest-priority rules are returned first and
   * their attributes win in the merge.
   * @param draft - Span draft used as the evaluation context
   * @returns Matching rules in descending priority order
   * @throws When any rule's condition cannot be evaluated; the message
   * lists each failed rule id with its error path and message. This keeps the
   * earlier behaviour, where a broken expression surfaced as a thrown error.
   */
  public evaluate(draft: SpanDraft): SpanEnricherRule[] {
    this.sortedRules ??= [...this.rules.values()].sort((a, b) => b.priority - a.priority);
    const { matched, failed } = evaluateRules(this.sortedRules, {
      spanId: draft.spanId,
      executionId: draft.executionId,
      frameId: draft.frameId,
      sessionId: draft.sessionId,
      namespace: draft.namespace,
      subject: draft.subject,
      name: draft.name,
      kind: draft.kind,
      status: draft.status,
      attributes: draft.attributes,
    } satisfies Record<keyof typeof EVALUATION_CONTEXT_KEYS, unknown>);
    if (failed.length > 0) {
      const details = failed.map(({ rule, error }) => `${rule.id} (${error.path}: ${error.message})`).join('; ');
      throw new Error(`Span enricher rule condition failed to evaluate: ${details}`);
    }
    return matched;
  }
}
