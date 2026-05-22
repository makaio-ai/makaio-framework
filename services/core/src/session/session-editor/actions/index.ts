import type { IMakaioBus } from '@makaio/bus-core';
import { actionRegistry } from '../action-registry.js';
import { stripToolOutputsAction } from './strip-tool-outputs.js';
import { stripReasoningAction } from './strip-reasoning.js';
import { messagesToContextAction } from './messages-to-context.js';
import { llmSummarizeAction } from './llm-summarize.js';
import { createLlmExtractAction } from './llm-extract.js';

/** Track if base (non-bus) actions have been registered */
let baseRegistered = false;
/** Track if bus-dependent actions have been registered */
let busRegistered = false;

/**
 * Register all built-in actions.
 * Call this at service startup. Safe to call multiple times.
 *
 * Base actions (no bus required) are registered once on first call.
 * Bus-dependent actions (e.g. llm-extract) are registered on the first
 * call that supplies a `bus` instance, independently of whether base
 * registration has already occurred.
 * @param bus - Optional bus instance. When provided, bus-dependent actions
 *   (e.g. llm-extract) are also registered. Existing callers that pass no
 *   args continue to work without change.
 */
export function registerBuiltInActions(bus?: IMakaioBus): void {
  if (!baseRegistered) {
    baseRegistered = true;
    actionRegistry.register(stripReasoningAction);
    actionRegistry.register(stripToolOutputsAction);
    actionRegistry.register(messagesToContextAction);
    actionRegistry.register(llmSummarizeAction);
  }
  if (bus && !busRegistered) {
    busRegistered = true;
    actionRegistry.register(createLlmExtractAction(bus));
  }
}

/**
 * Reset registration state.
 * @internal For testing only.
 */
export function resetBuiltInActionsRegistration(): void {
  baseRegistered = false;
  busRegistered = false;
}

export { stripReasoningAction, stripToolOutputsAction, messagesToContextAction, llmSummarizeAction };
