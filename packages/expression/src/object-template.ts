import { evaluateSync } from './engine.js';
import { resolveTemplate } from './template.js';
import type { ExpressionContext } from './types.js';

/** Finds template placeholders using the same expression boundary rules as resolveTemplate. */
const TEMPLATE_EXPRESSION_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const OMIT_OBJECT_PROPERTY = Symbol('omit-object-property');

/** Options for resolving templates in object payloads. */
export interface ResolveTemplatesInObjectOptions {
  /**
   * Omit object properties whose whole-value expression resolves to `undefined`.
   *
   * Arrays still receive `null` for missing values because array elements cannot
   * be omitted without changing positional semantics.
   */
  readonly omitUndefinedProperties?: boolean;
}

/**
 * Extract the expression when a string is exactly one whole-value placeholder.
 * @param value - string leaf to inspect
 * @returns expression text for a single whole-value placeholder, otherwise undefined
 */
function getSingleWholeValueExpression(value: string): string | undefined {
  const trimmed = value.trim();
  const matches = Array.from(trimmed.matchAll(TEMPLATE_EXPRESSION_RE));
  if (matches.length !== 1) {
    return undefined;
  }

  const [match] = matches;
  if (match.index !== 0 || match[0].length !== trimmed.length) {
    return undefined;
  }

  return match[1].trim();
}

/**
 * Resolve a single value node in the object tree.
 *
 * - Strings that are a single `{{ expr }}` template are evaluated natively
 *   (preserving number, boolean, object, etc.). `undefined` is coerced to
 *   `null` unless object-property omission is enabled.
 * - Strings that contain mixed text and placeholders are resolved via
 *   {@link resolveTemplate} and always return a string.
 * - Arrays are mapped element-by-element.
 * - Plain objects are recursed via {@link resolveTemplatesInObject}.
 * - All other value types (number, boolean, null) are returned unchanged.
 * @param value - tree node to resolve
 * @param context - expression evaluation context
 * @param options - resolver behavior flags
 * @returns resolved value
 */
function resolveNode(
  value: unknown,
  context: ExpressionContext,
  options: ResolveTemplatesInObjectOptions,
): unknown | typeof OMIT_OBJECT_PROPERTY {
  if (typeof value === 'string') {
    const expression = getSingleWholeValueExpression(value);
    if (expression !== undefined) {
      const resolved = evaluateSync(expression, context);
      if (resolved === undefined) {
        return options.omitUndefinedProperties ? OMIT_OBJECT_PROPERTY : null;
      }
      return resolved;
    }
    return resolveTemplate(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const resolved = resolveNode(item, context, options);
      return resolved === OMIT_OBJECT_PROPERTY ? null : resolved;
    });
  }

  if (typeof value === 'object' && value !== null) {
    return resolveTemplatesInObject(value as Record<string, unknown>, context, options);
  }

  return value;
}

/**
 * Walk a JSON object tree and resolve all `{{ }}` template expressions in
 * string leaves.
 *
 * A leaf that is a sole `{{ expr }}` template (no surrounding text) is
 * evaluated natively — the result keeps its original runtime type (number,
 * boolean, object, …). Mixed-content strings like `'Hello {{ name }}'` are
 * always returned as strings. `undefined` evaluation results become `null` by
 * default.
 * @param obj - JSON object whose string values may contain `{{ }}` templates.
 * @param context - expression context used for template evaluation.
 * @param options - resolver behavior flags.
 * @returns a new object with the same shape but all string leaves resolved.
 */
export function resolveTemplatesInObject(
  obj: Record<string, unknown>,
  context: ExpressionContext,
  options: ResolveTemplatesInObjectOptions = {},
): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const resolved = resolveNode(value, context, options);
    if (resolved !== OMIT_OBJECT_PROPERTY) {
      entries.push([key, resolved]);
    }
  }
  return Object.fromEntries(entries);
}
