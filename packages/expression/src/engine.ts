import jexl from 'jexl-extended';
import type { ExpressionContext } from './types.js';

/**
 * Result of compiling a jexl expression for repeated evaluation.
 *
 * Context is `object` rather than `ExpressionContext` because
 * compiled expressions are used in both workflow execution (ExpressionContext)
 * and trigger filter evaluation (payload-only context) — different shapes.
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
 * Compile a jexl expression for repeated evaluation.
 * Returns a compiled expression object with evalSync/eval methods.
 * Use this for hot paths (e.g., trigger filter evaluation).
 * @param expr - jexl expression string
 * @returns compiled expression
 */
export function compile(expr: string): CompiledExpression {
  const compiled = jexl.compile(expr);
  return {
    evalSync: (context: object) => compiled.evalSync(context),
    eval: (context: object) => compiled.eval(context),
  };
}
