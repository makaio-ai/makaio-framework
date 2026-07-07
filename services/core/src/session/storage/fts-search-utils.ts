/**
 * Shared FTS search utility functions for session search result hydration.
 *
 * These utilities are extracted from the FTS search handler so host code
 * can reuse them when composing scope-aware search queries (e.g., JOIN with
 * a junction table) without duplicating result hydration logic.
 *
 * Host handlers run their own FTS+JOIN SQL queries and pass the raw row
 * results through these utilities to produce the final `IMakaioSession` shapes.
 */
import { count, inArray } from 'drizzle-orm';
import { resolveSchema, resolveStorageEngine, type MakaioDatabase } from '@makaio/storage-drizzle';
import {
  SessionRecordMetadataSchema,
  type ForkTransforms,
  type IMakaioSession,
  type JsonValue,
} from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { messagesSchema } from '../messages/schema.variants.js';

/** Canonical column shape of the agents table, resolved through the dialect seam. */
type AgentsTable = typeof sessionStorageSchema.sqlite.agents;

/**
 * Row shape returned by FTS session search queries.
 *
 * Contains only framework-owned columns. Scope fields (`project_id`,
 * `worktree_id`, `workstream_id`) are intentionally absent — they are
 * managed by the host-owned junction table after the sealed-sessions
 * refactor.
 */
export type SearchSessionRow = {
  session_id: string;
  created_at: number;
  last_activity_at: number;
  status: IMakaioSession['status'];
  title: string | null;
  lead_agent_id: string | null;
  parent_session_id: string | null;
  root_session_id: string | null;
  fork_point_message_id: string | null;
  branch_kind: IMakaioSession['branchKind'] | null;
  adapter_name: string | null;
  adapter_session_id: string | null;
  adapter_id: string | null;
  is_orchestrated: number | null;
  is_imported: number | null;
  summary: string | null;
  summary_updated_at: number | null;
  fork_transforms: string | null;
  target_working_directory: string | null;
  metadata: Record<string, JsonValue> | string | null;
  machine_id: string | null;
};

/**
 * Filter parameters accepted by FTS search queries.
 *
 * Scope filters (`projectId`, `worktreeId`) are intentionally absent —
 * scope-aware filtering is the responsibility of host priority-100
 * handlers that JOIN with the `session_scopes` junction table.
 */
export interface SearchFilters {
  status: IMakaioSession['status'] | 'all';
  isImported?: boolean;
}

/**
 * Loads agent rows and groups them by session ID.
 * @param db - Drizzle database instance
 * @param sessionIds - Matched session IDs
 * @returns Agent rows keyed by session ID
 */
export async function fetchAgentsBySession(
  db: MakaioDatabase,
  sessionIds: string[],
): Promise<Map<string, Array<AgentsTable['$inferSelect']>>> {
  if (sessionIds.length === 0) return new Map();
  const { agents } = resolveSchema(db, sessionStorageSchema);
  const uniqueIds = [...new Set(sessionIds)];
  const agentRows = await db.select().from(agents).where(inArray(agents.sessionId, uniqueIds));
  const agentsBySession = new Map<string, Array<AgentsTable['$inferSelect']>>();
  for (const agent of agentRows) {
    const list = agentsBySession.get(agent.sessionId) ?? [];
    list.push(agent);
    agentsBySession.set(agent.sessionId, list);
  }
  return agentsBySession;
}

/**
 * Resolves first-user-message previews for matched sessions.
 *
 * The same-timestamp tie-break is engine-owned (`StorageEngine.fts`): rowid
 * insertion order on SQLite, lexicographic message_id order on Postgres.
 * @param db - Drizzle database instance
 * @param sessionIds - Matched session IDs
 * @returns First user message text keyed by session ID
 */
export async function fetchPreviewBySession(
  db: MakaioDatabase,
  sessionIds: string[],
): Promise<Map<string, string | null>> {
  return resolveStorageEngine(db).fts.fetchFirstUserMessagePreviews(db, sessionIds);
}

