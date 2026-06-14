import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue, WorkflowStateContext } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { createWorkflowStatePatch } from '../workflow-state-json-patch.js';

/**
 * Create a state context backed by the workflow state bus subjects.
 *
 * The returned context provides `get()` and `update()` methods that delegate to
 * `WorkflowSubjects.state.get` and `WorkflowSubjects.state.patch` respectively.
 *
 * The `update()` method applies the mutator to a structured clone of the current
 * state, then sends both JSON Patch operations and the full next value to the
 * engine for sequence-checked persistence.
 * @param executionId - Execution to bind the state context to
 * @param bus - Bus for state RPC calls
 * @returns A state context with `get()` and `update()` methods
 */
export function createWorkflowStateContext(executionId: string, bus: IMakaioBus): WorkflowStateContext<JsonValue> {
  return {
    async get(): Promise<JsonValue> {
      const result = await bus.request(WorkflowSubjects.state.get, {
        executionId,
      });
      return result.value;
    },

    async update(mutator: (draft: JsonValue) => JsonValue | void | Promise<JsonValue | void>): Promise<JsonValue> {
      // Get current state
      const current = await bus.request(WorkflowSubjects.state.get, {
        executionId,
      });

      // Apply mutator to a structured clone
      const draft = structuredClone(current.value);
      const replacement = await mutator(draft);
      const nextValue = replacement === undefined ? draft : replacement;
      const patch = createWorkflowStatePatch(current.value, nextValue);

      // Send the patch — use the full next value
      const result = await bus.request(WorkflowSubjects.state.patch, {
        executionId,
        expectedSequence: current.sequence,
        patch,
        nextValue,
      });

      return result.value;
    },
  };
}
