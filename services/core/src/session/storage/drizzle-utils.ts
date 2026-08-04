/**
 * Shared Drizzle session handler utility functions.
 *
 * These utilities are exported from the session storage layer so host code
 * can reuse them when composing scope-aware list queries (e.g., JOIN with the
 * `session_scopes` junction table) without duplicating result hydration logic.
 *
 * Host handlers run their own Drizzle queries and pass the raw row results
 * through these utilities to produce the final `IMakaioSession` shapes.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import { ForkTransformsSchema, type ForkTransforms, type IMakaioSession } from '@makaio/contracts';
import { ClientIdentityObservationSchema } from '@makaio/contracts/client';
import { mapAgent } from './agent-drizzle-handler.js';
import type { sessionStorageSchema } from './schema.variants.js';
import { messagesSchema } from '../messages/schema.variants.js';

type SessionRow = (typeof sessionStorageSchema.sqlite.sessions)['$inferSelect'];
type AgentRow = (typeof sessionStorageSchema.sqlite.agents)['$inferSelect'];

type ClientIdentityObservation = IMakaioSession['lastClientIdentityObservation'];

/**
 * Convert a nullable row column into an optional API value.
 * @param value - Database value that may be null
 * @returns API-friendly value using undefined for absence
 */
function toOptionalValue<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

/**
 * Parse the persisted client identity observation JSON blob.
 * @param observation - Raw JSON string from the sessions table
 * @returns Parsed observation object, or `undefined` when absent/invalid
 */
