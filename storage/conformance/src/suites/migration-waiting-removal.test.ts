/**
 * Conformance for the waiting-removal data migration.
 *
 * Acceptance requires the complete suite against both dialects and the intended contract and reader changes.
 * Executing seed functions and SQL alone does not verify response readers.
 * Narrow frame/span responses omit retained gate rows. Direct frame totals in
 * `aggregateTokenTotalsInTransaction` and `reaggregateSqliteTokenTotalsInSingleStatement` keep their values;
 * `aggregateWorklogStats` sums those summary totals again for `worklog.stats`.
 *
 * The same cases run against file-backed SQLite and, with
 * `MAKAIO_STORAGE_TEST_DIALECT=postgres` and `MAKAIO_STORAGE_TEST_URL`, against
 * live PostgreSQL. The context is created WITHOUT the central chain: the suite
 * applies every migration before the data migration, seeds rows in the shape the
 * removed features wrote, applies the data migration, asserts every row outcome,
 * and then applies the rest of the chain. Nothing is dropped and no row is
 * deleted: the gate tables, gate frames and spans and the legacy columns stay.
 *
 * Every piece of wait evidence (paused status, waiting frame in either frame
 * table, paused summary, waiting gate instance, waiting gate event) sits alone on
 * its own execution, so a migration that forgets one branch fails exactly one
 * case. The external registration binding is seeded the way the registration
 * handler writes it (the frame only in the WorkLog table, status `running`) and
 * is settled afterwards through the real settlement path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { createBusInstance } from '@makaio/bus-core';
import {
  isDefinitionInvalidError,
  WorkflowDefinitionSchema,
  WorkflowNamespace,
  WorkflowRunResultSchema,
  WorkflowSubjects,
} from '@makaio/contracts';
import {
  registerDrizzleWorkflowStorage,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
} from '@makaio/subsystem-workflow-engine';
import type { StorageDialect } from '@makaio/storage-drizzle';
import { applyMigrations } from '@makaio/storage-migrations';
import { readCentralChain } from '../harness/chains.js';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

/** Suffix of the data migration tag; the numeric prefix comes from the generator. */
const DATA_SUFFIX = '_waiting-removal-data';
const REASON =
  'Workflow waits were removed; this execution was waiting for a gate response and can no longer continue.';

/**
 * The fixed, literal
 * reason format for a stored paused attempt outcome that becomes `failed`. Each identifier is a complete,
 * JSON-quoted string behind its reserved name (`pausedAtGateId=`, `pausedAtFrameId=`), not an unquoted token up
 * to the next space: `pausedAtGateId`/`pausedAtFrameId` allow any non-empty string (`framework/core/contracts/src/workflow/worker.ts`,
 * `:341`), including spaces, newlines and the separator sequence itself, so an unquoted read is not reversible.
 * A reader starts at the reserved name, reads a JSON string (the next unescaped `"` under JSON escaping rules),
 * and JSON-decodes it.
 * @param pausedAtGateId - Node ID of the gate at which the stored outcome was paused.
 * @param pausedAtFrameId - Frame ID of the stored outcome's suspended gate instance.
 * @returns The literal failure reason this migration writes.
 */
function reasonPausedOutcome(pausedAtGateId: string, pausedAtFrameId: string): string {
  return `${REASON} pausedAtGateId=${JSON.stringify(pausedAtGateId)} pausedAtFrameId=${JSON.stringify(pausedAtFrameId)}`;
}

/** Opaque JSON that looks like a gate node but sits outside every node position. */
const lookalike = { id: 'payload-gate', type: 'gate', nodes: [{ id: 'x', type: 'gate' }], gate: { handler: 'z' } };

/**
 * Build a sequence node.
 * @param id - Node identifier.
 * @param nodes - Child nodes.
 * @returns Sequence node JSON.
 */
function sequence(id: string, nodes: readonly unknown[]) {
  return { id, type: 'sequence', nodes };
}

/**
 * Build a loop node in the old (`gate`) or the converted (`check`) form.
 * @param id - Node identifier.
 * @param form - Form of the check member.
 * @param extra - Members of the check object besides `handler`.
 * @returns Loop node JSON.
 */
function loopNode(id: string, form: 'old' | 'new', extra: Record<string, unknown> = {}) {
  const check = { handler: `${id}-handler`, ...extra };
  return {
    id,
    type: 'loop',
    maxRounds: 2,
    body: sequence(`${id}-body`, [{ id: `${id}-step`, type: 'code-step' }]),
    ...(form === 'old' ? { gate: check } : { onExhausted: 'complete', check }),
  };
}

/**
 * Build a tree that uses every node position of the schema (root, sequence
 * nodes, a parallel branch with a dotted key, a branch key with a quote,
 * iterate, iterate-chain and loop bodies) and carries opaque lookalike payload.
 * @param form - Old or converted loop form.
 * @returns Root sequence JSON.
 */
function positionTree(form: 'old' | 'new') {
  return sequence('root', [
    loopNode('top', form, {
      input: 'frames.a.output',
      config: { payload: lookalike, onExhausted: 'opaque', escaped: '\\"'.repeat(550) },
    }),
    { ...loopNode('already-uses-check', 'new'), onExhausted: 'fail' },
    {
      id: 'fan',
      type: 'parallel',
      branches: {
        'a.b': sequence('fan-ab', [loopNode('in-dot', form)]),
        'c"d': sequence('fan-cd', [loopNode('in-quote', form)]),
      },
    },
    { id: 'each', type: 'iterate', collection: 'xs', body: sequence('each-body', [loopNode('in-iterate', form)]) },
    {
      id: 'chain',
      type: 'iterate-chain',
      collection: 'ys',
      body: sequence('chain-body', [loopNode('in-chain', form)]),
    },
    { id: 'payload', type: 'code-step', outputSchema: lookalike },
  ]);
}

const gateNode = { id: 'approve', type: 'gate', prompt: 'ok', autoAction: 'reject', timeoutMs: null };
const trees = {
  convertible: positionTree('old'),
  converted: positionTree('new'),
  gate: sequence('root', [gateNode]),
  escalation: sequence('root', [
    { ...loopNode('esc', 'old'), gate: { handler: 'esc-handler', escalation: { prompt: 'p' } } },
  ]),
  mixed: sequence('root', [loopNode('l', 'old'), gateNode]),
  both: sequence('root', [{ ...loopNode('l', 'new'), gate: { handler: 'old' } }]),
  nonObject: sequence('root', [{ ...loopNode('nobj', 'old'), gate: 'nobj-handler' }]),
  extraKey: sequence('root', [{ ...loopNode('xk', 'old'), gate: { handler: 'xk-handler', foo: 1 } }]),
  plain: sequence('root', [{ id: 'payload', type: 'code-step', outputSchema: lookalike }]),
  bodyGate: sequence('root', [{ ...loopNode('bg', 'new'), body: sequence('bg-body', [gateNode]) }]),
  loopExtra: sequence('root', [{ ...loopNode('le', 'old'), extra: true }]),
  loopExtraMixed: sequence('root', [loopNode('a', 'old'), { ...loopNode('b', 'new'), extra: true }]),
  // A `handler` that is missing, wrongly typed or an `input` that is not a
  // non-empty string keeps the document unchanged even when the loop otherwise looks convertible.
  badHandler: sequence('root', [{ ...loopNode('bh', 'old'), gate: { input: 'frames.a.output' } }]),
  badHandlerType: sequence('root', [{ ...loopNode('bt', 'old'), gate: { handler: 3 } }]),
  badInput: sequence('root', [{ ...loopNode('bi', 'old'), gate: { handler: 'bi-handler', input: '' } }]),
  // A missing handler beside a convertible sibling blocks conversion of the whole document.
  // `IFNULL`/`COALESCE` must normalize SQL NULL to false before the block predicate is negated.
  badHandlerSibling: sequence('root', [
    loopNode('good', 'old'),
    { ...loopNode('bh2', 'old'), gate: { input: 'frames.a.output' } },
  ]),
  // An opaque NUL escape blocks the whole-document jsonb cast on Postgres. SQLite converts the loop.
  nulConfig: sequence('root', [
    loopNode('nul', 'old', { config: { note: 'contains a NUL control character: \u0000' } }),
  ]),
  nulConfigConverted: sequence('root', [
    loopNode('nul', 'new', { config: { note: 'contains a NUL control character: \u0000' } }),
  ]),
  // The structural rename from `gate` to `check` does not establish
  // full schema validity. `maxRounds: 0` fails `WorkflowLoopNodeSchema` (`schemas.ts`, positive integer
  // required) but the SQL predicates only check `handler`/`input`, so this loop converts before being
  // rejected by the downstream `WorkflowDefinitionSchema` parse.
  badMaxRounds: sequence('root', [{ ...loopNode('bm', 'old'), maxRounds: 0 }]),
  badMaxRoundsConverted: sequence('root', [{ ...loopNode('bm', 'new'), maxRounds: 0 }]),
};

