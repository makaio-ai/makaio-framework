import jexl from 'jexl-extended';
import type { ExpressionContext } from './types.js';

/**
 * Resolve \{\{ \}\} placeholders in a template string using jexl evaluation.
 *
 * Each placeholder is evaluated as a jexl expression against the context.
 * Unknown paths resolve to '' (empty string) — templates should degrade
 * gracefully rather than fail on missing context.
 * Errors in individual placeholders are caught and resolve to ''.
 * @param template - string with \{\{ expr \}\} placeholders
 * @param context - evaluation context
 * @returns resolved string
 */
export function resolveTemplate(template: string, context: ExpressionContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    try {
      const result = jexl.evalSync(expr.trim(), context);
      return result != null ? String(result) : '';
    } catch {
      // Unknown path or invalid expression — degrade gracefully to empty string
      return '';
    }
  });
}
