import type { ToolCapability } from '../tool-capability/index.js';

/**
 * Risk level for a tool call approval request.
 * Derived from the agent's classification of the tool's destructive potential.
 */
export type RiskLevel = 'safe' | 'neutral' | 'destructive';

/**
 * A pending approval entry in the approval queue.
 * Represents a tool call awaiting user review.
 */
export interface ApprovalEntry {
  /** Unique approval request identifier */
  requestId: string;
  /** Tool call identifier from the agent */
  toolCallId: string;
  /** Name of the tool being called */
  toolName?: string;
  /** Tool call arguments */
  args?: Record<string, unknown>;
  /** Agent that initiated the tool call */
  agentId: string;
  /** Makaio session identifier */
  sessionId?: string;
  /** Adapter type name (e.g., 'claude-code') */
  adapterName: string;
  /** Persona display name */
  personaName?: string;
  /** Profile display name */
  profileName?: string;
  /** Agent capability identifiers */
  capabilities?: readonly ToolCapability[];
  /** Risk classification for this tool call */
  riskLevel?: RiskLevel;
  /** LLM reasoning/thinking that preceded this tool call (when available) */
  reasoning?: string;
  /** Unix timestamp (ms) when the request was created */
  createdAt: number;
}

/**
 * An approval entry that has been resolved with a user decision.
 * Extends {@link ApprovalEntry} with the outcome and resolution timestamp.
 */
export interface ResolvedApprovalEntry extends ApprovalEntry {
  /** The user's approval decision */
  action: 'allow' | 'deny';
  /** Unix timestamp (ms) when the decision was made */
  resolvedAt: number;
}
