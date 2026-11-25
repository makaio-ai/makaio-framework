import { createBusInstance } from '@makaio/bus-core';
import type { HostDatabase, ReactionDefinition } from '@makaio/contracts';
import type { ReactionRule, RuleSourceContribution } from '@makaio/contracts/rules';
import {
  allGroupStrategy,
  busMessageTrigger,
  RuleContributionsService,
  RuleEvaluator,
  ReactionRegistry,
  storeRuleOccasion,
  type RuleOccasion,
} from '@makaio/services-core';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { eq } from 'drizzle-orm';
import { ruleStorageSchema } from '../../../../services/core/src/rules/storage/schema.variants.js';

export const principal = { kind: 'test.person', id: 'principal' };
export const witness = { kind: 'test.source', id: 'witness' };
export const subject = 'rule-suite.changed';

/** @param rule - Rule overrides for a scenario.
 * @returns One rule using a real built-in trigger.
 */
export function ruleFor(rule: Partial<ReactionRule> = {}): ReactionRule {
  return {
    id: 'notify',
    description: 'Notify on change',
    on: { kind: busMessageTrigger.kind, params: { subject } },
    reaction: { kind: 'rule-suite.notify' },
    ...rule,
  };
}

/** @param rules - Candidate rules.
 * @returns A witnessed event and its effective rules.
 */
export function occasion(rules: readonly ReactionRule[]): RuleOccasion {
  const id = crypto.randomUUID();
  return {
    id,
    event: {
      cause: { entryId: id, position: 1 },
      subject,
      origin: { caller: witness, principal, attestedBy: witness },
      facts: {},
    },
    payload: { entries: ['first', 'second'] },
    snapshot: { set: { id: 'configured', digest: 'version' }, rules, groups: [], excluded: [] },
  };
}

/** @param reaction - Effective reaction definition.
 * @returns Registries containing real rule contribution implementations.
 */
export function contributions(reaction?: ReactionDefinition) {
  const bus = createBusInstance();
  const reactions = new ReactionRegistry(bus);
  const service = new RuleContributionsService(
    bus,
    () => reactions,
    () => true,
  );
  service.triggers.register('makaio', [busMessageTrigger]);
  service.groupStrategies.register('makaio', [allGroupStrategy]);
  if (reaction) reactions.register('rule-suite', [reaction]);
  return { service, invoke: reactions.invoke.bind(reactions) };
}

/** @param db - Host database.
 * @param service - Active rule contributions.
 * @param invoke - Dispatcher for the current registrations.
 * @param input - Occasion.
 * @returns Whether this transaction created evaluations.
 */
export async function enqueue(
  db: HostDatabase,
  service: RuleContributionsService,
  invoke: ReactionRegistry['invoke'],
  input: RuleOccasion,
): Promise<boolean> {
  const { snapshot, ...event } = input;
  const source: RuleSourceContribution = {
    rulesFor: async () => snapshot,
    ruleTriggers: () => [],
    onTriggersChanged: () => () => {},
  };
  const registration = { contribution: source };
  const prepared = await new RuleEvaluator(db, service, invoke, () => registration).prepare(event);
  if (prepared.state !== 'prepared') throw new Error('The fixture trigger did not fire');
  return db.transaction((tx) => storeRuleOccasion(tx, prepared.work));
}

/** @param db - Host database.
 * @param id - Occasion identity.
 * @returns Independently read committed causes, evaluations and parts.
 */
export function read(db: HostDatabase, id: string) {
  return db.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleCauses, ruleEvaluations, ruleEvaluationParts } = resolveSchema(query, ruleStorageSchema);
    const [cause] = await query.select().from(ruleCauses).where(eq(ruleCauses.id, id));
    const rules = await query.select().from(ruleEvaluations).where(eq(ruleEvaluations.causeId, id));
    const parts = await query
      .select()
      .from(ruleEvaluationParts)
      .innerJoin(ruleEvaluations, eq(ruleEvaluationParts.evaluationId, ruleEvaluations.id))
      .where(eq(ruleEvaluations.causeId, id));
    return { cause, rules, parts: parts.map((part) => part.rule_evaluation_parts) };
  });
}
