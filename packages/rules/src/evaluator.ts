import {
  type ConditionError,
  type ConditionOutcome,
  type ConditionScalarValue,
  isJsonObject,
  jsonEquals,
  readDotPath,
} from '@makaio/contracts/shared';
import { compile, type CompiledExpression } from '@makaio/expression';
import { Minimatch } from 'minimatch';
import { childPath } from './condition-path.js';
import type { Condition, FieldOperator, JsonObjectShape, Rule, RuleSetOptions, RuleSetOutcome } from './types.js';

const CACHE_LIMIT = 256;
const expressionCache = new Map<string, CompiledExpression>();
const globCache = new Map<string, Minimatch>();

/**
 * RFC 3339 `date-time` (full-date "T" full-time). Time zone offset is required.
 */
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Evaluate a condition synchronously against a context object.
 *
 * Evaluation never throws. The outcome is `{ matched }` when the condition could be
 * evaluated, or `{ error: { path, message } }` when it could not (an `$expr` that fails to
 * compile or run, or any other throw such as a throwing getter or an over-long glob). `path` locates the failing node in the condition tree;
 * the root is `''`, for example `$and[1].$not.$expr`.
 *
 * The outcome does not depend on operand order: `$and` and `$or` evaluate every operand.
 * If any operand fails, the outcome is that error (with several, the first by position);
 * otherwise `$and` matches when every operand matched and `$or` when any operand matched.
 * `$not` passes an error through unchanged and negates a match.
 *
 * Field paths read own properties only (via `readDotPath`); `$expr` sees the object as given,
 * including inherited properties.
 * @param condition - Condition tree to evaluate
 * @param context - Context object available to field and expression conditions
 * @returns Whether the condition matched, or why it could not be evaluated
 */
export function evaluate(condition: Condition, context: object): ConditionOutcome {
  return evaluateAt(condition, context, '');
}

/**
 * Evaluate a rule list synchronously and sort the rules by outcome, in input order.
 * Disabled rules are skipped unless explicitly included via options.
 * This function does not inspect `Rule.priority`; callers that need priority
 * ordering must sort the rule array before passing it in. It never throws: a rule
 * whose condition cannot be evaluated is reported in `failed` with its error.
 * @param rules - Rules to evaluate
 * @param context - Context object available to each condition
 * @param options - Rule-set evaluation options
 * @returns Rules whose conditions matched, and rules whose conditions failed
 */
export function evaluateRules<TAction extends JsonObjectShape>(
  rules: readonly Rule<TAction>[],
  context: object,
  options: RuleSetOptions = {},
): RuleSetOutcome<TAction> {
  const { includeDisabled = false } = options;
  const outcome: RuleSetOutcome<TAction> = { matched: [], failed: [] };

  for (const rule of rules) {
    if (!includeDisabled && !rule.enabled) {
      continue;
    }

    const result = evaluate(rule.condition, context);
    if ('error' in result) {
      outcome.failed.push({ rule, error: result.error });
    } else if (result.matched) {
      outcome.matched.push(rule);
    }
  }

  return outcome;
}

/**
 * Evaluate one node of a condition tree.
 * @param condition - Node to evaluate
 * @param context - Context object available to field and expression conditions
 * @param path - Path of this node in the condition tree (root is `''`)
 * @returns Outcome of this node
 */
