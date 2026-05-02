import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Validates the `{packageName}:{windowId}` format required for all window
 * registration ID fields. Both segments must be non-empty strings separated
 * by a single colon.
 * @example `'my-package.project-window:main'`
 */
const WindowRegistrationIdSchema = z.string().refine(
  (value) => {
    const parts = value.split(':');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  },
  { message: 'registrationId must be "{packageName}:{windowId}"' },
);

/**
 * Shared schema for manifest-declared window route/context params.
 *
 * Kept in one place so window state, lifecycle events, and create RPCs stay
 * aligned when the param contract changes.
 */
const WindowParamsSchema = z.record(z.string(), z.string()).optional();

/**
 * Desktop host window state snapshot.
 *
 * `registrationId` is the qualified window ID from the package registry
 * (`{packageName}:{windowId}`) and replaces the former static `WindowType`
 * enum field. The numeric `windowId` remains the host-assigned instance ID.
 */
export const WindowStateSchema = z.object({
  /** Unique window identifier assigned by the host runtime */
  windowId: z.number().int().nonnegative(),
  /** Qualified window registration ID: `{packageName}:{windowId}`. */
  registrationId: WindowRegistrationIdSchema,
  /**
   * Context parameters associated with the window.
   * Keys are param names declared by the window manifest (e.g. `projectId`,
   * `sessionId`).
   */
  params: WindowParamsSchema,
  /** Display label (project name, chat preview, or window title) */
  label: z.string().optional(),
  /** Whether the window is currently visible */
  visible: z.boolean(),
  /** Whether the window is currently focused */
  focused: z.boolean(),
});

/**
 * Host shell domain schemas.
 *
 * Cross-cutting RPCs that any host shell (Electron, Electrobun, browser)
 * should implement. Framework UI packages import these subjects directly
 * from `@makaio/contracts` instead of reaching into a specific host app.
 *
 * Covers window lifecycle events (host → bus) consumed by the tray,
 * and window management RPCs (bus → host) issued by the tray.
 */
