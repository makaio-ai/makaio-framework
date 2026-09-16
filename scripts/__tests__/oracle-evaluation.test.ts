/**
 * Unit tests for the pure `evaluateOracle` helper in runner.ts.
 *
 * The capability-proving branch has two sub-cases (mirroring provesDeclaredEffects):
 * - With sentinelEffect: requires responseConsumed AND terminal === 'ok'.
 * - Without sentinelEffect: requires responseConsumed AND terminatedCleanly
 *   (error_max_turns is accepted — negative-control scenarios prove a native
 *   refusal that legitimately prevents the model from completing).
 */
import { describe, expect, it } from 'vitest';
import { evaluateOracle } from '../lib/agent-clients/runner.js';

// Minimal scenario shapes required by evaluateOracle.

/** Capability scenario with a declared sentinel effect — requires terminal === 'ok'. */
const capabilityScenarioWithEffect = {
  oracle: 'final-response-must-contain-marker' as const,
  candidateExpectedStatus: 'supported' as const,
  sentinelEffect: 'context.append',
};

/** Capability scenario without a declared sentinel effect — allows error_max_turns. */
const capabilityScenarioNoEffect = {
  oracle: 'native-must-deny-unapproved-tool' as const,
  candidateExpectedStatus: 'supported' as const,
  sentinelEffect: undefined,
};

const unobservedScenario = {
  oracle: 'unobserved' as const,
  candidateExpectedStatus: 'unobserved' as const,
  sentinelEffect: undefined,
};

const captureOnlyScenario = {
  oracle: 'capture-only' as const,
  candidateExpectedStatus: 'observer-only' as const,
  sentinelEffect: undefined,
};

describe('evaluateOracle — capability-proving branch (with sentinelEffect)', () => {
  it('passes when responseConsumed is true and terminal is ok', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioWithEffect,
        terminal: 'ok',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(true);
  });

  it('fails when responseConsumed is true but terminal is error_max_turns', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioWithEffect,
        terminal: 'error_max_turns',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(false);
  });

  it('fails when responseConsumed is true but terminal is error', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioWithEffect,
        terminal: 'error',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(false);
  });

  it('fails when responseConsumed is true but terminal is killed', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioWithEffect,
        terminal: 'killed',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(false);
  });

  it('fails when responseConsumed is false even with terminal ok', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioWithEffect,
        terminal: 'ok',
        hookFired: true,
        responseConsumed: false,
      }),
    ).toBe(false);
  });
});

describe('evaluateOracle — capability-proving branch (without sentinelEffect, negative-control)', () => {
  it('passes when responseConsumed is true and terminal is error_max_turns', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioNoEffect,
        terminal: 'error_max_turns',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(true);
  });

  it('passes when responseConsumed is true and terminal is ok', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioNoEffect,
        terminal: 'ok',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(true);
  });

  it('fails when responseConsumed is true but terminal is killed', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioNoEffect,
        terminal: 'killed',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(false);
  });

  it('fails when responseConsumed is true but terminal is error', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioNoEffect,
        terminal: 'error',
        hookFired: true,
        responseConsumed: true,
      }),
    ).toBe(false);
  });

  it('fails when responseConsumed is false even with terminal error_max_turns', () => {
    expect(
      evaluateOracle({
        scenario: capabilityScenarioNoEffect,
        terminal: 'error_max_turns',
        hookFired: true,
        responseConsumed: false,
      }),
    ).toBe(false);
  });
});

describe('evaluateOracle — unobserved branch (unchanged)', () => {
  it('passes for ok terminal', () => {
    expect(
      evaluateOracle({
        scenario: unobservedScenario,
        terminal: 'ok',
        hookFired: false,
        responseConsumed: false,
      }),
    ).toBe(true);
  });

  it('passes for error_max_turns terminal', () => {
    expect(
      evaluateOracle({
        scenario: unobservedScenario,
        terminal: 'error_max_turns',
        hookFired: false,
        responseConsumed: false,
      }),
    ).toBe(true);
  });

  it('fails for error terminal', () => {
    expect(
      evaluateOracle({
        scenario: unobservedScenario,
        terminal: 'error',
        hookFired: false,
        responseConsumed: false,
      }),
    ).toBe(false);
  });
});

describe('evaluateOracle — capture-only branch (unchanged)', () => {
  it('passes when terminated cleanly, hook fired, and not already supported', () => {
    expect(
      evaluateOracle({
        scenario: captureOnlyScenario,
        terminal: 'ok',
        hookFired: true,
        responseConsumed: false,
      }),
    ).toBe(true);
  });

  it('fails when hook did not fire', () => {
    expect(
      evaluateOracle({
        scenario: captureOnlyScenario,
        terminal: 'ok',
        hookFired: false,
        responseConsumed: false,
      }),
    ).toBe(false);
  });

  it('fails when candidateExpectedStatus is supported', () => {
    expect(
      evaluateOracle({
        scenario: { oracle: 'capture-only', candidateExpectedStatus: 'supported', sentinelEffect: undefined },
        terminal: 'ok',
        hookFired: true,
        responseConsumed: false,
      }),
    ).toBe(false);
  });
});
