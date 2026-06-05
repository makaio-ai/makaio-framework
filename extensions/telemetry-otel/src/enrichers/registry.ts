/**
 * Registry for declarative span enricher rules.
 *
 * Stores {@link SpanEnricherRule} entries and evaluates them against a
 * {@link SpanDraft} using the shared rules engine. Rules are evaluated in
 * descending priority order (highest first).
 * @packageDocumentation
 */

import { evaluateRules } from '@makaio/rules';
import type { SpanDraft, SpanEnricherRule } from '../contracts/index.js';

/**
 * In-process registry of declarative span enricher rules.
 *
 * Rules are stored by their stable {@link SpanEnricherRule.id} and evaluated
 * against a {@link SpanDraft} context in descending priority order when
 * {@link evaluate} is called.
 */
export class SpanEnricherRuleRegistry {
  private readonly rules = new Map<string, SpanEnricherRule>();

  /**
   * Register a span enricher rule.
   *
   * If a rule with the same {@link SpanEnricherRule.id} is already registered,
   * it is replaced.
   * @param rule - Rule to register
   * @returns Cleanup function that unregisters the rule
   */
  public register(rule: SpanEnricherRule): () => void {
    this.rules.set(rule.id, rule);
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
  }

  /**
   * Evaluate all registered rules against the supplied span draft.
   *
   * Rules are sorted by {@link SpanEnricherRule.priority} in descending order
   * before evaluation so the highest-priority rules are returned first and
   * their attributes win in the merge.
   * @param draft - Span draft used as the evaluation context
   * @returns Matching rules in descending priority order
   */
  public evaluate(draft: SpanDraft): SpanEnricherRule[] {
    const sorted = [...this.rules.values()].sort((a, b) => b.priority - a.priority);
    return evaluateRules(sorted, {
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
    });
  }
}
