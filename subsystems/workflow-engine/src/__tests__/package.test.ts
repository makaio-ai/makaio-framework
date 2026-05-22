import { describe, expect, it } from 'vitest';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { WorkflowNamespace } from '@makaio/contracts';
import { WorkflowStorageNamespace } from '../storage/namespace.js';
import { workflowEnginePackage, WorkflowEngineToken } from '../package.js';

describe('workflowEnginePackage', () => {
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
});
