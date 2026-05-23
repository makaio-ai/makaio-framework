import { fileURLToPath } from 'node:url';
import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowNamespace, dep, extensionToken, type MakaioNodeExtension } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { SessionToken } from '@makaio/services-core';
import { WorkflowEngineService } from './workflow-engine-service.js';
import { WorkflowStorageNamespace } from './storage/namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Typed package token for retrieving the workflow engine package service. */
export const WorkflowEngineToken = extensionToken<WorkflowEngineService>('makaio.workflow-engine');

/**
 * MakaioExtension manifest for the workflow engine subsystem.
 *
 * Registers:
 * - The `WorkflowEngineService` as the package service (lifecycle owner).
 * - The `WorkflowNamespace` and `WorkflowStorageNamespace` for bus routing.
 * - Drizzle-backed storage handlers for workflow definition and execution
 *   persistence.
 *
 * Declared critical because the workflow engine is a core framework service
 * that other packages depend on for workflow execution.
 */
export const workflowEnginePackage: MakaioNodeExtension<IMakaioBus> = {
  name: WorkflowEngineToken.name,
  displayName: 'Workflow Engine',
  version: '0.1.0',
  dependencies: [dep(SessionToken.name)],
  critical: true,
  namespaces: [WorkflowNamespace, WorkflowStorageNamespace],
  storage: {
    migrations: 'drizzle',
    packageRoot: PACKAGE_ROOT,
    migrationSourceId: 'subsystems/workflow-engine/src/drizzle',
    registerHandlers: registerDrizzleHandlers(registerDrizzleWorkflowStorage),
  },
  /**
   * Creates the workflow engine service bound to the runtime bus.
   * @param ctx - Runtime package context.
   * @returns Uninitialized workflow engine service instance.
   */
  create: (ctx) => new WorkflowEngineService(ctx.bus),
};
