import type { ReactionDefinition } from '@makaio/contracts/reaction';
import type {
  ReactionRule,
  RuleCheckContext,
  RuleContributionValidationFailure,
  RuleFinding,
  RuleValidationFinding,
} from '@makaio/contracts/rules';
import { boundedWait, getErrorString } from '@makaio/utils';
import type { LookupRegistry } from './lookup-registry.js';
import type { RuleBlockRegistry } from './rule-block-registry.js';

/** Local checks should finish promptly while leaving room for asynchronous checks to yield. */
export const DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS = 1_000;

/** The contribution checks available to the host for one rule. */
interface ContributionValidators {
  /** Finds the validator of the rule's reaction. */
  readonly reaction: (kind: string) => ReactionDefinition['validate'];
  /** Finds declarations of lookups used by the rule. */
  readonly lookups: LookupRegistry;
  /** Finds declarations of extension blocks included in the rule. */
  readonly blocks: RuleBlockRegistry;
}

/** Identity and position of a check; its findings all belong to the same rule. */
export type CheckLocation = Pick<RuleContributionValidationFailure, 'ruleId' | 'contribution' | 'path'>;

/**
 * Collects custom findings for a structurally checked rule.
 * @param rule - The rule, with its extension blocks already checked against their schemas.
 * @param ctx - Validation context supplied by the host.
 * @param validators - Registered contributions referenced by the rule.
 * @param timeoutMs - Time budget for each validator independently.
 * @returns The findings in rule declaration order, beginning with the reaction.
 */
export async function validateRuleContributions(
  rule: ReactionRule,
  ctx: RuleCheckContext,
  validators: ContributionValidators,
  timeoutMs: number,
): Promise<RuleValidationFinding[]> {
  const checks: Array<Promise<RuleValidationFinding[]>> = [];
  const reaction = validators.reaction(rule.reaction.kind);
  if (reaction) {
    checks.push(
      runContributionCheck(
        { ruleId: rule.id, path: '$.reaction', contribution: { kind: 'reaction', name: rule.reaction.kind } },
        timeoutMs,
        () => reaction(rule.reaction.params ?? {}, ctx),
      ),
    );
  }
  for (const [index, lookup] of (rule.lookups ?? []).entries()) {
    const definition = validators.lookups.get(lookup.lookup);
    const validate = definition?.validate;
    if (!validate) continue;
    checks.push(
      runContributionCheck(
        { ruleId: rule.id, path: `$.lookups[${index}]`, contribution: { kind: 'lookup', name: lookup.lookup } },
        timeoutMs,
        () => validate.call(definition, lookup.args, ctx),
      ),
    );
  }
  for (const [name, block] of Object.entries(rule.extensions ?? {})) {
    const definition = validators.blocks.get(name);
    const validate = definition?.validate;
    if (!validate) continue;
    checks.push(
      runContributionCheck(
        { ruleId: rule.id, path: `$.extensions[${JSON.stringify(name)}]`, contribution: { kind: 'rule-block', name } },
        timeoutMs,
        () => validate.call(definition, block, rule, ctx),
      ),
    );
  }
  return (await Promise.all(checks)).flat();
}

/**
 * Bounds the wait for one check and converts exceptions and missed deadlines into findings.
 * @param location - Attribution of the rule and checked contribution.
 * @param timeoutMs - Maximum time to wait for the check in milliseconds.
 * @param check - The contributed validation call.
 * @returns Its findings or a host finding if the call fails or times out.
 */
export async function runContributionCheck(
  location: CheckLocation,
  timeoutMs: number,
  check: () => RuleFinding[] | Promise<RuleFinding[]>,
): Promise<RuleValidationFinding[]> {
  const { contribution, ruleId } = location;
  const label = `${contribution.kind} '${contribution.name}'`;
  const deadline = performance.now() + timeoutMs;
  try {
    const checking = check();
    const outcome = Array.isArray(checking)
      ? { settled: true, value: checking }
      : await boundedWait(checking, Math.max(0, Math.ceil(deadline - performance.now())));
    // Synchronous checks can cross their deadline before the timer gets a turn.
    if (outcome.settled && performance.now() < deadline) {
      return outcome.value.map((finding) => ({ ...finding, ruleId, contribution }));
    }
  } catch (error) {
    if (performance.now() < deadline) {
      const failure: RuleContributionValidationFailure = {
        ...location,
        severity: 'error',
        code: 'contribution-validation-failed',
        message: `Validation of ${label} failed: ${getErrorString(error)}`,
      };
      return [failure];
    }
  }
  const failure: RuleContributionValidationFailure = {
    ...location,
    severity: 'error',
    code: 'contribution-validation-timeout',
    message: `Validation of ${label} exceeded ${timeoutMs} ms`,
  };
  return [failure];
}
