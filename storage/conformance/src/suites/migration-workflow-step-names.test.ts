/**
 * Conformance for the workflow step-name data migration.
 *
 * The same cases run against file-backed SQLite and, with
 * `MAKAIO_STORAGE_TEST_DIALECT=postgres` and `MAKAIO_STORAGE_TEST_URL`, against
 * live PostgreSQL. The context is created WITHOUT the central chain: the test
 * applies every migration before the target, seeds rows in the legacy node
 * vocabulary, applies the target migration, and asserts the rewritten rows.
 *
 * Covered: structural rewriting at the node positions of the definition schema
 * only (opaque payload that looks like a node stays untouched), the handler
 * source rule (definition-dispatched versus module-dispatched, including a
 * `kind`-less non-null `executable_source` treated like SQL NULL is NOT on
 * Postgres), rows that stay legacy and are rejected through REAL storage
 * `get`/`list` loading (not `safeParse`) — the delegate-agent rule and the
 * undecidable role-station rule proved independently of each other —
 * frame/span/WorkLog rows, a foreign attempt row whose instruction text
 * contains an escaped NUL (PostgreSQL's `::jsonb` cast must not abort the
 * migration while scanning it), and the external settlement fingerprint
 * through the real settlement replay.
 */
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { createBusInstance } from '@makaio/bus-core';
import { isDefinitionInvalidError, WorkflowDefinitionSchema, WorkflowNamespace } from '@makaio/contracts';
import {
  registerDrizzleWorkflowStorage,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
} from '@makaio/subsystem-workflow-engine';
import type { MakaioDatabase, StorageDialect } from '@makaio/storage-drizzle';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import { readCentralChain } from '../harness/chains.js';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

/** Suffix of the target migration tag; the numeric prefix comes from the generator. */
const TARGET_SUFFIX = '_workflow_step_names';
const startedAt = 1_000;
const completedAt = 1_250;

/** Which dispatch the stored row belongs to: handlers absent (`definition`) or taken from a module (`source`). */
type Dispatch = 'definition' | 'source';
/** Whether a tree is written in the legacy vocabulary or in the expected migrated form. */
type Form = 'legacy' | 'migrated';

/** Opaque JSON that looks like nodes but sits outside every node position. */
const opaquePayload = {
  body: { id: 'payload-station', type: 'station', prompt: 'opaque' },
  branches: { x: { id: 'payload-branch', type: 'station', prompt: 'opaque' } },
  nodes: [{ id: 'payload-node', type: 'delegate-role', role: 'r', prompt: 'p' }],
};

/**
 * Build a station without a role (becomes a code step in every row).
 * @param id - Node identifier.
 * @param form - Legacy or migrated vocabulary.
 * @returns Node JSON.
 */
function codeNode(id: string, form: Form) {
  return form === 'legacy' ? { id, type: 'station', prompt: id } : { id, type: 'code-step' };
}

/**
 * Build a station with a role (an agent step for definition dispatch; unchanged for module dispatch,
 * where the module's handlers decide).
 * @param id - Node identifier.
 * @param form - Legacy or migrated vocabulary.
 * @param dispatch - Dispatch of the row holding the tree.
 * @returns Node JSON.
 */
function roleStation(id: string, form: Form, dispatch: Dispatch) {
  const migrated = form === 'migrated' && dispatch === 'definition';
  return { id, type: migrated ? 'agent-step' : 'station', prompt: 'p', role: 'reviewer', completion: 'turn' };
}

/**
 * Build a delegate-role node (becomes an agent step everywhere).
 * @param id - Node identifier.
 * @param form - Legacy or migrated vocabulary.
 * @returns Node JSON.
 */
function roleNode(id: string, form: Form) {
  return { id, type: form === 'legacy' ? 'delegate-role' : 'agent-step', role: 'reviewer', prompt: 'p' };
}

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
 * Build the fixture tree: every node position of the schema (root, sequence nodes, parallel branch with a
 * dotted key, iterate, iterate-chain and loop bodies), every node kind the migration rewrites or leaves alone,
 * and opaque payload.
 * @param form - Legacy or migrated vocabulary.
 * @param dispatch - Dispatch of the row holding the tree.
 * @returns Root sequence JSON.
 */
