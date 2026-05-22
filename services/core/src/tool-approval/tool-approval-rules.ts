import { computeMetaTags, type ApprovalPolicy, type MakaioSessionAgent, type ToolCapability } from '@makaio/contracts';
import type { FileAccessRuleProvider } from '@makaio/tools-core';
import {
  type EnrichedApprovalRequest,
  type EnrichedBasePolicyResult,
  type FileAccessContext,
  type HarnessResolution,
  type PolicyResolutionResult,
  type RawEnrichedPolicyResult,
  POLICY_RANK,
  generateRequestId,
} from './tool-approval-types.js';

/**
 * Maps an `approval.resolveEnrichedPolicy` action to an internal {@link ApprovalPolicy}.
 * @param action - Action returned by the host-tier enriched policy RPC
 * @returns Corresponding internal approval policy
 */
export function mapActionToPolicy(action: 'allow' | 'deny' | 'ask'): ApprovalPolicy {
  switch (action) {
    case 'allow':
      return 'full-access';
    case 'deny':
      return 'reject';
    case 'ask':
      return 'always-ask';
  }
}

/**
 * Classify a tool's risk level from its capability set.
 * Delegates to {@link computeMetaTags} for canonical meta-tag derivation.
 * @param capabilities - Capability identifiers declared by the tool, if known
 * @returns Risk level: 'destructive', 'safe', or 'neutral'
 */
export function deriveRiskLevel(capabilities?: readonly ToolCapability[]): 'safe' | 'neutral' | 'destructive' {
  if (!capabilities?.length) return 'neutral';
  const metaTags = computeMetaTags(capabilities);
  if (metaTags.includes('destructive')) return 'destructive';
  if (metaTags.includes('read-only')) return 'safe';
  return 'neutral';
}

/**
 * Resolve the harness-level effective policy for a specific tool.
 * Checks `toolApprovalOverrides` first for an exact match on the tool name.
 * Falls back to the harness `approvalPolicy` when no per-tool override exists.
 * @param harness - Resolved harness data, or undefined if no harness is available
 * @param toolName - Name of the tool being invoked
 * @returns Per-tool or base harness policy, or undefined if harness is unavailable
 */
export function resolveHarnessLevelPolicy(
  harness: HarnessResolution | undefined,
  toolName: string | undefined,
): ApprovalPolicy | undefined {
  if (!harness) return undefined;
  if (toolName && harness.toolApprovalOverrides?.[toolName] !== undefined) {
    return harness.toolApprovalOverrides[toolName];
  }
  return harness.approvalPolicy;
}

/**
 * Apply capability-based policy overrides using most-restrictive-wins rule.
 * For each capability declared on the invoked tool, checks if a per-capability
 * override exists. The effective policy is the most restrictive among the base
 * policy and all matching overrides.
 * @param basePolicy - Resolved base policy from the cascade
 * @param toolName - Name of the tool being invoked
 * @param capabilityOverrides - Per-capability policy overrides from the harness
 * @param toolCapabilityMap - Tool-to-capability mapping from the harness
 * @returns Most-restrictive effective policy
 */
export function applyCapabilityOverrides(
  basePolicy: ApprovalPolicy,
  toolName: string,
  capabilityOverrides: Record<string, ApprovalPolicy>,
  toolCapabilityMap: Record<string, readonly ToolCapability[]>,
): ApprovalPolicy {
  const capabilities = toolCapabilityMap[toolName];
  if (!capabilities?.length) return basePolicy;

  let mostRestrictive = basePolicy;
  for (const cap of capabilities) {
    const override = capabilityOverrides[cap];
    if (override && POLICY_RANK[override] > POLICY_RANK[mostRestrictive]) {
      mostRestrictive = override;
    }
  }
  return mostRestrictive;
}

/**
 * Fetch `allowedDirectories` from a pre-fetched enriched-policy RPC result.
 * Returns `undefined` when neither persona nor profile is active, the profile
 * sets no directory restrictions, or `toolName` is absent. Only profiles carry
 * directory restrictions — personas do not.
 * @param _personaId - Optional persona ID from agent metadata (unused; only profiles carry directory restrictions)
 * @param profileId - Optional profile ID from agent metadata
 * @param rawResult - Pre-fetched RPC result from the enriched-policy fetch
 * @returns Directory allowlist from the active profile, or undefined
 */
export function resolveProfileAllowedDirectories(
  _personaId: string | undefined,
  profileId: string | undefined,
  rawResult: RawEnrichedPolicyResult,
): string[] | undefined {
  if (!rawResult.handled) {
    // No handler registered or RPC failed. Fail-closed when a profile constrains dirs.
    // When only personaId is set (no profile directory policy), undefined preserves
    // the "no restriction" semantic.
    return profileId ? [] : undefined;
  }
  return rawResult.data.allowedDirectories ?? undefined;
}

