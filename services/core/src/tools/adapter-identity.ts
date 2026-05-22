import { validateToolAdapterIdentity, type ToolAdapterIdentity } from '@makaio/contracts';
import { ToolErrorCodes, toolError, toolSuccess, type ToolResult } from '@makaio/tools-core';
import type { ExecuteOptions } from './types.js';

export type EffectiveAdapterIdentity = ToolAdapterIdentity;

/**
 * Resolves the single effective adapter identity for policy checks and tool context.
 * Top-level execute options are canonical when present; context overrides may only
 * duplicate those same fields and may not contribute missing adapter identity.
 * @param options - Execution options containing optional adapter identity fields
 * @returns Effective adapter identity, or a validation failure when overrides conflict
 * with top-level fields, try to complete a partial top-level identity, or act
 * as the sole adapter-identity source
 */
export function resolveAdapterIdentity(options?: ExecuteOptions): ToolResult<EffectiveAdapterIdentity> {
  const validation = validateToolAdapterIdentity({
    adapterId: options?.adapterId,
    adapterName: options?.adapterName,
    contextOverrides: {
      adapterId: options?.contextOverrides?.adapterId,
      adapterName: options?.contextOverrides?.adapterName,
    },
  });

  const firstIssue = validation.issues[0];
  if (firstIssue) {
    return toolError(ToolErrorCodes.VALIDATION_FAILED, firstIssue.message);
  }

  return toolSuccess(validation.effectiveIdentity);
}
