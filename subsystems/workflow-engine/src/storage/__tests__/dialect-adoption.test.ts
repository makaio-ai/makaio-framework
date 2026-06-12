import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { createTestBusInstance, expectSubjectHandlerLifecycle, makeStubExtensionContext } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';
import { workflowEngineSchema } from '../schema.variants.js';
import { WorkflowStorageSubjects } from '../namespace.js';
import { registerDrizzleWorkflowStorage } from '../handler.js';
import {
  workflowDefinitions,
  workflowExecutions,
  workflowExecutionFrames,
  workflowGateInstances,
  workflowStepSpans,
  workflowExecutionLinks,
  workflowRunContexts,
  worklogSummaries,
  worklogFrameEntries,
  worklogArtifactWrites,
  worklogGateEvents,
} from '../schema.js';

describe('workflow-engine dialect adoption', () => {
  it('resolves the postgres twins for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, workflowEngineSchema);
    expect(resolved).toBe(workflowEngineSchema.postgres);
    expect(is(resolved.workflowDefinitions, PgTable)).toBe(true);
    expect(is(resolved.workflowExecutions, PgTable)).toBe(true);
    expect(is(resolved.workflowExecutionFrames, PgTable)).toBe(true);
    expect(is(resolved.workflowGateInstances, PgTable)).toBe(true);
    expect(is(resolved.workflowStepSpans, PgTable)).toBe(true);
    expect(is(resolved.workflowExecutionLinks, PgTable)).toBe(true);
    expect(is(resolved.workflowRunContexts, PgTable)).toBe(true);
    expect(is(resolved.worklogSummaries, PgTable)).toBe(true);
    expect(is(resolved.worklogFrameEntries, PgTable)).toBe(true);
    expect(is(resolved.worklogArtifactWrites, PgTable)).toBe(true);
    expect(is(resolved.worklogGateEvents, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite tables for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), workflowEngineSchema);
    expect(resolved).toBe(workflowEngineSchema.sqlite);
    expect(resolved.workflowDefinitions).toBe(workflowDefinitions);
    expect(resolved.workflowExecutions).toBe(workflowExecutions);
    expect(resolved.workflowExecutionFrames).toBe(workflowExecutionFrames);
    expect(resolved.workflowGateInstances).toBe(workflowGateInstances);
    expect(resolved.workflowStepSpans).toBe(workflowStepSpans);
    expect(resolved.workflowExecutionLinks).toBe(workflowExecutionLinks);
    expect(resolved.workflowRunContexts).toBe(workflowRunContexts);
    expect(resolved.worklogSummaries).toBe(worklogSummaries);
    expect(resolved.worklogFrameEntries).toBe(worklogFrameEntries);
    expect(resolved.worklogArtifactWrites).toBe(worklogArtifactWrites);
    expect(resolved.worklogGateEvents).toBe(worklogGateEvents);
  });

  it('registers exactly one handler per storage subject on an isolated bus and cleanup removes them', async () => {
    // createPgBrandedTestDb's executor records statements instead of
    // executing them, so a live set/get round-trip is impossible here. Full
    // round-trip coverage lives in
    // src/__tests__/workflow-run-context.test.ts (SQLite) and in the storage
    // conformance suite, which runs these handlers against live Postgres in
    // CI. This case proves the registration path adopts the pg-branded
    // handle: registerDrizzleWorkflowStorage resolves the Postgres twins via
    // the real resolveSchema seam and subscribes every workflow storage
    // subject on a bus isolated from the process-global singleton.
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(bus);
    // Every concrete subject in the namespace is registered by
    // registerDrizzleWorkflowStorage; only the $all wildcard accessor is not
    // an individually subscribable storage subject.
    const subjects = Object.values(WorkflowStorageSubjects).filter((subject) => subject.subject !== '*');

    expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleWorkflowStorage(bus, db, ctx));
  });
});
