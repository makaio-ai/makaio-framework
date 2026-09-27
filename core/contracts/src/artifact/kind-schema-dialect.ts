import type { z } from 'zod';
import { childSchemas } from './kind-paths.js';

/**
 * Reference keywords outside the artifact registration profile. Dynamic and
 * recursive references resolve against the evaluation path rather than the
 * document, so no static schema walker (path inspection, reserved-field checks)
 * can follow them; the profile rejects them instead of resolving them.
 */
const DYNAMIC_REFERENCE_KEYWORDS = ['$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor'] as const;

/**
 * Reject dynamic and recursive references anywhere in a data schema.
 * @param node - Current schema node.
 * @param ctx - Registration validation context.
 * @param path - Diagnostic path to the current schema node.
 */
export function validateSchemaDialect(
  node: Record<string, unknown>,
  ctx: z.RefinementCtx,
  path: (string | number)[] = ['dataSchema'],
): void {
  for (const keyword of DYNAMIC_REFERENCE_KEYWORDS) {
    if (Object.hasOwn(node, keyword)) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, keyword],
        message: 'Unsupported dynamic reference: use a plain local $ref',
      });
    }
  }
  for (const child of childSchemas(node)) validateSchemaDialect(child.node, ctx, [...path, ...child.path]);
}