function buildTree(form: Form, dispatch: Dispatch) {
  const schemaStep =
    form === 'legacy'
      ? { id: 'schema', type: 'station', prompt: 'schema', outputSchema: opaquePayload }
      : { id: 'schema', type: 'code-step', outputSchema: opaquePayload };
  return sequence('root', [
    codeNode('code', form),
    roleStation('agent', form, dispatch),
    roleNode('role', form),
    { id: 'legacy-agent', type: 'delegate-agent', agentId: 'a', inputExpression: '{}' },
    {
      id: 'fan',
      type: 'parallel',
      branches: {
        'a.b': sequence('fan-ab', [codeNode('fan-code', form)]),
        c: sequence('fan-c', [roleNode('fan-role', form)]),
      },
    },
    { id: 'each', type: 'iterate', collection: 'items', body: sequence('each-body', [codeNode('each-code', form)]) },
    {
      id: 'chain',
      type: 'iterate-chain',
      collection: 'items',
      body: sequence('chain-body', [roleStation('chain-agent', form, dispatch)]),
    },
    {
      id: 'rounds',
      type: 'loop',
      maxRounds: 2,
      body: sequence('rounds-body', [codeNode('rounds-code', form)]),
      check: { handler: 'check', config: opaquePayload },
    },
    schemaStep,
  ]);
}

/** A tree without any station or delegate node; the migration must leave its row byte-identical. */
const untouchedTree = sequence('root', [{ id: 'g', type: 'code-step' }]);

/**
 * Wrap a tree into a stored definition document.
 * @param id - Workflow identifier.
 * @param root - Root sequence JSON.
 * @returns Definition JSON.
 */
