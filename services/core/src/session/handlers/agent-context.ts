/**
 * Pure helpers for {@link routeToAgents}: per-agent session context layering.
 */

import type { Message, SessionContext } from '@makaio/contracts';

/** Previous and new working directory of an agent that swapped connector. */
export interface CwdSwapMeta {
  previousCwd: string;
  newCwd: string;
}

/** Inputs layered into one agent's session context by {@link buildAgentContext}. */
export interface PerAgentContextInput {
  baseContext?: SessionContext;
  recoveryContext?: SessionContext;
  isRecovered: boolean;
  isSwapped: boolean;
  swapMeta?: CwdSwapMeta;
  /**
   * Pre-resolved CWD change message to inject, or undefined when notifications
   * are disabled or no swap occurred. Resolved once in `routeToAgents` before
   * the per-agent fan-out to avoid redundant preference lookups.
   */
  cwdMessage?: string;
  freshMessageHistory?: Message[];
}

/**
 * Build agent-specific session context by layering recovery/swap overlays.
 * @param input - Base and overlay context inputs for a single agent
 * @returns Final context for this agent, or undefined when no context applies
 */
export function buildAgentContext(input: PerAgentContextInput): SessionContext | undefined {
  const { baseContext, recoveryContext, isRecovered, isSwapped, swapMeta, cwdMessage, freshMessageHistory } = input;

  let agentContext = isRecovered && recoveryContext ? { ...baseContext, ...recoveryContext } : baseContext;
  if (!isSwapped) {
    // Keep non-swapped agents on their normal resume path.
    return agentContext;
  }

  const cwdChangeContext =
    swapMeta && cwdMessage !== undefined
      ? {
          cwdChange: {
            previousCwd: swapMeta.previousCwd,
            newCwd: swapMeta.newCwd,
            message: cwdMessage,
          },
        }
      : undefined;

  agentContext = {
    ...agentContext,
    hasConnectorSwap: true,
    ...(freshMessageHistory !== undefined && { messageHistory: freshMessageHistory }),
    ...(cwdChangeContext && {
      turnContext: {
        ...agentContext?.turnContext,
        ...cwdChangeContext,
      },
    }),
  };

  return agentContext;
}
