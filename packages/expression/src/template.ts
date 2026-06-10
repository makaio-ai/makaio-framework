import { evaluateSync } from './engine.js';
import type { ExpressionContext } from './types.js';

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
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
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
