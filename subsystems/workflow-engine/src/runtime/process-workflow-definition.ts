import {
  WorkflowError,
  WorkflowErrorCode,
  type WorkflowAgentStepNode,
  type WorkflowDefinition,
} from '@makaio/contracts';
import { preflightStepOutputs } from './step-output-validation.js';

/**
 * Check whether an agent step can execute through the process runner.
 * @param step - Parsed agent step definition.
 */
function assertStructuredTurn(step: WorkflowAgentStepNode): void {
  if (step.outputSchema === undefined || step.completion !== 'turn' || step.resultFinalizerId !== undefined) {
    throw new WorkflowError(
      WorkflowErrorCode.AGENT_STEP_UNSUPPORTED,
      `Agent step '${step.id}' requires explicit turn completion, structured output and no result finalizer`,
    );
  }
  if ((step.allowedTools?.length ?? 0) > 0) {
    throw new WorkflowError(
      WorkflowErrorCode.AGENT_STEP_UNSUPPORTED,
      `Agent step '${step.id}' declares unsupported tools`,
    );
  }
}

/**
 * Admit only steps supported by the process runner, including their declared output schemas.
 * @param definition - Frozen workflow definition to check.
 */
export function assertProcessWorkflowSupported(definition: WorkflowDefinition): void {
  preflightStepOutputs(definition, (step) => {
    if (step.type === 'agent-step') assertStructuredTurn(step);
  });
}
