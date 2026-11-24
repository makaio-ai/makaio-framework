import type { StepRunErrorCode } from '../step-runner.js';

/** Failure scenarios that must report the same code at each Agent Step execution site. */
export const agentStepFailureCases = [
  { scenario: 'unresolved-role', error: 'unknownRole' },
  { scenario: 'deadline', error: 'timeLimit' },
] as const satisfies readonly { scenario: string; error: StepRunErrorCode }[];
