import { isRequestSchema, matchesSubscription } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { getFullSubjectForSubjectDefinition, isSubjectName, isSubjectPattern } from '@makaio/core';
import { AccessSubjects } from '@makaio/contracts/access';
import { JsonRecordSchema, type JsonSchema } from '@makaio/contracts';
import {
  EventFactsSchema,
  ReactionRuleSchema,
  RulesSubjects,
  type ReactionRule,
  type RuleFinding,
  type RuleGroup,
  type RuleValidationFinding,
  type ValidateRulesInput,
} from '@makaio/contracts/rules';
import { isJsonObject } from '@makaio/contracts/shared';
import { z } from 'zod';
import { describeSchemaValue } from '@makaio/rules';
import { BUS_MESSAGE_TRIGGER_KIND } from '../rule-contributions/builtins/bus-message-trigger.js';
import { SEND_BUS_REQUEST_REACTION_KIND } from '../rule-contributions/builtins/send-bus-request-reaction.js';
import { HAS_RIGHT_LOOKUP_KIND } from '../rule-contributions/builtins/has-right-lookup.js';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { checkParameterReferences, expression, factSchema, objectSchema } from './parameter-tree.js';
import { scopeSchema } from './schema-scope.js';
import { unsupportedRules } from './supported-rules.js';
import { checkParameterSchema, checkRuleLookups, checkRuleCondition, type RuleCheck } from './validate-rule-inputs.js';
import type { RuleValidationRights } from './validation-types.js';

// Zod's custom claim field is opaque to condition validation.
const { $schema: _dialect, ...eventSchema } = JsonRecordSchema.parse(
  z.toJSONSchema(EventFactsSchema, { unrepresentable: 'any' }),
);

/** Validate a candidate against live contributions without adding it to any registry.
 * @param service - Active contribution directory.
 * @param rights - Shared candidate authorization operations.
 * @param input - Proposed effective rule set.
 * @returns Stable rule findings in input order.
 */
export async function validateRuleSet(
  service: RuleContributionsService,
  rights: RuleValidationRights,
  input: ValidateRulesInput,
): Promise<RuleValidationFinding[]> {
  const findings: RuleValidationFinding[] = [];
  const groups = Map.groupBy(input.groups.entries(), ([, declaration]) => declaration.group);
  for (const declarations of groups.values()) {
    for (const [index] of declarations.slice(1)) {
      findings.push(error('duplicate-group', `groups.${index}.group`, 'Group name must be unique'));
    }
  }
  const unsupported = unsupportedRules(input);
  for (const rule of input.rules) {
    const parsed = ReactionRuleSchema.safeParse(rule);
    if (!parsed.success) {
      findings.push(
        ...parsed.error.issues.map((issue) => ({
          ...error('rule-invalid', issue.path.join('.'), issue.message),
          ruleId: rule.id,
        })),
      );
      continue;
    }
    const check: RuleCheck = { findings: [], roots: {}, catalogContext: input.catalogContext };
    try {
      await checkRule(service, rights, input, rule, check);
    } catch {
      check.findings.push(error('params-invalid', '', 'A contribution could not check these parameters'));
    }
    const group = rule.group === undefined ? undefined : groups.get(rule.group)?.[0]?.[1];
    checkGroup(service, input, rule, group, check.findings);
    findings.push(...check.findings.map((finding) => ({ ...finding, ruleId: rule.id })));
  }
  for (const [ruleId, path] of unsupported) {
    findings.push({ ...error('not-implemented', path, 'This rule construct is not supported'), ruleId });
  }
  return findings;
}

/** @param code - Finding code.
 * @param path - Rule location.
 * @param message - Finding description.
 * @returns A rejecting finding.
 */
function error(code: string, path: string, message: string): RuleFinding {
  return { severity: 'error', code, path, message };
}

/** Check group rules independently of schemas and authorization.
 * @param service - Active contribution directory.
 * @param input - Effective set.
 * @param rule - Candidate member.
 * @param group - Matching group declaration, when present.
 * @param findings - Findings for the member.
 */
function checkGroup(
  service: RuleContributionsService,
  input: ValidateRulesInput,
  rule: ValidateRulesInput['rules'][number],
  group: RuleGroup | undefined,
  findings: RuleFinding[],
): void {
  if (input.rules.filter(({ id }) => id === rule.id).length > 1) {
    findings.push(error('duplicate-rule-id', 'id', 'Rule identifier must be unique'));
  }
  if (rule.group === undefined) {
    if (rule.priority !== undefined)
      findings.push(error('priority-without-group', 'priority', 'Priority requires a group'));
    if (rule.stop === 'group') findings.push(error('stop-group-without-group', 'stop', 'Group stop requires a group'));
    return;
  }
  if (!group) findings.push(error('unknown-group', 'group', 'Group is not declared'));
  else if (!service.strategy(group.strategy))
    findings.push(error('unknown-strategy', 'group', 'Strategy is not active'));
  if (rule.priority === undefined)
    findings.push(error('priority-missing', 'priority', 'Group members require a priority'));
  else {
    for (const other of input.rules) {
      if (other.id !== rule.id && other.group === rule.group && other.priority === rule.priority) {
        findings.push(error('priority-tie', 'priority', `Priority is also used by '${other.id}'`));
      }
    }
  }
  if (rule.mandatory) findings.push(error('mandatory-in-group', 'mandatory', 'Mandatory rules are independent'));
  if (rule.stop === 'event') findings.push(error('event-stop-in-group', 'stop', 'Event stops are independent'));
}

