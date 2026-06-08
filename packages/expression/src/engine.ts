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
 * Context is an {@link ExpressionContext} because compiled expressions are used
 * by multiple domains with different variable maps.
 */
export interface CompiledExpression {
  /**
   * Evaluate the compiled expression synchronously.
   * @param context - variable map passed to the expression
   * @returns evaluated result
   */
  evalSync(context: ExpressionContext): unknown;
  /**
   * Evaluate the compiled expression asynchronously.
   * @param context - variable map passed to the expression
   * @returns evaluated result
   */
  eval(context: ExpressionContext): Promise<unknown>;
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
 * Compile a jexl expression for repeated evaluation.
 * Returns a compiled expression object with evalSync/eval methods.
 * Use this for hot paths (e.g., trigger filter evaluation).
 * @param expr - jexl expression string
 * @returns compiled expression
 */
export function compile(expr: string): CompiledExpression {
  const compiled = jexl.compile(expr);
  return {
    evalSync: (context: ExpressionContext) => compiled.evalSync(context),
    eval: (context: ExpressionContext) => compiled.eval(context),
  };
}
