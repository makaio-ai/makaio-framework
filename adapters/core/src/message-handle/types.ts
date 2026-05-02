import type { SendMessageResultInnerResult, MessageOutcome, MessageDeliveryMode } from '@makaio/contracts';

/**
 * Result of a message operation.
 */
export type MessageResult = {
  result?: SendMessageResultInnerResult | null;
  error?: Error | string;
  outcome: MessageOutcome;
  /** Present when outcome='superseded': the messageId that replaced this one */
  supersededBy?: string;
  /** Present when outcome='merged': the messageId this was folded into */
  mergedInto?: string;
};

/**
 * Lifecycle states for a queued message.
 */
export type MessageState =
  | 'queued' // In queue, waiting for turn boundary
  | 'acknowledged' // SDK echoed message (isReplay received)
  | 'completed' // Result received for this message's turn
  | 'cancelled'; // Message was cancelled before submission

/**
 * Options for sending a message.
 */
export interface SendMessageOptions {
  /**
   * Custom identifier for message tracking (generated if not provided).
   */
  messageId?: string;

  /**
   * Controls delivery behavior.
   * @defaultValue 'enqueue'
   */
  deliveryMode?: MessageDeliveryMode;
}

/**
 * Processing state for agent orchestration.
 */
export type ProcessingState =
  | 'idle'
  | 'processing_started'
  | 'turn_started'
  | 'step_started'
  | 'step_finished'
  | 'turn_finished'
  | 'processing_finished'
  | 'active'
  | 'paused';