/**
 * Counts messages per matched session.
 * @param db - Drizzle database instance
 * @param sessionIds - Matched session IDs
 * @returns Message counts keyed by session ID
 */
export async function fetchMessageCountsBySession(
  db: MakaioDatabase,
  sessionIds: string[],
): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const { messages } = resolveSchema(db, messagesSchema);
  const uniqueIds = [...new Set(sessionIds)];
  const messageCountRows = await db
    .select({
      sessionId: messages.sessionId,
      count: count(),
    })
    .from(messages)
    .where(inArray(messages.sessionId, uniqueIds))
    .groupBy(messages.sessionId);

  const countBySession = new Map<string, number>();
  for (const row of messageCountRows) {
    countBySession.set(row.sessionId, row.count);
  }
  return countBySession;
}

/**
 * Parses serialized fork transform JSON.
 * @param raw - Raw JSON column value
 * @returns Parsed fork transforms, or undefined on invalid JSON
 */
export function parseForkTransforms(raw: string | null): ForkTransforms | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as ForkTransforms;
  } catch {
    return undefined;
  }
}

/**
 * Parses session metadata from a raw search row.
 * @param raw - Raw JSON column value from SQLite text JSON or Postgres jsonb
 * @returns Validated metadata, or undefined when absent/invalid
 */
function parseSessionMetadata(raw: SearchSessionRow['metadata']): Record<string, JsonValue> | undefined {
  if (raw === null) {
    return undefined;
  }

  try {
    const candidate: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const result = SessionRecordMetadataSchema.safeParse(candidate);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps a raw search row to session API format with preview metadata.
 *
 * Scope fields are intentionally absent from the returned `IMakaioSession`.
 * Host handlers composing a scoped search must augment the result with
 * scope data read from the junction table after calling this utility.
 * @param row - Raw session row from SQL search query
 * @param sessionAgents - Agents attached to the session
 * @param previewBySession - First-user-message map
 * @param countBySession - Message count map
 * @returns Session payload with preview block
 */
export function mapRowToSession(
  row: SearchSessionRow,
  sessionAgents: Array<AgentsTable['$inferSelect']>,
  previewBySession: Map<string, string | null>,
  countBySession: Map<string, number>,
): IMakaioSession & { preview: { messageCount: number; firstUserMessage: string | null } } {
  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    status: row.status,
    title: row.title ?? undefined,
    leadAgentId: row.lead_agent_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    rootSessionId: row.root_session_id ?? undefined,
    forkPointMessageId: row.fork_point_message_id ?? undefined,
    branchKind: row.branch_kind ?? undefined,
    adapterName: row.adapter_name ?? undefined,
    adapterSessionId: row.adapter_session_id ?? undefined,
    adapterId: row.adapter_id ?? undefined,
    // Preserve explicit false from SQLite integer booleans (0/1), while keeping NULL as undefined.
    isOrchestrated: row.is_orchestrated === null ? undefined : Boolean(row.is_orchestrated),
    isImported: row.is_imported === null ? undefined : Boolean(row.is_imported),
    summary: row.summary ?? undefined,
    summaryUpdatedAt: row.summary_updated_at ?? undefined,
    forkTransforms: parseForkTransforms(row.fork_transforms),
    targetWorkingDirectory: row.target_working_directory ?? undefined,
    metadata: parseSessionMetadata(row.metadata),
    machineId: row.machine_id ?? undefined,
    agents: sessionAgents.map((agent) => ({
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      adapterName: agent.adapterName,
      sessionId: agent.sessionId,
      role: agent.role,
      status: agent.status,
      createdAt: agent.createdAt,
      lastActivityAt: agent.lastActivityAt,
      model: agent.model ?? undefined,
      adapterSessionId: agent.adapterSessionId ?? undefined,
      cwd: agent.cwd ?? undefined,
    })),
    preview: {
      messageCount: countBySession.get(row.session_id) ?? 0,
      firstUserMessage: previewBySession.get(row.session_id) ?? null,
    },
  };
}