/** Check the trigger, facts, reaction, and extension blocks of one rule.
 * @param service - Active contribution directory.
 * @param rights - Shared candidate authorization operations.
 * @param input - Effective set and candidate rights.
 * @param rule - Rule to check.
 * @param check - Schema scope and findings.
 */
async function checkRule(
  service: RuleContributionsService,
  rights: RuleValidationRights,
  input: ValidateRulesInput,
  rule: ValidateRulesInput['rules'][number],
  check: RuleCheck,
): Promise<void> {
  const trigger = service.trigger(rule.on.kind);
  if (!trigger) check.findings.push(error('unknown-trigger', 'on.kind', 'Trigger is not active'));
  const parameters = trigger?.params ? await trigger.params.safeParseAsync(rule.on.params) : undefined;
  if (trigger && (parameters ? !parameters.success : rule.on.params !== undefined)) {
    const code = rule.on.kind === BUS_MESSAGE_TRIGGER_KIND ? 'pattern-invalid' : 'params-invalid';
    check.findings.push(error(code, 'on.params', 'Trigger parameters do not match the schema'));
  } else if (trigger) {
    await checkSubjects(service, rights, rule, trigger.subjects(rule.on.params), check);
  }
  const factsSchema =
    rule.on.kind === BUS_MESSAGE_TRIGGER_KIND
      ? objectSchema({ subject: { type: 'string' }, payload: {} })
      : (trigger?.facts(rule.on.params, input.catalogContext) ?? {});
  check.roots.$event = {
    ...eventSchema,
    properties: {
      ...(isJsonObject(eventSchema.properties) ? eventSchema.properties : {}),
      facts: scopeSchema(factsSchema, '#/properties/facts'),
    },
  };
  const availableRights = new Set([...rights.listRights(), ...(input.pendingRights ?? []).map(({ right }) => right)]);
  await checkRuleLookups(service, rule, check, availableRights, HAS_RIGHT_LOOKUP_KIND);
  checkRuleCondition(rule.when, check.roots, 'when', check.findings);
  if (trigger?.expand && rule.on.params !== undefined && parameters?.success) {
    checkRuleCondition(trigger.expand(rule.on.params), { $event: check.roots.$event }, 'on.params', check.findings);
  }
  if (rule.each) checkEach(rule.each, check);
  await checkReaction(service, rights, rule, check);
  await checkBlocks(service, rule, check);
}

/** @param each - List path declared by the rule.
 * @param check - Schema scope and findings.
 */
function checkEach(each: string, check: RuleCheck): void {
  const roots = objectSchema(check.roots);
  const array = factSchema(roots, each, 'each', check.findings);
  if (array && describeSchemaValue(array, roots).types?.has('array') === false) {
    check.findings.push(error('type-mismatch', 'each', 'Each must select an array'));
  }
  check.roots.$item = factSchemaForItem(roots, each);
}

/** @param service - Active contribution directory.
 * @param rule - Candidate rule containing the blocks.
 * @param check - Schema scope and findings.
 */
async function checkBlocks(
  service: RuleContributionsService,
  rule: ValidateRulesInput['rules'][number],
  check: RuleCheck,
): Promise<void> {
  for (const [owner, block] of Object.entries(rule.extensions ?? {})) {
    const contribution = service.ruleBlock(owner);
    const path = `extensions.${owner}`;
    if (!contribution) check.findings.push(error('extension-block-unknown', path, 'Rule block is not active'));
    else if (!(await contribution.schema.safeParseAsync(block)).success) {
      check.findings.push(error('extension-block-mismatch', path, 'Rule block does not match its schema'));
    } else {
      const validate = contribution.validate?.bind(contribution);
      if (!validate) continue;
      check.findings.push(
        ...(await service.checkContribution(
          {
            ruleId: rule.id,
            path: `$.extensions[${JSON.stringify(owner)}]`,
            contribution: { kind: 'rule-block', name: owner },
          },
          async () =>
            (
              await validate(block, rule, check)
            ).map((finding) => ({
              ...finding,
              path: finding.path ? `${path}.${finding.path}` : path,
              code: finding.severity === 'error' ? 'extension-block-mismatch' : finding.code,
            })),
        )),
      );
    }
  }
}

/** @param roots - Rule fact schemas.
 * @param each - List path.
 * @returns Element schema when described.
 */
