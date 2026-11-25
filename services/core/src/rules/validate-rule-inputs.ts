import type { Condition, JsonSchema, JsonValue } from '@makaio/contracts';
import type { ConditionTemplate, ReactionRule, RuleFinding } from '@makaio/contracts/rules';
import { validateCondition } from '@makaio/rules';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { describeSchemaValue } from '@makaio/rules';
import { isJsonObject, type JsonValueType } from '@makaio/contracts/shared';
import { bindLookupWhere, lookupComparison } from './lookup-where.js';
import { z } from 'zod';
import {
  checkParameterReferences,
  expression,
  factSchema,
  objectSchema,
  resolveParameters,
  type ParameterRoot,
} from './parameter-tree.js';

const exampleValues: Record<JsonValueType, JsonValue> = {
  number: 0,
  boolean: true,
  null: null,
  array: [],
  object: {},
  string: 'value',
};
const exampleDateTime = '1970-01-01T00:00:00Z';

/** Fact schemas and findings kept while checking one rule in evaluation order. */
export interface RuleCheck {
  /** Candidate context forwarded to contribution schemas and checks. */
  readonly catalogContext?: JsonValue;
  /** Fact schemas available up to the current position. */
  readonly roots: Record<string, JsonSchema>;
  /** Findings discovered so far. */
  readonly findings: RuleFinding[];
}

/** Validate one condition within its current fact scope.
 * @param condition - Rule or lookup condition.
 * @param roots - Fact schemas by root.
 * @param path - Location on the rule.
 * @param findings - Accumulator to receive prefixed findings.
 */
export function checkRuleCondition(
  condition: Condition | undefined,
  roots: Record<string, JsonSchema>,
  path: string,
  findings: RuleFinding[],
): void {
  if (!condition) return;
  findings.push(
    ...validateCondition({ condition, context: objectSchema(roots) })
      .filter(({ severity }) => severity !== 'warning')
      .map((finding) => ({ ...finding, path: finding.path ? `${path}.${finding.path}` : path })),
  );
}

/** Check each lookup against the facts that precede it.
 * @param service - Active lookup registry.
 * @param rule - Candidate rule.
 * @param check - Current fact schemas and findings.
 * @param rights - Names known in the active or candidate directory.
 * @param rightLookupKind - Built-in lookup that checks a right.
 */
export async function checkRuleLookups(
  service: RuleContributionsService,
  rule: ReactionRule,
  check: RuleCheck,
  rights: ReadonlySet<string>,
  rightLookupKind: string,
): Promise<void> {
  const answers: Record<string, JsonSchema> = {};
  for (const [index, call] of (rule.lookups ?? []).entries()) {
    const path = `lookups.${index}`;
    check.roots.$lookup = objectSchema(answers);
    const lookup = service.lookup(call.lookup);
    if (!lookup) {
      check.findings.push({ severity: 'error', code: 'unknown-lookup', path, message: 'Lookup is not active' });
      continue;
    }
    if (Object.hasOwn(answers, call.name)) {
      check.findings.push({
        severity: 'error',
        code: 'duplicate-lookup',
        path,
        message: 'Lookup names must be unique',
      });
    }
    checkParameterReferences(call.args, objectSchema(check.roots), `${path}.args`, check.findings, 'record');
    await checkParameterSchema(call.args, lookup.args, `${path}.args`, check.findings, 'record');
    const validate = lookup.validate?.bind(lookup);
    if (validate) {
      const location = {
        ruleId: rule.id,
        path: `$.lookups[${index}]`,
        contribution: { kind: 'lookup' as const, name: call.lookup },
      };
      check.findings.push(...(await service.checkContribution(location, () => validate(call.args, check))));
    }
    if (call.lookup === rightLookupKind) {
      const arg = call.args.right;
      const node = arg === undefined ? undefined : expression(arg);
      const value = node && 'literal' in node ? node.literal : arg;
      if (typeof value !== 'string' || !rights.has(value)) {
        check.findings.push({
          severity: 'error',
          code: 'unknown-right',
          path: `${path}.args.right`,
          message: 'Right is not declared',
        });
      }
    }
    if (call.where && lookup.where) {
      checkLookupWhere(call.where, lookup.where.roots(call.args, check), `${path}.where`, check);
    } else if (call.where) {
      check.findings.push({
        severity: 'error',
        code: 'params-invalid',
        path: `${path}.where`,
        message: 'Lookup does not accept where',
      });
    }
    const answer = lookup.answer(call.args, check);
    if (lookup.where && describeSchemaValue(answer, answer).types?.has('array') === false) {
      check.findings.push({
        severity: 'error',
        code: 'params-invalid',
        path,
        message: 'Lookup with where must return a list',
      });
    }
    Object.defineProperty(answers, call.name, {
      value: answer,
      enumerable: true,
      configurable: true,
    });
  }
  check.roots.$lookup = objectSchema(answers);
}

/** Type-check an expression-bearing lookup condition after binding reference types.
 * @param where - Proposed lookup condition.
 * @param roots - Lookup-specific roots available on a result element.
 * @param path - Location of the lookup condition.
 * @param check - Earlier fact schemas and findings.
 */
