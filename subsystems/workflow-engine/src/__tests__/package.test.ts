import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { MakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import type { ExtensionService, ExtensionToken, NodeExtensionContext } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { z } from 'zod';
import {
  BUS_EVENT_AUTOMATION_TRIGGER_KIND,
  CRON_AUTOMATION_TRIGGER_KIND,
  WorkflowNamespace,
  WorkflowSubjects,
} from '@makaio/contracts';
import {
  AUTOMATION_TRIGGER_BUILTINS_OWNER,
  AutomationTriggerBindingRuntime,
  AutomationTriggerBindingRuntimeToken,
  AutomationTriggerRegistry,
  LocalAutomationCronScheduler,
  createBusEventAutomationTrigger,
  createCronAutomationTrigger,
} from '@makaio/services-core/automation-trigger';
import { WorkflowEngineService } from '../workflow-engine-service.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { workflowEnginePackage, WorkflowEngineToken } from '../package.js';
import { createTestDb, createWorkflowDefinition, type TestDbContext } from './shared.js';

const { subjects: PackageLifecycleSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('workflowEnginePackageLifecycle', {
    changed: z.object({ id: z.string(), status: z.string() }),
  }),
);

/**
 * Builds a Node extension context that exposes an automation trigger binding
 * runtime, the way a booted host does.
 * @param runtime - Live binding runtime, or `undefined` for a host without one.
 * @returns Node extension context for `workflowEnginePackage.create`.
 */
function createNodeContext(runtime?: AutomationTriggerBindingRuntime): NodeExtensionContext<IMakaioBus> {
  return {
    ...makeStubExtensionContext(MakaioBus),
    bus: MakaioBus,
    platform: process.platform,
    homedir: '/tmp',
    makaioHome: '/tmp/.makaio-test',
    username: 'test',
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      token.name === AutomationTriggerBindingRuntimeToken.name ? (runtime as T | undefined) : undefined,
  };
}

function expectWorkflowEngineService(service: ExtensionService | undefined): asserts service is WorkflowEngineService {
  expect(service).toBeInstanceOf(WorkflowEngineService);
}

describe('workflowEnginePackage', () => {
  let dbContext: TestDbContext | undefined;
  let service: WorkflowEngineService | undefined;
  let registry: AutomationTriggerRegistry | undefined;
  let runtime: AutomationTriggerBindingRuntime | undefined;
  let cronScheduler: LocalAutomationCronScheduler | undefined;
  let cleanupFns: Array<() => void> = [];

  /**
   * Boots a real automation trigger registry plus binding runtime and registers
   * the framework's built-in trigger types under their canonical owner.
   * @returns The live binding runtime a host would expose to the engine.
   */
  async function bootAutomationTriggers(): Promise<AutomationTriggerBindingRuntime> {
    registry = new AutomationTriggerRegistry(MakaioBus);
    await registry.init();
    const liveRegistry = registry;
    runtime = new AutomationTriggerBindingRuntime({
      resolveRegistration: (kind) => liveRegistry.resolveRegistration(kind),
    });
    cronScheduler = new LocalAutomationCronScheduler();
    const scheduler = cronScheduler;
    await registry.register(AUTOMATION_TRIGGER_BUILTINS_OWNER, [
      createBusEventAutomationTrigger(MakaioBus),
      createCronAutomationTrigger(() => scheduler),
    ]);
    return runtime;
  }

  afterEach(async () => {
    await service?.destroy();
    service = undefined;
    await runtime?.close();
    runtime = undefined;
    await cronScheduler?.shutdown();
    cronScheduler = undefined;
    await registry?.destroy();
    registry = undefined;
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    dbContext?.cleanup();
    dbContext = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('declares namespace, storage handlers, and service factory', () => {
    expect(workflowEnginePackage.name).toBe(WorkflowEngineToken.name);
    expect(workflowEnginePackage.critical).toBe(true);
    expect(workflowEnginePackage.namespaces).toContain(WorkflowNamespace);
    expect(workflowEnginePackage.namespaces).toContain(WorkflowStorageNamespace);
    // Migrations are now managed by the central storage-migrations tier
    expect(workflowEnginePackage.storage?.migrations).toBeUndefined();
    expect(workflowEnginePackage.storage?.registerHandlers).toEqual(expect.any(Function));
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

  it('resolves workspace roots through active resolvers in registration order', async () => {
    const workflowEngine = new WorkflowEngineService(MakaioBus);
    const firstCleanup = workflowEngine.registerWorkspaceRootResolver(async () => undefined);
    const secondCleanup = workflowEngine.registerWorkspaceRootResolver(async (workspaceId) =>
      workspaceId === 'acme/factory' ? '/workspaces/factory' : undefined,
    );

    expect(await workflowEngine.resolveWorkspaceRoot('acme/factory')).toBe('/workspaces/factory');

    firstCleanup();
    expect(await workflowEngine.resolveWorkspaceRoot('acme/factory')).toBe('/workspaces/factory');

    secondCleanup();
    expect(await workflowEngine.resolveWorkspaceRoot('acme/factory')).toBeUndefined();
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
      triggers: [
        {
          kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND,
          params: { subject: 'workflowEnginePackageLifecycle.changed' },
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const created = await workflowEnginePackage.create?.(createNodeContext(await bootAutomationTriggers()));
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
      scope: { type: 'external', kind: 'project', id: 'project-1' },
      triggers: [{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const created = await workflowEnginePackage.create?.(createNodeContext(await bootAutomationTriggers()));
    expectWorkflowEngineService(created);
    service = created;
    await service.init();

    expect(service.triggerReconciler.activeConsumerCount()).toBe(1);
    expect(cronScheduler?.activeScheduleCount()).toBe(1);

    await service.destroy();

    expect(service.triggerReconciler.activeConsumerCount()).toBe(0);
    expect(cronScheduler?.activeScheduleCount()).toBe(0);
    service = undefined;
  });

  it('does not activate a global cron trigger without single-host execution authority', async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    const workflow = createWorkflowDefinition({
      id: 'workflow-package-global-cron',
      scope: { type: 'global' },
      triggers: [{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const created = await workflowEnginePackage.create?.(createNodeContext(await bootAutomationTriggers()));
    expectWorkflowEngineService(created);
    service = created;
    await service.init();

    expect(service.triggerReconciler.activeConsumerCount()).toBe(0);
    expect(cronScheduler?.activeScheduleCount()).toBe(0);
  });

  it('leaves declarative triggers inactive when the host exposes no binding runtime', async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    await MakaioBus.request(WorkflowStorageSubjects.set, {
      workflow: createWorkflowDefinition({
        id: 'workflow-package-no-runtime',
        triggers: [{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }],
      }),
    });

    const created = await workflowEnginePackage.create?.(createNodeContext());
    expectWorkflowEngineService(created);
    service = created;
    await service.init();

    // Invocation mode still works; only the declarative binding stays inactive.
    expect(service.triggerReconciler.activeConsumerCount()).toBe(0);
  });
});
