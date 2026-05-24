import type { StepRunConfig, StepRunResult, ShellWorkflowStep } from '@makaio/contracts';
import { spawnProcess } from '@makaio/subsystem-workflow-engine';

/**
 * Execute a shell step inside the platform-default working directory.
 *
 * Validates that the config describes a shell step, spawns the process
 * using the shared `spawnProcess` helper, respects the provided
 * {@link AbortSignal} for cooperative cancellation, and returns a
 * {@link StepRunResult} with stdout as output and duration telemetry.
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
  const cwd = config.platformDefaults.cwd;
  const env = { ...config.platformDefaults.env, ...stepDef.env };
  const timeoutMs = stepDef.timeoutMs ?? 300_000;

  const startTime = performance.now();

  try {
    const { stdout } = await spawnProcess({
      command: stepDef.command,
      cwd,
      env,
      timeoutMs,
      signal,
    });

    const duration = performance.now() - startTime;

    return {
      status: 'completed',
      output: stdout,
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
