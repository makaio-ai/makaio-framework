/**
 * Warning action dispatcher for extension health-warning toasts.
 *
 * Handles `toast.interacted` events emitted when users click action buttons on
 * extension-health-warning toasts. Routes each {@link ExtensionWarningAction}
 * kind to the appropriate bus operation:
 *
 * - `configure-integration` — dispatches `client:<id>.wiring.apply` at user
 *   scope via {@link bus.requestOptional}. Non-fatal: failures are logged.
 * - All other kinds — logged and skipped (not routable from the runtime layer).
 *
 * The dispatcher is purely functional: callers own the action map lifecycle and
 * pass a live reference so they can populate it before and clear it after use.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionWarningAction } from '@makaio/contracts';
import { ToastSubjects } from '@makaio/contracts/toast';

// ---------------------------------------------------------------------------
// Minimal wiring subject definition
// ---------------------------------------------------------------------------

/**
 * Minimal request payload shape for `client:<id>.wiring.apply`.
 *
 * Uses an index signature to satisfy the `UnknownRecord` constraint imposed by
 * `RequestMessagePayload<Request, Response>`. The known fields match the
 * intersection of the claude-code and codex `wiring.apply` request schemas.
 * `projectDir` is omitted because the coordinator always applies at user scope.
 */
type WiringApplyRequest = {
  /** Scope at which to install the wiring entries. */
  scope: string;
  /**
   * Makaio CLI command to embed in the installed hook entries.
   * Supplied by the host so framework runtime code never infers host
   * entrypoint paths from the current process.
   */
  makaioCommand: string;
  [key: string]: unknown;
};

/**
 * Minimal response payload shape for `client:<id>.wiring.apply`.
 *
 * Uses an index signature to satisfy the `UnknownRecord` constraint.
 */
type WiringApplyResponse = {
  /** Number of wiring entries that were newly installed. */
  applied: number;
  /** Number of entries that were already present and skipped. */
  skipped: number;
  [key: string]: unknown;
};

/**
 * Non-owning subject definition for `client:<clientId>.wiring.apply`.
 *
 * The shape is intentionally inlined rather than derived from the generic
 * {@link SubjectDefinition} type to avoid the `UnknownRecord` constraint that
 * prevents clean declaration of the known request/response fields.
 */
type WiringApplySubjectDef = {
  subject: 'wiring.apply';
  $meta: {
    namespace: `client:${string}`;
    isRequest: true;
    local: boolean;
    channel: boolean;
    payload: { request: WiringApplyRequest; response: WiringApplyResponse };
  };
};

/**
 * Build a non-owning subject definition for `client:<clientId>.wiring.apply`.
 *
 * Avoids importing from `@makaio/clients-core` to prevent the circular
 * dependency chain: `runtime → clients-core → services-core → runtime`.
 * Returns a plain object whose shape matches what the bus uses at runtime to
 * route requests: `subject` and `$meta.namespace`.
 * @param clientId - Stable client identifier (e.g. `'claude-code'`).
 * @returns Plain subject definition for the per-client wiring apply subject.
 */
