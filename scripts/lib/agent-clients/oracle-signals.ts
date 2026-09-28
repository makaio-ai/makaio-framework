/**
 * Pure oracle signal helpers for agent-client live probes: workspace marker
 * checks, structured-output parsing, payload-key gating, and oracle evaluation.
 * @packageDocumentation
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { ProbeOptions, ProbeScenario, TerminalClassification } from './types.js';

/**
 * Checks that the hook fired and that every matching invocation carries the scenario's required payload keys.
 *
 * Every invocation, not some: one invocation outside the intended context (for
 * example the parent running the tool a subagent was asked to run) means the
 * observed outcome cannot be attributed to that context.
 * @param requiredPayloadKeys - Keys the scenario requires; absent requires nothing beyond a fired hook.
 * @param invocationPayloadKeys - Recorded top-level payload keys, one entry per matching invocation.
 * @returns Whether at least one invocation was captured and all carry every required key.
 */
export function firedWithRequiredPayloadKeys(
  requiredPayloadKeys: readonly string[] | undefined,
  invocationPayloadKeys: readonly (readonly string[])[],
): boolean {
  const required = requiredPayloadKeys ?? [];
  return (
    invocationPayloadKeys.length > 0 && invocationPayloadKeys.every((keys) => required.every((k) => keys.includes(k)))
  );
}

/**
 * Pure oracle evaluation for a completed scenario run.
 *
 * The capability-proving branch has two sub-cases keyed on `sentinelEffect`
 * (mirroring `provesDeclaredEffects` in the fixture suite):
 *
 * - **With a declared effect** (`sentinelEffect` defined): the session must
 *   have ended with `terminal === 'ok'`. A run that consumed the marker but
 *   ended in `error_max_turns` is not clean evidence — the fixture suite
 *   rejects such fixtures via `provesDeclaredEffects`.
 * - **Without a declared effect** (`sentinelEffect` undefined): the same
 *   bounded-turn rule as the observation branches applies — `error_max_turns`
 *   is accepted alongside `ok`. Negative-control scenarios (e.g.
 *   `native-must-deny-unapproved-tool`) prove a native refusal, which may keep
 *   the model from completing within its turn bound; the oracle relies only on
 *   `responseConsumed` plus a clean termination, not on a specific terminal.
 *   (The current committed fixture ends `terminal: 'ok'`, `exitCode: 0`.)
 * @param params - Oracle kind, terminal classification, and derived signal flags.
 * @returns Whether the oracle condition is met for this run.
 */
export function evaluateOracle(params: {
  scenario: Pick<ProbeScenario, 'oracle' | 'candidateExpectedStatus' | 'sentinelEffect'>;
  terminal: TerminalClassification;
  hookFired: boolean;
  responseConsumed: boolean;
}): boolean {
  const { scenario, terminal, hookFired, responseConsumed } = params;
  // A run that ended on its own turn bound is finished evidence; one that was
  // killed or failed is not. The distinction is read from the persisted
  // classification, uniformly for every provider.
  const terminatedCleanly = terminal === 'ok' || terminal === 'error_max_turns';
  return scenario.oracle === 'unobserved'
    ? terminatedCleanly
    : scenario.oracle === 'capture-only'
      ? terminatedCleanly && hookFired && scenario.candidateExpectedStatus !== 'supported'
      : // Capability-proving branch: two sub-cases distinguished by sentinelEffect.
        // With a declared effect: require responseConsumed AND terminal === 'ok'.
        // Without a declared effect: require responseConsumed AND terminatedCleanly
        // (error_max_turns is acceptable — the scenario proves a native refusal).
        scenario.sentinelEffect !== undefined
        ? responseConsumed && terminal === 'ok'
        : responseConsumed && terminatedCleanly;
}

/**
 * Resolves and checks a scenario-owned marker inside its disposable project.
 * @param projectDir - Disposable project root.
 * @param marker - Basename declared by the scenario.
 * @returns Whether the marker exists without accepting path traversal.
 */
export function markerPresent(projectDir: string, marker: string | undefined): boolean {
  return isProjectMarker(marker) && existsSync(path.join(projectDir, marker));
}

/**
 * Resolves and checks absence of a scenario-owned marker.
 * @param projectDir - Disposable project root.
 * @param marker - Basename declared by the scenario.
 * @returns Whether the marker is valid and absent.
 */
export function markerAbsent(projectDir: string, marker: string | undefined): boolean {
  return isProjectMarker(marker) && !existsSync(path.join(projectDir, marker));
}

/**
 * Validates a single scenario-owned filename without accepting the project root or traversal.
 * @param marker - Marker basename declared by a scenario.
 * @returns Whether the marker can safely be resolved below the disposable project.
 */
export function isProjectMarker(marker: string | undefined): marker is string {
  return marker !== undefined && marker !== '' && marker !== '.' && marker !== '..' && path.basename(marker) === marker;
}

/**
 * Tests a marker only in the provider's structured final assistant response.
 * Raw hook stdout, diagnostics, and echoed command input are deliberately not evidence.
 * @param provider - Provider whose machine-readable output format is parsed.
 * @param stdout - Complete bounded CLI stdout.
 * @param marker - Unique marker injected through the hook response.
 * @returns Whether a final assistant response contains the marker.
 */
export function finalResponseContainsMarker(
  provider: ProbeOptions['provider'],
  stdout: string,
  marker: string | undefined,
): boolean {
  if (!marker) return false;
  try {
    if (provider === 'claude-code') {
      const result = JSON.parse(stdout) as Record<string, unknown>;
      return result.type === 'result' && typeof result.result === 'string' && result.result.includes(marker);
    }
    return stdout
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return false;
        const item = event.item as Record<string, unknown>;
        return item.type === 'agent_message' && typeof item.text === 'string' && item.text.includes(marker);
      });
  } catch {
    return false;
  }
}

/**
 * Rejects a blocked-before-model proof when Codex reported a completed non-diagnostic item.
 * @param provider - Provider whose machine-readable output format is parsed.
 * @param stdout - Complete bounded CLI stdout.
 * @returns Whether completed items, if any, are only diagnostic errors.
 */
export function noCompletedAgentOrToolOutput(provider: ProbeOptions['provider'], stdout: string): boolean {
  if (provider !== 'codex') return false;
  try {
    return !stdout
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return false;
        return (event.item as Record<string, unknown>).type !== 'error';
      });
  } catch {
    return false;
  }
}
