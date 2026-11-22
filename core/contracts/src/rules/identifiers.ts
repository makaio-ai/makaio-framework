import type { ContributionName } from '@makaio/core';
import { z } from 'zod';

/** Zod schema for {@link RuleId}. */
export const RuleIdSchema = z.string().min(1);

/** Identifier of a reaction rule. */
export type RuleId = z.infer<typeof RuleIdSchema>;

/** Zod schema for {@link EvaluationId}. */
export const EvaluationIdSchema = z.string().min(1);

/**
 * Identifier of an evaluation: the one durable record per occasion and rule,
 * with its state, reason, recorded decision and parts.
 */
export type EvaluationId = z.infer<typeof EvaluationIdSchema>;

/** Kind of a trigger that opens an occasion for rules (for example `makaio.bus-message`). */
export type TriggerKind = ContributionName;

/** Kind of a reaction a rule may run (for example `makaio.send-bus-request`). */
export type ReactionKind = ContributionName;

/** Kind of a lookup a rule may call while it is evaluated. */
export type LookupKind = ContributionName;

/** Kind of a strategy that decides a group of rules (for example `makaio.first-match`). */
export type StrategyKind = ContributionName;
