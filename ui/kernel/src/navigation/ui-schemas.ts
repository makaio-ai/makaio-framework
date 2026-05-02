import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import type { SurfaceType } from '@makaio/contracts';

/**
 * Zod schema for surface types, aligned with the canonical {@link SurfaceType}
 * union in `@makaio/contracts`.
 */
const SurfaceTypeSchema = z.enum(['electron', 'electrobun', 'web', 'mobile', 'tray']) satisfies z.ZodType<SurfaceType>;

/**
 * UI surface domain schemas.
 *
 * Covers lifecycle events emitted by web surfaces (React apps) to signal
 * rendering milestones. Surface-agnostic — any web surface (Electron, browser,
 * mobile) can emit these events.
 *
 * Each key becomes a subject identifier as: `ui.{key}`
 * @example
 * ```typescript
 * // Listen for any UI surface becoming ready
 * bus.on(UiSubjects.ready, (ctx) => {
 *   console.log(`${ctx.payload.surface} UI rendered`);
 * });
 * ```
 */
export const UiSchemas = {
  /**
   * Emitted when a web surface has mounted its React tree and is visually ready.
   *
   * Fired once per surface mount (deduplicated across React StrictMode
   * double-invocations). Consumers can use this to confirm that the UI is
   * actually rendered, not just that a window or tab was opened.
   *
   * Subject: `ui.ready`
   * Type: Event
   */
  ready: z.object({
    /** Which surface emitted the event */
    surface: SurfaceTypeSchema,
    /** Unix epoch ms when the surface mounted */
    timestamp: z.number(),
  }),
  /**
   * Request to navigate to a URL.
   *
   * Handlers at different priorities decide what to do with the intent:
   * - Electron main process (priority 100): parse URL, find-or-create window
   * - Browser app shell (priority 10): open URL via window.open()
   *
   * Subject: `ui.navigate`
   * Type: Request RPC
   */
  navigate: {
    request: z.object({
      /** Target URL path, e.g. '/project/abc-123' or '/control-center' */
      url: z.string().regex(/^\/(?!\/)/, 'url must be an internal app path starting with a single /'),
    }),
    response: z.object({
      /** What the handler did with the navigation intent */
      action: z.enum(['opened', 'focused', 'navigated']),
    }),
  },
  /**
   * Show the popover panel.
   *
   * Idempotent: when the popover is already visible this request is a no-op
   * and the popover remains open. When `x` / `y` are provided the popover is
   * anchored near that screen coordinate (e.g. the tray icon position); exact
   * placement and clamping are host-specific. When omitted the host chooses a
   * default position (typically centered on the primary display work area).
   *
   * Subject: `ui.popover.show`
   * Type: Request RPC
   */
  'popover.show': {
    request: z.object({
      /** Optional horizontal screen coordinate to anchor the popover. */
      x: z.number().optional(),
      /** Optional vertical screen coordinate to anchor the popover. */
      y: z.number().optional(),
    }),
    response: z.object({
      /** Whether the popover is now visible */
      shown: z.boolean(),
    }),
  },

  /**
   * Fired when the global keyboard shortcut is triggered.
   *
   * Reserved for external listeners (e.g. extensions on a separate bus
   * client) that want to react to the hotkey. The core Electron hotkey
   * handler uses `bus.request(ui.popover.show)` directly instead of
   * emitting this event, because local events don't fire local handlers
   * on the same bus instance.
   *
   * Subject: `ui.shortcut.triggered`
   * Type: Event
   */
  'shortcut.triggered': z.object({
    /** The accelerator string that was pressed (e.g. "Alt+CommandOrControl+M") */
    accelerator: z.string(),
  }),
} satisfies SchemaRecord;

/** Payload of the `ui.ready` event. */
export type UiReadyEvent = z.infer<(typeof UiSchemas)['ready']>;

/** Payload of the `ui.navigate` request. */
export type UiNavigateRequest = z.infer<(typeof UiSchemas)['navigate']['request']>;

/** Response from the `ui.navigate` RPC. */
export type UiNavigateResponse = z.infer<(typeof UiSchemas)['navigate']['response']>;

/** Possible navigation actions returned by `ui.navigate`. */
export type UiNavigateAction = UiNavigateResponse['action'];

/** Request payload for `ui.popover.show`. */
export type UiPopoverShowRequest = z.infer<(typeof UiSchemas)['popover.show']['request']>;

/** Response from `ui.popover.show`. */
export type UiPopoverShowResponse = z.infer<(typeof UiSchemas)['popover.show']['response']>;

/** Payload of the `ui.shortcut.triggered` event. */
export type UiShortcutTriggeredEvent = z.infer<(typeof UiSchemas)['shortcut.triggered']>;
