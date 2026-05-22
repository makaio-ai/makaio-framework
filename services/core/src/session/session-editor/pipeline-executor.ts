import type { SessionMessage } from '@makaio/contracts';
import type { PipelineStep } from '../../session-editor/types.js';
import { actionRegistry } from './action-registry.js';

/**
 * Result of executing a pipeline.
 */
export interface PipelineResult {
  /** Final messages after all transformations */
  messages: SessionMessage[];
  /** Context JSON if any action produced one (last one wins) */
  contextJson?: Record<string, unknown>;
  /** Estimated token count */
  tokenEstimate?: number;
}

/**
 * Execute a pipeline of actions on messages.
 * Actions are executed in sequence, each receiving the output of the previous.
 *
 * The `context` object is merged into each step's `options` before the action
 * executes, allowing callers to inject session-level data (e.g. `sessionId`)
 * without requiring every pipeline step config to repeat it.
 * @param messages - Source messages
 * @param steps - Pipeline steps to execute
 * @param context - Optional session-level context merged into each step's options
 * @returns Final result after all steps
 */
export async function executePipeline(
  messages: SessionMessage[],
  steps: PipelineStep[],
  context?: Record<string, unknown>,
): Promise<PipelineResult> {
  let currentMessages = messages;
  let contextJson: Record<string, unknown> | undefined;
  let tokenEstimate: number | undefined;

  for (const step of steps) {
    const action = actionRegistry.get(step.actionId);
    if (!action) {
      throw new Error(`Unknown action: ${step.actionId}`);
    }

    const stepOptions: Record<string, unknown> = { ...context, ...step.options };
    const result = await action.execute(currentMessages, stepOptions);

    if (result.kind === 'messages') {
      currentMessages = result.messages;
    } else {
      // Context JSON is the final output - stop pipeline execution
      contextJson = result.json;
      tokenEstimate = result.tokenEstimate;
      currentMessages = [];
      break;
    }
  }

  // If no steps produced context JSON, estimate tokens from messages
  if (!contextJson && currentMessages.length > 0) {
    // Rough estimate: 4 chars per token
    const totalChars = currentMessages.reduce((sum, msg) => sum + JSON.stringify(msg.blocks).length, 0);
    tokenEstimate = Math.ceil(totalChars / 4);
  }

  return { messages: currentMessages, contextJson, tokenEstimate };
}
