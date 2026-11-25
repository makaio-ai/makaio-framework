import type { ExtensionName } from '@makaio/core';
import type { RightContribution } from '../rights/right.js';
import type { JsonValue } from '../shared/json-value.js';
import type { RuleFinding } from './finding.js';
import type { LookupKind, ReactionKind, RuleId } from './identifiers.js';
import type { ReactionRule, RuleExclusion, RuleGroup } from './rule.js';

/**
 * Finding from checking an effective rule set.
 */
export interface RuleValidationFinding extends RuleFinding {
  /** Rule the finding concerns, when the path is relative to a rule. */
  readonly ruleId?: RuleId;
  /** The hook that produced the finding or failed, when applicable. */
  readonly contribution?: RuleValidationContribution;
}

/** Identity of a contribution that checked a rule. */
export type RuleValidationContribution =
  | { readonly kind: 'reaction'; readonly name: ReactionKind }
  | { readonly kind: 'lookup'; readonly name: LookupKind }
  | { readonly kind: 'rule-block'; readonly name: ExtensionName };

/** A host finding for a custom contribution check that could not complete. */
export interface RuleContributionValidationFailure extends RuleValidationFinding {
  /** Rule the contribution checked. */
  readonly ruleId: RuleId;
  /** Custom checks must complete successfully before the rule can take effect. */
  readonly severity: 'error';
  /** Whether the check ran out of time or threw. */
  readonly code: 'contribution-validation-timeout' | 'contribution-validation-failed';
  /** Contribution whose check could not complete. */
  readonly contribution: RuleValidationContribution;
}

/**
 * Input of checking rule definitions before a rule set takes effect, both for
 * the host-side `validateRules` tool and for `RulesCapability.validate`.
 *
 * `rules` is one effective set, the way the rule source would name it for one
 * occasion; a host with several effective sets (for example one per scope)
 * calls the check once per set.
 */
export interface ValidateRulesInput {
  /** The effective set of rules to check. */
  readonly rules: readonly ReactionRule[];
  /** Every group a rule of the set names, with its strategy. */
  readonly groups: readonly RuleGroup[];
  /** Every exclusion, with the excluded rule, so checks on exclusions can read its traits. */
  readonly excluded?: readonly RuleExclusion[];
  /**
   * Rights an extension will declare from data of the set that is only now
   * being checked; treated like directory entries so a new right and its
   * first rule can come into being in one set.
   */
  readonly pendingRights?: readonly RightContribution[];
  /**
   * Forwarded to the schemas of contributions and to the resolution place
   * when the check asks about rights, so an answer source can answer for the
   * set that is only now being checked.
   */
  readonly catalogContext?: JsonValue;
}
