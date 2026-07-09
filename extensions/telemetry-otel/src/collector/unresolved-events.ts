/**
 * Pure partition helpers for late workflow correlation and standalone expiry.
 * @packageDocumentation
 */

import type { AgentUsagePayload, UnresolvedToolCall, UnresolvedUsage } from './types.js';

/**
 * Copy a public usage payload into the collector's unresolved event shape.
 * @param payload - Validated agent usage payload.
 * @param ingestedAt - Collector clock value at ingestion.
 * @returns Content-free usage record ready for late correlation.
 */
export function createUnresolvedUsage(payload: AgentUsagePayload, ingestedAt: number): UnresolvedUsage {
  return {
    llmCallId: payload.llmCallId,
    executionId: payload.executionId,
    frameId: payload.frameId,
    agentId: payload.agentId,
    adapterId: payload.adapterId,
    adapterName: payload.adapterName,
    sessionId: payload.sessionId,
    adapterSessionId: payload.adapterSessionId,
    messageId: payload.messageId,
    turnId: payload.turnId,
    clientId: payload.clientId,
    providerConfigId: payload.providerConfigId,
    provider: payload.provider,
    model: payload.model,
    inputTokens: payload.inputTokens,
    inputCachedTokens: payload.inputCachedTokens,
    cacheWriteTokens: payload.cacheWriteTokens,
    outputTokens: payload.outputTokens,
    reasoningTokens: payload.reasoningTokens,
    totalTokens: payload.totalTokens,
    costUnits: payload.costUnits,
    costUnitType: payload.costUnitType,
    cost: payload.cost,
    currency: payload.currency,
    costProvenance: payload.costProvenance,
    duration: payload.duration,
    occurredAt: payload.occurredAt,
    ingestedAt,
  };
}

/** Result of matching buffered usage to one workflow execution. */
export interface ExecutionUsagePartition {
  readonly matched: UnresolvedUsage[];
  readonly retained: UnresolvedUsage[];
}

/**
 * Partition usage records by their authoritative execution context.
 * @param usages - Usage records currently waiting for correlation
 * @param executionId - Execution becoming available or receiving a session link
 * @param includeUnscoped - Whether records without an explicit execution may match
 * @returns Matching records and records that must remain deferred
 */
export function partitionUsageForExecution(
  usages: readonly UnresolvedUsage[],
  executionId: string,
  includeUnscoped: boolean,
): ExecutionUsagePartition {
  const matched: UnresolvedUsage[] = [];
  const retained: UnresolvedUsage[] = [];
  for (const usage of usages) {
    if (usage.executionId === executionId || (includeUnscoped && usage.executionId === undefined)) {
      matched.push(usage);
    } else {
      retained.push(usage);
    }
  }
  return { matched, retained };
}

/** Expired and retained events for one unresolved session. */
export interface StaleSessionPartition {
  readonly expiredUsages: UnresolvedUsage[];
  readonly retainedUsages: UnresolvedUsage[];
  readonly expiredTools: UnresolvedToolCall[];
  readonly retainedTools: Map<string, UnresolvedToolCall>;
}

/**
 * Group usage for standalone export, retaining an execution-derived fallback.
 * @param usages - Usage records whose claimed execution did not open.
 * @param executionId - Claimed execution ID used when no session ID exists.
 * @returns Records grouped by their real or execution-derived session ID.
 */
export function groupUsageBySession(
  usages: readonly UnresolvedUsage[],
  executionId: string,
): Map<string, UnresolvedUsage[]> {
  const grouped = new Map<string, UnresolvedUsage[]>();
  for (const usage of usages) {
    const sessionId = usage.sessionId ?? `unresolved-execution:${executionId}`;
    const existing = grouped.get(sessionId) ?? [];
    existing.push(usage);
    grouped.set(sessionId, existing);
  }
  return grouped;
}

/**
 * Partition every unresolved event against its own late-correlation deadline.
 * @param usages - Usage records for one session
 * @param tools - Tool records for one session, keyed by collector correlation key
 * @param now - Collector clock in epoch milliseconds
 * @param timeoutMs - Allowed late-correlation window
 * @returns Expired events to export and fresh events to retain
 */
export function partitionStaleSessionEvents(
  usages: readonly UnresolvedUsage[],
  tools: ReadonlyMap<string, UnresolvedToolCall>,
  now: number,
  timeoutMs: number,
): StaleSessionPartition {
  const expiredUsages: UnresolvedUsage[] = [];
  const retainedUsages: UnresolvedUsage[] = [];
  for (const usage of usages) {
    (now - usage.ingestedAt >= timeoutMs ? expiredUsages : retainedUsages).push(usage);
  }

  const expiredTools: UnresolvedToolCall[] = [];
  const retainedTools = new Map<string, UnresolvedToolCall>();
  for (const [key, tool] of tools) {
    if (now - tool.ingestedAt >= timeoutMs) {
      expiredTools.push(tool);
    } else {
      retainedTools.set(key, tool);
    }
  }
  return { expiredUsages, retainedUsages, expiredTools, retainedTools };
}
