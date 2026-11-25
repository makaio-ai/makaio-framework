import { DEFAULT_REQUEST_TIMEOUT_MS } from '@makaio/bus-core';
import type { HostDatabase, ReactionOutcome } from '@makaio/contracts';
import type { RuleSourceContribution } from '@makaio/contracts/rules';
import type { ReactionRegistry } from '../reaction/reaction-registry.js';
import { uncertainReactionOutcome } from '../reaction/uncertain-outcome.js';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { decideGroups } from './decide-groups.js';
import { prepareRuleOccasion } from './prepare-occasion.js';
import { ruleCall } from './rule-call.js';
import { claimDecision, loadOccasion, persistDecisions } from './storage/decision-store.js';
import { finishPart, loadParts, startPart } from './storage/part-store.js';
import type { RuleCauseRow, RuleEvaluationRow, RulePartRow } from './storage/schema.js';
import type { PreparedOccasion, RuleOccasion } from './types.js';

/** One pass over committed rule work. The reader and scheduler may wake this repeatedly. */
export class RuleEvaluator {
  /**
   * @param database - Host database where the reader committed the occasion.
   * @param contributions - Active rule contributions.
   * @param invokeReaction - Dispatcher supplied by the host's live reaction registry.
   * @param getRuleSource - Reads the active contribution for each new occasion.
   * @param budget - Time allowed for a decision attempt or one reaction call.
   */
  public constructor(
    private readonly database: HostDatabase,
    private readonly contributions: RuleContributionsService,
    private readonly invokeReaction: ReactionRegistry['invoke'],
    private readonly getRuleSource: () => RuleSourceContribution | undefined,
    private readonly budget = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  /**
   * Read and project the effective rule set before opening the commit transaction.
   * Resuming committed work uses the stored snapshot.
   * @param input - New occasion whose rules have yet to be selected.
   * @returns Prepared work, `null` when no rule set is available, or `undefined` when no trigger matches.
   */
  public async prepare(input: Omit<RuleOccasion, 'snapshot'>): Promise<PreparedOccasion | null | undefined> {
    const snapshot = await this.getRuleSource()?.rulesFor({ cause: structuredClone(input.event) });
    return prepareRuleOccasion(this.contributions, input, snapshot);
  }

  /** Evaluate or resume one persisted occasion from its pinned snapshot.
   * @param id - Stable occasion identifier.
   * @param signal - Host shutdown signal.
   */
  public async evaluate(id: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const loaded = await loadOccasion(this.database, id);
    if (!loaded) return;
    const { cause, rules } = loaded;
    if (cause.reason === 'not-implemented') return;
    const now = Date.now();
    if (cause.state === 'pending' && (cause.notBefore === null || cause.notBefore <= now)) {
      const deadline = now + this.budget;
      const claimed = await claimDecision(this.database, cause, now, deadline);
      if (claimed && !signal?.aborted) {
        const proposal = await decideGroups(this.contributions, claimed, rules, deadline);
        if (!signal?.aborted) await persistDecisions(this.database, claimed, rules, proposal);
      }
    }
    // Committed parts have their own retry schedule and claim fence.
    for (const rule of rules) {
      for (const part of await loadParts(this.database, rule.id)) {
        if (signal?.aborted) return;
        await this.dispatch(cause, rule, part, signal);
      }
    }
  }

  /** Claim and run a single effect, or recover an expired started attempt.
   * @param cause - Pinned occasion and rule-set identity.
   * @param rule - Pinned evaluated rule.
   * @param part - Committed effect and its attempt version.
   * @param signal - Host shutdown signal.
   */
  private async dispatch(
    cause: RuleCauseRow,
    rule: RuleEvaluationRow,
    part: RulePartRow,
    signal?: AbortSignal,
  ): Promise<void> {
    const now = Date.now();
    if (part.notBefore !== null && part.notBefore > now) return;
    if (part.callDeadline !== null) {
      if (part.callDeadline <= now)
        await finishPart(this.database, part, uncertainReactionOutcome(part.keyed, 'outcome-unknown'), now);
      return;
    }
    const definition = this.contributions.reaction(part.reaction);
    if (!definition || part.keyed !== definition.keyed) return;
    const deadline = now + this.budget;
    const started = await startPart(this.database, part, now, deadline);
    if (!started) return;
    const outcome = await this.invoke(cause, rule, started, deadline, signal);
    await finishPart(this.database, started, outcome, Date.now());
  }

  /** @param cause - Pinned occasion and rule-set identity.
   * @param rule - Pinned evaluated rule.
   * @param part - Persisted attempt and effect arguments.
   * @param deadline - This attempt's deadline.
   * @param signal - Host shutdown signal.
   * @returns Reaction reply or an uncertain outcome.
   */
  private async invoke(
    cause: RuleCauseRow,
    rule: RuleEvaluationRow,
    part: RulePartRow,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<ReactionOutcome> {
    const { event } = rule.snapshot;
    try {
      return await this.invokeReaction(part.reaction, part.parameters, {
        call: ruleCall(event),
        key: part.key,
        expectedKeyed: part.keyed,
        hostSignal: signal,
        deadlineEpochMs: deadline,
        cause: {
          ruleId: rule.ruleId,
          evaluationId: rule.id,
          event: structuredClone(event),
          ruleSet: structuredClone(cause.snapshot.snapshot.set),
          rule: structuredClone(rule.snapshot.rule),
        },
      });
    } catch {
      return uncertainReactionOutcome(part.keyed, 'outcome-unknown');
    }
  }
}
