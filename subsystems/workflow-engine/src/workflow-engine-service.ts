import type { IMakaioBus } from '@makaio/bus-core';
import type { IStepRunner, IWorkflowTriggerTypeRegistry } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { BusEventTriggerEvaluator } from './bus-event-trigger-evaluator.js';
import { CronTriggerEvaluator } from './cron-trigger-evaluator.js';
import type { ExecutorConfig } from './types.js';
import { WorkflowExecutor } from './workflow-executor.js';

/**
 * Options for constructing a {@link WorkflowEngineService}.
 *
 * Both fields are optional — when omitted the service falls back to the
 * default in-process step runner and default executor config.
 */
export interface WorkflowEngineServiceOptions {
  /** Custom step runner injected by the runtime composition root. */
  stepRunner?: IStepRunner;
  /** Partial executor configuration merged with defaults. */
  executorConfig?: Partial<ExecutorConfig>;
}

/**
 * Workflow engine package service.
 *
 * Owns the boot lifecycle for the workflow executor and trigger evaluators so
 * stored triggers become active during normal runtime package startup.
 */
export class WorkflowEngineService extends BaseService {
  private readonly workflowExecutor: WorkflowExecutor;
  private readonly busEventTriggerEvaluator: BusEventTriggerEvaluator;
  private readonly cronTriggerEvaluator: CronTriggerEvaluator;

  /**
   * @param bus - Shared runtime bus.
   * @param options - Optional step runner and executor config overrides.
   */
  public constructor(bus: IMakaioBus, options?: WorkflowEngineServiceOptions) {
    super(bus);
    this.workflowExecutor = new WorkflowExecutor(bus, options?.executorConfig, options?.stepRunner);
    this.busEventTriggerEvaluator = new BusEventTriggerEvaluator(bus);
    this.cronTriggerEvaluator = new CronTriggerEvaluator(bus);
  }

  /**
   * Executor owned by this package service.
   * @returns Workflow executor instance.
   */
  public get executor(): WorkflowExecutor {
    return this.workflowExecutor;
  }

  /**
   * Cron evaluator owned by this package service.
   * @returns Cron trigger evaluator instance.
   */
  public get cronTriggers(): CronTriggerEvaluator {
    return this.cronTriggerEvaluator;
  }

  /**
   * Set the trigger type registry used by executor request handlers.
   * @param registry - Trigger type registry instance.
   */
  public setTriggerTypeRegistry(registry: IWorkflowTriggerTypeRegistry): void {
    this.workflowExecutor.setTriggerTypeRegistry(registry);
  }

  /**
   * Retrieve the executor trigger type registry.
   * @returns Trigger type registry, or `undefined` when none is set.
   */
  public getTriggerTypeRegistry(): IWorkflowTriggerTypeRegistry | undefined {
    return this.workflowExecutor.getTriggerTypeRegistry();
  }

  /**
   * Initialize executor handlers before trigger evaluators can fire starts.
   * @returns Promise that resolves once all child services are initialized.
   */
  protected async onInit(): Promise<void> {
    this.addCleanup(() => this.destroyOwnedServices());
    await this.workflowExecutor.init();
    await this.busEventTriggerEvaluator.init();
    await this.cronTriggerEvaluator.init();
  }

  /**
   * Tear down child services in reverse boot order.
   * @returns Promise that resolves once all child services are destroyed.
   */
  private async destroyOwnedServices(): Promise<void> {
    const errors: unknown[] = [];
    for (const destroy of [
      () => this.cronTriggerEvaluator.destroy(),
      () => this.busEventTriggerEvaluator.destroy(),
      () => this.workflowExecutor.destroy(),
    ]) {
      try {
        await destroy();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Workflow engine service teardown failed');
    }
  }
}
