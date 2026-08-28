import { compile, type CompiledExpression } from '@makaio/expression';
import { Minimatch } from 'minimatch';
import type { Condition, FieldOperator, JsonObjectShape, Rule, RuleSetOptions } from './types.js';

const CACHE_LIMIT = 256;
const expressionCache = new Map<string, CompiledExpression>();
const globCache = new Map<string, Minimatch>();

/**
 * Evaluate a condition synchronously against a context object.
 * @param condition - Condition tree to evaluate
 * @param context - Context object available to field and expression conditions
 * @returns Whether the condition matched
 * @throws Error if an evaluated `$expr` cannot be compiled or executed by
 * `@makaio/expression`
 */
export function evaluate(condition: Condition, context: Record<string, unknown>): boolean {
  if ('$and' in condition) {
    for (const child of condition.$and) {
      if (!evaluate(child, context)) {
        return false;
      }
    }
    return true;
  }

  if ('$or' in condition) {
    for (const child of condition.$or) {
      if (evaluate(child, context)) {
        return true;
      }
    }
    return false;
  }

  if ('$not' in condition) {
    return !evaluate(condition.$not, context);
  }

  if ('$expr' in condition) {
    return Boolean(getCachedExpression(condition.$expr).evalSync(context));
  }

  return matchesOperator(getPath(context, condition.field), condition.operator);
}

/**
 * Evaluate a rule list synchronously and return matched rules in input order.
 * Disabled rules are skipped unless explicitly included via options.
 * This function does not inspect `Rule.priority`; callers that need priority
 * ordering must sort the rule array before passing it in.
 * @param rules - Rules to evaluate
 * @param context - Context object available to each condition
 * @param options - Rule-set evaluation options
 * @returns Rules whose conditions matched
 * @throws Error if an evaluated rule contains a `$expr` that cannot be
 * compiled or executed by `@makaio/expression`
 */
export function evaluateRules<TAction extends JsonObjectShape>(
  rules: readonly Rule<TAction>[],
  context: Record<string, unknown>,
  options: RuleSetOptions = {},
): Rule<TAction>[] {
  const { includeDisabled = false } = options;
  const matches: Rule<TAction>[] = [];

  for (const rule of rules) {
    if (!includeDisabled && !rule.enabled) {
      continue;
    }

    if (evaluate(rule.condition, context)) {
      matches.push(rule);
    }
  }

  return matches;
}

/**
 * These compatibility-sensitive helpers intentionally duplicate the overlapping
 * `@makaio/bus-core` payload-filter semantics instead of importing them.
 *
 * `@makaio/rules` is a lower-level package, so depending on bus-core would
 * invert the framework dependency direction. Keep the behavior aligned via the
 * package-local compatibility tests when either implementation changes.
 */

/**
 * Compare a resolved field value against a serialized field operator.
 * @param actual - Resolved field value from the evaluation context
 * @param operator - Serialized operator definition to apply
 * @returns Whether the operator matched the resolved value
 */
function matchesOperator(actual: unknown, operator: FieldOperator): boolean {
  if (typeof operator !== 'object' || operator === null) {
    return actual === operator;
  }

  if ('$eq' in operator) {
    return actual === operator.$eq;
  }

  if ('$ne' in operator) {
    return actual !== operator.$ne;
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

  return false;
}

/**
 * Resolve a dot-notation path using the same object-walking semantics as the
 * current payload filter implementation.
 * @param value - Root value to traverse
 * @param path - Dot-notation path to resolve
 * @returns The resolved value, or `undefined` when traversal cannot continue
 */
function getPath(value: unknown, path: string): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parts = path.split('.');
  let current: unknown = value;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
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