function checkLookupWhere(
  where: ConditionTemplate,
  roots: Record<string, JsonSchema>,
  path: string,
  check: RuleCheck,
): void {
  const previous = objectSchema(check.roots);
  const element = objectSchema(roots);
  const bound = bindLookupWhere(where, (operand, operator, field) => {
    if ('template' in operand) {
      checkParameterReferences(operand, previous, path, check.findings);
      const fixed = resolveParameters(operand, {});
      const candidates = fixed === undefined ? [exampleValues.string, exampleDateTime] : [fixed];
      return compatibleOperand(candidates, field, operator, element);
    }
    const source = factSchema(previous, operand.ref, path, check.findings);
    const { types, dateTime } = describeSchemaValue(source ?? {}, previous);
    const candidates = types
      ? [...types].map((type) => (type === 'string' && dateTime ? exampleDateTime : exampleValues[type]))
      : [...Object.values(exampleValues), exampleDateTime];
    return compatibleOperand(candidates, field, operator, element);
  });
  if (!bound) {
    check.findings.push({
      severity: 'error',
      code: 'params-invalid',
      path,
      message: 'Lookup condition operand has the wrong type',
    });
    return;
  }
  checkRuleCondition(bound, roots, path, check.findings);
}

/** Find a type-compatible value for the comparison's static check.
 * @param candidates - Representative values of admitted operand types.
 * @param field - Compared field.
 * @param operator - Comparison name.
 * @param context - JSON Schema of a lookup result element.
 * @returns A compatible operand or a parseable one to preserve the full condition's type diagnostic.
 */
function compatibleOperand(
  candidates: readonly JsonValue[],
  field: string,
  operator: string,
  context: JsonSchema,
): JsonValue | undefined {
  let firstBound: JsonValue | undefined;
  for (const operand of candidates) {
    const condition = lookupComparison(field, operator, operand);
    if (!condition) continue;
    if (firstBound === undefined) firstBound = operand;
    if (!validateCondition({ condition, context }).some(({ code }) => code === 'type-mismatch')) return operand;
  }
  return firstBound;
}

/** Parse fixed inputs with the same Zod schemas used by the runtime. In a mixed input,
 * only independently parsed fixed subtrees can establish a schema violation. Values
 * depending on facts and schemas that can change how children are parsed (such as pipes
 * and unions) are checked once the input is resolved at runtime.
 * @param tree - Rule parameter tree.
 * @param schema - Live contribution parameter schema.
 * @param path - Rule location.
 * @param findings - Accumulator for diagnostics.
 * @param root - Whether this node is a parameter record or a value.
 */
export async function checkParameterSchema(
  tree: unknown,
  schema: z.ZodType,
  path: string,
  findings: RuleFinding[],
  root?: ParameterRoot,
): Promise<void> {
  const fixed = resolveParameters(tree, {}, root);
  if (fixed !== undefined) {
    if (!(await schema.safeParseAsync(fixed)).success) {
      findings.push({
        severity: 'error',
        code: 'params-invalid',
        path,
        message: 'Parameters do not match the contribution schema',
      });
    }
    return;
  }
  if (expression(tree, root) || tree === null || typeof tree !== 'object') return;
  if (schema instanceof z.ZodObject && isJsonObject(tree)) {
    checkObjectKeys(tree, schema, path, findings);
  }
  if (schema.def.checks?.length) return;
  for (const [key, value] of Object.entries(tree)) {
    const child = parameterChildSchema(schema, tree, key);
    if (child) await checkParameterSchema(value, child, `${path}.${key}`, findings);
  }
}

/**
 * Check object keys whose presence is independent of resolved references.
 * @param tree - Explicit fields in the parameter object.
 * @param schema - Direct object parser used at runtime.
 * @param path - Rule location.
 * @param findings - Accumulator for diagnostics.
 */
function checkObjectKeys(
  tree: Record<string, unknown>,
  schema: z.ZodObject,
  path: string,
  findings: RuleFinding[],
): void {
  for (const [name, child] of Object.entries(schema.shape)) {
    // The object parser uses input optionality to distinguish an absent key from an undefined value.
    if (!Object.hasOwn(tree, name) && child instanceof z.ZodType && child._zod.optin !== 'optional') {
      findings.push({
        severity: 'error',
        code: 'params-invalid',
        path: `${path}.${name}`,
        message: 'Missing required parameter',
      });
    }
  }
  if (schema.def.catchall instanceof z.ZodNever) {
    for (const name of Object.keys(tree)) {
      // The object parser discards this key before applying the catchall.
      if (name !== '__proto__' && !Object.hasOwn(schema.shape, name)) {
        findings.push({
          severity: 'error',
          code: 'params-invalid',
          path: `${path}.${name}`,
          message: 'Unexpected parameter',
        });
      }
    }
  }
}

/** @param schema - Schema of the containing object or array.
 * @param tree - Candidate container.
 * @param key - Property name or array index.
 * @returns The child's schema when the container always delegates to it directly.
 */
function parameterChildSchema(schema: z.ZodType, tree: object, key: string): z.ZodType | undefined {
  if (schema instanceof z.ZodArray && Array.isArray(tree)) {
    return schema.element instanceof z.ZodType ? schema.element : undefined;
  }
  if (schema instanceof z.ZodObject && isJsonObject(tree) && Object.hasOwn(schema.shape, key)) {
    const child: unknown = schema.shape[key];
    return child instanceof z.ZodType ? child : undefined;
  }
  return undefined;
}