/**
 * Resolve minimal context needed for `.makaioignore` checks from pre-fetched data.
 * This intentionally avoids harness/persona policy resolution so session-level
 * `full-access`/`reject` overrides can short-circuit without running the
 * full approval cascade.
 *
 * Profile-level `allowedDirectories` are derived from the pre-fetched
 * `approval.resolveEnrichedPolicy` RPC result and enforced here as part of the
 * absolute deny floor — ahead of any policy cascade.
 * @param agent - Pre-fetched agent metadata, or null if unavailable
 * @param rawEnrichedPolicy - Pre-fetched enriched-policy RPC result, or undefined when toolName was absent or no persona/profile is active
 * @param fileAccessRuleProvider - Rule provider; used only as a truthiness gate to skip resolution when absent
 * @returns CWD and allowed-directory constraints for rule evaluation
 */
export function resolveFileAccessContext(
  agent: MakaioSessionAgent | null,
  rawEnrichedPolicy: RawEnrichedPolicyResult | undefined,
  fileAccessRuleProvider: FileAccessRuleProvider | undefined,
): FileAccessContext {
  if (!fileAccessRuleProvider || !agent?.cwd) {
    return {};
  }

  let allowedDirectories: string[] | undefined;
  if ((agent.personaId || agent.profileId) && rawEnrichedPolicy) {
    allowedDirectories = resolveProfileAllowedDirectories(agent.personaId, agent.profileId, rawEnrichedPolicy);
  }

  return { cwd: agent.cwd, ...(allowedDirectories && { allowedDirectories }) };
}

/**
 * Resolve the base approval policy and display names from a pre-fetched
 * enriched-policy RPC result.
 *
 * Delegates persona/profile storage reads to the host tier so this service
 * remains free of host-tier storage subject imports. Returns `undefined`
 * when the RPC is unhandled (no host handler registered) or when neither
 * persona nor profile is set, so the harness/system-default cascade applies.
 * @param personaId - Optional persona ID from agent metadata
 * @param profileId - Optional profile ID from agent metadata
 * @param rawResult - Pre-fetched RPC result, or undefined when toolName was absent
 * @returns Resolved base policy with display names, or undefined
 */
export function resolveEnrichedBasePolicy(
  personaId: string | undefined,
  profileId: string | undefined,
  rawResult: RawEnrichedPolicyResult | undefined,
): EnrichedBasePolicyResult | undefined {
  if (!personaId && !profileId) return undefined;
  if (!rawResult) {
    // toolName was absent — cannot resolve per-tool policy; use fail-safe default.
    return { policy: 'always-ask' };
  }
  if (!rawResult.handled) {
    // No handler registered or RPC failed. When a persona/profile is set, we must
    // not silently bypass its restrictions — fall back to always-ask.
    return { policy: 'always-ask' };
  }
  return {
    policy: mapActionToPolicy(rawResult.data.action),
    ...(rawResult.data.personaName && { personaName: rawResult.data.personaName }),
    ...(rawResult.data.profileName && { profileName: rawResult.data.profileName }),
  };
}

/**
 * Build a display-enriched approval request payload from the tool call context.
 * Uses cached resolution data to avoid re-fetching harness data.
 * @param payload - Original tool approval payload from the bus event
 * @param resolved - Cached resolution context
 * @returns Enriched approval request ready to publish on ApprovalSubjects.request
 */
export function enrichApprovalRequest(
  payload: {
    toolName?: string;
    args?: Record<string, unknown>;
    toolCallId: string;
    agentId: string;
    sessionId: string;
    adapterName: string;
    reasoning?: string;
  },
  resolved: PolicyResolutionResult,
): EnrichedApprovalRequest {
  const capabilities =
    resolved.harness?.toolCapabilityMap && payload.toolName
      ? resolved.harness.toolCapabilityMap[payload.toolName]
      : undefined;

  return {
    requestId: generateRequestId(),
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    args: payload.args,
    agentId: payload.agentId,
    sessionId: payload.sessionId,
    // Keep adapter display metadata aligned with harness/policy resolution context.
    // If agent metadata overrides the incoming adapterName, UI should reflect that same source.
    adapterName: resolved.resolvedAdapterName,
    ...(resolved.personaName && { personaName: resolved.personaName }),
    ...(resolved.profileName && { profileName: resolved.profileName }),
    capabilities,
    riskLevel: deriveRiskLevel(capabilities),
    reasoning: payload.reasoning,
    createdAt: Date.now(),
  };
}
