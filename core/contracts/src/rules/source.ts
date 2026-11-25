import type { SubjectPattern } from '../journal/identifiers.js';
import type { JsonValue } from '../shared/json-value.js';
import type { EventFacts } from './event.js';
import type { RuleSetRef } from './evaluation.js';
import type { TriggerKind } from './identifiers.js';
import type { ReactionRule, RuleExclusion, RuleGroup } from './rule.js';

/**
 * Triggers of the rule set in effect, by kind and fixed parameters, with the
 * subjects they fire from.
 */
export interface RuleSourceTrigger {
  /** Kind of trigger. */
  readonly kind: TriggerKind;
  /** The trigger's fixed parameters. */
  readonly params: JsonValue | undefined;
  /** Subjects the trigger fires from. */
  readonly subjects: readonly SubjectPattern[];
}

/**
 * The host's rule source (at most one per host): which rules apply to an
 * occasion, which groups and exclusions are in effect, and which triggers the
 * rule set in effect declares.
 *
 * Which rules apply to an occasion (for example central rules plus a scope's
 * own, in a rule block), who may exclude and where a group is declared, is
 * the host's decision.
 */
export interface RuleSourceContribution {
  /**
   * The effective rule set for one occasion, without the excluded rules.
   *
   * Runs without a host transaction. The result is fixed by `set`; the kernel
   * may cache after that.
   * The source decides per entry whether rules apply to events recorded before their activation.
   * @param input - The occasion to resolve rules for.
   * @returns The effective set with its groups and exclusions, or `{ set: null }` when none applies.
   */
  rulesFor(input: { readonly cause: EventFacts }): Promise<
    | {
        readonly set: RuleSetRef;
        readonly rules: readonly ReactionRule[];
        readonly groups: readonly RuleGroup[];
        readonly excluded: readonly RuleExclusion[];
      }
    | { readonly set: null }
  >;

  /**
   * Triggers of every rule in the set currently in effect: kind, fixed
   * parameters, subject patterns. The evaluation subscribes to the patterns.
   * @returns The triggers of the set currently in effect.
   */
  ruleTriggers(): RuleSourceTrigger[];

  /**
   * Reports that the answer of `ruleTriggers()` changed.
   * @param listener - Called after the set of triggers changed.
   * @returns Unsubscribes `listener`.
   */
  onTriggersChanged(listener: () => void): () => void;
}