export const HostSchemas = {
  // ───────────────────────────────────────────────────────────────────────────
  // Events (host → bus, consumed by tray)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Emitted when a new desktop window is opened.
   *
   * Subject: `host.window.opened`
   * Type: Event
   */
  'window.opened': z.object({
    /** Unique window identifier assigned by the host runtime */
    windowId: z.number().int().nonnegative(),
    /** Qualified window registration ID: `{packageName}:{windowId}`. */
    registrationId: WindowRegistrationIdSchema,
    /**
     * Context parameters associated with the window.
     * Keys are param names declared by the window manifest.
     */
    params: WindowParamsSchema,
    /** Initial display label, if known at open-time (e.g. project name) */
    label: z.string().optional(),
    /** Whether the window starts visible */
    visible: z.boolean(),
    /** Whether the window starts focused */
    focused: z.boolean(),
  }),

  /**
   * Emitted when a desktop window is closed.
   *
   * Subject: `host.window.closed`
   * Type: Event
   */
  'window.closed': z.object({
    /** Unique window identifier assigned by the host runtime */
    windowId: z.number().int().nonnegative(),
    /** Qualified window registration ID at the time of close. */
    registrationId: WindowRegistrationIdSchema,
    /**
     * Context parameters at the time of close, if any.
     * Keys are param names declared by the window manifest.
     */
    params: WindowParamsSchema,
  }),

  /**
   * Emitted by the web UI when a window's display label changes — for example,
   * when a project name becomes available or when the first message of a chat
   * session is typed.
   *
   * The host main process listens for this event and calls
   * `WindowManager.updateLabel` so the internal registry stays current.
   * Because the event is on the shared bus, the tray handler can also
   * react to it (e.g. to update the tray menu item label) without any
   * additional wiring.
   *
   * Subject: `host.window.labelChanged`
   * Type: Event
   */
  'window.labelChanged': z.object({
    /** Unique window identifier assigned by the host runtime */
    windowId: z.number().int().nonnegative(),
    /** Updated display label (project name or first-message preview) */
    label: z.string(),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // RPCs (tray → bus → host)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a new desktop window identified by its registry registration ID.
   *
   * Subject: `host.window.create`
   * Type: Request (RPC)
   */
  'window.create': {
    request: z.object({
      /** Qualified window registration ID: `{packageName}:{windowId}`. */
      registrationId: WindowRegistrationIdSchema,
      /**
       * Context parameters to associate with the new window.
       * Keys are param names declared by the window manifest
       * (e.g. `{ projectId: 'abc-123' }`).
       */
      params: WindowParamsSchema,
    }),
    response: z.object({
      /** Unique window identifier assigned to the newly created window */
      windowId: z.number().int().nonnegative(),
    }),
  },

  /**
   * Focus an existing window. If no `windowId` is provided, focuses the
   * most recently active window.
   *
   * Subject: `host.window.focus`
   * Type: Request (RPC)
   */
  'window.focus': {
    request: z.object({
      /** Window to focus; omit to focus the most recently active window */
      windowId: z.number().int().nonnegative().optional(),
    }),
    response: z.object({
      /** Whether a window was successfully focused */
      success: z.boolean(),
    }),
  },

  /**
   * List all currently open desktop windows with their current state.
   *
   * Subject: `host.window.list`
   * Type: Request (RPC)
   */
  'window.list': {
    request: z.object({}),
    response: z.object({
      /** Snapshot of all open windows */
      windows: z.array(WindowStateSchema),
    }),
  },

  /**
   * Open (or focus) the primary dashboard window managed by the host shell.
   *
   * Request: empty — the handler knows the dashboard registration ID.
   * Response: `windowId` — the host-assigned window ID, or `null` when no
   * window could be created or focused.
   *
   * Subject: `host.window.openDashboard`
   * Type: Request (RPC)
   */
  'window.openDashboard': {
    // Bare z.object({}) is intentional — matches the 30+ empty-request
    // schemas across contracts. .strict() would be the sole exception and
    // breaks the extendSubject() widening seam used by other namespaces.
    request: z.object({}),
    response: z.object({ windowId: z.number().nullable() }),
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tray popover (tray click → host)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Activate the tray popover panel. Fired when the user
   * left-clicks the tray icon.
   *
   * The response tells whether the host handled the click.
   * When `handled` is `true`, suppress the native menu.
   * This is `true` for both showing and dismissing the popover (toggle).
   *
   * Subject: `host.tray.activate`
   * Type: Request (RPC)
   */
  'tray.activate': {
    request: z.object({}),
    response: z.object({
      /** Whether the host handled the click (suppresses native menu) */
      handled: z.boolean(),
    }),
  },

  /**
   * Focus the application: bring an existing window to front, or open the
   * default shell window if none are open.
   *
   * Used by: second-instance detection (Electrobun health-probe),
   * `makaio open` CLI command, Electron `second-instance` event.
   *
   * Subject: `host.app.focus`
   * Type: Request (RPC)
   */
  'app.focus': {
    request: z.object({}),
    response: z.object({
      /** Whether the app was successfully focused or a window created. */
      focused: z.boolean(),
      /** The host-assigned window ID that was focused/created, or null on failure. */
      windowId: z.number().int().nonnegative().nullable(),
    }),
  },
} satisfies SchemaRecord;

// ── Type exports ──────────────────────────────────────────────────────────────

/** State snapshot for a single desktop window. */
export type WindowState = z.infer<typeof WindowStateSchema>;

/** Payload of the `host.window.opened` event. */
export type WindowOpenedEvent = z.infer<(typeof HostSchemas)['window.opened']>;

/** Payload of the `host.window.closed` event. */
export type WindowClosedEvent = z.infer<(typeof HostSchemas)['window.closed']>;

/** Payload of the `host.window.labelChanged` event. */
export type WindowLabelChangedEvent = z.infer<(typeof HostSchemas)['window.labelChanged']>;

/** Request payload for `host.window.create`. */
export type WindowCreateRequest = z.infer<(typeof HostSchemas)['window.create']['request']>;

/** Response payload for `host.window.create`. */
export type WindowCreateResponse = z.infer<(typeof HostSchemas)['window.create']['response']>;

/** Request payload for `host.window.focus`. */
export type WindowFocusRequest = z.infer<(typeof HostSchemas)['window.focus']['request']>;

/** Response payload for `host.window.focus`. */
export type WindowFocusResponse = z.infer<(typeof HostSchemas)['window.focus']['response']>;

/** Request payload for `host.window.list`. */
export type WindowListRequest = z.infer<(typeof HostSchemas)['window.list']['request']>;

/** Response payload for `host.window.list`. */
export type WindowListResponse = z.infer<(typeof HostSchemas)['window.list']['response']>;

/** Request payload for `host.tray.activate`. */
export type TrayActivateRequest = z.infer<(typeof HostSchemas)['tray.activate']['request']>;

/** Response payload for `host.tray.activate`. */
export type TrayActivateResponse = z.infer<(typeof HostSchemas)['tray.activate']['response']>;

/** Request payload for `host.app.focus`. */
export type AppFocusRequest = z.infer<(typeof HostSchemas)['app.focus']['request']>;

/** Response payload for `host.app.focus`. */
export type AppFocusResponse = z.infer<(typeof HostSchemas)['app.focus']['response']>;
