import { describe, expect, it } from 'vitest';
import { removeShutdownSteps, type ShutdownStep } from './boot-phase.js';

describe('removeShutdownSteps', () => {
  it('removes only the requested number of duplicate shutdown steps', () => {
    const sharedStep: ShutdownStep = () => undefined;
    const stableStep: ShutdownStep = () => undefined;
    const shutdownSteps = [sharedStep, stableStep, sharedStep];

    removeShutdownSteps(shutdownSteps, [sharedStep]);

    expect(shutdownSteps).toEqual([sharedStep, stableStep]);
  });
});
