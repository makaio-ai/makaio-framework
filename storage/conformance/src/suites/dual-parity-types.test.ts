/**
 * Anti-drift net 1b: dual-table parity + negative type pins, plus a runtime
 * completeness guard so no converted dual table can be silently skipped.
 *
 * **Role in the anti-drift system**
 *
 * - Net 1 (compile-time pin, this file): every `Expect<Equal<...>>` below is a
 *   compile-time assertion checked by the project validation (`tsc`). It guards
 *   the `defineDualTable` factory against **symmetric type degradation** — both
 *   dialect faces collapsing to a wider type (e.g. a `textEnum`/`$type` column
 *   widening to plain `string`, or an int column widening to `bigint`). A
 *   runtime catalog net cannot see that: the SQL type stays `text`/`integer`
 *   while the inferred TypeScript row type silently widens.
 * - Net 2 (`schema-parity.test.ts`): structural / type-image parity over EVERY
 *   discovered table via `discoverSchemas`. It already covers the SQL-level
 *   shape of every dual table without a database.
 * - Net 3 (`live-schema-inventory.test.ts`): live catalog ground truth.
 *
 * **Why this lives in `@makaio/storage-conformance`**
 *
 * The pins anchor concrete consumer tables (`@makaio/services-core`,
 * `@makaio/subsystem-client`, `@makaio/subsystem-workflow-engine`). Conformance
 * is the one package that legitimately depends on the storage seam AND on all
 * its consumers (it asserts the public storage contracts on live databases), so
 * the dependency direction stays honest. Hosting these pins in
 * `@makaio/storage-drizzle` (the seam itself) would make the generic factory's
 * test suite depend upward on its own consumers.
 *
 * **Completeness guard (`it('every converted dual table is classified', …)`)**
 *
 * The compile-time pins necessarily cover only tables reachable through the
 * public consumer surface. To stop a newly converted dual from being silently
 * skipped, the runtime guard discovers every `defineDualTable`-produced table
 * via `discoverSchemas` (the same mechanism nets 2/3 use) and asserts each is
 * classified as either {@link PINNED_DUAL_TABLES} (carries a compile-time pin
 * below) or {@link STRUCTURAL_ONLY_DUAL_TABLES} (no `textEnum`/`$type`
 * narrowing, so net 2 fully covers it, or its narrowing is consumed only inside
 * its own package where a collapse breaks that package's own type-check). A new
 * dual table that is in neither set fails this test, forcing a deliberate
 * classification decision.
 *
 * The pins anchor on either the partner dialect face (parity) or a stable
 * external truth — a contract type where one exists, otherwise the EXACT column
 * type the column declares. Anchoring on a deleted twin would make the net
 * vanish with the thing it guards.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { PgTable } from 'drizzle-orm/pg-core';
import { harnessDefinitionsDual, type SelectHarnessDefinition } from '@makaio/services-core/harness/storage/schema';
import { clientRuntimesDual } from '@makaio/subsystem-client';
import {
  workflowDefinitionsDual,
  workflowExecutionsDual,
  workflowFinalizationsDual,
  workflowStepSpansDual,
  worklogSummariesDual,
  worklogFrameEntriesDual,
} from '@makaio/subsystem-workflow-engine';
import {
  agentsDual,
  importCursorsDual,
  messageRoutingDual,
  sessionEventsDual,
  sessionsDual,
  turnsDual,
} from '@makaio/services-core/session';
import { discoverSchemas } from '@makaio/storage-migrations/discover-schemas';
import type {
  MessageRoutingStatus,
  SpanStatus,
  TurnStatus,
  WorkflowExecutionScope,
  WorkflowNodeType,
} from '@makaio/contracts';

/** Type-level assertion helpers (mutual-assignability invariant trick). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ─────────────────────────────────────────────────────────────────────────────
// harness_definitions — the simplest table: text PK, json maps, bools, epochMs
// timestamps, no FKs, no extras.
// ─────────────────────────────────────────────────────────────────────────────

type HarnessSqliteSelect = typeof harnessDefinitionsDual.sqlite.$inferSelect;
type HarnessPgSelect = typeof harnessDefinitionsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _HarnessCongruent = Expect<Equal<HarnessSqliteSelect, HarnessPgSelect>>;

// The canonical row alias is derived from the SQLite face (file-topology rule).
type _HarnessSelectAlias = Expect<Equal<SelectHarnessDefinition, HarnessSqliteSelect>>;

// Concrete column-type pins on BOTH dialects (parity nets cannot catch a wrong
// column kind; these do).
type _IdSqlite = Expect<Equal<HarnessSqliteSelect['id'], string>>;
type _IdPg = Expect<Equal<HarnessPgSelect['id'], string>>;
type _DescriptionSqlite = Expect<Equal<HarnessSqliteSelect['description'], string | null>>;
type _DescriptionPg = Expect<Equal<HarnessPgSelect['description'], string | null>>;
type _IsDefaultSqlite = Expect<Equal<HarnessSqliteSelect['isDefault'], boolean>>;
type _IsDefaultPg = Expect<Equal<HarnessPgSelect['isDefault'], boolean>>;
type _EnvSqlite = Expect<Equal<HarnessSqliteSelect['env'], Record<string, string> | null>>;
type _EnvPg = Expect<Equal<HarnessPgSelect['env'], Record<string, string> | null>>;
type _NativeToolsEnabledSqlite = Expect<Equal<HarnessSqliteSelect['nativeToolsEnabled'], string[]>>;
type _NativeToolsEnabledPg = Expect<Equal<HarnessPgSelect['nativeToolsEnabled'], string[]>>;
type _CreatedAtSqlite = Expect<Equal<HarnessSqliteSelect['createdAt'], number>>;
type _CreatedAtPg = Expect<Equal<HarnessPgSelect['createdAt'], number>>;

// ─────────────────────────────────────────────────────────────────────────────
// client_runtimes — int4 pid/parentPid: both dialects must infer
// `number | null` (not `bigint | null` or `string | null`).
// ─────────────────────────────────────────────────────────────────────────────

type ClientRuntimeSqliteSelect = typeof clientRuntimesDual.sqlite.$inferSelect;
type ClientRuntimePgSelect = typeof clientRuntimesDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _ClientRuntimeCongruent = Expect<Equal<ClientRuntimeSqliteSelect, ClientRuntimePgSelect>>;

// Negative: int4 pid/parentPid must be `number | null` on both dialects.
type _PidSqlite = Expect<Equal<ClientRuntimeSqliteSelect['pid'], number | null>>;
type _PidPg = Expect<Equal<ClientRuntimePgSelect['pid'], number | null>>;
type _ParentPidSqlite = Expect<Equal<ClientRuntimeSqliteSelect['parentPid'], number | null>>;
type _ParentPidPg = Expect<Equal<ClientRuntimePgSelect['parentPid'], number | null>>;

// ─────────────────────────────────────────────────────────────────────────────
// sessions — the widest enum-bearing public table: required `status` enum plus
// nullable `contextInheritance` / `branchKind` enums. A symmetric collapse of
// any of these to plain `string`/`string | null` must fail here.
// ─────────────────────────────────────────────────────────────────────────────

type SessionSqliteSelect = typeof sessionsDual.sqlite.$inferSelect;
type SessionPgSelect = typeof sessionsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _SessionCongruent = Expect<Equal<SessionSqliteSelect, SessionPgSelect>>;

// Negative: enum unions must stay narrowed (not `string`) on both dialects.
type _SessionStatusSqlite = Expect<
  Equal<SessionSqliteSelect['status'], 'active' | 'closed' | 'archived' | 'discovered'>
>;
type _SessionStatusPg = Expect<Equal<SessionPgSelect['status'], 'active' | 'closed' | 'archived' | 'discovered'>>;
type _SessionContextInheritanceSqlite = Expect<
  Equal<SessionSqliteSelect['contextInheritance'], 'parent-history' | 'none' | null>
>;
type _SessionContextInheritancePg = Expect<
  Equal<SessionPgSelect['contextInheritance'], 'parent-history' | 'none' | null>
>;

// ─────────────────────────────────────────────────────────────────────────────
// agents — FK→sessions; `role` / `status` enums must stay narrowed on both
// dialects, and the FK-bearing row stays congruent.
// ─────────────────────────────────────────────────────────────────────────────

type AgentSqliteSelect = typeof agentsDual.sqlite.$inferSelect;
type AgentPgSelect = typeof agentsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _AgentCongruent = Expect<Equal<AgentSqliteSelect, AgentPgSelect>>;

// Negative: role/status enum unions must stay narrowed on both dialects.
type _AgentRoleSqlite = Expect<Equal<AgentSqliteSelect['role'], 'lead' | 'member'>>;
type _AgentRolePg = Expect<Equal<AgentPgSelect['role'], 'lead' | 'member'>>;
type _AgentStatusSqlite = Expect<Equal<AgentSqliteSelect['status'], 'idle' | 'active' | 'dead' | 'disposed'>>;
type _AgentStatusPg = Expect<Equal<AgentPgSelect['status'], 'idle' | 'active' | 'dead' | 'disposed'>>;

// ─────────────────────────────────────────────────────────────────────────────
// workflow_definitions — scopeType must be WorkflowExecutionScope['type']
// on BOTH dialects (guards against a symmetric collapse to `unknown`).
// ─────────────────────────────────────────────────────────────────────────────

type WorkflowDefinitionSqliteSelect = typeof workflowDefinitionsDual.sqlite.$inferSelect;
type WorkflowDefinitionPgSelect = typeof workflowDefinitionsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _WorkflowDefinitionCongruent = Expect<Equal<WorkflowDefinitionSqliteSelect, WorkflowDefinitionPgSelect>>;

// Negative: scopeType must be the narrowed WorkflowExecutionScope union on BOTH dialects.
type _ScopeTypeSqlite = Expect<Equal<WorkflowDefinitionSqliteSelect['scopeType'], WorkflowExecutionScope['type']>>;
type _ScopeTypePg = Expect<Equal<WorkflowDefinitionPgSelect['scopeType'], WorkflowExecutionScope['type']>>;

// ─────────────────────────────────────────────────────────────────────────────
// workflow_executions — `status` enum + `scopeType` $type (shared `scopeColumns`
// helper) must both stay narrowed across dialects.
// ─────────────────────────────────────────────────────────────────────────────

type WorkflowExecutionSqliteSelect = typeof workflowExecutionsDual.sqlite.$inferSelect;
type WorkflowExecutionPgSelect = typeof workflowExecutionsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _WorkflowExecutionCongruent = Expect<Equal<WorkflowExecutionSqliteSelect, WorkflowExecutionPgSelect>>;

// Negative: status enum union must stay narrowed on both dialects.
type _ExecutionStatusSqlite = Expect<
  Equal<
    WorkflowExecutionSqliteSelect['status'],
    'pending' | 'running' | 'paused' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  >
>;
type _ExecutionStatusPg = Expect<
  Equal<
    WorkflowExecutionPgSelect['status'],
    'pending' | 'running' | 'paused' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  >
>;
// Negative: scopeType must be the narrowed WorkflowExecutionScope union on BOTH dialects.
type _ExecutionScopeTypeSqlite = Expect<
  Equal<WorkflowExecutionSqliteSelect['scopeType'], WorkflowExecutionScope['type']>
>;
type _ExecutionScopeTypePg = Expect<Equal<WorkflowExecutionPgSelect['scopeType'], WorkflowExecutionScope['type']>>;

// ─────────────────────────────────────────────────────────────────────────────
// workflow_finalizations — durable claim state must remain narrowed on both
// dialects while the complete select rows stay congruent.
// ─────────────────────────────────────────────────────────────────────────────

type WorkflowFinalizationSqliteSelect = typeof workflowFinalizationsDual.sqlite.$inferSelect;
type WorkflowFinalizationPgSelect = typeof workflowFinalizationsDual.postgres.$inferSelect;

type _WorkflowFinalizationCongruent = Expect<Equal<WorkflowFinalizationSqliteSelect, WorkflowFinalizationPgSelect>>;
type _WorkflowFinalizationStateSqlite = Expect<
  Equal<WorkflowFinalizationSqliteSelect['state'], 'claimed' | 'acknowledged' | 'failed'>
>;
type _WorkflowFinalizationStatePg = Expect<
  Equal<WorkflowFinalizationPgSelect['state'], 'claimed' | 'acknowledged' | 'failed'>
>;

// ─────────────────────────────────────────────────────────────────────────────
// workflow_step_spans — float8 estimatedCost + int4 durationMs (number | null
// both dialects) and `$type<SpanStatus>` status (contract-anchored).
// ─────────────────────────────────────────────────────────────────────────────

type WorkflowStepSpanSqliteSelect = typeof workflowStepSpansDual.sqlite.$inferSelect;
type WorkflowStepSpanPgSelect = typeof workflowStepSpansDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _WorkflowStepSpanCongruent = Expect<Equal<WorkflowStepSpanSqliteSelect, WorkflowStepSpanPgSelect>>;

// Negative: float8 estimatedCost must be `number | null` on both dialects.
type _EstimatedCostSqlite = Expect<Equal<WorkflowStepSpanSqliteSelect['estimatedCost'], number | null>>;
type _EstimatedCostPg = Expect<Equal<WorkflowStepSpanPgSelect['estimatedCost'], number | null>>;

// Negative: int4 durationMs must be `number | null` on both dialects.
type _DurationMsSqlite = Expect<Equal<WorkflowStepSpanSqliteSelect['durationMs'], number | null>>;
type _DurationMsPg = Expect<Equal<WorkflowStepSpanPgSelect['durationMs'], number | null>>;

// Contract-anchored: `$type<SpanStatus>` status must equal SpanStatus on both dialects.
type _SpanStatusSqlite = Expect<Equal<WorkflowStepSpanSqliteSelect['status'], SpanStatus>>;
type _SpanStatusPg = Expect<Equal<WorkflowStepSpanPgSelect['status'], SpanStatus>>;

// ─────────────────────────────────────────────────────────────────────────────
// worklog_summaries — float8 totalEstimatedCost (number | null) + `status` enum.
// ─────────────────────────────────────────────────────────────────────────────

type WorklogSummarySqliteSelect = typeof worklogSummariesDual.sqlite.$inferSelect;
type WorklogSummaryPgSelect = typeof worklogSummariesDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _WorklogSummaryCongruent = Expect<Equal<WorklogSummarySqliteSelect, WorklogSummaryPgSelect>>;

// Negative: float8 totalEstimatedCost must be `number | null` on both dialects.
type _TotalEstimatedCostSqlite = Expect<Equal<WorklogSummarySqliteSelect['totalEstimatedCost'], number | null>>;
type _TotalEstimatedCostPg = Expect<Equal<WorklogSummaryPgSelect['totalEstimatedCost'], number | null>>;

// Negative: status enum union must stay narrowed on both dialects.
type _WorklogSummaryStatusSqlite = Expect<
  Equal<
    WorklogSummarySqliteSelect['status'],
    'pending' | 'running' | 'paused' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  >
>;
type _WorklogSummaryStatusPg = Expect<
  Equal<
    WorklogSummaryPgSelect['status'],
    'pending' | 'running' | 'paused' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  >
>;

// ─────────────────────────────────────────────────────────────────────────────
// worklog_frame_entries — float8 estimatedCost + int4 durationMs/tokens
// (number | null both dialects) and `$type<WorkflowNodeType>` nodeType.
// ─────────────────────────────────────────────────────────────────────────────

type WorklogFrameEntrySqliteSelect = typeof worklogFrameEntriesDual.sqlite.$inferSelect;
type WorklogFrameEntryPgSelect = typeof worklogFrameEntriesDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _WorklogFrameEntryCongruent = Expect<Equal<WorklogFrameEntrySqliteSelect, WorklogFrameEntryPgSelect>>;

// Negative: float8 estimatedCost must be `number | null` on both dialects.
type _FrameEstimatedCostSqlite = Expect<Equal<WorklogFrameEntrySqliteSelect['estimatedCost'], number | null>>;
type _FrameEstimatedCostPg = Expect<Equal<WorklogFrameEntryPgSelect['estimatedCost'], number | null>>;

// Contract-anchored: `$type<WorkflowNodeType>` nodeType must equal WorkflowNodeType on both dialects.
type _FrameNodeTypeSqlite = Expect<Equal<WorklogFrameEntrySqliteSelect['nodeType'], WorkflowNodeType>>;
type _FrameNodeTypePg = Expect<Equal<WorklogFrameEntryPgSelect['nodeType'], WorkflowNodeType>>;

// ─────────────────────────────────────────────────────────────────────────────
// import_cursors — int8 bytesRead: both dialects must infer `number`
// (SQLite `integer`, PG `bigint` in 'number' mode), NOT `bigint` or `string`.
// ─────────────────────────────────────────────────────────────────────────────

type ImportCursorSqliteSelect = typeof importCursorsDual.sqlite.$inferSelect;
type ImportCursorPgSelect = typeof importCursorsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _ImportCursorCongruent = Expect<Equal<ImportCursorSqliteSelect, ImportCursorPgSelect>>;

// Negative: int8 bytesRead must be `number` (NOT NULL) on both dialects.
type _BytesReadSqlite = Expect<Equal<ImportCursorSqliteSelect['bytesRead'], number>>;
type _BytesReadPg = Expect<Equal<ImportCursorPgSelect['bytesRead'], number>>;

// ─────────────────────────────────────────────────────────────────────────────
// turns — FK→sessions via columnPair; cross-dialect $inferSelect congruence
// holds for an FK-bearing table. The textEnum `status` is anchored to the
// contract `TurnStatus`.
// ─────────────────────────────────────────────────────────────────────────────

type TurnSqliteSelect = typeof turnsDual.sqlite.$inferSelect;
type TurnPgSelect = typeof turnsDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _TurnCongruent = Expect<Equal<TurnSqliteSelect, TurnPgSelect>>;

// Negative: int4 turnNumber must be `number` (NOT NULL) on both dialects.
type _TurnNumberSqlite = Expect<Equal<TurnSqliteSelect['turnNumber'], number>>;
type _TurnNumberPg = Expect<Equal<TurnPgSelect['turnNumber'], number>>;

// Contract-anchored: the textEnum `status` must equal the contract `TurnStatus`
// union on BOTH dialects (catches a symmetric collapse to plain `string`).
type _TurnStatusSqlite = Expect<Equal<TurnSqliteSelect['status'], TurnStatus>>;
type _TurnStatusPg = Expect<Equal<TurnPgSelect['status'], TurnStatus>>;

// ─────────────────────────────────────────────────────────────────────────────
// message_routing — textEnum status must equal the contract
// `MessageRoutingStatus` union on BOTH dialects: the dual→twin FK direction must
// not widen it, and a symmetric collapse must fail here.
// ─────────────────────────────────────────────────────────────────────────────

type MessageRoutingSqliteSelect = typeof messageRoutingDual.sqlite.$inferSelect;
type MessageRoutingPgSelect = typeof messageRoutingDual.postgres.$inferSelect;

// Parity: both dialect faces infer the same select row.
type _MessageRoutingCongruent = Expect<Equal<MessageRoutingSqliteSelect, MessageRoutingPgSelect>>;

// Contract-anchored: status enum union must equal the contract type on both dialects.
type _RoutingStatusSqlite = Expect<Equal<MessageRoutingSqliteSelect['status'], MessageRoutingStatus>>;
type _RoutingStatusPg = Expect<Equal<MessageRoutingPgSelect['status'], MessageRoutingStatus>>;

// ─────────────────────────────────────────────────────────────────────────────
// session_events — autoPk insert-key divergence: the SQLite face keeps the
// auto-increment `id` optional in the insert shape (so `'id'` is a key), while
// the Postgres `GENERATED ALWAYS AS IDENTITY` face omits it entirely. This is
// the drizzle-honest divergence the canonical insert type rides on.
// ─────────────────────────────────────────────────────────────────────────────

type SessionEventSqliteInsert = typeof sessionEventsDual.sqlite.$inferInsert;
type SessionEventPgInsert = typeof sessionEventsDual.postgres.$inferInsert;

// Negative: 'id' is an insert key on SQLite (optional) but NOT on Postgres.
type _SessionEventIdSqliteHasKey = Expect<Equal<'id' extends keyof SessionEventSqliteInsert ? true : false, true>>;
type _SessionEventIdPgOmitsKey = Expect<Equal<'id' extends keyof SessionEventPgInsert ? true : false, false>>;

// Parity: the SELECT rows stay congruent across dialects even though INSERT diverges.
type SessionEventSqliteSelect = typeof sessionEventsDual.sqlite.$inferSelect;
type SessionEventPgSelect = typeof sessionEventsDual.postgres.$inferSelect;
type _SessionEventSelectCongruent = Expect<Equal<SessionEventSqliteSelect, SessionEventPgSelect>>;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime completeness guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dual tables that carry a compile-time type pin above. These are the tables
 * whose narrowing leaks across a package boundary into the public consumer
 * surface, where a silent widening would weaken an external consumer's types.
 */
