import type { JsonValue } from '@makaio/contracts';
import type { EventFacts, GroupEvaluationView, ReactionRule, RuleSourceContribution } from '@makaio/contracts/rules';

/** Effective rule set resolved before the caller opens its commit transaction. */
export type RuleSnapshot = Extract<Awaited<ReturnType<RuleSourceContribution['rulesFor']>>, { set: object }>;

/** Immutable input to durable evaluation. */
export interface RuleOccasion {
  /** Stable identity of this occasion, such as the journal entry ID. */
  readonly id: string;
  /** Facts and recorded authority shared by the rules of this occasion. */
  readonly event: EventFacts;
  /** Payload the trigger contributions project. */
  readonly payload: JsonValue;
  /** Effective rules pinned by the caller. */
  readonly snapshot: RuleSnapshot;
}

/** Trigger projection and expanded guard captured before the enqueue commit. */
export interface PreparedRule {
  /** Original rule and its extension blocks. */
  readonly rule: ReactionRule;
  /** Rule-specific trigger facts and the recorded authority. */
  readonly event: EventFacts;
  /** Trigger parameters expanded into a guard, if registered. */
  readonly triggerCondition?: ReactionRule['when'];
}

/** Pinned source entries in source order. An entry with no JSON representation uses null. */
export type PinnedRuleSnapshot = Omit<RuleSnapshot, 'rules'> & { readonly rules: readonly JsonValue[] };

/** Occasion with the audited, storage-safe snapshot of its source. */
export type PinnedRuleOccasion = Omit<RuleOccasion, 'snapshot'> & { readonly snapshot: PinnedRuleSnapshot };

/** Why a source entry could not become an executable evaluation. */
export type RuleSourceBlockReason =
  | 'rule-invalid'
  | 'duplicate-rule-id'
  | 'trigger-unavailable'
  | 'trigger-parameters-invalid'
  | 'trigger-projection-invalid'
  | 'invalid-rule-set';

/** A blocked evaluation points to its exact entry in the pinned source array. */
export interface BlockedRule {
  /** Source position, distinguishing even entries with the same identifier. */
  readonly sourceIndex: number;
  /** Identifier when available, with null for an entry that never had a usable identifier. */
  readonly ruleId: string | null;
  /** Condition that prevented execution. */
  readonly reason: RuleSourceBlockReason;
}

/** Prepared occasion to persist in the caller's transaction. */
export interface PreparedOccasion {
  /** Immutable input including the full rule snapshot. */
  readonly occasion: PinnedRuleOccasion;
  /** Matching triggers and their projections. */
  readonly rules: readonly PreparedRule[];
  /** Source entries that failed validation or trigger projection. */
  readonly blockedRules: readonly BlockedRule[];
  /** Groups initialized in priority order. */
  readonly groups: readonly GroupEvaluationView[];
  /** Runtime refuses unsupported constructs, leaving their cause pending. */
  readonly blockedReason?: 'not-implemented';
}

/** Result of selecting rules for one journal entry. */
export type RuleOccasionPreparation =
  | { readonly state: 'prepared'; readonly work: PreparedOccasion }
  | { readonly state: 'no-match' }
  | { readonly state: 'source-unavailable' };

/** Materialized input of one effect. */
export interface PreparedPart {
  /** Zero-based item position, or zero for a rule without each. */
  readonly position: number;
  /** Value of the item if each was declared. */
  readonly item?: JsonValue;
  /** Arguments that will be passed to the reaction. */
  readonly parameters: Record<string, JsonValue>;
  /** Whether the registered reaction promises idempotency for this key. */
  readonly keyed: boolean;
  /** A permanent input failure, when this part could not be prepared. */
  readonly reason?: 'parameters-unresolved' | 'params-invalid';
}
