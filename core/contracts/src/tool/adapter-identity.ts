/**
 * Adapter identity attached to a tool execution request.
 */
export interface ToolAdapterIdentity {
  adapterId?: string;
  adapterName?: string;
}

/**
 * Minimal tool execute payload shape needed to validate adapter identity.
 */
export interface ToolAdapterIdentityRequest {
  adapterId?: string;
  adapterName?: string;
  contextOverrides?: ToolAdapterIdentity;
}

/**
 * Adapter identity field name.
 */
export type ToolAdapterIdentityField = 'adapterId' | 'adapterName';

/**
 * Validation issue for an incoherent adapter identity request.
 */
export interface ToolAdapterIdentityIssue {
  field: ToolAdapterIdentityField;
  message: string;
}

/**
 * Result of validating a tool execute request's adapter identity.
 */
export interface ToolAdapterIdentityValidation {
  issues: ToolAdapterIdentityIssue[];
  effectiveIdentity: ToolAdapterIdentity;
}

const OVERRIDE_ONLY_IDENTITY_MESSAGE =
  'adapter identity must be provided at the top level; contextOverrides cannot supply adapter identity';

/**
 * Validates the coherent adapter-identity invariant shared by wire contracts and runtime.
 *
 * Adapter identity is optional, but when present the top-level fields are canonical.
 * `contextOverrides` may duplicate those same values, but it may not be the sole source
 * of adapter identity, complete a partial top-level identity, or contradict it.
 * @param request - Tool execute request fields relevant to adapter identity.
 * @returns Validation issues plus the coalesced effective identity.
 */
export function validateToolAdapterIdentity(request: ToolAdapterIdentityRequest): ToolAdapterIdentityValidation {
  const topLevelIdentity: ToolAdapterIdentity = {
    adapterId: request.adapterId,
    adapterName: request.adapterName,
  };
  const overrideIdentity: ToolAdapterIdentity = {
    adapterId: request.contextOverrides?.adapterId,
    adapterName: request.contextOverrides?.adapterName,
  };
  const issues: ToolAdapterIdentityIssue[] = [];

  if (!hasAdapterIdentity(topLevelIdentity) && hasAdapterIdentity(overrideIdentity)) {
    if (overrideIdentity.adapterId !== undefined) {
      issues.push({ field: 'adapterId', message: OVERRIDE_ONLY_IDENTITY_MESSAGE });
    }
    if (overrideIdentity.adapterName !== undefined) {
      issues.push({ field: 'adapterName', message: OVERRIDE_ONLY_IDENTITY_MESSAGE });
    }
  }

  for (const field of ['adapterId', 'adapterName'] as const) {
    const overrideValue = overrideIdentity[field];
    if (overrideValue === undefined) {
      continue;
    }

    const topLevelValue = topLevelIdentity[field];
    if (topLevelValue === undefined) {
      if (hasAdapterIdentity(topLevelIdentity)) {
        issues.push({
          field,
          message: `contextOverrides.${field} cannot supply adapter identity when top-level adapter identity is present`,
        });
      }
      continue;
    }

    if (topLevelValue !== overrideValue) {
      issues.push({
        field,
        message: `contextOverrides.${field} must match top-level ${field} when both are provided`,
      });
    }
  }

  return {
    issues,
    effectiveIdentity: {
      adapterId: topLevelIdentity.adapterId ?? overrideIdentity.adapterId,
      adapterName: topLevelIdentity.adapterName ?? overrideIdentity.adapterName,
    },
  };
}

/**
 * Checks whether either adapter identity field is present.
 * @param identity - Adapter identity candidate to inspect.
 * @returns `true` when the identity contains an adapter id or adapter name.
 */
function hasAdapterIdentity(identity: ToolAdapterIdentity): boolean {
  return identity.adapterId !== undefined || identity.adapterName !== undefined;
}