const PINNED_DUAL_TABLES: ReadonlySet<string> = new Set([
  'harness_definitions',
  'client_runtimes',
  'sessions',
  'agents',
  'workflow_definitions',
  'workflow_executions',
  'workflow_finalizations',
  'workflow_step_spans',
  'worklog_summaries',
  'worklog_frame_entries',
  'import_cursors',
  'turns',
  'message_routing',
  'session_events',
]);

/**
 * Dual tables that net 1 deliberately does not pin at compile time, because a
 * symmetric type collapse on them is already caught elsewhere:
 *
 * - Tables with no `textEnum`/`$type` narrowing (only `text`/`epochMs`/`bool`/
 *   `int` columns). Their `$inferSelect` row is structurally derived, so net 2
 *   fully covers any divergence.
 * - Package-internal workflow/supervisor/log-import tables whose narrowing flows
 *   only into the canonical `x = xDual.sqlite` export consumed inside their own
 *   package; a collapse there breaks that package's own type-check, and net 2
 *   covers their structure. They are intentionally not part of any package's
 *   public dual surface.
 *
 * Each entry is a deliberate classification: removing a table from here (e.g.
 * because it gained a public, cross-package narrowed column) requires adding a
 * compile-time pin above instead.
 */
const STRUCTURAL_ONLY_DUAL_TABLES: ReadonlySet<string> = new Set([
  // No enum/$type narrowing — net 2 covers them structurally.
  'preferences',
  'client_profiles',
  'client_binary_versions',
  'client_binary_state',
  // Narrowing consumed only inside the owning package; not on a public surface.
  'supervisor_runtimes',
  'log_import_settings',
  'workflow_execution_frames',
  'workflow_gate_instances',
  'workflow_execution_links',
  'workflow_run_contexts',
  'worklog_artifact_writes',
  'worklog_gate_events',
  'workflow_execution_state',
  'workflow_execution_state_events',
]);

