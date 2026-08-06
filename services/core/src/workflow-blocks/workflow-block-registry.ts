import type { IMakaioBus } from '@makaio/bus-core';
import type { RegisteredStepBlock, WorkflowBlockCollection, WorkflowBlockMetadata } from '@makaio/contracts';
import { WorkflowBlocksSubjects, zodSchemaToJsonRecord } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';

/**
 * Registry for workflow step blocks contributed by extensions.
 *
 * Manages step block registrations, serves them via the `workflow-blocks.list`
 * bus subject, and emits `workflow-blocks.changed` on mutations.
 *
 * Workflow start conditions are deliberately absent: they are executable
 * automation trigger types owned by the automation trigger registry, and a
 * second declarative catalog for them could only ever drift from runtime truth.
 */
export class WorkflowBlockRegistry extends BaseService {
  private readonly stepsByExtension = new Map<string, RegisteredStepBlock[]>();
  private revision = 0;
  private cache: {
    revision: number;
    steps: RegisteredStepBlock[];
  } | null = null;

  /**
   * @param bus - Bus instance used for registering handlers.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Initialize the service by registering the `workflow-blocks.list` handler.
   */
  protected onInit(): void {
    this.registerHandler(WorkflowBlocksSubjects.list, (ctx) => {
      ctx.setResult({ steps: this.listSteps() });
    });
  }

  /**
   * Registers all workflow step blocks from an extension.
   * @param extensionName - The extension contributing the blocks.
   * @param collection - The step block declarations.
   * @throws If a block name collides with an existing registration.
   */
  public async register(extensionName: string, collection: WorkflowBlockCollection): Promise<void> {
    const steps: RegisteredStepBlock[] = [];
    const snapshot = this.snapshotExtensionState(extensionName);

    const existingNames = new Set<string>();
    for (const registered of this.stepsByExtension.values()) {
      for (const step of registered) existingNames.add(step.metadata.name);
    }

    for (const step of collection.steps ?? []) {
      this.assertExtensionNamespace(extensionName, step.metadata);
      this.assertNoCollision(step.metadata, existingNames);
      existingNames.add(step.metadata.name);
      steps.push({
        metadata: { ...step.metadata, extensionName },
        configSchema: zodSchemaToJsonRecord(step.configSchema),
        inputSchema: zodSchemaToJsonRecord(step.inputSchema),
        outputSchema: zodSchemaToJsonRecord(step.outputSchema),
        runs: structuredClone(step.runs),
      });
    }

    if (steps.length === 0) return;

    this.stepsByExtension.set(extensionName, steps);
    this.revision += 1;
    try {
      await this.emitChanged(extensionName, 'registered');
    } catch (error) {
      this.restoreExtensionState(extensionName, snapshot);
      throw error;
    }
  }

  /**
   * Deregisters all workflow step blocks for an extension.
   * @param extensionName - The extension to remove.
   */
  public async deregister(extensionName: string): Promise<void> {
    const snapshot = this.snapshotExtensionState(extensionName);
    if (!this.stepsByExtension.delete(extensionName)) return;

    this.revision += 1;
    try {
      await this.emitChanged(extensionName, 'deregistered');
    } catch (error) {
      this.restoreExtensionState(extensionName, snapshot);
      throw error;
    }
  }

  /**
   * Returns all registered step blocks.
   * @returns Flat list of all step blocks across all extensions.
   */
  public listSteps(): RegisteredStepBlock[] {
    return this.getCache().steps.map(cloneStepBlock);
  }

  private async emitChanged(extensionName: string, reason: 'registered' | 'deregistered'): Promise<void> {
    await this.bus.emit(WorkflowBlocksSubjects.changed, {
      extensionName,
      revision: this.revision,
      reason,
    });
  }

  private getCache() {
    if (!this.cache || this.cache.revision !== this.revision) {
      this.cache = {
        revision: this.revision,
        steps: [...this.stepsByExtension.values()].flat(),
      };
    }
    return this.cache;
  }

  private snapshotExtensionState(extensionName: string): WorkflowBlockRegistryExtensionSnapshot {
    return {
      steps: this.stepsByExtension.get(extensionName),
      revision: this.revision,
      cache: this.cache,
    };
  }

  private restoreExtensionState(extensionName: string, snapshot: WorkflowBlockRegistryExtensionSnapshot): void {
    if (snapshot.steps) this.stepsByExtension.set(extensionName, snapshot.steps);
    else this.stepsByExtension.delete(extensionName);
    this.revision = snapshot.revision;
    this.cache = snapshot.cache;
  }

  private assertNoCollision(metadata: WorkflowBlockMetadata, existing: Set<string>): void {
    if (existing.has(metadata.name)) {
      throw new Error(`Workflow block name collision: '${metadata.name}' is already registered`);
    }
  }

  private assertExtensionNamespace(extensionName: string, metadata: WorkflowBlockMetadata): void {
    const prefix = `${extensionName}.`;
    if (!metadata.name.startsWith(prefix)) {
      throw new Error(`Workflow block '${metadata.name}' must be namespaced by extension '${prefix}'`);
    }
  }
}

interface WorkflowBlockRegistryExtensionSnapshot {
  steps: RegisteredStepBlock[] | undefined;
  revision: number;
  cache: {
    revision: number;
    steps: RegisteredStepBlock[];
  } | null;
}

/**
 * @param block - Registered step block to clone.
 * @returns Defensive copy of the step block.
 */
function cloneStepBlock(block: RegisteredStepBlock): RegisteredStepBlock {
  return {
    metadata: cloneMetadata(block.metadata),
    configSchema: structuredClone(block.configSchema),
    inputSchema: structuredClone(block.inputSchema),
    outputSchema: structuredClone(block.outputSchema),
    runs: structuredClone(block.runs),
  };
}

/**
 * @param metadata - Block metadata to clone.
 * @returns Defensive copy preserving optional categories.
 */
function cloneMetadata(metadata: WorkflowBlockMetadata & { extensionName: string }): WorkflowBlockMetadata & {
  extensionName: string;
} {
  return metadata.categories ? { ...metadata, categories: [...metadata.categories] } : { ...metadata };
}