/** Definitions the migration must leave unchanged because it cannot convert them exactly. */
const rejectedTrees = [
  'gate',
  'escalation',
  'mixed',
  'both',
  'nonObject',
  'extraKey',
  'bodyGate',
  'loopExtra',
  'loopExtraMixed',
  'badHandler',
  'badHandlerType',
  'badInput',
  'badHandlerSibling',
] as const;
const definitionRows: ReadonlyArray<readonly [string, unknown]> = [
  ['def-convertible', trees.convertible],
  ['def-gate', trees.gate],
  ['def-escalation', trees.escalation],
  ['def-mixed', trees.mixed],
  ['def-both', trees.both],
  ['def-non-object', trees.nonObject],
  ['def-extra-key', trees.extraKey],
  ['def-unknown-node-key', sequence('root', [{ ...sequence('nested', []), label: 'Main' }])],
  ['def-plain', trees.plain],
  ['def-body-gate', trees.bodyGate],
  ['def-loop-extra', trees.loopExtra],
  ['def-loop-extra-mixed', trees.loopExtraMixed],
  ['def-bad-handler', trees.badHandler],
  ['def-bad-handler-type', trees.badHandlerType],
  ['def-bad-input', trees.badInput],
  ['def-bad-handler-sibling', trees.badHandlerSibling],
];
const rejectedIds = [
  'def-convertible-bad-maxrounds',
  'def-both',
  'def-body-gate',
  'def-escalation',
  'def-extra-key',
  'def-unknown-node-key',
  'def-gate',
  'def-loop-extra',
  'def-loop-extra-mixed',
  'def-mixed',
  'def-non-object',
  'def-bad-handler',
  'def-bad-handler-type',
  'def-bad-input',
  'def-bad-handler-sibling',
];

/**
 * Wrap a tree into a stored definition document.
 * @param id - Workflow identifier.
 * @param root - Root sequence JSON.
 * @param canvasLayout - Optional value of the legacy `canvasLayout` key. `WorkflowDefinitionSchema` no longer
 *   declares this member. Seed it to exercise the cleanup of executable copies.
 * @returns Definition JSON.
 */
function definitionDocument(id: string, root: unknown, canvasLayout?: unknown) {
  return { id, name: id, root, scope: { type: 'global' }, ...(canvasLayout !== undefined ? { canvasLayout } : {}) };
}

/**
 * Whether a stored definition document satisfies the current schema.
 * @param document - Definition JSON.
 * @returns `true` when the schema accepts the document.
 */
function parses(document: unknown): boolean {
  return WorkflowDefinitionSchema.safeParse(document).success;
}

/**
 * Narrow a parsed JSON value to an object.
 * @param value - Parsed JSON.
 * @returns `true` for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the definition snapshot out of a parsed attempt instruction.
 * @param instruction - Parsed instruction JSON.
 * @returns The embedded snapshot, or `undefined` when the instruction has none.
 */
function snapshotOf(instruction: unknown): unknown {
  if (!isRecord(instruction) || !isRecord(instruction['workload'])) return undefined;
  const input = instruction['workload']['input'];
  return isRecord(input) ? input['definitionSnapshot'] : undefined;
}

/**
 * Bind a JSON value for the active dialect (`jsonb` on Postgres, text on SQLite).
 * @param dialect - Active dialect.
 * @param value - JSON-serializable value.
 * @returns SQL fragment.
 */
function jsonValue(dialect: StorageDialect, value: unknown): SQL {
  const text = JSON.stringify(value);
  return dialect === 'postgres' ? sql`${text}::jsonb` : sql`${text}`;
}

/**
 * Read a JSON column value that the driver returns as text or already parsed.
 * @param value - Raw column value.
 * @returns Parsed JSON.
 */
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Build the instruction of a workflow attempt around a definition snapshot.
 * @param executionId - Execution the attempt belongs to.
 * @param workload - Workload kind.
 * @param snapshot - Definition snapshot placed in the workload input.
 * @returns Instruction JSON.
 */
function instructionOf(executionId: string, workload: string, snapshot: unknown) {
  return {
    id: `attempt-${executionId}`,
    revision: '1',
    workload: { kind: workload, version: '1', input: { executionId, workflowId: 'wf', definitionSnapshot: snapshot } },
    preservation: { required: [] },
  };
}

/** Stored documents the migration rewrites or must leave alone, parsed. */
interface StoredDocuments {
  readonly definitions: ReadonlyMap<string, unknown>;
  readonly snapshots: ReadonlyMap<string, unknown>;
  readonly instructions: ReadonlyMap<string, unknown>;
  readonly outcomes: ReadonlyMap<string, unknown>;
}

/** Rows of the retained gate tables and of node type `gate` in the live tables. */
interface RetainedCounts {
  readonly gateInstances: number;
  readonly gateEvents: number;
  readonly engineGateFrames: number;
  readonly worklogGateFrames: number;
  readonly gateSpans: number;
}

const startedAt = 1_000;
const completedAt = 2_000;

