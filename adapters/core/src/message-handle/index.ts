// Types - MessageDeliveryMode from contracts canonical source
export type { MessageDeliveryMode } from '@makaio/contracts';
export type {
  MessageHandleOptions,
  MessageResult,
  MessageState,
  SendMessageOptions,
  ProcessingState,
} from './types.js';

// MessageHandle class
export { markCompletedWithFinalResult, MessageHandle } from './message-handle.js';

// Fail-closed reading of terminal turn output
export { requireCompletedTurnText, TurnNotCompletedError } from './completed-turn-output.js';
export type { NonCompletedTurnResult } from './completed-turn-output.js';
