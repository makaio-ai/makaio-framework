import { renderPromptTemplate, TemplatePlaceholderError } from '@makaio/expression';
import {
  CodeStepDataSchema,
  type StepRunConfig,
  type WorkflowAgentStepNode,
  type WorkflowCodeStepNode,
} from '@makaio/contracts';
import {
  buildPreviousStepsFromFrames,
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { resolveStepOutputValidator } from './step-output-validation.js';

/**
 * Freeze the execution data needed by either kind of step runner.
 * @param node - Workflow leaf being executed.
 * @param ctx - Execution-wide runtime context.
 * @param scope - Current sequence or iteration context.
 * @param frameId - Frame for this occurrence of the node.
 * @returns Data-only runner invocation.
 */
function stepConfig(
  node: WorkflowCodeStepNode | WorkflowAgentStepNode,
  ctx: RuntimeContext,
  scope: PrimitiveExpressionContext,
  frameId?: string,
): StepRunConfig {
  const base = {
    stepId: node.id,
    frameId,
    data: CodeStepDataSchema.parse({
      executionId: ctx.executionId,
      workflowId: ctx.workflowId,
      inputs: ctx.execution.inputs,
      config: ctx.execution.config ?? {},
      previousSteps: buildPreviousStepsFromFrames(scope.frames),
      ...(scope.item !== undefined && { item: scope.item }),
      ...(scope.index !== undefined && { index: scope.index }),
      ...(scope.previous !== undefined && { previous: scope.previous }),
    }),
    platformDefaults: { cwd: ctx.platformContext.repoPath },
  };
  if (node.type === 'code-step') {
    return { ...base, stepType: node.type, stepDefinition: node };
  }
  const resolvedPrompt = renderPromptTemplate(node.prompt, buildRuntimeExpressionScope(scope));
  return { ...base, stepType: node.type, stepDefinition: node, resolvedPrompt };
}

/**
 * Submit a code or agent step to the runtime's required execution port.
 * @param node - The executable workflow leaf.
 * @param ctx - Execution context that owns the runner and cancellation.
 * @param scope - Data used for templating and iteration.
 * @param frameId - Frame for this occurrence of the step.
 * @returns Terminal node result for frame persistence.
 */
export async function dispatchStep(
  node: WorkflowCodeStepNode | WorkflowAgentStepNode,
  ctx: RuntimeContext,
  scope: PrimitiveExpressionContext,
  frameId?: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) return { status: 'cancelled' };
  try {
    const config = stepConfig(node, ctx, scope, frameId);
    const validateOutput = resolveStepOutputValidator(node);
    const result = await ctx.stepRunner.run(config, ctx.signal);
    if (ctx.signal.aborted || result.status === 'cancelled') return { status: 'cancelled' };
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error ?? 'stepExecutionFailed', detail: result.detail };
    }
    const outputFinalized =
      node.type === 'agent-step' && node.resultFinalizerId !== undefined && result.outputFinalized === true;
    if (
      !outputFinalized &&
      validateOutput !== undefined &&
      (result.output === undefined || !validateOutput(result.output))
    ) {
      return { status: 'failed', error: 'invalidOutput' };
    }
    return { status: 'completed', output: result.output };
  } catch (error) {
    if (error instanceof TemplatePlaceholderError) {
      return { status: 'failed', error: `agent step '${node.id}': ${error.message}` };
    }
    throw error;
  }
}
