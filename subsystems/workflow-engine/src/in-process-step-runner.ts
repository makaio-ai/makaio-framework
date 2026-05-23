import type { IStepRunner, StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { StepExecutorDeps } from './workflow-step-executors.js';
import { executeAgentStep, executeGateStep, executeShellStep, failResult } from './workflow-step-executors.js';

export class InProcessStepRunner implements IStepRunner {
  public readonly managesWorkflowLifecycle = true;

  public constructor(private readonly deps: StepExecutorDeps) {}

  public async run(config: StepRunConfig): Promise<StepRunResult> {
    const startedAt = Date.now();
    if (!this.deps.activeExecutions.has(config.executionId)) {
      return failResult(`Active execution not found: ${config.executionId}`, startedAt);
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
