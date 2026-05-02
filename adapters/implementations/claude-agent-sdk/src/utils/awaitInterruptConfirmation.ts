import { ClaudeCodeConnectorSubjects } from '../namespace/index.js';
import type { SDKMessage, SDKUserMessage } from '@makaio/client-claude-code';
import { ClaudeSdkConnector } from '../connector.js';
import { EventContext } from '@makaio/core';

/**
 * Check if message content contains 'interrupted' text.
 * @param msg - SDK user message to check
 * @returns True if message contains interrupted confirmation
 */
function isInterruptedMessage(msg: SDKUserMessage): boolean {
  if (!msg.message?.content) return false;

  if (typeof msg.message.content === 'string') {
    return msg.message.content.includes('interrupted');
  }
  const first = msg.message.content[0];
  return first.type === 'text' && first.text.includes('interrupted');
}

/**
 * Type guard to check if an SDK message is a user message.
 * @param msg - SDK message to check
 * @returns True if message is a user message
 */
function isUserMessage(msg: SDKMessage): msg is SDKUserMessage {
  return msg.type === 'user';
}

/**
 * Wait for user message containing 'interrupted' text to confirm interrupt was processed.
 * @param connector - The ClaudeSdkConnector to listen for events on
 * @param sessionId - Session identifier to filter messages
 */
export async function awaitInterruptConfirmation(connector: ClaudeSdkConnector, sessionId: string): Promise<void> {
  // Wait for SDK events and filter for user messages with interrupt confirmation
  while (true) {
    // Type assertion needed due to complex type inference with union schemas
    const ctx = (await connector.once(ClaudeCodeConnectorSubjects.sdk.event, {
      filter: { type: 'user', session_id: sessionId },
    })) as EventContext<SDKMessage>;
    const payload = ctx.payload;

    // Check for interrupt confirmation in user message
    if (isUserMessage(payload) && isInterruptedMessage(payload)) {
      return;
    }
    // Continue waiting for next message
  }
}
