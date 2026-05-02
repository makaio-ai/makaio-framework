/**
 * \@makaio/extension-pin-message
 *
 * Reference implementation package for session event actions.
 *
 * Demonstrates:
 * - Single-mode action: Pin Message (kebab menu, immediate execution)
 * - Multi-mode action: Summarize Selection (picker modal, selection feedback)
 * - In-memory storage with bus subjects (MVP, non-persistent)
 *
 * Storage is in-memory and resets on process restart.
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts/extension';
import { registerPinStorage } from './storage.js';
import { createActions } from './actions.js';

/**
 * Pin message package definition.
 *
 * Minimal reference implementation for session event actions.
 * The `create` factory registers in-memory pin storage handlers on the
 * provided bus and returns a service whose `destroy` cleans them up.
 */
export const PinMessagePackage: MakaioExtension = {
  name: 'pin-message',
  displayName: 'Pin Message',

  /**
   * Creates the package service.
   *
   * Registers in-memory pin storage handlers on the bus. Session event action
   * callback wiring is supplied later through the contribution context owned by
   * the session-event-action service package.
   * @param ctx - Package context with bus and environment info.
   * @returns Service with `destroy` lifecycle hook.
   */
  create: (ctx) => {
    const cleanup = registerPinStorage(ctx.bus);

    return {
      destroy: () => {
        cleanup();
      },
    };
  },

  /**
   * Session event actions provided by this package.
   *
   * Creates two actions:
   * - pin-message:pin (single-mode, immediate execution)
   * - pin-message:summarize (multi-mode, picker modal)
   */
  sessionEventActions: {
    createActions: (ctx) => createActions(ctx),
  },
};

// Default exports stay on the MakaioExtension contract.
export default PinMessagePackage;