function buildWiringApplySubjectDef(clientId: string): WiringApplySubjectDef {
  return {
    subject: 'wiring.apply',
    $meta: {
      namespace: `client:${clientId}` as `client:${string}`,
      isRequest: true,
      local: false,
      channel: false,
      payload: { request: {} as WiringApplyRequest, response: {} as WiringApplyResponse },
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stable action identifier for the single action button on health-warning toasts.
 *
 * Deterministic (not a UUID) so tests can assert the action shape without
 * random identifiers and so the coordinator can construct the action map key
 * before the button is clicked.
 */
export const WARNING_ACTION_ID = 'action';

// ---------------------------------------------------------------------------
// Action map key helpers
// ---------------------------------------------------------------------------

/**
 * Build the composite key used to look up an action in the warning action map.
 *
 * A single warning carries at most one action. The key encodes both the toast
 * identity and the action slot so the dispatcher can distinguish actions from
 * different warning toasts without relying on UUID ordering.
 * @param toastId - Toast identifier from `toast.show`.
 * @param actionId - Action button identifier from the `actions` array.
 * @returns Composite key string.
 */
export function buildActionMapKey(toastId: string, actionId: string): string {
  return `${toastId}:${actionId}`;
}

// ---------------------------------------------------------------------------
// Dispatcher registration
// ---------------------------------------------------------------------------

/**
 * Register a `toast.interacted` listener that routes extension-warning actions.
 *
 * The caller owns the {@link actionMap} lifecycle: populate it before emission
 * and clear it (or remove entries) after the warning is dismissed or the
 * coordinator shuts down.
 *
 * The listener is fire-and-forget: it handles the event internally and never
 * re-emits or throws to the bus.
 * @param bus - Bus instance to register the listener on.
 * @param actionMap - Live map from composite key (`toastId:actionId`) to action.
 * @param launcherCommand - Host-provided Makaio command written into client wiring.
 * @returns Cleanup function that unregisters the listener.
 */
export function registerWarningActionHandler(
  bus: IMakaioBus,
  actionMap: Map<string, ExtensionWarningAction>,
  launcherCommand: string,
): () => void {
  return bus.on(ToastSubjects.interacted, (ctx) => {
    const { toastId, actionId } = ctx.payload;
    const key = buildActionMapKey(toastId, actionId);
    const action = actionMap.get(key);
    if (!action) return;

    void dispatchWarningAction(bus, action, toastId, launcherCommand).catch((err) => {
      console.error(`[ExtensionCoordinator] Warning action dispatch failed for toast "${toastId}":`, err);
    });
  });
}

// ---------------------------------------------------------------------------
// Action routing
// ---------------------------------------------------------------------------

/**
 * Dispatch a single extension-warning action to the appropriate bus operation.
 *
 * Only `configure-integration` is routable from the runtime layer. Other kinds
 * are logged at info level because they require a UI surface or an external
 * runtime capability not available in the headless coordinator.
 * @param bus - Bus instance used to dispatch the action.
 * @param action - Extension warning action to execute.
 * @param toastId - Toast identifier for diagnostic logging.
 * @param launcherCommand - Host-provided Makaio command written into client wiring.
 */
async function dispatchWarningAction(
  bus: IMakaioBus,
  action: ExtensionWarningAction,
  toastId: string,
  launcherCommand: string,
): Promise<void> {
  switch (action.kind) {
    case 'configure-integration': {
      await applyClientWiring(bus, action.clientId, toastId, launcherCommand);
      break;
    }
    case 'open-url': {
      console.info(
        `[ExtensionCoordinator] Toast "${toastId}" open-url action not routable from runtime layer: ${action.url}`,
      );
      break;
    }
    case 'run-command': {
      console.info(
        `[ExtensionCoordinator] Toast "${toastId}" run-command action not routable from runtime layer: ${action.command}`,
      );
      break;
    }
    case 'install-extension': {
      console.info(
        `[ExtensionCoordinator] Toast "${toastId}" install-extension action not routable from runtime layer: ${action.extensionName}`,
      );
      break;
    }
    default: {
      assertNever(action);
    }
  }
}

/**
 * Enforce exhaustive handling for discriminated unions.
 * @param value - Unreachable value left after all known variants are handled.
 * @returns Never returns; throws for malformed runtime data.
 */
function assertNever(value: never): never {
  throw new Error(`[ExtensionCoordinator] Unsupported warning action: ${JSON.stringify(value)}`);
}

/**
 * Dispatch `client:<clientId>.wiring.apply` for a `configure-integration` action.
 *
 * Uses `requestOptional` so missing client handlers (e.g. the client package is
 * not loaded in headless mode) are non-fatal. The result is logged for
 * diagnostic purposes; errors are surfaced as console warnings.
 * @param bus - Bus instance for the request.
 * @param clientId - Client identifier from the `configure-integration` action.
 * @param toastId - Toast identifier for diagnostic logging.
 * @param launcherCommand - Host-provided Makaio command written into client wiring.
 */
async function applyClientWiring(
  bus: IMakaioBus,
  clientId: string,
  toastId: string,
  launcherCommand: string,
): Promise<void> {
  const subjectDef = buildWiringApplySubjectDef(clientId);

  const result = await bus.requestOptional(subjectDef, {
    scope: 'user',
    makaioCommand: launcherCommand,
  });

  if (!result.handled) {
    console.warn(
      `[ExtensionCoordinator] Toast "${toastId}" configure-integration: ` +
        `no wiring handler for client "${clientId}". Is the client package loaded?`,
    );
    return;
  }

  const { applied, skipped } = result.data;
  console.info(
    `[ExtensionCoordinator] Toast "${toastId}" configure-integration: ` +
      `wired client "${clientId}" — ${applied} applied, ${skipped} skipped.`,
  );
}