describeStorageConformance('waiting-removal data migration', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });
  const dialect = config.dialect;
  let chain: ReturnType<typeof readCentralChain>;
  let dataIndex: number;
  let rawDefinitionsBefore = new Map<string, unknown>();
  let otherInstructionBefore: unknown;
  let foreignNulBefore: { instruction: unknown; outcomeText: unknown } | undefined;
  let foreignOutcomeCleanBefore: { instruction: unknown; outcomeText: unknown } | undefined;
  let documentsAfterData: StoredDocuments | undefined;
  let countsAfterData: RetainedCounts | undefined;

  /**
   * Read the documents captured right after the data migration.
   * @returns Parsed documents.
   * @throws Error when the data migration has not run yet.
   */
  function afterData(): StoredDocuments {
    if (documentsAfterData === undefined) throw new Error('the data migration has not run');
    return documentsAfterData;
  }

  /**
   * Run one raw statement on the suite database.
   * @param ctx - Database context.
   * @param query - Statement to run.
   */
  async function run(ctx: StorageDatabaseContext, query: SQL): Promise<void> {
    await ctx.executor.run(query);
  }

  /**
   * Read rows of a query.
   * @param ctx - Database context.
   * @param query - Query to run.
   * @returns Result rows.
   */
  function rows(ctx: StorageDatabaseContext, query: SQL): Promise<Record<string, unknown>[]> {
    return ctx.executor.all<Record<string, unknown>>(query);
  }

  /**
   * Read every row of a two-column query into a map keyed by the first column.
   * @param ctx - Database context.
   * @param query - Query selecting a key column `k` and a value column `v`.
   * @returns Map from key to the parsed value.
   */
  async function keyed(ctx: StorageDatabaseContext, query: SQL): Promise<Map<string, unknown>> {
    return new Map((await rows(ctx, query)).map((row) => [String(row['k']), parseJson(row['v'])] as const));
  }

  /**
   * Read a table's rows into a map keyed by one column.
   * @param ctx - Database context.
   * @param table - Table name.
   * @param key - Key column.
   * @returns Map from key value to the row.
   */
  async function rowsBy(
    ctx: StorageDatabaseContext,
    table: string,
    key: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    const result = await rows(ctx, sql.raw(`SELECT * FROM ${table}`));
    return new Map(result.map((row) => [String(row[key]), row] as const));
  }

  /**
   * Read the stored documents the migration may rewrite.
   * @param ctx - Database context.
   * @returns Parsed definitions, snapshots, instructions and outcomes.
   */
  async function readDocuments(ctx: StorageDatabaseContext): Promise<StoredDocuments> {
    const outcomes = await keyed(
      ctx,
      sql`SELECT execution_attempt_id AS k, outcome_text AS v FROM execution_attempt WHERE outcome_text IS NOT NULL`,
    );
    return {
      definitions: await keyed(ctx, sql`SELECT id AS k, root AS v FROM workflow_definitions`),
      snapshots: await keyed(ctx, sql`SELECT execution_id AS k, definition_snapshot AS v FROM workflow_run_contexts`),
      instructions: await keyed(ctx, sql`SELECT execution_attempt_id AS k, instruction AS v FROM execution_attempt`),
      outcomes,
    };
  }

  /**
   * Count the rows that earlier releases wrote for the gate feature.
   * @param ctx - Database context.
   * @returns Row counts of the retained gate tables and of gate frames and spans.
   */
  async function retainedCounts(ctx: StorageDatabaseContext): Promise<RetainedCounts> {
    const count = async (query: string): Promise<number> =>
      Number((await rows(ctx, sql.raw(`SELECT count(*) AS n FROM ${query}`)))[0]?.['n']);
    return {
      gateInstances: await count('workflow_gate_instances'),
      gateEvents: await count('worklog_gate_events'),
      engineGateFrames: await count("workflow_execution_frames WHERE node_type = 'gate'"),
      worklogGateFrames: await count("worklog_frame_entries WHERE node_type = 'gate'"),
      gateSpans: await count("workflow_step_spans WHERE step_type = 'gate'"),
    };
  }

  /**
   * List the column names of a table; an absent table yields an empty list.
   * @param ctx - Database context.
   * @param table - Table name.
   * @returns Column names.
   */
  async function columnNames(ctx: StorageDatabaseContext, table: string): Promise<string[]> {
    const query =
      dialect === 'postgres'
        ? sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table}`
        : sql`SELECT name FROM pragma_table_info(${table})`;
    return (await rows(ctx, query)).map((row) => String(row['name']));
  }

  /**
   * Seed one execution row.
   * @param ctx - Database context.
   * @param id - Execution identifier.
   * @param status - Execution status.
   * @param options - Optional external registration frame and completion time.
   */
  async function seedExecution(
    ctx: StorageDatabaseContext,
    id: string,
    status: string,
    options: { readonly registrationFrameId?: string; readonly completed?: number } = {},
  ): Promise<void> {
    await run(
      ctx,
      sql`INSERT INTO workflow_executions (id, workflow_id, status, started_at, completed_at, scope_type, external_registration_frame_id)
        VALUES (${id}, 'wf', ${status}, ${startedAt}, ${options.completed ?? null}, 'global', ${options.registrationFrameId ?? null})`,
    );
  }

  /**
   * Seed a frame row in the engine table, the WorkLog table, or both.
   * @param ctx - Database context.
   * @param tables - Tables that receive the row.
   * @param frame - Frame values.
   */
  async function seedFrame(
    ctx: StorageDatabaseContext,
    tables: ReadonlyArray<'engine' | 'worklog'>,
    frame: {
      readonly executionId: string;
      readonly frameId: string;
      readonly nodeType: string;
      readonly status: string;
      readonly startedAt?: number;
      readonly completedAt?: number;
    },
  ): Promise<void> {
    const path = jsonValue(dialect, [frame.frameId]);
    const values = sql`${frame.frameId}, ${frame.executionId}, ${frame.frameId}, ${frame.nodeType}, ${path}, ${frame.status}, ${frame.startedAt ?? null}, ${frame.completedAt ?? null}`;
    if (tables.includes('engine')) {
      await run(
        ctx,
        sql`INSERT INTO workflow_execution_frames (frame_id, execution_id, node_id, node_type, path, status, started_at, completed_at)
          VALUES (${values})`,
      );
    }
    if (tables.includes('worklog')) {
      await run(
        ctx,
        sql`INSERT INTO worklog_frame_entries (frame_id, execution_id, node_id, node_type, path, status, started_at, completed_at)
          VALUES (${values})`,
      );
    }
  }

  /**
   * Seed a WorkLog summary row.
   * @param ctx - Database context.
   * @param executionId - Owning execution.
   * @param status - Summary status.
   */
  async function seedSummary(ctx: StorageDatabaseContext, executionId: string, status: string): Promise<void> {
    await run(
      ctx,
      sql`INSERT INTO worklog_summaries (execution_id, workflow_id, status, started_at)
        VALUES (${executionId}, 'wf', ${status}, ${startedAt})`,
    );
  }

  /**
   * Seed a step span row.
   * @param ctx - Database context.
   * @param span - Span values; unset measurements stay `NULL`.
   */
  async function seedSpan(
    ctx: StorageDatabaseContext,
    span: {
      readonly executionId: string;
      readonly frameId: string;
      readonly stepType: string;
      readonly status: string;
      readonly completedAt?: number;
      readonly durationMs?: number;
      readonly inputTokens?: number;
    },
  ): Promise<void> {
    await run(
      ctx,
      sql`INSERT INTO workflow_step_spans (execution_id, frame_id, step_id, step_type, status, started_at, completed_at, duration_ms, input_tokens)
        VALUES (${span.executionId}, ${span.frameId}, ${span.frameId}, ${span.stepType}, ${span.status}, ${startedAt},
          ${span.completedAt ?? null}, ${span.durationMs ?? null}, ${span.inputTokens ?? null})`,
    );
  }

  /**
   * Seed a waiting gate instance.
   * @param ctx - Database context.
   * @param executionId - Owning execution.
   * @param frameId - Frame of the gate.
   */
  async function seedGateInstance(ctx: StorageDatabaseContext, executionId: string, frameId: string): Promise<void> {
    await run(
      ctx,
      sql`INSERT INTO workflow_gate_instances (id, execution_id, node_id, frame_id, schema, status, created_at)
        VALUES (${`${executionId}:${frameId}`}, ${executionId}, 'approve', ${frameId}, ${jsonValue(dialect, {})}, 'waiting', ${startedAt})`,
    );
  }

  /**
   * Seed a waiting WorkLog gate event.
   * @param ctx - Database context.
   * @param executionId - Owning execution.
   * @param frameId - Frame of the gate.
   */
  async function seedGateEvent(ctx: StorageDatabaseContext, executionId: string, frameId: string): Promise<void> {
    await run(
      ctx,
      sql`INSERT INTO worklog_gate_events (id, execution_id, node_id, frame_id, status, opened_at)
        VALUES (${`event-${executionId}`}, ${executionId}, 'approve', ${frameId}, 'waiting', ${startedAt})`,
    );
  }

  /**
   * Seed a run context and an attempt around one definition snapshot.
   * @param ctx - Database context.
   * @param executionId - Owning execution.
   * @param snapshot - Definition snapshot stored on both rows.
   * @param outcome - Stored attempt outcome, when the attempt settled.
   */
  async function seedSnapshot(
    ctx: StorageDatabaseContext,
    executionId: string,
    snapshot: unknown,
    outcome: unknown = null,
  ): Promise<void> {
    await run(
      ctx,
      sql`INSERT INTO workflow_run_contexts (execution_id, workflow_id, coordinator_session_id, source_kind,
          definition_snapshot, worker_manifest, trigger_payload, cancel_subject, env, created_at)
        VALUES (${executionId}, 'wf', 'session', 'definition', ${jsonValue(dialect, snapshot)},
          ${jsonValue(dialect, { contributionRefs: [] })}, ${jsonValue(dialect, {})}, 'cancel', ${jsonValue(dialect, {})}, ${startedAt})`,
    );
    const instruction = JSON.stringify(instructionOf(executionId, 'workflow', snapshot));
    await run(
      ctx,
      sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at, outcome_text)
        VALUES (${`attempt-${executionId}`}, ${executionId}, ${instruction}, 'running', '1', ${outcome === null ? null : JSON.stringify(outcome)})`,
    );
  }

  /**
   * Seed one execution with a running root frame and a summary.
   * @param ctx - Database context.
   * @param id - Execution identifier.
   * @param status - Execution status.
   * @param summaryStatus - Status of the summary row.
   */
  async function seedPlainExecution(
    ctx: StorageDatabaseContext,
    id: string,
    status: string,
    summaryStatus: string,
  ): Promise<void> {
    await seedExecution(ctx, id, status);
    await seedFrame(ctx, ['engine', 'worklog'], {
      executionId: id,
      frameId: `${id}:root`,
      nodeType: 'sequence',
      status: 'running',
    });
    await seedSummary(ctx, id, summaryStatus);
  }

  /**
   * Seed the executions that each carry exactly one kind of wait evidence.
   * @param ctx - Database context.
   */
  async function seedEvidenceExecutions(ctx: StorageDatabaseContext): Promise<void> {
    await seedPlainExecution(ctx, 'ev-status', 'paused', 'running');
    await seedExecution(ctx, 'ev-frame-engine', 'running');
    await seedFrame(ctx, ['engine'], {
      executionId: 'ev-frame-engine',
      frameId: 'ev-frame-engine:loop',
      nodeType: 'loop',
      status: 'waiting',
    });
    await seedSummary(ctx, 'ev-frame-engine', 'running');
    await seedExecution(ctx, 'ev-frame-worklog', 'running');
    await seedFrame(ctx, ['worklog'], {
      executionId: 'ev-frame-worklog',
      frameId: 'ev-frame-worklog:loop',
      nodeType: 'loop',
      status: 'waiting',
    });
    await seedSummary(ctx, 'ev-frame-worklog', 'running');
    await seedPlainExecution(ctx, 'ev-summary', 'running', 'paused');
    await seedPlainExecution(ctx, 'ev-instance', 'running', 'running');
    await seedGateInstance(ctx, 'ev-instance', 'ev-instance:gate');
    await seedPlainExecution(ctx, 'ev-event', 'running', 'running');
    await seedGateEvent(ctx, 'ev-event', 'ev-event:gate');
    await seedExecution(ctx, 'ev-finalizing', 'finalizing');
    await seedFrame(ctx, ['engine'], {
      executionId: 'ev-finalizing',
      frameId: 'ev-finalizing:loop',
      nodeType: 'loop',
      status: 'waiting',
    });
    await seedSummary(ctx, 'ev-finalizing', 'finalizing');
    await seedExecution(ctx, 'ev-pending', 'pending');
    await seedFrame(ctx, ['engine'], {
      executionId: 'ev-pending',
      frameId: 'ev-pending:loop',
      nodeType: 'loop',
      status: 'waiting',
    });
    await seedSummary(ctx, 'ev-pending', 'pending');
    await seedPlainExecution(ctx, 'ev-none', 'running', 'running');
    await seedSpan(ctx, { executionId: 'ev-none', frameId: 'ev-none:root', stepType: 'code-step', status: 'running' });
    await seedExecution(ctx, 'ev-done', 'completed', { completed: completedAt });
    await seedFrame(ctx, ['engine', 'worklog'], {
      executionId: 'ev-done',
      frameId: 'ev-done:root',
      nodeType: 'sequence',
      status: 'completed',
    });
    await seedSummary(ctx, 'ev-done', 'paused');
  }

  /**
   * Seed a paused parallel run whose running sibling keeps a running span.
   * @param ctx - Database context.
   */
  async function seedParallelPaused(ctx: StorageDatabaseContext): Promise<void> {
    await seedExecution(ctx, 'par', 'paused');
    await seedSummary(ctx, 'par', 'paused');
    for (const [frameId, nodeType, status] of [
      ['par:root', 'sequence', 'running'],
      ['par:fan', 'parallel', 'running'],
      ['par:gate', 'gate', 'waiting'],
      ['par:sibling', 'code-step', 'running'],
      ['par:done', 'code-step', 'completed'],
    ] as const) {
      await seedFrame(ctx, ['engine', 'worklog'], { executionId: 'par', frameId, nodeType, status });
    }
    await seedSpan(ctx, {
      executionId: 'par',
      frameId: 'par:sibling',
      stepType: 'code-step',
      status: 'running',
      inputTokens: 5,
    });
    await seedSpan(ctx, {
      executionId: 'par',
      frameId: 'par:done',
      stepType: 'code-step',
      status: 'completed',
      completedAt: 1_500,
      durationMs: 500,
      inputTokens: 3,
    });
    await seedSpan(ctx, { executionId: 'par', frameId: 'par:gate', stepType: 'gate', status: 'running' });
  }

  /**
   * Seed external executions the way the registration handler writes them: the
   * registration frame lives only in the WorkLog table and is `running`.
   * @param ctx - Database context.
   */
  async function seedExternalExecutions(ctx: StorageDatabaseContext): Promise<void> {
    const registered = [
      ['wfx-ext-gate-running', 'worklog', 'gate', 'running', undefined],
      ['wfx-ext-gate-done', 'worklog', 'gate', 'completed', completedAt],
      ['wfx-ext-gate-engine', 'engine', 'gate', 'running', undefined],
      ['wfx-ext-code', 'worklog', 'code-step', 'running', undefined],
    ] as const;
    for (const [id, table, nodeType, status, completed] of registered) {
      const frameId = `${id}:registration`;
      await seedExecution(ctx, id, status === 'completed' ? 'completed' : 'running', {
        registrationFrameId: frameId,
        ...(completed !== undefined ? { completed } : {}),
      });
      await seedSummary(ctx, id, status === 'completed' ? 'completed' : 'running');
      await seedFrame(ctx, [table], {
        executionId: id,
        frameId,
        nodeType,
        status,
        startedAt,
        ...(completed !== undefined ? { completedAt: completed } : {}),
      });
    }
  }

  /**
   * Seed the stored documents: definitions, snapshots and instructions of each class.
   * @param ctx - Database context.
   */
  async function seedDocuments(ctx: StorageDatabaseContext): Promise<void> {
    for (const [id, root] of definitionRows) {
      await run(
        ctx,
        sql`INSERT INTO workflow_definitions (id, name, root, scope_type, scope_kind, scope_id, created_at, updated_at)
          VALUES (${id}, ${id}, ${jsonValue(dialect, root)}, 'global', '', '', 1, 1)`,
      );
    }
    await run(
      ctx,
      sql`UPDATE workflow_definitions SET canvas_layout = ${jsonValue(dialect, { a: { x: 1 } })}
      WHERE id = 'def-convertible'`,
    );
    if (dialect === 'sqlite') {
      // A raw import can retain repeated members. Both checks must keep their original order.
      const raw = JSON.stringify(trees.convertible).replace(
        '"gate":{"handler":"top-handler"',
        '"gate":{"handler":"first-handler"},"gate":{"handler":"top-handler"',
      );
      await run(ctx, sql`UPDATE workflow_definitions SET root = ${raw} WHERE id = 'def-convertible'`);
    }
    // Seeded outside `definitionRows` because, unlike every other row there, this one IS
    // structurally rewritten and only afterwards rejected — it belongs to neither the single `converted`
    // row nor the unchanged `definitionRows` entries of the generic loop below.
    await run(
      ctx,
      sql`INSERT INTO workflow_definitions (id, name, root, scope_type, scope_kind, scope_id, created_at, updated_at)
        VALUES ('def-convertible-bad-maxrounds', 'def-convertible-bad-maxrounds', ${jsonValue(dialect, trees.badMaxRounds)}, 'global', '', '', 1, 1)`,
    );
    for (const [id, status] of [
      ['snap-convertible', 'running'],
      ['snap-gate', 'completed'],
      ['snap-escalation', 'completed'],
      ['snap-both', 'completed'],
      ['snap-plain', 'completed'],
      ['snap-mixed', 'completed'],
      ['snap-non-object', 'completed'],
      ['snap-extra-key', 'completed'],
      ['snap-loop-extra', 'completed'],
      ['snap-body-gate', 'completed'],
      ['snap-bad-handler', 'completed'],
      ['snap-bad-handler-type', 'completed'],
      ['snap-bad-input', 'completed'],
      ['snap-bad-handler-sibling', 'completed'],
    ] as const) {
      await seedExecution(ctx, id, status, status === 'completed' ? { completed: completedAt } : {});
      await seedSummary(ctx, id, status);
    }
    await seedSnapshot(ctx, 'snap-convertible', definitionDocument('wf', trees.convertible, { a: { x: 1 } }));
    await seedSnapshot(ctx, 'snap-gate', definitionDocument('wf', trees.gate, { a: 1 }));
    await seedSnapshot(ctx, 'snap-escalation', definitionDocument('wf', trees.escalation, { a: 1 }));
    await seedSnapshot(ctx, 'snap-both', definitionDocument('wf', trees.both, { a: 1 }));
    await seedSnapshot(ctx, 'snap-mixed', definitionDocument('wf', trees.mixed, { a: 1 }));
    await seedSnapshot(ctx, 'snap-non-object', definitionDocument('wf', trees.nonObject, { a: 1 }));
    await seedSnapshot(ctx, 'snap-extra-key', definitionDocument('wf', trees.extraKey, { a: 1 }));
    await seedSnapshot(ctx, 'snap-loop-extra', definitionDocument('wf', trees.loopExtra, { a: 1 }));
    await seedSnapshot(ctx, 'snap-body-gate', definitionDocument('wf', trees.bodyGate, { a: 1 }));
    await seedSnapshot(ctx, 'snap-bad-handler', definitionDocument('wf', trees.badHandler, { a: 1 }));
    await seedSnapshot(ctx, 'snap-bad-handler-type', definitionDocument('wf', trees.badHandlerType, { a: 1 }));
    await seedSnapshot(ctx, 'snap-bad-input', definitionDocument('wf', trees.badInput, { a: 1 }));
    await seedSnapshot(ctx, 'snap-bad-handler-sibling', definitionDocument('wf', trees.badHandlerSibling, { a: 1 }));
    await seedSnapshot(ctx, 'snap-plain', definitionDocument('wf', trees.plain, { a: 1 }), {
      executionId: 'snap-plain',
      workflowId: 'wf',
      status: 'completed',
    });
    await seedSnapshot(ctx, 'ev-status', definitionDocument('wf', trees.gate), {
      executionId: 'ev-status',
      workflowId: 'wf',
      status: 'paused',
      pausedAtGateId: 'approve',
      pausedAtFrameId: 'ev-status:gate',
    });
    // A tricky identifier (embedded space and backslash) proves the JSON-string encoding is
    // reversible where an unquoted "read up to the next space" would not be.
    await seedExecution(ctx, 'ev-tricky', 'completed', { completed: completedAt });
    await seedSnapshot(ctx, 'ev-tricky', definitionDocument('wf', trees.gate), {
      executionId: 'ev-tricky',
      workflowId: 'wf',
      status: 'paused',
      pausedAtGateId: 'approve this one\\please',
      pausedAtFrameId: 'ev-tricky:gate frame',
    });
    await run(
      ctx,
      sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at)
        VALUES ('attempt-other', 'ev-done', ${JSON.stringify(instructionOf('ev-done', 'other', { root: trees.gate }))}, 'settled', '1')`,
    );
    // A foreign owner whose instruction and outcome are BOTH fully `jsonb`/`json`-readable
    // (no NUL anywhere), isolated from the NUL cases below, so the owner-binding predicate is proven on its own
    // and not merely because an unrelated cast failure already left the row untouched.
    await run(
      ctx,
      sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at, outcome_text)
        VALUES ('attempt-foreign-outcome-clean', 'ev-done',
          ${JSON.stringify({ workload: { kind: 'other', input: {} } })}, 'settled', '1',
          ${JSON.stringify({ executionId: 'ev-done', workflowId: 'wf', status: 'paused', owner: 'other' })})`,
    );
    // Opaque NUL escape inside the untouched `gate.config` position of a convertible loop, `workload.kind =
    // 'workflow'`, no outcome recorded (unconverted instruction): on SQLite the loop
    // still converts (`json1` casts and rewrites structurally, never extracting the affected leaf as its own
    // string, verified against sqlite3 3.54). On Postgres `waiting_removal_parse_jsonb` returns NULL for the WHOLE document
    // because the check is whole-text, not per-path (verified against psql 18.3): this row therefore stays
    // byte-identical with its stored `gate` node, counted below, and is rejected only when its instruction is
    // later parsed as an executable workflow instruction
    // (`framework/subsystems/workflow-engine/src/workflow-attempt-instruction.ts`, executing parse
    // `framework/subsystems/workflow-engine/src/workflow-attempt-outcome.ts`), not by the outcome codec
    // (this row has no `outcome_text`).
    await run(
      ctx,
      sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at)
        VALUES ('attempt-nul-convertible', 'ev-done',
          ${JSON.stringify(instructionOf('ev-done', 'workflow', definitionDocument('wf', trees.nulConfig)))}, 'running', '1')`,
    );
    // Own workflow attempt with a recorded `status: 'paused'` outcome and an opaque NUL elsewhere in the same
    // outcome text (unconverted outcome): stays byte-identical on Postgres for the
    // same whole-text reason and is rejected only when read, because the outcome codec no longer accepts
    // `status: 'paused'` after this migration ships. On SQLite it still converts to
    // `failed` with the named-pair reason like every other `paused` outcome.
    await run(
      ctx,
      sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at, outcome_text)
        VALUES ('attempt-paused-nul', 'ev-done',
          ${JSON.stringify(instructionOf('ev-done', 'workflow', definitionDocument('wf', trees.plain)))}, 'running', '1',
          ${JSON.stringify({ executionId: 'ev-done', workflowId: 'wf', status: 'paused', pausedAtGateId: 'approve', pausedAtFrameId: 'frame-approve-1', note: 'contains a NUL control character: \u0000' })})`,
    );
    for (const [suffix, note] of [
      ['pua', '\uE000'],
      ['literal', '\\u0000'],
      ['surrogate', '\uD800'],
    ] as const) {
      const tree = sequence('root', [loopNode('probe', 'old', { config: { note } })]);
      await run(
        ctx,
        sql`INSERT INTO execution_attempt
        (execution_attempt_id, execution_id, instruction, status, created_at)
        VALUES (${`attempt-probe-${suffix}`}, 'ev-done',
          ${JSON.stringify(instructionOf('ev-done', 'workflow', definitionDocument('wf', tree)))}, 'running', '1')`,
      );
      await run(
        ctx,
        sql`INSERT INTO execution_attempt
        (execution_attempt_id, execution_id, instruction, status, created_at, outcome_text)
        VALUES (${`attempt-paused-${suffix}`}, 'ev-done',
          ${JSON.stringify(instructionOf('ev-done', 'workflow', definitionDocument('wf', trees.plain)))}, 'running', '1',
          ${JSON.stringify({ executionId: 'ev-done', workflowId: 'wf', status: 'paused', pausedAtGateId: 'approve', pausedAtFrameId: 'frame-approve-1', note })})`,
      );
    }
    // Foreign workload owner whose own outcome happens to carry `status: 'paused'` and an opaque NUL:
    // both `instruction` and `outcome_text` must stay byte-identical because `workload.kind` is not
    // `'workflow'`, and the embedded NUL must not fail the cast that checks that.
    await run(
      ctx,
      sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at, outcome_text)
        VALUES ('attempt-foreign-nul', 'ev-done',
          ${JSON.stringify(instructionOf('ev-done', 'other', { note: 'foreign payload' }))}, 'settled', '1',
          ${JSON.stringify({ status: 'paused', owner: 'other', note: 'contains a NUL control character: \u0000' })})`,
    );
  }

  /**
   * Seed live executions without wait evidence, with independent blockers in each executable copy.
   * @param ctx - Database context.
   */
  async function seedActiveBlockedCopies(ctx: StorageDatabaseContext): Promise<void> {
    for (const [id, status, snapshot, attempt, active] of [
      ['pending-gated-context', 'pending', trees.gate, trees.plain, true],
      ['running-gated-attempt', 'running', trees.plain, trees.gate, true],
      ['running-gated-history', 'running', trees.plain, trees.gate, false],
    ] as const) {
      await seedPlainExecution(ctx, id, status, status);
      await seedSnapshot(ctx, id, definitionDocument('wf', snapshot));
      const attemptId = `attempt-${id}`;
      const instruction = JSON.stringify(instructionOf(id, 'workflow', definitionDocument('wf', attempt)));
      await run(
        ctx,
        sql`UPDATE execution_attempt SET instruction = ${instruction}, status = 'allocated', claimable = 1
          WHERE execution_attempt_id = ${attemptId}`,
      );
      if (active) {
        await run(
          ctx,
          sql`INSERT INTO active_execution_attempt (execution_id, execution_attempt_id) VALUES (${id}, ${attemptId})`,
        );
      }
      await seedSpan(ctx, { executionId: id, frameId: `${id}:root`, stepType: 'code-step', status: 'running' });
    }
  }

  /**
   * Seed attempts with recorded outcomes or provider obligations and a mismatched owner pointer.
   * @param ctx - Database context.
   */
  async function seedAttemptClosureFixtures(ctx: StorageDatabaseContext): Promise<void> {
    await seedSnapshot(ctx, 'ev-pending', definitionDocument('wf', trees.plain), {
      executionId: 'ev-pending',
      workflowId: 'wf',
      status: 'completed',
    });
    await run(
      ctx,
      sql`UPDATE execution_attempt SET status = 'settled', settlement_kind = 'outcome', operation_start_gate = 'closed'
        WHERE execution_attempt_id = 'attempt-ev-pending'`,
    );
    await run(
      ctx,
      sql`INSERT INTO active_execution_attempt (execution_id, execution_attempt_id) VALUES
        ('ev-status', 'attempt-ev-status'),
        ('ev-pending', 'attempt-ev-pending'),
        ('ev-event', 'attempt-running-gated-history')`,
    );
    await run(
      ctx,
      sql`INSERT INTO provider_operation (execution_attempt_id, generation, obligation, failure_count)
        VALUES ('attempt-running-gated-attempt', 2, 'allocation-control', 1)`,
    );
  }

  beforeAll(async () => {
    const ctx = getCtx();
    chain = readCentralChain(dialect);
    dataIndex = chain.findIndex((migration) => migration.tag.endsWith(DATA_SUFFIX));
    expect(dataIndex).toBeGreaterThan(0);
    await applyMigrations(ctx.db, chain.slice(0, dataIndex));
    await seedEvidenceExecutions(ctx);
    await seedParallelPaused(ctx);
    await seedExternalExecutions(ctx);
    await seedDocuments(ctx);
    await seedActiveBlockedCopies(ctx);
    await seedAttemptClosureFixtures(ctx);
    rawDefinitionsBefore = new Map(
      (await rows(ctx, sql`SELECT id, root FROM workflow_definitions`)).map((row) => [String(row['id']), row['root']]),
    );
    otherInstructionBefore = (
      await rows(ctx, sql`SELECT instruction FROM execution_attempt WHERE execution_attempt_id = 'attempt-other'`)
    )[0]?.['instruction'];
    const foreignNulRow = (
      await rows(
        ctx,
        sql`SELECT instruction, outcome_text FROM execution_attempt WHERE execution_attempt_id = 'attempt-foreign-nul'`,
      )
    )[0];
    foreignNulBefore = { instruction: foreignNulRow?.['instruction'], outcomeText: foreignNulRow?.['outcome_text'] };
    const foreignOutcomeCleanRow = (
      await rows(
        ctx,
        sql`SELECT instruction, outcome_text FROM execution_attempt WHERE execution_attempt_id = 'attempt-foreign-outcome-clean'`,
      )
    )[0];
    foreignOutcomeCleanBefore = {
      instruction: foreignOutcomeCleanRow?.['instruction'],
      outcomeText: foreignOutcomeCleanRow?.['outcome_text'],
    };
    await applyMigrations(ctx.db, [chain[dataIndex]!]);
    documentsAfterData = await readDocuments(ctx);
    countsAfterData = await retainedCounts(ctx);
  });

  describe('after the data migration', () => {
    it('fails every execution with a single kind of wait evidence, and only those', async () => {
      const executions = await rowsBy(getCtx(), 'workflow_executions', 'id');
      for (const id of [
        'ev-status',
        'ev-frame-engine',
        'ev-frame-worklog',
        'ev-summary',
        'ev-instance',
        'ev-event',
        'ev-finalizing',
        'ev-pending',
        'par',
      ]) {
        expect(executions.get(id), id).toMatchObject({ status: 'failed', error: REASON });
        expect(Number(executions.get(id)?.['completed_at']), id).toBeGreaterThan(startedAt);
      }
      expect(executions.get('ev-none')).toMatchObject({ status: 'running', error: null, completed_at: null });
      expect(executions.get('ev-done')).toMatchObject({ status: 'completed', error: null });
    });

    it('fails live executions with an incompatible stored copy before reaching their gate', async () => {
      const ctx = getCtx();
      const executions = await rowsBy(ctx, 'workflow_executions', 'id');
      const frames = await rowsBy(ctx, 'workflow_execution_frames', 'frame_id');
      const entries = await rowsBy(ctx, 'worklog_frame_entries', 'frame_id');
      const summaries = await rowsBy(ctx, 'worklog_summaries', 'execution_id');
      const spans = await rowsBy(ctx, 'workflow_step_spans', 'frame_id');
      const reason =
        'Workflow waits were removed; this execution has an incompatible definition snapshot and cannot continue.';
      for (const id of ['pending-gated-context', 'running-gated-attempt']) {
        const frameId = `${id}:root`;
        expect(executions.get(id), id).toMatchObject({ status: 'failed', error: reason });
        expect(Number(executions.get(id)?.['completed_at']), id).toBeGreaterThan(startedAt);
        expect(frames.get(frameId), id).toMatchObject({ status: 'failed', error: reason });
        expect(entries.get(frameId), id).toMatchObject({ status: 'failed', error: reason });
        expect(summaries.get(id), id).toMatchObject({ status: 'failed', error: reason });
        expect(spans.get(frameId), id).toMatchObject({ status: 'failed' });
      }
      expect(executions.get('running-gated-history')).toMatchObject({ status: 'running', error: null });
      expect(executions.get('snap-gate')).toMatchObject({ status: 'completed', error: null });
    });

    it('settles and detaches only matching active attempts of failed executions', async () => {
      const ctx = getCtx();
      const attempts = await rowsBy(ctx, 'execution_attempt', 'execution_attempt_id');
      const pointers = await rowsBy(ctx, 'active_execution_attempt', 'execution_id');
      for (const id of ['pending-gated-context', 'running-gated-attempt']) {
        expect(attempts.get(`attempt-${id}`), id).toMatchObject({
          status: 'settled',
          settlement_kind: 'abandoned',
          claimable: 0,
          operation_start_gate: 'closed',
          outcome_text: null,
        });
        expect(pointers.has(id), id).toBe(false);
      }
      const { outcomes } = afterData();
      for (const id of ['ev-status', 'ev-pending']) {
        expect(attempts.get(`attempt-${id}`), id).toMatchObject({
          status: 'settled',
          settlement_kind: 'outcome',
          operation_start_gate: 'closed',
        });
        expect(pointers.has(id), id).toBe(false);
      }
      expect(outcomes.get('attempt-ev-status')).toMatchObject({ status: 'failed' });
      expect(outcomes.get('attempt-ev-pending')).toEqual({
        executionId: 'ev-pending',
        workflowId: 'wf',
        status: 'completed',
      });
      expect(attempts.get('attempt-running-gated-history')).toMatchObject({
        status: 'allocated',
        settlement_kind: null,
        claimable: 1,
        operation_start_gate: 'open',
      });
      expect(pointers.get('ev-event')).toMatchObject({ execution_attempt_id: 'attempt-running-gated-history' });
      const provider = await rowsBy(ctx, 'provider_operation', 'execution_attempt_id');
      expect(provider.get('attempt-running-gated-attempt')).toMatchObject({
        generation: 2,
        obligation: 'allocation-control',
        failure_count: 1,
        completion_evidence: null,
      });
    });

    it('fails waiting and non-terminal frames of failed executions in both tables and keeps the rest', async () => {
      for (const table of ['workflow_execution_frames', 'worklog_frame_entries']) {
        const frames = await rowsBy(getCtx(), table, 'frame_id');
        expect(frames.get('par:sibling'), table).toMatchObject({ status: 'failed', error: REASON });
        expect(frames.get('par:fan'), table).toMatchObject({ status: 'failed', error: REASON });
        expect(frames.get('par:done'), table).toMatchObject({ status: 'completed', error: null });
        expect(frames.get('ev-none:root'), table).toMatchObject({ status: 'running', error: null });
        expect(frames.get('ev-done:root'), table).toMatchObject({ status: 'completed' });
        expect(frames.get('par:gate'), table).toMatchObject({ node_type: 'gate', status: 'failed', error: REASON });
      }
      const engine = await rowsBy(getCtx(), 'workflow_execution_frames', 'frame_id');
      expect(engine.get('ev-frame-engine:loop')).toMatchObject({ status: 'failed', error: REASON });
      const worklog = await rowsBy(getCtx(), 'worklog_frame_entries', 'frame_id');
      expect(worklog.get('ev-frame-worklog:loop')).toMatchObject({ status: 'failed', error: REASON });
    });

    it('closes the running spans of failed executions, keeps measured values and keeps gate spans', async () => {
      const spans = await rowsBy(getCtx(), 'workflow_step_spans', 'frame_id');
      expect(spans.get('par:sibling')).toMatchObject({ status: 'failed', duration_ms: null, input_tokens: 5 });
      expect(Number(spans.get('par:sibling')?.['completed_at'])).toBeGreaterThan(startedAt);
      expect(spans.get('par:done')).toMatchObject({ status: 'completed', duration_ms: 500 });
      expect(Number(spans.get('par:done')?.['completed_at'])).toBe(1_500);
      expect(spans.get('ev-none:root')).toMatchObject({ status: 'running', completed_at: null });
      expect(spans.get('par:gate')).toMatchObject({ step_type: 'gate', status: 'failed' });
    });

    it('lets WorkLog summaries follow their execution, including a lagging or paused summary', async () => {
      const summaries = await rowsBy(getCtx(), 'worklog_summaries', 'execution_id');
      for (const id of [
        'ev-status',
        'ev-frame-engine',
        'ev-frame-worklog',
        'ev-summary',
        'ev-instance',
        'ev-event',
        'ev-pending',
        'par',
      ]) {
        expect(summaries.get(id), id).toMatchObject({ status: 'failed', error: REASON });
      }
      expect(summaries.get('ev-none')).toMatchObject({ status: 'running', error: null });
      expect(summaries.get('ev-done')).toMatchObject({ status: 'completed' });
    });

    it('clears the external registration binding of every retained gate frame and keeps the others', async () => {
      const executions = await rowsBy(getCtx(), 'workflow_executions', 'id');
      for (const id of ['wfx-ext-gate-running', 'wfx-ext-gate-done', 'wfx-ext-gate-engine']) {
        expect(executions.get(id)?.['external_registration_frame_id'], id).toBeNull();
      }
      expect(executions.get('wfx-ext-gate-running')).toMatchObject({ status: 'running', error: null });
      expect(executions.get('wfx-ext-gate-done')).toMatchObject({ status: 'completed' });
      expect(executions.get('wfx-ext-code')).toMatchObject({
        status: 'running',
        external_registration_frame_id: 'wfx-ext-code:registration',
      });
      const worklog = await rowsBy(getCtx(), 'worklog_frame_entries', 'frame_id');
      const engine = await rowsBy(getCtx(), 'workflow_execution_frames', 'frame_id');
      expect(worklog.get('wfx-ext-gate-running:registration')).toMatchObject({ node_type: 'gate', status: 'running' });
      expect(worklog.get('wfx-ext-gate-done:registration')).toMatchObject({ node_type: 'gate', status: 'completed' });
      expect(engine.get('wfx-ext-gate-engine:registration')).toMatchObject({ node_type: 'gate', status: 'running' });
      expect(worklog.get('wfx-ext-code:registration')).toMatchObject({ status: 'running', node_type: 'code-step' });
    });

    it('deletes no row of the gate feature: tables, gate frames and gate spans keep their rows', async () => {
      expect(countsAfterData).toEqual({
        gateInstances: 1,
        gateEvents: 1,
        engineGateFrames: 2,
        worklogGateFrames: 3,
        gateSpans: 1,
      });
      const instances = await rowsBy(getCtx(), 'workflow_gate_instances', 'id');
      expect(instances.get('ev-instance:ev-instance:gate')).toMatchObject({ status: 'waiting' });
    });

    it('preserves completion on exhaustion for converted loops and leaves existing check loops alone', async () => {
      const { definitions } = afterData();
      expect(definitions.get('def-convertible')).toEqual(trees.converted);
      if (dialect === 'sqlite') {
        expect(JSON.stringify(definitions.get('def-convertible'))).toBe(JSON.stringify(trees.converted));
        const [row] = await rows(
          getCtx(),
          sql`SELECT root -> '$.nodes[0]' AS loop FROM workflow_definitions WHERE id = 'def-convertible'`,
        );
        expect(String(row?.['loop'])).toContain(
          '"onExhausted":"complete","check":{"handler":"first-handler"},"check":{"handler":"top-handler"',
        );
        expect(String(row?.['loop']).match(/"onExhausted":"complete"/g)).toHaveLength(1);
      }
      // This historical migration preserves the old handler name. It cannot infer the convergence step ID.
      expect(parses(definitionDocument('def-convertible', definitions.get('def-convertible')))).toBe(false);
      for (const [id, root] of definitionRows.slice(1)) {
        expect(definitions.get(id), id).toEqual(root);
        if (dialect === 'sqlite') {
          const raw = (await rows(getCtx(), sql`SELECT root FROM workflow_definitions WHERE id = ${id}`))[0]?.['root'];
          expect(raw, id).toBe(rawDefinitionsBefore.get(id));
        }
      }
      for (const name of rejectedTrees) {
        expect(parses(definitionDocument(name, trees[name])), name).toBe(false);
      }
      expect(parses(definitionDocument('def-plain', trees.plain))).toBe(true);
    });

    it('a converted loop with `maxRounds: 0` ' + 'is rewritten and THEN rejected by the schema', async () => {
      const { definitions } = afterData();
      expect(definitions.get('def-convertible-bad-maxrounds')).toEqual(trees.badMaxRoundsConverted);
      const document = definitionDocument(
        'def-convertible-bad-maxrounds',
        definitions.get('def-convertible-bad-maxrounds'),
      );
      expect(WorkflowDefinitionSchema.safeParse(document).error?.issues).toContainEqual(
        expect.objectContaining({ path: ['root', 'nodes', 0, 'maxRounds'] }),
      );
    });

    it('migrates executable snapshots without changing other workloads', async () => {
      const { snapshots, instructions } = afterData();
      expect(snapshots.get('snap-convertible')).toEqual(definitionDocument('wf', trees.converted));
      expect(snapshots.get('snap-gate')).toEqual(definitionDocument('wf', trees.gate));
      expect(snapshots.get('snap-escalation')).toEqual(definitionDocument('wf', trees.escalation));
      expect(snapshots.get('snap-both')).toEqual(definitionDocument('wf', trees.both));
      for (const [id, tree] of [
        ['snap-mixed', trees.mixed],
        ['snap-non-object', trees.nonObject],
        ['snap-extra-key', trees.extraKey],
        ['snap-loop-extra', trees.loopExtra],
        ['snap-body-gate', trees.bodyGate],
        ['snap-bad-handler', trees.badHandler],
        ['snap-bad-handler-type', trees.badHandlerType],
        ['snap-bad-input', trees.badInput],
        ['snap-bad-handler-sibling', trees.badHandlerSibling],
      ] as const) {
        expect(snapshots.get(id), id).toEqual(definitionDocument('wf', tree));
        expect(parses(snapshots.get(id)), id).toBe(false);
      }
      expect(snapshots.get('snap-plain')).toEqual(definitionDocument('wf', trees.plain));
      expect(parses(snapshots.get('snap-convertible'))).toBe(false);
      for (const id of ['snap-gate', 'snap-escalation', 'snap-both']) {
        expect(parses(snapshots.get(id)), id).toBe(false);
      }
      for (const [attempt, snapshot] of [
        ['attempt-snap-convertible', definitionDocument('wf', trees.converted)],
        ['attempt-snap-gate', definitionDocument('wf', trees.gate)],
        ['attempt-snap-escalation', definitionDocument('wf', trees.escalation)],
        ['attempt-snap-both', definitionDocument('wf', trees.both)],
        ['attempt-snap-mixed', definitionDocument('wf', trees.mixed)],
        ['attempt-snap-non-object', definitionDocument('wf', trees.nonObject)],
        ['attempt-snap-extra-key', definitionDocument('wf', trees.extraKey)],
        ['attempt-snap-loop-extra', definitionDocument('wf', trees.loopExtra)],
        ['attempt-snap-body-gate', definitionDocument('wf', trees.bodyGate)],
        ['attempt-snap-bad-handler', definitionDocument('wf', trees.badHandler)],
        ['attempt-snap-bad-handler-type', definitionDocument('wf', trees.badHandlerType)],
        ['attempt-snap-bad-input', definitionDocument('wf', trees.badInput)],
        ['attempt-snap-bad-handler-sibling', definitionDocument('wf', trees.badHandlerSibling)],
      ] as const) {
        expect(snapshotOf(instructions.get(attempt)), attempt).toEqual(snapshot);
      }
      expect(parses(snapshotOf(instructions.get('attempt-snap-convertible')))).toBe(false);
      expect(snapshotOf(instructions.get('attempt-snap-plain'))).toEqual(definitionDocument('wf', trees.plain));
      const executions = await rowsBy(getCtx(), 'workflow_executions', 'id');
      expect(executions.get('snap-convertible')).toMatchObject({ status: 'running', error: null });
      const other = (
        await rows(
          getCtx(),
          sql`SELECT instruction FROM execution_attempt WHERE execution_attempt_id = 'attempt-other'`,
        )
      )[0]?.['instruction'];
      expect(other).toBe(otherInstructionBefore);
    });

    it(
      'casting an opaque NUL escape is a whole-text check, and leaves two counted row ' +
        'classes on Postgres instead of converting a per-path position',
      async () => {
        // Unconverted instruction: an otherwise convertible loop with an opaque NUL escape in the untouched `gate.config` position.
        // SQLite casts and rewrites structurally and the loop converts; Postgres rejects the WHOLE document cast
        // (whole-document restriction) and the row stays exactly as stored, with `gate`.
        const { instructions } = afterData();
        const nulSnapshot = snapshotOf(instructions.get('attempt-nul-convertible'));
        if (dialect === 'sqlite') {
          expect(nulSnapshot).toEqual(definitionDocument('wf', trees.nulConfigConverted));
          expect(parses(nulSnapshot)).toBe(false);
        } else {
          expect(nulSnapshot).toEqual(definitionDocument('wf', trees.nulConfig));
          expect(parses(nulSnapshot)).toBe(false);
        }
        // Unconverted outcome: a row's own recorded `status: 'paused'` outcome with an opaque NUL elsewhere in the same text.
        // SQLite still rewrites it to `failed` with the named-pair reason; Postgres leaves it byte-identical, still
        // `status: 'paused'`, rejected only when read because the outcome codec no longer accepts that status.
        const { outcomes } = afterData();
        const pausedNulRow = (
          await rows(
            getCtx(),
            sql`SELECT outcome_text FROM execution_attempt WHERE execution_attempt_id = 'attempt-paused-nul'`,
          )
        )[0];
        if (dialect === 'sqlite') {
          expect(WorkflowRunResultSchema.parse(outcomes.get('attempt-paused-nul'))).toEqual({
            executionId: 'ev-done',
            workflowId: 'wf',
            status: 'failed',
            error: reasonPausedOutcome('approve', 'frame-approve-1'),
          });
        } else {
          const parsedOutcome = JSON.parse(String(pausedNulRow?.['outcome_text']));
          expect(parsedOutcome['status']).toBe('paused');
          expect(() => WorkflowRunResultSchema.parse(parsedOutcome)).toThrow();
        }
        // Observable count: only the NUL and surrogate probes remain in each class on Postgres;
        // SQLite leaves neither behind (count 0 for both).
        const instructionRows = await rows(
          getCtx(),
          sql`SELECT execution_attempt_id, instruction FROM execution_attempt
            WHERE execution_attempt_id IN ('attempt-nul-convertible', 'attempt-probe-pua', 'attempt-probe-literal', 'attempt-probe-surrogate')
            ORDER BY execution_attempt_id`,
        );
        const leftBehindInstructions = instructionRows.filter((row) => {
          const instruction: unknown = JSON.parse(String(row['instruction']));
          if (!isRecord(instruction) || !isRecord(instruction['workload'])) return false;
          if (instruction['workload']['kind'] !== 'workflow') return false;
          const snapshot = snapshotOf(instruction);
          if (!isRecord(snapshot) || !isRecord(snapshot['root'])) return false;
          const nodes = snapshot['root']['nodes'];
          return Array.isArray(nodes) && isRecord(nodes[0]) && isRecord(nodes[0]['gate']);
        });
        const outcomeRows = await rows(
          getCtx(),
          sql`SELECT execution_attempt_id, instruction, outcome_text FROM execution_attempt
            WHERE outcome_text IS NOT NULL ORDER BY execution_attempt_id`,
        );
        const leftBehindOutcomes = outcomeRows.filter((row) => {
          const instruction: unknown = JSON.parse(String(row['instruction']));
          const outcome: unknown = JSON.parse(String(row['outcome_text']));
          return (
            isRecord(instruction) &&
            isRecord(instruction['workload']) &&
            instruction['workload']['kind'] === 'workflow' &&
            isRecord(outcome) &&
            outcome['status'] === 'paused'
          );
        });
        expect(leftBehindInstructions.map((row) => String(row['execution_attempt_id'])).sort()).toEqual(
          dialect === 'postgres' ? ['attempt-nul-convertible', 'attempt-probe-surrogate'] : [],
        );
        expect(leftBehindOutcomes.map((row) => String(row['execution_attempt_id'])).sort()).toEqual(
          dialect === 'postgres' ? ['attempt-paused-nul', 'attempt-paused-surrogate'] : [],
        );
        for (const [suffix, note] of [
          ['pua', '\uE000'],
          ['literal', '\\u0000'],
          ['surrogate', '\uD800'],
        ] as const) {
          const retained = dialect === 'postgres' && suffix === 'surrogate';
          const expectedTree = sequence('root', [loopNode('probe', retained ? 'old' : 'new', { config: { note } })]);
          expect(snapshotOf(instructions.get(`attempt-probe-${suffix}`))).toEqual(
            definitionDocument('wf', expectedTree),
          );
          expect(parses(snapshotOf(instructions.get(`attempt-probe-${suffix}`)))).toBe(false);
          expect(outcomes.get(`attempt-paused-${suffix}`)).toEqual(
            retained
              ? {
                  executionId: 'ev-done',
                  workflowId: 'wf',
                  status: 'paused',
                  pausedAtGateId: 'approve',
                  pausedAtFrameId: 'frame-approve-1',
                  note,
                }
              : {
                  executionId: 'ev-done',
                  workflowId: 'wf',
                  status: 'failed',
                  error: reasonPausedOutcome('approve', 'frame-approve-1'),
                },
          );
        }
        // A foreign workload owner's own `status: 'paused'` field and its opaque NUL stay byte-identical: the
        // outcome migration is bound to `instruction.workload.kind = 'workflow'` of the same row.
        const foreignNulAfter = (
          await rows(
            getCtx(),
            sql`SELECT instruction, outcome_text FROM execution_attempt WHERE execution_attempt_id = 'attempt-foreign-nul'`,
          )
        )[0];
        expect(foreignNulAfter?.['instruction']).toBe(foreignNulBefore?.instruction);
        expect(foreignNulAfter?.['outcome_text']).toBe(foreignNulBefore?.outcomeText);
      },
    );

    it('a foreign owner without any NUL stays byte-identical, isolated from the NUL cases', async () => {
      const foreignCleanAfter = (
        await rows(
          getCtx(),
          sql`SELECT instruction, outcome_text FROM execution_attempt WHERE execution_attempt_id = 'attempt-foreign-outcome-clean'`,
        )
      )[0];
      expect(foreignCleanAfter?.['instruction']).toBe(foreignOutcomeCleanBefore?.instruction);
      expect(foreignCleanAfter?.['outcome_text']).toBe(foreignOutcomeCleanBefore?.outcomeText);
    });

    it('rewrites a stored paused outcome as a failed result with the named-pair reason, and keeps other outcomes', () => {
      const { outcomes } = afterData();
      const rewritten = WorkflowRunResultSchema.parse(outcomes.get('attempt-ev-status'));
      expect(rewritten).toEqual({
        executionId: 'ev-status',
        workflowId: 'wf',
        status: 'failed',
        error: reasonPausedOutcome('approve', 'ev-status:gate'),
      });
      expect(outcomes.get('attempt-snap-plain')).toEqual({
        executionId: 'snap-plain',
        workflowId: 'wf',
        status: 'completed',
      });
    });

    it('a reason with a space and a backslash in each identifier round-trips byte-exactly', () => {
      const { outcomes } = afterData();
      const trickyRewritten = WorkflowRunResultSchema.parse(outcomes.get('attempt-ev-tricky'));
      expect(trickyRewritten).toEqual({
        executionId: 'ev-tricky',
        workflowId: 'wf',
        status: 'failed',
        error: reasonPausedOutcome('approve this one\\please', 'ev-tricky:gate frame'),
      });
    });

    it('leaves no session object of the migration behind', async () => {
      const query =
        dialect === 'postgres'
          ? sql`SELECT proname AS name FROM pg_proc
              WHERE pronamespace = pg_my_temp_schema()
                AND proname IN ('waiting_removal_has_nul_escape', 'waiting_removal_parse_jsonb',
                  'waiting_removal_node_blocked', 'waiting_removal_convert_loops')`
          : sql`SELECT name FROM sqlite_temp_master
              WHERE name IN ('waiting_removal_documents', 'waiting_removal_nodes', 'waiting_removal_rewrites')`;
      expect(await rows(getCtx(), query)).toEqual([]);
    });

    describe('after the rest of the chain and through the real storage handlers', () => {
      let bus: ReturnType<typeof createBusInstance>;
      let cleanup: (() => void) | undefined;

      beforeAll(async () => {
        const ctx = getCtx();
        await applyMigrations(ctx.db, chain.slice(dataIndex + 1));
        bus = createBusInstance();
        bus.registerNamespace(WorkflowNamespace);
        bus.registerNamespace(WorkflowStorageNamespace);
        cleanup = registerDrizzleWorkflowStorage(bus, ctx.db);
      });

      afterAll(() => {
        cleanup?.();
      });

      it('drops nothing: the gate tables, the legacy columns and every gate row are still there', async () => {
        const ctx = getCtx();
        expect(await columnNames(ctx, 'workflow_gate_instances')).toContain('execution_attempt_id');
        expect(await columnNames(ctx, 'worklog_gate_events')).toContain('frame_id');
        expect(await columnNames(ctx, 'workflow_definitions')).toContain('canvas_layout');
        const runContextColumns = await columnNames(ctx, 'workflow_run_contexts');
        expect(runContextColumns).toContain('suspension_strategy');
        expect(runContextColumns).toContain('dispatch_metadata');
        expect(runContextColumns).toContain('definition_snapshot');
        expect(await retainedCounts(ctx)).toEqual(countsAfterData);
      });

      it('keeps every definition, snapshot, instruction and outcome exactly as the data migration left it', async () => {
        const after = await readDocuments(getCtx());
        expect(after.definitions).toEqual(afterData().definitions);
        expect(after.snapshots).toEqual(afterData().snapshots);
        expect(after.instructions).toEqual(afterData().instructions);
        expect(after.outcomes).toEqual(afterData().outcomes);
        expect(
          await rows(getCtx(), sql`SELECT id FROM workflow_executions WHERE status = 'failed' ORDER BY id`),
        ).toHaveLength(11);
      });

      it('answers the span read of a migrated paused run without the retained gate span', async () => {
        const { spans } = await bus.request(WorkflowStorageSubjects.listSpans, { executionId: 'par' });
        expect(spans.map((span) => [span.frameId, span.status]).sort()).toEqual([
          ['par:done', 'completed'],
          ['par:sibling', 'failed'],
        ]);
        expect(spans.find((span) => span.frameId === 'par:sibling')?.durationMs).toBeUndefined();
      });

      it('answers engine frame reads without the retained gate frame', async () => {
        await expect(bus.request(WorkflowStorageSubjects.getFrame, { frameId: 'par:gate' })).resolves.toEqual({
          frame: null,
        });
        const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId: 'par' });
        expect(frames.some((frame) => frame.frameId === 'par:gate')).toBe(false);
      });

      it('reads a retained gate frame as absent instead of failing', async () => {
        await expect(bus.request(WorkflowSubjects.worklog.frame.get, { frameId: 'par:gate' })).resolves.toEqual({
          frame: null,
        });
      });

      it('lists the readable definition and rejects historical loop handlers with a reason', async () => {
        const { workflows, rejected } = await bus.request(WorkflowStorageSubjects.list, {});
        expect(workflows.map((workflow) => workflow.id)).toEqual(['def-plain']);
        const storedLayout = (
          await rows(getCtx(), sql`SELECT canvas_layout FROM workflow_definitions WHERE id = 'def-convertible'`)
        )[0]?.['canvas_layout'];
        expect(parseJson(storedLayout)).toEqual({ a: { x: 1 } });
        expect(rejected.map((entry) => entry.id).sort()).toEqual(['def-convertible', ...rejectedIds].sort());
        for (const entry of rejected) expect(entry.reason, entry.id).not.toBe('');
        expect(rejected.find((entry) => entry.id === 'def-unknown-node-key')?.reason).toContain('label');
        expect(rejected.find((entry) => entry.id === 'def-convertible')?.reason).toContain('check');
        await expect(bus.request(WorkflowStorageSubjects.get, { id: 'def-convertible' })).rejects.toSatisfy(
          isDefinitionInvalidError,
        );
      });

      it('settles an external execution whose gate registration binding was cleared, without a frame', async () => {
        await expect(
          bus.request(WorkflowStorageSubjects.settleExternalExecution, {
            executionId: 'wfx-ext-gate-running',
            status: 'completed',
            completedAt,
          }),
        ).resolves.toEqual({ success: true });
        await expect(
          bus.request(WorkflowSubjects.worklog.get, { executionId: 'wfx-ext-gate-running' }),
        ).resolves.toMatchObject({
          summary: { status: 'completed' },
        });
      });

      it('settles an external execution through its retained registration frame', async () => {
        await expect(
          bus.request(WorkflowStorageSubjects.settleExternalExecution, {
            executionId: 'wfx-ext-code',
            status: 'completed',
            completedAt,
          }),
        ).resolves.toEqual({ success: true });
        await expect(
          bus.request(WorkflowSubjects.worklog.frame.get, { frameId: 'wfx-ext-code:registration' }),
        ).resolves.toMatchObject({
          frame: { executionId: 'wfx-ext-code', status: 'completed', completedAt, durationMs: completedAt - startedAt },
        });
      });
    });
  });
});
