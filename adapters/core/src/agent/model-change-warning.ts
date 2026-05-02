import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';

/**
 * Input for the model-change confirmation flow.
 */
interface ModelChangeWarningInput {
  /** Bus instance used for dispatching the validation RPC. */
  bus: IMakaioBus;
  /** Stable identifier of the agent whose connector is about to swap. */
  agentId: string;
  /** Model identifier currently active on the agent. */
  currentModel: string;
  /** Model identifier the agent is switching to. */
  nextModel: string;
  /**
   * When `true`, bypass the validation RPC entirely.
   *
   * Trusted/programmatic callers (e.g. headless orchestration) set this to
   * skip any interactive dialog registered by the host layer.
   */
  skipWarning?: boolean;
}

/**
 * Result from the model-change confirmation flow.
 */
interface ModelChangeWarningResult {
  /** Whether the connector swap should proceed. */
  proceed: boolean;
  /** Whether the host handler requested an edit-history fork. */
  requestEditHistory: boolean;
}

/**
 * Runs the optional model-change validation flow via the bus.
 *
 * Framework never imports host UI subjects. Instead it emits
 * `agent.validateModelChange` and lets an optional host handler
 * decide whether the swap should proceed and whether to request an
 * edit-history fork.
 *
 * - If `skipWarning` is set, the change is auto-approved.
 * - If no handler is registered (`!result.handled`), the change is auto-approved.
 *   This is the correct behaviour for OSS / headless mode.
 * - Otherwise the handler's decision is forwarded to the caller.
 * @param input - Model change warning inputs
 * @returns Whether the swap should proceed and whether to request edit history
 */
export async function confirmModelChange(input: ModelChangeWarningInput): Promise<ModelChangeWarningResult> {
  const { bus, agentId, currentModel, nextModel, skipWarning } = input;

  if (skipWarning) {
    return { proceed: true, requestEditHistory: false };
  }

  // requestOptional intentionally propagates non-NoHandlerError exceptions.
  // Silently approving a model change when the registered validator crashes
  // would be a worse failure mode; callers should handle propagated errors.
  const result = await bus.requestOptional(AgentSubjects.validateModelChange, {
    agentId,
    currentModel,
    nextModel,
  });

  if (!result.handled) {
    // No validator registered (OSS / headless) — allow by default.
    return { proceed: true, requestEditHistory: false };
  }

  return {
    proceed: result.data.proceed,
    requestEditHistory: result.data.requestEditHistory ?? false,
  };
}
