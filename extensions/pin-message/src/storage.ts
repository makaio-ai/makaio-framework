/**
 * \@makaio/extension-pin-message
 *
 * In-memory pin storage with bus subjects for session event actions.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import { createExtensionStorageNamespace } from '@makaio/storage-core';

// ============================================================================
// In-Memory Storage
// ============================================================================

/**
 * In-memory pin storage.
 *
 * Maps messageId to pin data.
 * For MVP: Non-persistent, reset on process restart.
 */
const pinStore = new Map<string, { sessionId: string; messageId: string; pinnedAt: number }>();

// ============================================================================
// Bus Subjects
// ============================================================================

/**
 * Pin storage namespace.
 *
 * Provides bus subjects for pin CRUD operations.
 * Domain: 'extension:pin-message' becomes 'storage:extension:pin-message'
 */
export const PinStorageNamespace = createExtensionStorageNamespace('pin-message', {
  schemas: {
    /**
     * Check if a message is pinned.
     *
     * Subject: storage:extension:pin-message.check
     * Type: Request (RPC)
     */
    check: {
      request: z.object({
        messageId: z.string(),
      }),
      response: z.object({
        isPinned: z.boolean(),
      }),
    },

    /**
     * Add a pin to a message.
     *
     * Subject: storage:extension:pin-message.add
     * Type: Request (RPC)
     */
    add: {
      request: z.object({
        sessionId: z.string(),
        messageId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Remove a pin from a message.
     *
     * Subject: storage:extension:pin-message.remove
     * Type: Request (RPC)
     */
    remove: {
      request: z.object({
        messageId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * List all pinned messages for a session.
     *
     * Subject: storage:extension:pin-message.list
     * Type: Request (RPC)
     */
    list: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        pinnedMessageIds: z.array(z.string()),
      }),
    },

    /**
     * Clear all pins for a session.
     *
     * Subject: storage:extension:pin-message.clear
     * Type: Request (RPC)
     */
    clear: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },
  },
});

/**
 * Typed subjects for pin storage operations.
 */
export const PinStorageSubjects = PinStorageNamespace.subjects;

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register pin storage handlers on the bus.
 *
 * This implements the in-memory storage backend for pin operations.
 * @param bus - Bus instance used to register handlers
 * @returns Cleanup function to unregister handlers
 */
export function registerPinStorage(bus: IMakaioBus): () => void {
  const cleanups: Array<() => void> = [];

  // Register CRUD handlers
  cleanups.push(registerCheckHandler(bus));
  cleanups.push(registerAddHandler(bus));
  cleanups.push(registerRemoveHandler(bus));
  cleanups.push(registerListHandler(bus));
  cleanups.push(registerClearHandler(bus));

  // Return cleanup function
  return () => {
    let firstError: unknown;
    let sawError = false;

    try {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch (error) {
          if (!sawError) {
            firstError = error;
          }
          sawError = true;
        }
      }
    } finally {
      cleanups.length = 0;
      pinStore.clear();
    }

    if (sawError) {
      throw firstError;
    }
  };
}

/**
 * Register the check handler.
 * @param bus - Bus instance used to register the handler
 * @returns Cleanup function
 */
function registerCheckHandler(bus: IMakaioBus): () => void {
  return bus.on(PinStorageSubjects.check, async ({ payload, setResult }) => {
    const { messageId } = payload;
    const isPinned = pinStore.has(messageId);
    setResult({ isPinned });
  });
}

/**
 * Register the add handler.
 * @param bus - Bus instance used to register the handler
 * @returns Cleanup function
 */
function registerAddHandler(bus: IMakaioBus): () => void {
  return bus.on(PinStorageSubjects.add, async ({ payload, setResult }) => {
    const { sessionId, messageId } = payload;
    pinStore.set(messageId, {
      sessionId,
      messageId,
      pinnedAt: Date.now(),
    });
    setResult({ success: true });
  });
}

/**
 * Register the remove handler.
 * @param bus - Bus instance used to register the handler
 * @returns Cleanup function
 */
function registerRemoveHandler(bus: IMakaioBus): () => void {
  return bus.on(PinStorageSubjects.remove, async ({ payload, setResult }) => {
    const { messageId } = payload;
    const deleted = pinStore.delete(messageId);
    setResult({ success: deleted });
  });
}

/**
 * Register the list handler.
 * @param bus - Bus instance used to register the handler
 * @returns Cleanup function
 */
function registerListHandler(bus: IMakaioBus): () => void {
  return bus.on(PinStorageSubjects.list, async ({ payload, setResult }) => {
    const { sessionId } = payload;
    const pinnedMessageIds: string[] = [];

    for (const [messageId, pin] of pinStore.entries()) {
      if (pin.sessionId === sessionId) {
        pinnedMessageIds.push(messageId);
      }
    }

    setResult({ pinnedMessageIds });
  });
}

/**
 * Register the clear handler.
 * @param bus - Bus instance used to register the handler
 * @returns Cleanup function
 */
function registerClearHandler(bus: IMakaioBus): () => void {
  return bus.on(PinStorageSubjects.clear, async ({ payload, setResult }) => {
    const { sessionId } = payload;
    for (const [messageId, pin] of pinStore.entries()) {
      if (pin.sessionId === sessionId) {
        pinStore.delete(messageId);
      }
    }
    setResult({ success: true });
  });
}
