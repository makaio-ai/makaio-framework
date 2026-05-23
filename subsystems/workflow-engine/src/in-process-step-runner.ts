import type { IStepRunner, StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { StepExecutorDeps } from './workflow-step-executors.js';
import { executeAgentStep, executeGateStep, executeShellStep } from './workflow-step-executors.js';

/**
 * In-process step runner that delegates to the executor functions directly.
 * All step execution happens synchronously in the same process as the executor.
 * This is the default runner; remote-process runners are a future extension point.
 */
export class InProcessStepRunner implements IStepRunner {
  public constructor(private readonly deps: StepExecutorDeps) {}

  /**
   * Execute a workflow step in-process, routing to the appropriate executor.
   * @param config - Step run configuration including execution context
   * @returns Step run result with status, optional output, and telemetry
   */
  public async run(config: StepRunConfig): Promise<StepRunResult> {
    const startedAt = Date.now();
    if (!this.deps.activeExecutions.has(config.executionId)) {
      return {
        status: 'failed',
        error: `Active execution not found: ${config.executionId}`,
        telemetry: { duration: Date.now() - startedAt },
      };
    }

    switch (config.stepType) {
      case 'agent':
        return executeAgentStep(this.deps, config.executionId, config.stepId);
      case 'shell':
        return executeShellStep(this.deps, config.executionId, config.stepId);
      case 'gate':
        return executeGateStep(this.deps, config.executionId, config.stepId);
    }
  }
}
