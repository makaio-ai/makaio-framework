import type { ProcessingState } from '../message-handle/index.js';

const COMPLETION_STATES: Array<ProcessingState> = ['active', 'step_finished', 'turn_finished', 'processing_finished'];

/**
 * Calculate state transition prerequisites and determine if state is a completion state.
 * @param previousState - Current agent processing state
 * @param nextState - Target agent processing state
 * @returns State update metadata with prerequisites and completion flag, or null if no change
 */
export function getProcessingStateUpdates(previousState: ProcessingState, nextState: ProcessingState) {
  if (previousState === nextState) {
    return null;
  }

  const prerequisites: ProcessingState[] = [];

  switch (nextState) {
    case 'processing_started':
      // No prerequisites
      break;

    case 'turn_started':
      if (['idle', 'processing_finished', 'paused'].includes(previousState)) {
        prerequisites.push('processing_started');
      } else if (previousState === 'active') {
        prerequisites.push('processing_started');
      }
      break;

    case 'step_started':
      if (['idle', 'processing_finished', 'paused'].includes(previousState)) {
        prerequisites.push('processing_started', 'turn_started');
      } else if (previousState === 'active') {
        prerequisites.push('processing_started', 'turn_started');
      } else if (['processing_started', 'turn_finished'].includes(previousState)) {
        prerequisites.push('turn_started');
      }
      break;

    case 'step_finished':
      // No prerequisites
      break;

    case 'turn_finished':
      if (previousState === 'step_started') {
        prerequisites.push('step_finished');
      }
      break;

    case 'processing_finished':
      if (previousState === 'step_started') {
        prerequisites.push('step_finished', 'turn_finished');
      } else if (['turn_started', 'step_finished'].includes(previousState)) {
        prerequisites.push('turn_finished');
      }
      break;

    // idle, paused, active have no prerequisites
  }

  return {
    isCompletionState: COMPLETION_STATES.includes(nextState),
    statesToEmit: [...prerequisites, nextState],
  };
}
