import type {
  CompositeStepState,
  ShellWorkflowStep,
  StepRunConfig,
  StepRunResult,
  StepStatus,
} from '@makaio/contracts';
import { runShellStep } from '@makaio/subsystem-workflow-engine';

type WorkerExpressionStep = { result?: string; status: StepStatus | CompositeStepState['status'] };
type WorkerExpressionContext = {
  trigger: Record<string, unknown>;
  steps: Record<string, WorkerExpressionStep>;
  inputs: Record<string, unknown>;
  item?: unknown;
  index?: number;
};

/**
 * Check whether a value is a non-array object record.
 * @param value - Value to test.
 * @returns True when the value can be read as an object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the workflow expression context that shared shell execution expects.
 * @param resolvedInputs - Runner-provided resolved expression context.
 * @returns Expression context with required root maps present.
 */
function buildExpressionContext(resolvedInputs: StepRunConfig['resolvedInputs']): WorkerExpressionContext {
  const context: WorkerExpressionContext = {
    trigger: isRecord(resolvedInputs.trigger) ? resolvedInputs.trigger : {},
    steps: isRecord(resolvedInputs.steps) ? (resolvedInputs.steps as Record<string, WorkerExpressionStep>) : {},
    inputs: isRecord(resolvedInputs.inputs) ? resolvedInputs.inputs : {},
  };

  if ('item' in resolvedInputs) {
    context.item = resolvedInputs.item;
  }
  if (typeof resolvedInputs.index === 'number') {
    context.index = resolvedInputs.index;
  }

  return context;
}

/**
 * Execute a shell step with the shared workflow shell semantics.
 *
 * Validates that the config describes a shell step, delegates command/env/cwd
 * interpolation and cwd containment to `runShellStep`, respects the provided
 * {@link AbortSignal}, and returns a {@link StepRunResult}.
 * @param config - Step run configuration (must be a shell step).
 * @param signal - Abort signal for cooperative cancellation.
 * @returns Step run result with output and telemetry.
 */
export async function runWorkerShellStep(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> {
  if (config.stepType !== 'shell') {
    return {
      status: 'failed',
      error: `Expected shell step but received '${config.stepType}'`,
      telemetry: { duration: 0 },
    };
  }

  if (config.stepDefinition.type !== 'shell') {
    return {
      status: 'failed',
      error: `stepType is 'shell' but stepDefinition.type is '${config.stepDefinition.type}'`,
      telemetry: { duration: 0 },
    };
  }

  const stepDef = config.stepDefinition as ShellWorkflowStep;
  const startTime = performance.now();

  try {
    const outcome = await runShellStep({
      step: {
        command: stepDef.command,
        cwd: stepDef.cwd,
        env: { ...config.platformDefaults.env, ...stepDef.env },
        timeoutMs: stepDef.timeoutMs,
      },
      workspaceRoot: config.platformDefaults.cwd,
      expressionContext: buildExpressionContext(config.resolvedInputs),
      signal,
    });

    const duration = performance.now() - startTime;

    if (outcome.status === 'failed') {
      return {
        status: 'failed',
        error: outcome.error,
        telemetry: { duration },
      };
    }

    return {
      status: 'completed',
      output: outcome.stdout,
      telemetry: { duration },
    };
  } catch (error: unknown) {
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      status: 'failed',
      error: errorMessage,
      telemetry: { duration },
    };
  }
}
