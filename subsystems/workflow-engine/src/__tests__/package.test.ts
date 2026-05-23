import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { MakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import type { ExtensionService, NodeExtensionContext } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { z } from 'zod';
import { WorkflowNamespace, WorkflowSubjects } from '@makaio/contracts';
import { WorkflowEngineService } from '../workflow-engine-service.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { workflowEnginePackage, WorkflowEngineToken } from '../package.js';
import { createTestDb, createWorkflowDefinition, type TestDbContext } from './shared.js';

const { subjects: PackageLifecycleSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('workflowEnginePackageLifecycle', {
    changed: z.object({ id: z.string(), status: z.string() }),
  }),
);

function createNodeContext(): NodeExtensionContext<IMakaioBus> {
  return {
    ...makeStubExtensionContext(MakaioBus),
    bus: MakaioBus,
    platform: process.platform,
    homedir: '/tmp',
    makaioHome: '/tmp/.makaio-test',
    username: 'test',
  };
}

function expectWorkflowEngineService(service: ExtensionService | undefined): asserts service is WorkflowEngineService {
  expect(service).toBeInstanceOf(WorkflowEngineService);
}

describe('workflowEnginePackage', () => {
  let dbContext: TestDbContext | undefined;
  let service: WorkflowEngineService | undefined;
  let cleanupFns: Array<() => void> = [];

  afterEach(async () => {
    await service?.destroy();
    service = undefined;
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    dbContext?.cleanup();
    dbContext = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('declares namespace, storage migrations, and service factory', () => {
    expect(workflowEnginePackage.name).toBe(WorkflowEngineToken.name);
    expect(workflowEnginePackage.critical).toBe(true);
    expect(workflowEnginePackage.namespaces).toContain(WorkflowNamespace);
    expect(workflowEnginePackage.namespaces).toContain(WorkflowStorageNamespace);
    expect(workflowEnginePackage.storage?.migrations).toBe('drizzle');
    expect(workflowEnginePackage.storage?.migrationSourceId).toBe('subsystems/workflow-engine/src/drizzle');
    expect(workflowEnginePackage.create).toEqual(expect.any(Function));
  });

  it('uses the Drizzle storage manifest bridge', () => {
    expect(registerDrizzleHandlers).toEqual(expect.any(Function));
    expect(workflowEnginePackage.storage?.registerHandlers).toEqual(expect.any(Function));
  });

  it('creates the workflow engine lifecycle service', async () => {
    const created = await workflowEnginePackage.create?.(createNodeContext());

    expectWorkflowEngineService(created);
    await created.destroy();
  });

  it('initializes persisted bus-event triggers through the package service lifecycle', async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    const observedStarts: Array<{ workflowId: string; triggerPayload: Record<string, unknown> | undefined }> = [];
    cleanupFns.push(
      MakaioBus.on(
        WorkflowSubjects.start,
        (ctx) => {
          observedStarts.push({
            workflowId: ctx.payload.workflowId,
            triggerPayload: ctx.payload.triggerPayload,
          });
          ctx.setResult({ executionId: 'execution-from-package-lifecycle-test' });
        },
        { priority: 100 },
      ),
    );

    const workflow = createWorkflowDefinition({
      id: 'workflow-package-bus-event',
      triggers: [{ type: 'bus-event', subject: 'workflowEnginePackageLifecycle.changed' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const created = await workflowEnginePackage.create?.(createNodeContext());
    expectWorkflowEngineService(created);
    service = created;
    await service.init();

    const payload = { id: 'item-1', status: 'changed' };
    await MakaioBus.emit(PackageLifecycleSubjects.changed, payload);

    await vi.waitFor(() => expect(observedStarts).toHaveLength(1));
    expect(observedStarts[0]).toEqual({
      workflowId: workflow.id,
      triggerPayload: payload,
    });
  });

  it('initializes persisted cron triggers through the package service lifecycle', async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    const workflow = createWorkflowDefinition({
      id: 'workflow-package-cron',
      projectId: 'project-1',
      triggers: [{ type: 'cron', schedule: '* * * * *' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const created = await workflowEnginePackage.create?.(createNodeContext());
    expectWorkflowEngineService(created);
    service = created;
    await service.init();

    expect(service.cronTriggers.activeJobCount()).toBe(1);

    await service.destroy();

    expect(service.cronTriggers.activeJobCount()).toBe(0);
    service = undefined;
  });
});
