import type {
  ApprovalPolicy,
  HarnessDefinition,
  MakaioSessionAgent,
  ResolveEnrichedPolicyResponse,
  ToolCapability,
} from '@makaio/contracts';
import type { FileAccessRuleProvider } from '@makaio/tools-core';

/** Fields needed from a resolved harness for tool and capability-based approval. */
export type HarnessResolution = Pick<
  HarnessDefinition,
  'approvalPolicy' | 'capabilityOverrides' | 'toolCapabilityMap' | 'toolApprovalOverrides'
>;

/** Resolved policy context with cached harness data. */
export interface PolicyResolutionResult {
  /** Effective approval policy after cascade resolution. */
  policy: ApprovalPolicy;
  /** Resolved harness data for capability enrichment. */
  harness?: HarnessResolution;
  /** Agent metadata if found. */
  agent?: MakaioSessionAgent | null;
  /** Adapter name used for harness/policy resolution. */
  resolvedAdapterName: string;
  /** Persona display name from the host-tier enriched-policy RPC, if resolved. */
  personaName?: string;
  /** Profile display name from the host-tier enriched-policy RPC, if resolved. */
  profileName?: string;
}

/** Resolved base policy and display names from the host-tier enriched-policy RPC. */
export interface EnrichedBasePolicyResult {
  /** Resolved approval policy. */
  policy: ApprovalPolicy;
  /** Human-readable display name of the active persona, if returned by the RPC. */
  personaName?: string;
  /** Human-readable display name of the active profile, if returned by the RPC. */
  profileName?: string;
}

/** Raw result of a single `approval.resolveEnrichedPolicy` RPC call. */
export type RawEnrichedPolicyResult = { handled: false } | { handled: true; data: ResolveEnrichedPolicyResponse };

/** CWD and directory constraints for `.makaioignore` rule evaluation. */
export interface FileAccessContext {
  /** Working directory of the agent. */
  cwd?: string;
  /** Profile-constrained directory allowlist for the current request. */
  allowedDirectories?: string[];
}

/** Display-enriched approval request payload ready to publish on ApprovalSubjects.request. */
export interface EnrichedApprovalRequest {
  /** Unique identifier for this approval request. */
  requestId: string;
  /** Tool call correlation ID. */
  toolCallId: string;
  /** Name of the tool being approved. */
  toolName?: string;
  /** Arguments passed to the tool. */
  args?: Record<string, unknown>;
  /** Agent that invoked the tool. */
  agentId: string;
  /** Makaio session ID — required for approval routing to the owning tab. */
  sessionId: string;
  /** Adapter that owns the tool call. */
  adapterName: string;
  /** Persona display name, propagated from the enriched-policy RPC. */
  personaName?: string;
  /** Profile display name, propagated from the enriched-policy RPC. */
  profileName?: string;
  /** Capability identifiers declared by the tool. */
  capabilities?: readonly ToolCapability[];
  /** Derived risk level from capability set. */
  riskLevel?: 'safe' | 'neutral' | 'destructive';
  /** Reasoning text from the agent, if provided. */
  reasoning?: string;
  /** Epoch ms when this request was created. */
  createdAt: number;
}

/**
 * Policy restrictiveness rank — higher values are more restrictive.
 * Used by capability-based approval to compute the most-restrictive effective policy.
 */
export const POLICY_RANK: Record<ApprovalPolicy, number> = {
  'full-access': 0,
  'always-ask': 1,
  reject: 2,
};

/**
 * Generate a globally unique identifier for an approval request.
 * @returns Prefixed UUID suitable for queue/callback correlation
 */
export function generateRequestId(): string {
  return `apr_${crypto.randomUUID()}`;
}

/** Configuration options for {@link ToolApprovalService}. */
export interface ToolApprovalServiceOptions {
  /**
   * Provider for file access rules derived from `.makaioignore` files.
   * When supplied, enforces file-access restrictions as an absolute pre-check
   * that runs before any policy cascade — including `full-access` policies.
   */
  fileAccessRuleProvider?: FileAccessRuleProvider;
}
