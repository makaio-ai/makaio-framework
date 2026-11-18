import { runBoundedShutdownSteps, type BoundedShutdownStep } from '@makaio/kernel';
import { processStopBudgetMs } from '@makaio/subprocess';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_STEP_STOP_BUDGET_MS,
  bootCancellationBudgetMs,
  bootCheckpointGraceMs,
  localStep,
  resourceStep,
  resourceStepStopBudgetMs,
} from './runtime-stop-budget.js';

describe('runtime stop windows', () => {
  it('gives a step that closes a resource the window of one bounded stop, which follows the subprocess stop timing', () => {
    expect(resourceStepStopBudgetMs()).toBe(processStopBudgetMs());
    expect(resourceStep('database', () => undefined).budgetMs()).toBe(processStopBudgetMs());
  });

  it('gives a step that only releases in-process state a short window', () => {
    expect(localStep('handlers', () => undefined).budgetMs()).toBe(LOCAL_STEP_STOP_BUDGET_MS);
    expect(LOCAL_STEP_STOP_BUDGET_MS).toBeLessThan(processStopBudgetMs());
  });

  it('names a local step that does not settle and still runs the step after it', async () => {
    const ran: string[] = [];
    const stuck = { ...localStep('stuck handlers', () => new Promise<void>(() => undefined)), budgetMs: () => 20 };

    const failures = await runBoundedShutdownSteps([stuck, localStep('after', () => void ran.push('after'))]);

    expect(ran).toEqual(['after']);
    expect(failures.map(String)).toEqual(['Error: Shutdown step "stuck handlers" did not finish within 20 ms']);
  });

  it('bounds a cancelled boot by the grace for the phase in flight plus the rollback steps registered so far', () => {
    const steps: BoundedShutdownStep[] = [];
    expect(bootCheckpointGraceMs()).toBe(processStopBudgetMs());
    const budget = () => bootCancellationBudgetMs(steps);
    expect(budget()).toBe(processStopBudgetMs());

    // Read lazily: a step registered after the bound was created still counts.
    steps.push(
      resourceStep('bus transport', () => undefined),
      localStep('handlers', () => undefined),
    );

    expect(budget()).toBe(processStopBudgetMs() + resourceStepStopBudgetMs() + LOCAL_STEP_STOP_BUDGET_MS);
  });
});
