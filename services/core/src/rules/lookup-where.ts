import { type Condition, type FieldCondition, type JsonValue } from '@makaio/contracts';
import type { ConditionTemplate, ValueExpr } from '@makaio/contracts/rules';
import { ConditionSchema, FieldConditionSchema, isJsonObject } from '@makaio/contracts/shared';
import { evaluate } from '@makaio/rules';
import { expression } from './parameter-tree.js';

/** Value expression that reads facts before the lookup starts. */
type DynamicOperand = Exclude<ValueExpr, { readonly literal: JsonValue }>;

/** Outcome of filtering the lookup response locally. */
export type WhereResult =
  | { readonly values: JsonValue[] }
  | { readonly error: { readonly path: string; readonly message: string } };

/** Bind lookup comparison operands before sending the condition to the lookup.
 * @param condition - Condition containing direct operands or value expressions.
 * @param valueFor - Resolves a dynamic operand for its operator and compared field.
 * @returns Validated condition, or undefined if an operand is missing or invalid for its operator.
 */
export function bindLookupWhere(
  condition: ConditionTemplate,
  valueFor: (operand: DynamicOperand, operator: string, field: string) => unknown,
): Condition | undefined {
  if ('$and' in condition) {
    const clauses = condition.$and.map((entry) => bindLookupWhere(entry, valueFor));
    return clauses.every((entry) => entry !== undefined) ? { $and: clauses } : undefined;
  }
  if ('$or' in condition) {
    const clauses = condition.$or.map((entry) => bindLookupWhere(entry, valueFor));
    return clauses.every((entry) => entry !== undefined) ? { $or: clauses } : undefined;
  }
  if ('$not' in condition) {
    const inner = bindLookupWhere(condition.$not, valueFor);
    return inner ? { $not: inner } : undefined;
  }
  if ('$expr' in condition || !isJsonObject(condition.operator)) return ConditionSchema.safeParse(condition).data;
  const [comparison, extra] = Object.entries(condition.operator);
  if (!comparison || extra) return undefined;
  const [operator, value] = comparison;
  const operand = expression(value);
  const bound = operand
    ? 'literal' in operand
      ? operand.literal
      : valueFor(operand, operator, condition.field)
    : value;
  return lookupComparison(condition.field, operator, bound);
}

/** Build a comparison only if the operator accepts the operand.
 * @param field - Compared field.
 * @param operator - Comparison name.
 * @param operand - Bound value.
 * @returns The comparison, if the operand fits its operator.
 */
export function lookupComparison(field: string, operator: string, operand: unknown): FieldCondition | undefined {
  return FieldConditionSchema.safeParse({ field, operator: { [operator]: operand } }).data;
}

/** Condition safe to send to a lookup and whether local filtering is needed. */
interface LookupPushdown {
  /** Necessary portions of the original filter, with no expressions. */
  readonly condition?: Condition;
  /** Whether the original condition must also be applied locally. */
  readonly inMemory: boolean;
}

/** Obtain a necessary condition that the lookup can evaluate without expressions.
 * @param condition - Bound lookup condition.
 * @returns Safe pushdown and whether to re-evaluate the original in memory.
 */
export function lookupPushdown(condition: Condition): LookupPushdown {
  if ('$expr' in condition) return { inMemory: true };
  if ('$not' in condition) {
    return lookupPushdown(condition.$not).inMemory ? { inMemory: true } : { condition, inMemory: false };
  }
  if ('$or' in condition) {
    return condition.$or.some((entry) => lookupPushdown(entry).inMemory)
      ? { inMemory: true }
      : { condition, inMemory: false };
  }
  if ('$and' in condition) {
    const clauses = condition.$and.map(lookupPushdown);
    const necessary = clauses.flatMap((entry) => entry.condition ?? []);
    return {
      condition: necessary.length ? { $and: necessary } : undefined,
      inMemory: clauses.some((entry) => entry.inMemory),
    };
  }
  return { condition, inMemory: false };
}

/** Evaluate the full condition over each returned element's roots.
 * @param condition - Bound original condition.
 * @param answer - Lookup's list response.
 * @returns Filtered values or the first condition error.
 */
export function filterLookupAnswer(condition: Condition, answer: readonly JsonValue[]): WhereResult {
  const values: JsonValue[] = [];
  for (const item of answer) {
    const result = evaluate(condition, isJsonObject(item) ? item : {});
    if ('error' in result) return result;
    if (result.matched) values.push(item);
  }
  return { values };
}