function evaluateAt(condition: Condition, context: object, path: string): ConditionOutcome {
  try {
    if ('$and' in condition) {
      return evaluateAll(condition.$and, context, childPath(path, '$and'), (matches) => matches.every(Boolean));
    }

    if ('$or' in condition) {
      return evaluateAll(condition.$or, context, childPath(path, '$or'), (matches) => matches.some(Boolean));
    }

    if ('$not' in condition) {
      const outcome = evaluateAt(condition.$not, context, childPath(path, '$not'));
      return 'error' in outcome ? outcome : { matched: !outcome.matched };
    }

    if ('$expr' in condition) {
      return { matched: Boolean(getCachedExpression(condition.$expr).evalSync(context)) };
    }

    return { matched: matchesOperator(readDotPath(context, condition.field), condition.operator) };
  } catch (error) {
    // The innermost frame catches first, so the error names the failing node.
    return {
      error: {
        path: '$expr' in condition ? childPath(path, '$expr') : path,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Evaluate every operand of `$and` or `$or` without short circuit.
 * @param children - Operands in position order
 * @param context - Context object available to each operand
 * @param path - Path of the operand list (for example `$and`)
 * @param combine - Reduces the operands' matches when none of them failed
 * @returns The first error by position, or the combined match
 */
function evaluateAll(
  children: readonly Condition[],
  context: object,
  path: string,
  combine: (matches: boolean[]) => boolean,
): ConditionOutcome {
  let firstError: ConditionError | undefined;
  const matches: boolean[] = [];

  for (const [index, child] of children.entries()) {
    const outcome = evaluateAt(child, context, `${path}[${index}]`);
    if ('error' in outcome) {
      firstError ??= outcome.error;
    } else {
      matches.push(outcome.matched);
    }
  }

  return firstError === undefined ? { matched: combine(matches) } : { error: firstError };
}

/**
 * These compatibility-sensitive helpers intentionally duplicate the overlapping
 * `@makaio/bus-core` payload-filter semantics instead of importing them.
 *
 * `@makaio/rules` is a lower-level package, so depending on bus-core would
 * invert the framework dependency direction. Keep the behavior aligned via the
 * package-local compatibility tests when either implementation changes.
 *
 * The ordering operators (`$lt`, `$lte`, `$gt`, `$gte`), `$empty`, and JSON value
 * equality for `$eq`/`$ne` exist only here, not in the payload filter.
 */

/**
 * Compare a resolved field value against a serialized field operator.
 *
 * Package-internal (not exported from the package index): the condition validator
 * calls it with `undefined` to learn whether an operator matches an absent field.
 * @param actual - Resolved field value from the evaluation context
 * @param operator - Serialized operator definition to apply
 * @returns Whether the operator matched the resolved value
 */
export function matchesOperator(actual: unknown, operator: FieldOperator): boolean {
  if (typeof operator !== 'object' || operator === null) {
    return actual === operator;
  }

  if ('$eq' in operator) {
    return jsonEquals(actual, operator.$eq);
  }

  if ('$ne' in operator) {
    return !jsonEquals(actual, operator.$ne);
  }

  if ('$in' in operator) {
    return operator.$in.includes(actual as (typeof operator.$in)[number]);
  }

  if ('$nin' in operator) {
    return !operator.$nin.includes(actual as (typeof operator.$nin)[number]);
  }

  if ('$contains' in operator) {
    return Array.isArray(actual) && actual.includes(operator.$contains);
  }

  if ('$containsPrefix' in operator) {
    return (
      Array.isArray(actual) &&
      actual.some((value: unknown) => typeof value === 'string' && value.startsWith(operator.$containsPrefix))
    );
  }

  if ('$exists' in operator) {
    // null is treated as "present": only undefined signals absence (PayloadFilter compatibility).
    const exists = actual !== undefined;
    return operator.$exists ? exists : !exists;
  }

  if ('$startsWith' in operator) {
    return typeof actual === 'string' && actual.startsWith(operator.$startsWith);
  }

  if ('$endsWith' in operator) {
    return typeof actual === 'string' && actual.endsWith(operator.$endsWith);
  }

  if ('$glob' in operator) {
    return typeof actual === 'string' && getCachedGlob(operator.$glob).match(actual);
  }

  return matchesOrderOrEmptyOperator(actual, operator);
}

/**
 * Apply the ordering operators and `$empty`; any other operator does not match.
 * @param actual - Resolved field value from the evaluation context
 * @param operator - Serialized operator object not handled by `matchesOperator`
 * @returns Whether the operator matched the resolved value
 */
function matchesOrderOrEmptyOperator(actual: unknown, operator: Exclude<FieldOperator, ConditionScalarValue>): boolean {
  if ('$lt' in operator) {
    return matchesOrder(actual, operator.$lt, (order) => order < 0);
  }

  if ('$lte' in operator) {
    return matchesOrder(actual, operator.$lte, (order) => order <= 0);
  }

  if ('$gt' in operator) {
    return matchesOrder(actual, operator.$gt, (order) => order > 0);
  }

  if ('$gte' in operator) {
    return matchesOrder(actual, operator.$gte, (order) => order >= 0);
  }

  if ('$empty' in operator) {
    // An absent field is neither empty nor non-empty.
    return actual !== undefined && isEmptyValue(actual) === operator.$empty;
  }

  return false;
}

/**
 * Three-way comparison of two numbers.
 * @param left - Left number
 * @param right - Right number
 * @returns Negative when `left` is smaller, positive when larger, `0` when equal
 */
function compareNumbers(left: number, right: number): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Three-way comparison of two instants: whole milliseconds first, then the digits below them.
 * @param left - Left instant
 * @param right - Right instant
 * @returns Negative when `left` is earlier, positive when later, `0` when the same instant
 */
function compareDateTimes(left: DateTimeInstant, right: DateTimeInstant): number {
  const byMilliseconds = compareNumbers(left.ms, right.ms);
  if (byMilliseconds !== 0) {
    return byMilliseconds;
  }

  // Equal-length digit strings order lexicographically like the numbers they spell.
  const width = Math.max(left.sub.length, right.sub.length);
  const leftSub = left.sub.padEnd(width, '0');
  const rightSub = right.sub.padEnd(width, '0');
  if (leftSub < rightSub) {
    return -1;
  }
  return leftSub > rightSub ? 1 : 0;
}

/**
 * Apply an ordering test to two comparable values.
 * Two finite numbers compare numerically; two RFC 3339 date-time strings compare
 * as instants. Any other pairing does not match.
 * @param actual - Resolved field value
 * @param operand - Operator operand
 * @param test - Ordering test applied to the three-way comparison result of actual against operand
 * @returns Whether both sides are comparable and the test holds
 */
function matchesOrder(actual: unknown, operand: number | string, test: (order: number) => boolean): boolean {
  if (typeof actual === 'number' && typeof operand === 'number') {
    return Number.isFinite(actual) && Number.isFinite(operand) && test(compareNumbers(actual, operand));
  }

  if (typeof actual === 'string' && typeof operand === 'string') {
    const left = parseDateTime(actual);
    const right = parseDateTime(operand);
    return left !== undefined && right !== undefined && test(compareDateTimes(left, right));
  }

  return false;
}

/**
 * Whether a year is a Gregorian leap year.
 * @param year - Four-digit year
 * @returns Whether February has 29 days
 */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Whether the numeric components of an RFC 3339 date-time are real calendar and clock values.
 * @param parts - Year, month, day, hour, minute, second and, for a numeric offset, offset hour and minute
 * @returns Whether every component is in range
 */
function hasRealComponents(parts: readonly number[]): boolean {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, offsetHour = 0, offsetMinute = 0] = parts;
  const daysInMonth = month === 2 && isLeapYear(year) ? 29 : (DAYS_PER_MONTH[month - 1] ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

/**
 * An instant with the full fractional precision of the string it was parsed from.
 */
export interface DateTimeInstant {
  /** Epoch milliseconds (fraction truncated to three digits). */
  readonly ms: number;
  /** Fraction digits after the third, trailing zeros removed; `''` when there are none. */
  readonly sub: string;
}

/**
 * Parse an RFC 3339 date-time string to an instant.
 *
 * Every component has to be a real calendar and clock value: month 1-12, a day the month has
 * in that year (leap years included), hour 0-23, minute 0-59, second 0-59 and, for a numeric
 * offset, offset hour 0-23 and offset minute 0-59. `Date.parse` alone is not enough because
 * it rolls an impossible day over (`2026-02-30` becomes March 2) and reads hour 24 as the
 * next midnight. A leap second (`:60`) is RFC 3339 syntax but is rejected too: epoch
 * milliseconds cannot represent it. The letters `T` and `Z` may be lower case.
 *
 * Any number of fractional-second digits is accepted and none is lost: `Date.parse` only sees
 * the fraction normalised to exactly three digits, and the digits below the millisecond are
 * returned as `sub`, so timestamps with microsecond, 100 ns or nanosecond precision order
 * correctly within one millisecond.
 *
 * Package-internal (not exported from the package index): the condition validator uses it to
 * check the string operands of the ordering operators.
 * @param value - Candidate string
 * @returns The instant, or `undefined` when the string is not an RFC 3339 date-time
 */
export function parseDateTime(value: string): DateTimeInstant | undefined {
  const match = RFC3339_DATE_TIME.exec(value);
  if (match === null) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second, fraction = '', offsetHour, offsetMinute] = match;
  const parts = [year, month, day, hour, minute, second, offsetHour, offsetMinute];
  if (!hasRealComponents(parts.map((part) => Number(part ?? 0)))) {
    return undefined;
  }

  const normalised = value.toUpperCase().replace(/\.\d+/, `.${fraction.slice(0, 3).padEnd(3, '0')}`);
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? undefined : { ms, sub: fraction.slice(3).replace(/0+$/, '') };
}

/**
 * Decide whether a present value is empty for `$empty`.
 * @param value - Resolved field value (not `undefined`)
 * @returns Whether the value is `''`, `[]`, `{}` (no own keys), or `null`
 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return isJsonObject(value) && Object.keys(value).length === 0;
}

/**
 * Compile or reuse a cached expression for repeated synchronous evaluation.
 * @param expression - Expression source string
 * @returns Cached compiled expression
 */
function getCachedExpression(expression: string): CompiledExpression {
  return getOrCreateCacheEntry(expressionCache, expression, () => compile(expression));
}

/**
 * Compile or reuse a cached glob matcher for repeated path evaluation.
 * @param pattern - Minimatch-style glob pattern
 * @returns Cached compiled matcher
 */
function getCachedGlob(pattern: string): Minimatch {
  return getOrCreateCacheEntry(globCache, pattern, () => new Minimatch(pattern));
}

/**
 * Read or populate a bounded cache while refreshing hit order.
 * @param cache - Cache map keyed by serialized matcher input
 * @param key - Cache lookup key
 * @param create - Factory used when the cache does not already contain the key
 * @returns Cached or newly created value
 */
function getOrCreateCacheEntry<T>(cache: Map<string, T>, key: string, create: () => T): T {
  const existing = cache.get(key);
  if (existing !== undefined) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }

  const created = create();
  cache.set(key, created);

  if (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  return created;
}
