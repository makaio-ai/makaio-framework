import { JexlExtended } from 'jexl-extended';
import type { ExpressionContext } from './types.js';

/**
 * Extract one property from every object in an array.
 * @param value - Value flowing through the pipe.
 * @param key - Object key to read from each array element.
 * @returns Extracted values, omitting non-object elements and missing keys.
 */
function pluck(value: unknown, key: unknown): unknown[] {
  if (!Array.isArray(value) || typeof key !== 'string') {
    return [];
  }

  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || !(key in item)) {
      return [];
    }

    return [(item as Record<string, unknown>)[key]];
  });
}

const jexl = new JexlExtended();
jexl.addTransform('pluck', pluck);

/**
 * Result of compiling a jexl expression for repeated evaluation.
 *
 * The context is any object, as in jexl's own typing, because compiled expressions are used
 * by multiple domains with different variable maps.
 */
export interface CompiledExpression {
  /**
   * Evaluate the compiled expression synchronously.
   * @param context - variable map passed to the expression
   * @returns evaluated result
   */
  evalSync(context: object): unknown;
  /**
   * Evaluate the compiled expression asynchronously.
   * @param context - variable map passed to the expression
   * @returns evaluated result
   */
  eval(context: object): Promise<unknown>;
}

/**
 * Evaluate a jexl expression synchronously.
 * @param expr - jexl expression string
 * @param context - evaluation context
 * @returns evaluated result
 */
export function evaluateSync(expr: string, context: ExpressionContext): unknown {
  return jexl.evalSync(expr, context);
}

/**
 * Evaluate a jexl expression asynchronously.
 * @param expr - jexl expression string
 * @param context - evaluation context
 * @returns evaluated result
 */
export function evaluate(expr: string, context: ExpressionContext): Promise<unknown> {
  return jexl.eval(expr, context);
}

/**
 * Reject a source that jexl compiles although a `)` is missing.
 *
 * jexl's parser finishes an open group silently when the enclosing parser has no node yet
 * (start of the source, `else` branch of a ternary). Wrapping the source in `0||(...)` opens
 * the group after an operand, where a missing `)` makes the parse fail. A valid expression
 * stays valid inside parentheses.
 * @param expr - jexl expression string that already compiled on its own
 * @throws When the wrapped source does not compile.
 */
function assertBalanced(expr: string): void {
  try {
    jexl.compile(`0||(${expr})`);
  } catch {
    throw new Error(`Expression has unbalanced parentheses: ${JSON.stringify(expr)}`);
  }
}

/**
 * Reject a `FunctionCall` node whose transform or function is not registered.
 * Walks enumerable own values only; `_parent` links are non-enumerable, so the walk cannot cycle.
 * @param node - syntax tree node, array, or primitive
 * @throws When an unregistered transform or function is called.
 */
function assertKnownCallees(node: unknown): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if ('type' in node && node.type === 'FunctionCall' && 'name' in node && typeof node.name === 'string') {
    const isTransform = 'pool' in node && node.pool === 'transforms';
    const known = isTransform ? jexl.getTransform(node.name) : jexl.getFunction(node.name);
    if (known === undefined) {
      throw new Error(`Expression uses unknown ${isTransform ? 'transform' : 'function'} '${node.name}'`);
    }
  }
  for (const child of Object.values(node)) {
    assertKnownCallees(child);
  }
}

/**
 * Compile a jexl expression for repeated evaluation.
 * Returns a compiled expression object with evalSync/eval methods.
 * Use this for hot paths (e.g., trigger filter evaluation).
 *
 * A source without any operand (empty, whitespace only, or only opening parentheses
 * such as `((`) is rejected here; jexl itself compiles it to an empty syntax tree that
 * fails only at evaluation.
 *
 * Two further holes in jexl's parser are closed here: a group left open at the start of the
 * source or in the `else` branch of a ternary (`(a`, `a ? b : (c`) compiles silently, and a
 * transform or function that is not registered fails only at evaluation.
 * @param expr - jexl expression string
 * @returns compiled expression
 * @throws When the expression has a syntax error, unbalanced parentheses, no operand, or
 *   names an unregistered transform or function.
 */
export function compile(expr: string): CompiledExpression {
  const compiled = jexl.compile(expr);
  if (compiled._ast === null || compiled._ast === undefined) {
    throw new Error(`Expression contains no operand: ${JSON.stringify(expr)}`);
  }
  assertBalanced(expr);
  assertKnownCallees(compiled._ast);
  return {
    evalSync: (context: object) => compiled.evalSync(context),
    eval: (context: object) => compiled.eval(context),
  };
}
