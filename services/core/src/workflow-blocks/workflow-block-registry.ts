import type { IMakaioBus } from '@makaio/bus-core';
import type {
  RegisteredTriggerBlock,
  RegisteredStepBlock,
  WorkflowBlockCollection,
  WorkflowBlockMetadata,
} from '@makaio/contracts';
import { WorkflowBlocksSubjects, zodSchemaToJsonRecord } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';

/**
 * Registry for workflow blocks contributed by extensions.
 *
 * Manages trigger and step block registrations, serves them via the
 * `workflow-blocks.list` bus subject, and emits `workflow-blocks.changed`
 * on mutations.
 */
export class WorkflowBlockRegistry extends BaseService {
  private readonly triggersByExtension = new Map<string, RegisteredTriggerBlock[]>();
  private readonly stepsByExtension = new Map<string, RegisteredStepBlock[]>();
  private revision = 0;
  private cache: {
    revision: number;
    triggers: RegisteredTriggerBlock[];
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
      ctx.setResult({
        triggers: this.listTriggers(),
        steps: this.listSteps(),
      });
    });
  }

  /**
   * Registers all workflow blocks from an extension.
   * @param extensionName - The extension contributing the blocks.
   * @param collection - The trigger and step block declarations.
   * @throws If a block name collides with an existing registration.
   */
  public async register(extensionName: string, collection: WorkflowBlockCollection): Promise<void> {
    const triggers: RegisteredTriggerBlock[] = [];
    const steps: RegisteredStepBlock[] = [];
    const snapshot = this.snapshotExtensionState(extensionName);

    const existingNames = new Set<string>();
    for (const registered of this.triggersByExtension.values()) {
      for (const trigger of registered) existingNames.add(trigger.metadata.name);
    }
    for (const registered of this.stepsByExtension.values()) {
      for (const step of registered) existingNames.add(step.metadata.name);
    }

    if (collection.triggers) {
      for (const trigger of collection.triggers) {
        this.assertExtensionNamespace(extensionName, trigger.metadata);
        this.assertNoCollision(trigger.metadata, existingNames);
        existingNames.add(trigger.metadata.name);
        triggers.push({
          metadata: { ...trigger.metadata, extensionName },
          configSchema: zodSchemaToJsonRecord(trigger.configSchema),
          outputSchema: zodSchemaToJsonRecord(trigger.outputSchema),
        });
      }
    }

    if (collection.steps) {
      for (const step of collection.steps) {
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
    }

    if (triggers.length > 0) this.triggersByExtension.set(extensionName, triggers);
    if (steps.length > 0) this.stepsByExtension.set(extensionName, steps);

    if (triggers.length > 0 || steps.length > 0) {
      this.revision += 1;
      try {
        await this.emitChanged(extensionName, 'registered');
      } catch (error) {
        this.restoreExtensionState(extensionName, snapshot);
        throw error;
      }
    }
  }

  /**
   * Deregisters all workflow blocks for an extension.
   * @param extensionName - The extension to remove.
   */
  public async deregister(extensionName: string): Promise<void> {
    const snapshot = this.snapshotExtensionState(extensionName);
    const hadTriggers = this.triggersByExtension.delete(extensionName);
    const hadSteps = this.stepsByExtension.delete(extensionName);

    if (hadTriggers || hadSteps) {
      this.revision += 1;
      try {
        await this.emitChanged(extensionName, 'deregistered');
      } catch (error) {
        this.restoreExtensionState(extensionName, snapshot);
        throw error;
      }
    }
  }

  /**
   * Returns all registered trigger blocks.
   * @returns Flat list of all trigger blocks across all extensions.
   */
  public listTriggers(): RegisteredTriggerBlock[] {
    return this.getCache().triggers.map(cloneTriggerBlock);
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
        triggers: [...this.triggersByExtension.values()].flat(),
        steps: [...this.stepsByExtension.values()].flat(),
      };
    }
    return this.cache;
  }

  private snapshotExtensionState(extensionName: string): WorkflowBlockRegistryExtensionSnapshot {
    return {
      triggers: this.triggersByExtension.get(extensionName),
      steps: this.stepsByExtension.get(extensionName),
      revision: this.revision,
      cache: this.cache,
    };
  }

  private restoreExtensionState(extensionName: string, snapshot: WorkflowBlockRegistryExtensionSnapshot): void {
    if (snapshot.triggers) this.triggersByExtension.set(extensionName, snapshot.triggers);
    else this.triggersByExtension.delete(extensionName);
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
  triggers: RegisteredTriggerBlock[] | undefined;
  steps: RegisteredStepBlock[] | undefined;
  revision: number;
  cache: {
    revision: number;
    triggers: RegisteredTriggerBlock[];
    steps: RegisteredStepBlock[];
  } | null;
}

/**
 * @param block - Registered trigger block to clone.
 * @returns Defensive copy of the trigger block.
 */
function cloneTriggerBlock(block: RegisteredTriggerBlock): RegisteredTriggerBlock {
  return {
    metadata: cloneMetadata(block.metadata),
    configSchema: structuredClone(block.configSchema),
    outputSchema: structuredClone(block.outputSchema),
  };
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