/**
 * Structural shape of a {@link DualTable} value as it appears on a schema
 * module's exports — both built dialect faces plus the `columnPair` accessor.
 * Used to recognise `defineDualTable` products without importing the factory's
 * generic types.
 */
interface DualTableShape {
  readonly sqlite: unknown;
  readonly postgres: unknown;
  readonly columnPair: (key: string) => unknown;
}

/**
 * Recognise a `defineDualTable` product on a module export by its structural
 * signature: a `columnPair` function plus a real SQLite table face and a real
 * Postgres table face. The drizzle `is()` guards make this robust against any
 * other export that merely happens to carry a `columnPair` property.
 * @param value - A module export value.
 * @returns True when the value is a dual-table object.
 */
function isDualTable(value: unknown): value is DualTableShape {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.columnPair === 'function' && is(candidate.sqlite, SQLiteTable) && is(candidate.postgres, PgTable)
  );
}

/**
 * Discover every `defineDualTable`-produced table's SQL name by scanning the
 * SQLite schema modules (the dual object lives in the SQLite-side schema file).
 * @returns Set of SQL table names declared via `defineDualTable`.
 */
async function discoverDualTableNames(): Promise<Set<string>> {
  // workspace root = 4 levels up: suites/ → src/ → conformance/ → storage/ → framework/
  const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
  const entries = await discoverSchemas(workspaceRoot, undefined, 'sqlite');
  const names = new Set<string>();
  for (const entry of entries) {
    const mod: Record<string, unknown> = await import(pathToFileURL(entry.schemaPath).href);
    for (const value of Object.values(mod)) {
      if (!isDualTable(value)) continue;
      names.add(getTableName(value.sqlite as SQLiteTable));
    }
  }
  return names;
}

