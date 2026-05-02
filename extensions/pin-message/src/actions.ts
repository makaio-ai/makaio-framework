/**
 * \@makaio/extension-pin-message
 *
 * Session event actions: Pin Message (single) and Summarize Selection (multi).
 * @packageDocumentation
 */

import type { SessionEventActionContext } from '@makaio/contracts/extension';
import { PinStorageSubjects } from './storage.js';

// ============================================================================
// Single-Mode Action: Pin Message
// ============================================================================

/**
 * Create the Pin Message action.
 *
 * Single-mode action that pins/unpins a message when clicked.
 * Shows in kebab menu for user and assistant messages.
 * Only shows if message is not already pinned.
 * @param ctx - Session event action context
 * @returns Action registration result (declaration + unregister)
 */
export function createPinMessageAction(ctx: SessionEventActionContext) {
  return ctx.createAction({
    id: 'pin-message:pin',
    label: 'Pin message',
    icon: 'pin',
    entrypoint: {
      messageRole: ['user', 'assistant'],
    },
    selectionMode: 'single',

    /**
     * Check if action should appear in menu for this message.
     * Only show if not already pinned.
     * @param whenCtx - When context with message and bus
     * @returns Whether to show the action
     */
    when: async (whenCtx) => {
      const { isPinned } = await whenCtx.bus.request(PinStorageSubjects.check, {
        messageId: whenCtx.message.messageId,
      });
      return !isPinned;
    },

    /**
     * Execute the pin action.
     * Adds the message to the pin store.
     * @param execCtx - Execute context with entrypoint and session info
     * @returns Execution result
     */
    onExecute: async (execCtx) => {
      await execCtx.bus.request(PinStorageSubjects.add, {
        sessionId: execCtx.sessionId,
        messageId: execCtx.entrypoint.messageId,
      });
      return { success: true };
    },
  });
}

// ============================================================================
// Multi-Mode Action: Summarize Selection
// ============================================================================

/**
 * Create the Summarize Selection action.
 *
 * Multi-mode action that opens a picker modal to select multiple messages,
 * then provides a summary of the selection with token estimates.
 * Demonstrates the onSelectionChange callback for real-time feedback.
 * @param ctx - Session event action context
 * @returns Action registration result (declaration + unregister)
 */
export function createSummarizeSelectionAction(ctx: SessionEventActionContext) {
  return ctx.createAction({
    id: 'pin-message:summarize',
    label: 'Summarize messages',
    icon: 'file-text',
    entrypoint: {
      messageRole: ['assistant'],
    },
    selectionMode: 'multi',
    applicableTo: [{ eventType: 'message', messageRole: ['user', 'assistant'] }],

    /**
     * Called as user changes selection in picker modal.
     * Provides token estimate and warnings for large selections.
     * @param selCtx - Selection change context with selected events
     * @returns Selection feedback (token estimate, warnings)
     */
    onSelectionChange: async (selCtx) => {
      const count = selCtx.selectedEvents.length;
      const tokenEstimate = count * 200;

      return {
        tokenEstimate,
        warning: count > 20 ? `Large selection (${count} messages) may be slow to process` : undefined,
      };
    },

    /**
     * Execute the summarize action.
     * Logs the selection (placeholder for actual summarization).
     * @param execCtx - Execute context with selected events
     * @returns Execution result
     */
    onExecute: async (execCtx) => {
      console.debug(`[pin-message] Summarizing ${execCtx.selectedEvents?.length ?? 0} messages`);
      return { success: true };
    },
  });
}

// ============================================================================
// Action Factory
// ============================================================================

/**
 * Create all session event actions for the pin-message plugin.
 * @param ctx - Session event action context
 * @returns Map of action ID to registration result
 */
export function createActions(ctx: SessionEventActionContext) {
  return {
    'pin-message:pin': createPinMessageAction(ctx),
    'pin-message:summarize': createSummarizeSelectionAction(ctx),
  };
}
