/**
 * Client-owned probe contract seam.
 *
 * The probe harness owns scenario scaffolding and the central evidence table.
 * It does not own what a provider's native hook response looks like — that is
 * client knowledge, and every client already implements it in the renderer its
 * `hook.handle` composer uses at runtime.
 *
 * A {@link ClientProbeContract} therefore derives its sentinel output from that
 * same renderer. The shape proven against a pinned binary and the shape emitted
 * in production cannot drift apart, because there is only one of them.
 * @packageDocumentation
 */

import type { ClientDefinition } from '@makaio/contracts';
import type { ScenarioOracle } from './types.js';

// ---------------------------------------------------------------------------
// Shared probe markers
// ---------------------------------------------------------------------------

/** Marker proving the provider consumed an injected hook response. */
export const RESPONSE_CONSUMED_MARKER = 'MAKAIO_PROBE_RESPONSE_CONSUMED';
/** Workspace marker written by the scenario's tool invocation. */
export const TOOL_MARKER = 'MAKAIO_PROBE_TOOL_MARKER';
/** Workspace marker a rewrite scenario must leave absent. */
export const ORIGINAL_MARKER = 'MAKAIO_PROBE_ORIGINAL_MARKER';
/** Workspace marker a rewrite scenario must produce. */
export const REWRITTEN_MARKER = 'MAKAIO_PROBE_REWRITTEN_MARKER';
/** Reason text injected by permission-denial scenarios. */
export const DENY_REASON = 'MAKAIO_PROBE_DENY';

const READ_PROBE_FILE_TOOL = 'Bash(cat MAKAIO_PROBE.md)';
const TOUCH_TOOL_MARKER_TOOL = `Bash(touch ${TOOL_MARKER})`;
const TEST_TOOL_MARKER_TOOL = `Bash(test -e ${TOOL_MARKER})`;

/** Tools pre-approved for an ordinary scenario. */
export const DEFAULT_ALLOWED_TOOLS = [READ_PROBE_FILE_TOOL, TOUCH_TOOL_MARKER_TOOL, TEST_TOOL_MARKER_TOOL] as const;
/** Tools pre-approved when the marker tool must not be natively pre-authorized. */
export const NO_TOOL_MARKER_ALLOWED_TOOLS = [READ_PROBE_FILE_TOOL, TEST_TOOL_MARKER_TOOL] as const;

/**
 * Prompt asking the model to create {@link TOOL_MARKER} through its shell tool.
 *
 * Shared rather than re-spelled per caller: the harness issues it as the
 * default `PreToolUse` prompt and a client contract reuses it for scenarios
 * whose oracle asserts the marker is *absent*. Both sides must name the same
 * sentinel — if one drifts, the oracle asserts against a file the prompt never
 * asked the model to create, and the probe passes for the wrong reason.
 */
export const TOOL_MARKER_PROMPT = `MAKAIO_PROBE_MARKER: use the shell tool to run \`touch ${TOOL_MARKER}\`, then reply probe-ack.`;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Client-owned probe shape for one declared effect on one declared event.
 *
 * Carries the native sentinel the capture shim writes to stdout plus the
 * observable oracle that decides whether the binary actually consumed it.
 */
export interface ProbeEffectScenario {
  /** Stable effect-specific fragment of the scenario id. */
  readonly suffix: string;
  /**
   * Native response the capture shim writes to stdout.
   *
   * Absent for baseline scenarios, which prove native behavior in the absence
   * of any injected response.
   */
  readonly sentinelOutput?: string;
  /** Observable native outcome required for a pass. */
  readonly oracle: ScenarioOracle;
  /** Overrides the generated scenario description. */
  readonly description?: string;
  /** Overrides the default marker-only prompt when the oracle needs a different action. */
  readonly prompt?: string;
  /** Overrides the pre-approved tool set. */
  readonly allowedTools?: readonly string[];
  /** Marker required in the provider's final response. */
  readonly expectedResponseMarker?: string;
  /** Workspace marker required after the run. */
  readonly expectedPresentMarker?: string;
  /** Workspace marker forbidden after the run. */
  readonly expectedAbsentMarker?: string;
}

/**
 * Everything the harness needs from a client to build its probe scenarios.
 *
 * Deliberately does **not** carry evidence status. Which effects are claimed
 * remains centrally owned so a client cannot widen its own contract; this
 * contract only answers how a claimed effect is rendered and observed.
 */
export interface ClientProbeContract {
  /** Stable client identifier. */
  readonly clientId: string;
  /** The client's static definition, source of declared hook events. */
  readonly definition: ClientDefinition;
  /**
   * Build the probe shape for one declared effect.
   * @param eventName - Native hook event being exercised.
   * @param effect - Declared capability whose native consumption is attempted.
   * @returns The client-owned probe shape for this effect.
   */
  scenarioForEffect(eventName: string, effect: string): ProbeEffectScenario;
  /**
   * Optional client-owned baseline scenarios that are not effect attempts.
   * @param eventName - Native hook event being exercised.
   * @returns Extra probe shapes, or an empty array.
   */
  baselineScenarios?(eventName: string): readonly ProbeEffectScenario[];
}
