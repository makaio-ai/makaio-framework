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