function definitionDocument(id: string, root: unknown) {
  return { id, name: id, root, scope: { type: 'global' } };
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
 * Read a JSON column value that the driver returns as text (SQLite, text columns) or parsed (jsonb).
 * @param value - Raw column value.
 * @returns Parsed JSON.
 */
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Create an isolated bus backed by one database handle.
 * @param db - Database handle used by the storage handlers.
 * @returns Bus and its cleanup.
 */
function createWorkflowStorageBus(db: MakaioDatabase) {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const cleanup = registerDrizzleWorkflowStorage(bus, db);
  return { bus, cleanup };
}

/**
 * Build the running frame of an external registration in the new vocabulary.
 * @param executionId - External execution identifier.
 * @param nodeType - Frame node type.
 * @returns Running frame.
 */
function runningFrame(executionId: string, nodeType: 'code-step' | 'agent-step') {
  const frameId = `${executionId}:step`;
  return {
    executionId,
    frameId,
    nodeId: 'step',
    nodeType,
    path: [frameId],
    status: 'running' as const,
    attempt: 0,
    startedAt,
  };
}

/**
 * Build the terminal frame of an external settlement in the new vocabulary.
 * @param executionId - External execution identifier.
 * @param nodeType - Frame node type.
 * @returns Completed frame.
 */
function completedFrame(executionId: string, nodeType: 'code-step' | 'agent-step') {
  return {
    ...runningFrame(executionId, nodeType),
    status: 'completed' as const,
    completedAt,
    durationMs: completedAt - startedAt,
  };
}

/** One external execution case: how registration and settlement carry the frame. */
interface ExternalCase {
  readonly id: string;
  readonly nodeType: 'code-step' | 'agent-step';
  readonly registerFrame: boolean;
  readonly settleFrame: boolean;
}

const externalCases: readonly ExternalCase[] = [
  { id: 'wfx-ext-w1', nodeType: 'code-step', registerFrame: true, settleFrame: true },
  { id: 'wfx-ext-w2', nodeType: 'code-step', registerFrame: false, settleFrame: true },
  { id: 'wfx-ext-w3', nodeType: 'code-step', registerFrame: true, settleFrame: false },
  { id: 'wfx-ext-w4', nodeType: 'agent-step', registerFrame: true, settleFrame: true },
];

/**
 * Build the registration request of an external case.
 * @param testCase - External case.
 * @returns Registration request for `setExternalExecutionStart`.
 */
function registrationOf(testCase: ExternalCase) {
  return {
    execution: {
      id: testCase.id,
      workflowId: 'conformance-external-workflow',
      status: 'running' as const,
      inputs: {},
      startedAt,
      scope: { type: 'global' as const },
    },
    ...(testCase.registerFrame ? { frame: runningFrame(testCase.id, testCase.nodeType) } : {}),
  };
}

/**
 * Build the settlement request of an external case.
 * @param testCase - External case.
 * @returns Settlement request for `settleExternalExecution`.
 */
function settlementOf(testCase: ExternalCase) {
  return {
    executionId: testCase.id,
    status: 'completed' as const,
    completedAt,
    ...(testCase.settleFrame ? { frame: completedFrame(testCase.id, testCase.nodeType) } : {}),
  };
}

describeStorageConformance('workflow step-name data migration', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });
  const describePg = config.dialect === 'postgres' ? describe : describe.skip;
  const dialect = config.dialect;
  const fingerprints = new Map<string, string>();

  /**
   * Insert one engine execution with its run context and frames in all three tables.
   * @param ctx - Database context.
   * @param executionId - Execution identifier (also used as workflow identifier suffix).
   * @param workflowId - Workflow identifier.
   * @param sourceKind - `definition` or `path`.
   * @param nodes - Frame rows as `[nodeId, legacyNodeType]`.
   */
  async function seedEngineExecution(
    ctx: StorageDatabaseContext,
    executionId: string,
    workflowId: string,
    sourceKind: 'definition' | 'path',
    nodes: ReadonlyArray<readonly [string, string]>,
  ): Promise<void> {
    const dispatch: Dispatch = sourceKind === 'definition' ? 'definition' : 'source';
    const snapshot = definitionDocument(workflowId, buildTree('legacy', dispatch));
    await ctx.executor.run(sql`
      INSERT INTO workflow_executions (id, workflow_id, status, started_at, scope_type)
      VALUES (${executionId}, ${workflowId}, 'completed', ${startedAt}, 'global')`);
    await ctx.executor.run(sql`
      INSERT INTO workflow_run_contexts (
        execution_id, workflow_id, coordinator_session_id, source_kind, definition_snapshot,
        worker_manifest, trigger_payload, cancel_subject, env, created_at)
      VALUES (
        ${executionId}, ${workflowId}, 'session', ${sourceKind}, ${jsonValue(dialect, snapshot)},
        ${jsonValue(dialect, { contributionRefs: [] })}, ${jsonValue(dialect, {})}, 'cancel', ${jsonValue(dialect, {})},
        ${startedAt})`);
    for (const [nodeId, nodeType] of nodes) {
      const frameId = `${executionId}:${nodeId}`;
      await ctx.executor.run(sql`
        INSERT INTO workflow_execution_frames (frame_id, execution_id, node_id, node_type, path)
        VALUES (${frameId}, ${executionId}, ${nodeId}, ${nodeType}, ${jsonValue(dialect, [frameId])})`);
      await ctx.executor.run(sql`
        INSERT INTO workflow_step_spans (execution_id, frame_id, step_id, step_type, status)
        VALUES (${executionId}, ${frameId}, ${nodeId}, ${nodeType}, 'completed')`);
      await ctx.executor.run(sql`
        INSERT INTO worklog_frame_entries (frame_id, execution_id, node_id, node_type, path, status)
        VALUES (${frameId}, ${executionId}, ${nodeId}, ${nodeType}, ${jsonValue(dialect, [frameId])}, 'completed')`);
    }
  }

  /**
   * Read the node types of one execution from one table, keyed by node identifier.
   * @param ctx - Database context.
   * @param table - Table to read.
   * @param executionId - Execution identifier.
   * @returns Map of node identifier to node type.
   */
  async function readNodeTypes(
    ctx: StorageDatabaseContext,
    table: 'workflow_execution_frames' | 'workflow_step_spans' | 'worklog_frame_entries',
    executionId: string,
  ): Promise<Record<string, string>> {
    const rows =
      table === 'workflow_step_spans'
        ? await ctx.executor.all<{ node_id: string; node_type: string }>(
            sql`
              SELECT step_id AS node_id, step_type AS node_type
              FROM workflow_step_spans
              WHERE execution_id = ${executionId}`,
          )
        : await ctx.executor.all<{ node_id: string; node_type: string }>(
            sql`SELECT node_id, node_type FROM ${sql.identifier(table)} WHERE execution_id = ${executionId}`,
          );
    return Object.fromEntries(rows.map((row) => [row.node_id, row.node_type]));
  }

  it('rewrites node trees, frames and settlement fingerprints and leaves everything else untouched', async () => {
    const ctx = getCtx();
    const chain = readCentralChain(dialect);
    const targetIndex = chain.findIndex((migration) => migration.tag.endsWith(TARGET_SUFFIX));
    expect(targetIndex).toBeGreaterThan(0);
    await applyMigrations(ctx.db, chain.slice(0, targetIndex));

    // Definitions: handler-less, module-backed, and one without any rewritable node.
    // A role station with no delegate-agent node, so its rejection is isolated proof of the undecidable
    // role-station rule on its own, separate from the delegate-agent rejection below. Two further source objects
    // must NOT be treated as definition dispatch on either dialect: one with no `kind` key at all, and one
    // with an explicit `kind: null` (a JSON null value for the key, distinct from an absent key); only SQL
    // NULL or `kind: 'definition'` may select definition dispatch.
    const roleStationOnlyTree = sequence('root', [roleStation('agent', 'legacy', 'source')]);
    for (const [id, source, tree] of [
      ['wf-definition', null, buildTree('legacy', 'definition')],
      ['wf-source', { kind: 'path', path: '/w/flow.ts' }, buildTree('legacy', 'source')],
      ['wf-role-station-only', { kind: 'path', path: '/w/role-station-only.ts' }, roleStationOnlyTree],
      ['wf-source-no-kind', {}, buildTree('legacy', 'source')],
      ['wf-source-null-kind', { kind: null, path: '/w/flow-null.ts' }, buildTree('legacy', 'source')],
      ['wf-untouched', null, untouchedTree],
      ['wf-migratable', null, sequence('root', [codeNode('code', 'legacy')])],
    ] as const) {
      await ctx.executor.run(sql`
        INSERT INTO workflow_definitions (id, name, root, executable_source, scope_type, created_at, updated_at)
        VALUES (${id}, ${id}, ${jsonValue(dialect, tree)},
          ${source === null ? sql`NULL` : jsonValue(dialect, source)}, 'global', ${startedAt}, ${startedAt})`);
    }
    const untouchedBefore = await ctx.executor.all<{ root: unknown }>(
      sql`SELECT root FROM workflow_definitions WHERE id = 'wf-untouched'`,
    );

    // Engine executions (run snapshots in both dispatch kinds) with frames, spans and WorkLog rows.
    await seedEngineExecution(ctx, 'exec-definition', 'wf-definition', 'definition', [
      ['code', 'station'],
      ['agent', 'station'],
      ['role', 'delegate-role'],
      ['legacy-agent', 'delegate-agent'],
      ['missing', 'station'],
    ]);
    await seedEngineExecution(ctx, 'exec-source', 'wf-source', 'path', [
      ['code', 'station'],
      ['agent', 'station'],
    ]);

    // An execution without a run-context snapshot: the current definition of the workflow is no proof
    // about what ran, so its station frame stays legacy even though 'code' exists in wf-definition.
    await ctx.executor.run(sql`
      INSERT INTO workflow_executions (id, workflow_id, status, started_at, scope_type)
      VALUES ('exec-nosnapshot', 'wf-definition', 'completed', ${startedAt}, 'global')`);
    await ctx.executor.run(sql`
      INSERT INTO worklog_frame_entries (frame_id, execution_id, node_id, node_type, path, status)
      VALUES ('exec-nosnapshot:code', 'exec-nosnapshot', 'code', 'station',
        ${jsonValue(dialect, ['exec-nosnapshot:code'])}, 'completed')`);

    // Attempt instructions: a workflow workload per dispatch and a foreign workload that merely contains a node.
    const instruction = (kind: string, sourceKind: string, tree: unknown) =>
      JSON.stringify({
        workload: {
          kind,
          version: 1,
          input: {
            source: { kind: sourceKind, workflowId: 'wf-definition' },
            definitionSnapshot: definitionDocument('wf-definition', tree),
            root: tree,
          },
        },
      });
    // The foreign row's text embeds an escaped NUL: PostgreSQL's `::jsonb` cast
    // rejects `\u0000` unconditionally, so this value is valid JSON text that a `::jsonb` cast cannot
    // decode. It proves the migration does not abort while scanning unrelated rows for the 'workflow' kind.
    const foreignInstructionText = JSON.stringify({
      workload: {
        kind: 'other',
        note: 'unrelated workload with an escaped NUL: \u0000',
        root: buildTree('legacy', 'definition'),
      },
    });
    const attempts = [
      ['attempt-definition', instruction('workflow', 'definition', buildTree('legacy', 'definition'))],
      ['attempt-source', instruction('workflow', 'path', buildTree('legacy', 'source'))],
      ['attempt-foreign', foreignInstructionText],
    ] as const;
    for (const [id, text] of attempts) {
      await ctx.executor.run(sql`
        INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, created_at)
        VALUES (${id}, 'exec-definition', ${text}, 'pending', '2026-01-01T00:00:00.000Z')`);
    }

    // External executions: written by the REAL handlers in the new vocabulary, then aged to the legacy names.
    const storage = createWorkflowStorageBus(ctx.db);
    try {
      for (const testCase of externalCases) {
        await storage.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registrationOf(testCase));
        await storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlementOf(testCase));
      }
      const written = await ctx.executor.all<{ id: string; external_settlement_fingerprint: string }>(
        sql`SELECT id, external_settlement_fingerprint FROM workflow_executions WHERE id LIKE 'wfx-ext-%'`,
      );
      for (const row of written) fingerprints.set(row.id, row.external_settlement_fingerprint);
      await ctx.executor.run(sql`
        UPDATE workflow_executions
        SET external_settlement_fingerprint = replace(replace(external_settlement_fingerprint,
          '"nodeType":"code-step"', '"nodeType":"station"'), '"nodeType":"agent-step"', '"nodeType":"delegate-role"')
        WHERE id LIKE 'wfx-ext-%'`);
      await ctx.executor.run(sql`
        UPDATE worklog_frame_entries
        SET node_type = CASE node_type
          WHEN 'code-step' THEN 'station'
          WHEN 'agent-step' THEN 'delegate-role'
          ELSE node_type
        END
        WHERE execution_id LIKE 'wfx-ext-%'`);
      const aged = await ctx.executor.all<{ external_settlement_fingerprint: string }>(
        sql`SELECT external_settlement_fingerprint FROM workflow_executions WHERE id = 'wfx-ext-w1'`,
      );
      expect(aged[0]?.external_settlement_fingerprint).toContain('"nodeType":"station"');

      await applyMigrations(ctx.db, [chain[targetIndex]!]);

      // Trees: structural equality at the node positions; opaque payload unchanged;
      // undecidable legacy nodes stay legacy.
      const definitions = await ctx.executor.all<{ id: string; root: unknown }>(
        sql`SELECT id, root FROM workflow_definitions ORDER BY id`,
      );
      const byId = new Map(definitions.map((row) => [row.id, parseJson(row.root)]));
      expect(byId.get('wf-definition')).toEqual(buildTree('migrated', 'definition'));
      expect(byId.get('wf-source')).toEqual(buildTree('migrated', 'source'));
      // A `kind`-less, non-null executable_source is NOT definition dispatch on either dialect: the role
      // station stays ambiguous, exactly like 'wf-source'.
      expect(byId.get('wf-source-no-kind')).toEqual(buildTree('migrated', 'source'));
      // An explicit `kind: null` is likewise not `'definition'`: the role station stays ambiguous.
      expect(byId.get('wf-source-null-kind')).toEqual(buildTree('migrated', 'source'));
      // The isolated module-dispatched role-station fixture carries no delegate-agent node at all.
      expect(byId.get('wf-role-station-only')).toEqual(roleStationOnlyTree);
      expect(byId.get('wf-untouched')).toEqual(parseJson(untouchedBefore[0]?.root));
      if (dialect === 'sqlite') {
        // SQLite stores the text verbatim: a row without a target node is not rewritten at all.
        const untouchedAfter = await ctx.executor.all<{ root: unknown }>(
          sql`SELECT root FROM workflow_definitions WHERE id = 'wf-untouched'`,
        );
        expect(untouchedAfter[0]?.root).toBe(untouchedBefore[0]?.root);
      }

      const runs = await ctx.executor.all<{ execution_id: string; definition_snapshot: unknown }>(
        sql`SELECT execution_id, definition_snapshot FROM workflow_run_contexts ORDER BY execution_id`,
      );
      const snapshots = new Map(runs.map((row) => [row.execution_id, parseJson(row.definition_snapshot)]));
      expect(snapshots.get('exec-definition')).toEqual(
        definitionDocument('wf-definition', buildTree('migrated', 'definition')),
      );
      expect(snapshots.get('exec-source')).toEqual(definitionDocument('wf-source', buildTree('migrated', 'source')));

      const instructions = await ctx.executor.all<{ execution_attempt_id: string; instruction: string }>(
        sql`SELECT execution_attempt_id, instruction FROM execution_attempt ORDER BY execution_attempt_id`,
      );
      const attemptsAfter = new Map(instructions.map((row) => [row.execution_attempt_id, row.instruction]));
      const workflowInput = (id: string) => {
        const parsed = parseJson(attemptsAfter.get(id)) as { workload: { input: Record<string, unknown> } };
        return parsed.workload.input;
      };
      expect(workflowInput('attempt-definition')['definitionSnapshot']).toEqual(
        definitionDocument('wf-definition', buildTree('migrated', 'definition')),
      );
      // Outside the definition snapshot nothing changes, even where the JSON looks like a legacy tree.
      expect(workflowInput('attempt-definition')['root']).toEqual(buildTree('legacy', 'definition'));
      expect(workflowInput('attempt-source')['definitionSnapshot']).toEqual(
        definitionDocument('wf-definition', buildTree('migrated', 'source')),
      );
      expect(attemptsAfter.get('attempt-foreign')).toBe(attempts[2][1]);

      // The rewritten 'wf-definition' tree WOULD parse once its permanent delegate-agent node is removed:
      // a structural sanity check, not a storage assertion (the stripped shape is never written).
      const parses = (id: string, root: unknown): boolean =>
        WorkflowDefinitionSchema.safeParse(definitionDocument(id, root)).success;
      expect(parses('wf-definition', stripLegacyAgent(byId.get('wf-definition')))).toBe(true);

      // Visible rejection through REAL storage loading, not `safeParse`: a rejected row stays listed as
      // `rejected` and keeps its stored column, a readable row is listed and gettable. `not.toContain` is
      // asserted per ID (not `not.toEqual(expect.arrayContaining(...))`, which would still pass if one or
      // two of these rejected IDs incorrectly appeared among the readable workflows).
      const listed = await storage.bus.request(WorkflowStorageSubjects.list, {});
      const readableIds = listed.workflows.map((workflow) => workflow.id);
      expect(readableIds).toContain('wf-migratable');
      await expect(storage.bus.request(WorkflowStorageSubjects.get, { id: 'wf-migratable' })).resolves.toMatchObject({
        workflow: { id: 'wf-migratable', root: sequence('root', [codeNode('code', 'migrated')]) },
      });
      const rejectedIds = [
        'wf-definition',
        'wf-source',
        'wf-role-station-only',
        'wf-source-no-kind',
        'wf-source-null-kind',
      ];
      expect(readableIds).toContain('wf-untouched');
      for (const id of rejectedIds) expect(readableIds).not.toContain(id);
      const actualRejectedIds = listed.rejected.map((entry) => entry.id);
      for (const id of rejectedIds) expect(actualRejectedIds).toContain(id);
      await expect(storage.bus.request(WorkflowStorageSubjects.get, { id: 'wf-untouched' })).resolves.toMatchObject({
        workflow: { id: 'wf-untouched' },
      });
      // 'wf-definition' is rejected by the permanent delegate-agent rule.
      await expect(storage.bus.request(WorkflowStorageSubjects.get, { id: 'wf-definition' })).rejects.toSatisfy(
        (error: unknown) => isDefinitionInvalidError(error) && (error as Error).message.includes('wf-definition'),
      );
      // 'wf-role-station-only' carries no delegate-agent node at all: its rejection is isolated proof of the
      // undecidable role-station rule on its own, separate from the delegate-agent rule above.
      await expect(storage.bus.request(WorkflowStorageSubjects.get, { id: 'wf-role-station-only' })).rejects.toSatisfy(
        (error: unknown) =>
          isDefinitionInvalidError(error) && (error as Error).message.includes('wf-role-station-only'),
      );
      // Rejected reads retain both the stored row and its migrated root unchanged.
      const afterRejectionReads = await ctx.executor.all<{ id: string; root: unknown }>(
        sql`SELECT id, root FROM workflow_definitions WHERE id IN ('wf-definition', 'wf-role-station-only') ORDER BY id`,
      );
      expect(afterRejectionReads.map((row) => row.id)).toEqual(['wf-definition', 'wf-role-station-only']);
      for (const row of afterRejectionReads) expect(parseJson(row.root)).toEqual(byId.get(row.id));

      // Frames, spans, WorkLog rows: delegate frames become agent steps, stations follow their node,
      // undecidable rows stay.
      const expectedDefinition = {
        code: 'code-step',
        agent: 'agent-step',
        role: 'agent-step',
        'legacy-agent': 'agent-step',
        missing: 'station',
      };
      const expectedSource = { code: 'code-step', agent: 'station' };
      for (const table of ['workflow_execution_frames', 'workflow_step_spans', 'worklog_frame_entries'] as const) {
        expect(await readNodeTypes(ctx, table, 'exec-definition')).toEqual(expectedDefinition);
        expect(await readNodeTypes(ctx, table, 'exec-source')).toEqual(expectedSource);
      }
      expect(await readNodeTypes(ctx, 'worklog_frame_entries', 'exec-nosnapshot')).toEqual({ code: 'station' });

      // External executions: the fingerprint is byte-identical to the one the real encoder wrote.
      const migrated = await ctx.executor.all<{ id: string; external_settlement_fingerprint: string }>(
        sql`SELECT id, external_settlement_fingerprint FROM workflow_executions WHERE id LIKE 'wfx-ext-%'`,
      );
      for (const row of migrated) expect(row.external_settlement_fingerprint).toBe(fingerprints.get(row.id));
      const worklog = await ctx.executor.all<{ execution_id: string; node_type: string }>(
        sql`SELECT execution_id, node_type FROM worklog_frame_entries WHERE execution_id LIKE 'wfx-ext-%'`,
      );
      for (const row of worklog) {
        const testCase = externalCases.find((candidate) => candidate.id === row.execution_id);
        expect(row.node_type).toBe(testCase?.nodeType);
      }

      // The real replay accepts the same settlement for all three completion paths and for delegate-role.
      for (const testCase of externalCases) {
        await expect(
          storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlementOf(testCase)),
        ).resolves.toEqual({ success: true });
      }
    } finally {
      storage.cleanup();
    }
  });

  describePg('postgres session objects', () => {
    it('leaves no helper function and no temporary table behind', async () => {
      const ctx = getCtx();
      const functions = await ctx.executor.all<{ name: string }>(
        sql`SELECT proname AS name FROM pg_proc WHERE proname = 'workflow_step_names_rewrite'`,
      );
      expect(functions).toEqual([]);
      const tables = await ctx.executor.all<{ name: string }>(
        sql`SELECT relname AS name FROM pg_class WHERE relname LIKE 'workflow_step_names_%'`,
      );
      expect(tables).toEqual([]);
    });
  });
});

/**
 * Remove the `delegate-agent` node, which the schema rejects by design, so the remainder can be parsed.
 * @param root - Migrated root JSON.
 * @returns Root JSON without the legacy agent node.
 */
function stripLegacyAgent(root: unknown): unknown {
  const tree = root as { nodes: Array<{ id: string }> };
  return { ...tree, nodes: tree.nodes.filter((node) => node.id !== 'legacy-agent') };
}
