import { evaluateSync } from './engine.js';
import type { ExpressionContext } from './types.js';

/** Matches `{{ expr }}` placeholders; the expression cannot contain `}`. Shared by every template resolver. */
export const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Raised by {@link renderPromptTemplate} when a placeholder fails to evaluate. */
export class TemplatePlaceholderError extends Error {
  /**
   * @param expression - The placeholder expression that failed.
   * @param cause - The evaluation error.
   */
  public constructor(
    public readonly expression: string,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Template placeholder {{ ${expression} }} failed to evaluate: ${message}`, { cause });
    this.name = 'TemplatePlaceholderError';
  }
}

/**
 * Resolve \{\{ \}\} placeholders in a template string using jexl evaluation.
 *
 * Each placeholder is evaluated as a jexl expression against the context,
 * using the shared engine instance so templates see the same transforms
 * (e.g. `pluck`) as every other expression surface.
 *
 * Evaluation MUST go through the engine's `JexlExtended` instance and never a
 * default import of `jexl-extended`: the package ships CJS, and under native
 * Node ESM interop the default import is the `module.exports` namespace — not
 * the instance — which made every placeholder silently resolve to `''`.
 *
 * Unknown paths resolve to '' (empty string) — templates should degrade
 * gracefully rather than fail on missing context.
 * Errors in individual placeholders resolve to '' but emit a warning so
 * infrastructure failures are not silently masked as missing variables.
 * @param template - string with \{\{ expr \}\} placeholders
 * @param context - evaluation context
 * @returns resolved string
 */
export function resolveTemplate(template: string, context: ExpressionContext): string {
  return template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_match, expr: string) => {
    try {
      const result = evaluateSync(expr.trim(), context);
      return result != null ? String(result) : '';
    } catch (error) {
      // Invalid expression or evaluation failure — degrade gracefully to an
      // empty string, but surface the failure instead of swallowing it.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[expression] template placeholder {{ ${expr.trim()} }} failed to evaluate: ${message}`);
      return '';
    }
  });
}

/**
 * Render a prompt template strictly: strings pass through verbatim, numbers
 * and booleans are coerced via `String`, objects and arrays render as
 * indented JSON, and a missing value (`null`/`undefined`) becomes an empty
 * string. Unlike {@link resolveTemplate}, a placeholder whose expression
 * throws does not degrade to an empty string — it raises
 * {@link TemplatePlaceholderError} so the caller fails visibly instead of
 * sending a silently malformed instruction to an agent.
 * @param template - Text with `{{ expr }}` placeholders.
 * @param context - Evaluation context.
 * @returns The rendered text.
 * @throws TemplatePlaceholderError When a placeholder fails to evaluate.
 */
export function renderPromptTemplate(template: string, context: ExpressionContext): string {
  return template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_match, expr: string) => {
    const trimmedExpression = expr.trim();
    let result: unknown;
    try {
      result = evaluateSync(trimmedExpression, context);
    } catch (error) {
      throw new TemplatePlaceholderError(trimmedExpression, error);
    }

    if (result === null || result === undefined) {
      return '';
    }
    if (typeof result === 'object') {
      return JSON.stringify(result, null, 2);
    }
    return String(result);
  });
}