function parseClientIdentityObservation(observation: string | null): ClientIdentityObservation {
  if (!observation) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(observation);
    const result = ClientIdentityObservationSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse persisted fork transforms JSON.
 * @param serializedForkTransforms - Raw JSON string from the sessions table
 * @returns Parsed fork transforms, or `undefined` when absent/invalid
 */
function parseForkTransforms(serializedForkTransforms: string | null): ForkTransforms | undefined {
  if (!serializedForkTransforms) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(serializedForkTransforms);
    const result = ForkTransformsSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Preview maps for session list response hydration.
 */
export interface SessionPreviewMaps {
  previewBySession?: Map<string, string | null>;
  countBySession?: Map<string, number>;
}

/**
 * Map a Drizzle session row to the `IMakaioSession` API type.
 *
 * Scope fields (`projectId`, `worktreeId`, `workstreamId`) are intentionally
 * absent from the returned object. They are managed by the host-owned
 * junction table after the sealed-sessions refactor. Host handlers
 * composing a scoped query must augment the result with scope data read
 * from the junction table.
 * @param sessionRow - The session table row
 * @param agentRows - The associated agent rows
 * @returns The mapped session object
 */
export function mapToSession(sessionRow: SessionRow, agentRows: AgentRow[]): IMakaioSession {
  const forkTransforms = parseForkTransforms(sessionRow.forkTransforms);
  const lastClientIdentityObservation = parseClientIdentityObservation(sessionRow.lastClientIdentityObservation);

  return {
    sessionId: sessionRow.sessionId,
    createdAt: sessionRow.createdAt,
    lastActivityAt: sessionRow.lastActivityAt,
    status: sessionRow.status,
    leadAgentId: toOptionalValue(sessionRow.leadAgentId),
    parentSessionId: toOptionalValue(sessionRow.parentSessionId),
    contextInheritance: toOptionalValue(sessionRow.contextInheritance),
    rootSessionId: toOptionalValue(sessionRow.rootSessionId),
    forkPointMessageId: toOptionalValue(sessionRow.forkPointMessageId),
    branchKind: toOptionalValue(sessionRow.branchKind),
    adapterName: toOptionalValue(sessionRow.adapterName),
    adapterSessionId: toOptionalValue(sessionRow.adapterSessionId),
    currentAdapterSessionId: toOptionalValue(sessionRow.currentAdapterSessionId),
    currentAdapterSessionIdState: sessionRow.currentAdapterSessionIdState,
    adapterId: toOptionalValue(sessionRow.adapterId),
    clientId: toOptionalValue(sessionRow.clientId),
    clientAccountId: toOptionalValue(sessionRow.clientAccountId),
    lastClientIdentityObservation,
    isOrchestrated: toOptionalValue(sessionRow.isOrchestrated),
    isImported: toOptionalValue(sessionRow.isImported),
    title: toOptionalValue(sessionRow.title),
    summary: toOptionalValue(sessionRow.summary),
    summaryUpdatedAt: toOptionalValue(sessionRow.summaryUpdatedAt),
    forkTransforms,
    targetWorkingDirectory: toOptionalValue(sessionRow.targetWorkingDirectory),
    executionTargetId: toOptionalValue(sessionRow.executionTargetId),
    agents: agentRows.map(mapAgent),
    approvalPolicyOverride: toOptionalValue(sessionRow.approvalPolicyOverride),
    metadata: toOptionalValue(sessionRow.metadata),
    spawningToolCallId: toOptionalValue(sessionRow.spawningToolCallId),
    source: toOptionalValue(sessionRow.source),
    parentExternalSessionId: toOptionalValue(sessionRow.parentExternalSessionId),
    logFilePath: toOptionalValue(sessionRow.logFilePath),
    discoveredAt: toOptionalValue(sessionRow.discoveredAt),
    importStatus: toOptionalValue(sessionRow.importStatus),
    isSidechain: toOptionalValue(sessionRow.isSidechain),
    machineId: toOptionalValue(sessionRow.machineId),
  };
}

/**
 * Groups agent rows by session ID for list response hydration.
 * @param agentRows - Agent table rows
 * @returns Map keyed by session ID
 */
export function mapAgentsBySession(agentRows: AgentRow[]): Map<string, AgentRow[]> {
  const agentsBySession = new Map<string, AgentRow[]>();
  for (const agent of agentRows) {
    const list = agentsBySession.get(agent.sessionId) ?? [];
    list.push(agent);
    agentsBySession.set(agent.sessionId, list);
  }
  return agentsBySession;
}

/**
 * Fetches optional preview maps for session list responses.
 * @param db - Drizzle database client
 * @param sessionIds - Session IDs in current result page
 * @param includePreview - Whether preview fields are requested
 * @returns Preview maps for first user message and message count
 */
export async function fetchSessionPreviewMaps(
  db: MakaioDatabase,
  sessionIds: string[],
  includePreview: boolean,
): Promise<SessionPreviewMaps> {
  if (!includePreview) {
    return {};
  }
  if (sessionIds.length === 0) {
    return {};
  }

  const { messages } = resolveSchema(db, messagesSchema);

  const firstUserMessageBySession = db
    .select({
      sessionId: messages.sessionId,
      minTimestamp: sql<number>`MIN(${messages.timestamp})`.as('min_timestamp'),
    })
    .from(messages)
    .where(and(eq(messages.role, 'user'), inArray(messages.sessionId, sessionIds)))
    .groupBy(messages.sessionId)
    .as('first_user_message_by_session');

  const previewRows = await db
    .select({
      sessionId: messages.sessionId,
      preview: messages.contentText,
    })
    .from(messages)
    .innerJoin(
      firstUserMessageBySession,
      and(
        eq(messages.sessionId, firstUserMessageBySession.sessionId),
        eq(messages.timestamp, firstUserMessageBySession.minTimestamp),
      ),
    )
    .where(eq(messages.role, 'user'));

  const previewBySession = new Map<string, string | null>();
  for (const row of previewRows) {
    // Tied timestamps can produce multiple rows; preserve the first row encountered.
    if (!previewBySession.has(row.sessionId)) {
      previewBySession.set(row.sessionId, row.preview);
    }
  }

  const messageCountRows = await db
    .select({
      sessionId: messages.sessionId,
      count: count(),
    })
    .from(messages)
    .where(inArray(messages.sessionId, sessionIds))
    .groupBy(messages.sessionId);

  const countBySession = new Map<string, number>();
  for (const row of messageCountRows) {
    countBySession.set(row.sessionId, row.count);
  }

  return { previewBySession, countBySession };
}