function factSchemaForItem(roots: JsonSchema, each: string): JsonSchema {
  const item = factSchema(roots, `${each}.0`, 'each', []);
  if (!item) return {};
  const scope = '#/$defs/scope';
  return { allOf: [scopeSchema(item, scope)], $defs: { scope: scopeSchema(roots, scope) } };
}

/** @param service - Contribution service.
 * @param rights - Candidate rights operations.
 * @param rule - Rule being checked.
 * @param patterns - Trigger subscriptions.
 * @param check - Findings and catalog scope.
 */
async function checkSubjects(
  service: RuleContributionsService,
  rights: RuleValidationRights,
  rule: ValidateRulesInput['rules'][number],
  patterns: readonly string[],
  check: RuleCheck,
): Promise<void> {
  const path = 'on.params';
  const events = busContextOf(service.validationBus)
    .namespaceRegistry.listRegisteredSubjects()
    .filter(({ schema }) => !isRequestSchema(schema));
  if (patterns.length === 0) check.findings.push(error('trigger-subjects-empty', path, 'Trigger returned no subjects'));
  for (const pattern of patterns) {
    if (!isSubjectPattern(pattern)) {
      check.findings.push(error('pattern-invalid', path, `Invalid subject pattern '${pattern}'`));
      continue;
    }
    if (!(await rights.canSubscribe(pattern, check.catalogContext))) {
      check.findings.push(error('not-subscribable', path, `Cannot subscribe to '${pattern}'`));
    }
    if (EVENT_HINTS.some((hint) => matchesSubscription(hint, pattern))) {
      check.findings.push(error('hint-subject', path, 'Trigger matches a framework hint'));
    }
    const matched = events.filter(({ fullSubject }) => matchesSubscription(fullSubject, pattern));
    if (matched.length > 0 && matched.every(({ journal }) => journal?.retention !== 'recorded')) {
      check.findings.push(error('not-implemented', path, 'Volatile-only rule triggers are not supported'));
    }
    if (rule.on.kind === BUS_MESSAGE_TRIGGER_KIND && matched.length === 0) {
      check.findings.push({
        severity: 'warning',
        code: 'unknown-subject',
        path,
        message: `No event matches '${pattern}'`,
      });
    }
  }
}

const EVENT_HINTS = [RulesSubjects['evaluation-settled'], AccessSubjects.denied].map(
  getFullSubjectForSubjectDefinition,
);

/** @param service - Active contribution directory.
 * @param rights - Shared candidate authorization operations.
 * @param rule - Rule to check.
 * @param check - Schema scope and findings.
 */
async function checkReaction(
  service: RuleContributionsService,
  rights: RuleValidationRights,
  rule: ValidateRulesInput['rules'][number],
  check: RuleCheck,
): Promise<void> {
  const reaction = service.reaction(rule.reaction.kind);
  if (!reaction) {
    check.findings.push(error('unknown-reaction', 'reaction.kind', 'Reaction is not active'));
    return;
  }
  const params = rule.reaction.params ?? {};
  checkParameterReferences(params, objectSchema(check.roots), 'reaction.params', check.findings, 'record');
  await checkParameterSchema(params, reaction.parameterSchema, 'reaction.params', check.findings, 'record');
  const { validate } = reaction;
  if (validate) {
    check.findings.push(
      ...(await service.checkContribution(
        { ruleId: rule.id, path: '$.reaction', contribution: { kind: 'reaction', name: rule.reaction.kind } },
        () => validate(params, check),
      )),
    );
  }
  if (rule.reaction.kind === SEND_BUS_REQUEST_REACTION_KIND) {
    await checkRequestReaction(service, rights, params, check);
  }
}

/** Check request targets and payload schema violations independent of runtime facts.
 * @param service - Active contribution directory.
 * @param rights - Shared candidate authorization operations.
 * @param params - Bus request parameter tree.
 * @param check - Schema scope and findings.
 */
async function checkRequestReaction(
  service: RuleContributionsService,
  rights: RuleValidationRights,
  params: NonNullable<ReactionRule['reaction']['params']>,
  check: RuleCheck,
): Promise<void> {
  const subjectTree = params.subject;
  const node = expression(subjectTree);
  const subject = node && 'literal' in node ? node.literal : subjectTree;
  const path = 'reaction.params.subject';
  if (typeof subject !== 'string') {
    check.findings.push(error('subject-not-literal', path, 'Request subject must be fixed'));
    return;
  }
  if (!isSubjectName(subject)) {
    check.findings.push(error('params-invalid', path, 'Invalid request subject'));
    return;
  }
  if (!(await rights.canSend(subject, check.catalogContext))) {
    check.findings.push(error('request-not-granted', path, `Cannot send to '${subject}'`));
  }
  const schema = busContextOf(service.validationBus).namespaceRegistry.getSchema(subject);
  if (!schema || !isRequestSchema(schema)) {
    check.findings.push({
      severity: 'warning',
      code: 'unknown-subject',
      path,
      message: `No request named '${subject}'`,
    });
    return;
  }
  await checkParameterSchema(params.payload, schema.request, 'reaction.params.payload', check.findings);
}