describe('dual-parity types', () => {
  it('compile-time pins type-check', () => {
    // The `Expect<Equal<...>>` aliases above are the assertions; the project
    // validation (`tsc`) is the real runner. This case keeps the file a valid
    // vitest module and documents that intent.
    expect(true).toBe(true);
  });

  it('every converted dual table is classified (pinned or structural-only)', async () => {
    const discovered = await discoverDualTableNames();
    expect(discovered.size).toBeGreaterThan(0);

    const unclassified = [...discovered].filter(
      (name) => !PINNED_DUAL_TABLES.has(name) && !STRUCTURAL_ONLY_DUAL_TABLES.has(name),
    );
    expect(
      unclassified,
      `New dual table(s) ${JSON.stringify(unclassified)} are neither pinned with a compile-time ` +
        `parity assertion nor declared STRUCTURAL_ONLY in dual-parity-types.test.ts. Add a pin ` +
        `(if the table has a public, cross-package textEnum/$type column) or classify it.`,
    ).toEqual([]);

    // Both classification sets must reference only real dual tables — a stale
    // entry (renamed/removed table) is a maintenance bug.
    const allClassified = [...PINNED_DUAL_TABLES, ...STRUCTURAL_ONLY_DUAL_TABLES];
    const stale = allClassified.filter((name) => !discovered.has(name));
    expect(stale, `Stale dual-table classification entries: ${JSON.stringify(stale)}`).toEqual([]);
  }, 30_000);
});
