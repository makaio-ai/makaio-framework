import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowNamespace, dep, extensionToken, type MakaioNodeExtension } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { SessionToken } from '@makaio/services-core';
import { WorkflowEngineService, type WorkflowEngineServiceOptions } from './workflow-engine-service.js';
import { WorkflowStorageNamespace } from './storage/namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';

/** Typed package token for retrieving the workflow engine package service. */
export const WorkflowEngineToken = extensionToken<WorkflowEngineService>('makaio.workflow-engine');

/**
 * Create a workflow engine package manifest with optional runtime overrides.
 *
 * The returned manifest registers the `WorkflowEngineService` as the package
 * service, wires Drizzle storage handlers, and forwards the provided options
 * to the executor so that composition roots can inject a workflow-level runner
 * or executor configuration (e.g. busUrl, busAuth, platformDefaults).
 * @param options - Optional workflow runner and executor config overrides.
 * @returns A `MakaioNodeExtension` manifest for the workflow engine subsystem.
 */
export function createWorkflowEnginePackage(options?: WorkflowEngineServiceOptions): MakaioNodeExtension<IMakaioBus> {
  return {
    name: WorkflowEngineToken.name,
    displayName: 'Workflow Engine',
    version: '0.1.0',
    dependencies: [dep(SessionToken.name)],
    critical: true,
    namespaces: [WorkflowNamespace, WorkflowStorageNamespace],
    storage: {
      registerHandlers: registerDrizzleHandlers(registerDrizzleWorkflowStorage),
    },
    /**
     * Creates the workflow engine service bound to the runtime bus.
     * @param ctx - Runtime package context.
     * @returns Uninitialized workflow engine service instance.
     */
    create: (ctx) => new WorkflowEngineService(ctx.bus, options),
  };
}

/**
 * Default workflow engine package manifest (no runtime overrides).
 *
 * Equivalent to `createWorkflowEnginePackage()` with no arguments. Preserved
 * for existing consumers that reference the static constant directly.
 */
export const workflowEnginePackage: MakaioNodeExtension<IMakaioBus> = createWorkflowEnginePackage();
