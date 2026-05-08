import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { localSubject } from '@makaio/bus-core';

/**
 * Widget scope schema.
 *
 * Defines where a widget can appear.
 *
 * Built-in scopes:
 * - `global`: No host-specific context required
 * - `any`: Works everywhere
 *
 * Host and plugin scopes are allowed when declared through `UiScopeMap`
 * and registered via WidgetScopeRegistry.
 */
const WidgetScopeSchema = z.string();

/**
 * Widget size schema.
 *
 * Defines the supported sizes for widgets:
 * - `small`: Compact widget
 * - `medium`: Standard widget
 * - `large`: Expanded widget
 * - `full-width`: Full-width widget
 */
const WidgetSizeSchema = z.enum(['small', 'medium', 'large', 'full-width']);

/**
 * Widget activation schema.
 *
 * Function fields such as `onActivate` and React component fields are
 * same-process only. The widget subjects are local, so preserving callable
 * values through the register/list seam is valid and required for renderer
 * activation to keep working after bus-backed registration.
 */
const WidgetActivationSchema = z.object({
  /** Page ID to open in the current window. */
  pageId: z.string().optional(),
  /** Host window registration ID to create or focus. */
  windowId: z.string().optional(),
  /** Optional same-process custom activation handler. */
  onActivate: z
    .unknown()
    .refine((value) => typeof value === 'function', {
      message: 'onActivate must be a function',
    })
    .optional(),
});

/**
 * Widget definition schema.
 *
 * Note: `component` is `z.unknown()` because React components are not
 * serializable. This matches the capability pattern where providers
 * use `z.unknown()`. The bus is same-process so serialization isn't needed.
 * @param id - Unique widget identifier
 * @param name - Display name
 * @param scope - Where this widget can appear
 * @param description - Short description (optional)
 * @param supportedSizes - Array of supported sizes
 * @param defaultSize - Default size when added to a slot
 * @param component - React component to render (non-serializable)
 * @param defaultConfig - Default configuration (optional)
 * @param allowMultiple - Whether multiple instances are allowed
 */
const WidgetDefinitionSchema = z.object({
  /** Unique widget identifier */
  id: z.string(),
  /** Display name */
  name: z.string(),
  /** Where this widget can appear (single scope or array of scopes) */
  scope: z.union([WidgetScopeSchema, z.array(WidgetScopeSchema)]),
  /** Short description */
  description: z.string().optional(),
  /** Supported sizes */
  supportedSizes: z.array(WidgetSizeSchema),
  /** Default size when added to a slot */
  defaultSize: WidgetSizeSchema,
  /** React component to render (non-serializable) */
  component: z.unknown().refine((value) => value !== undefined, {
    message: 'component is required',
  }),
  /** Default configuration */
  defaultConfig: z.unknown().optional(),
  /** Whether multiple instances are allowed */
  allowMultiple: z.boolean().optional(),
  /** Optional activation behaviour for widget clicks. */
  activate: WidgetActivationSchema.optional(),
});

/**
 * Unregister payload schema.
 */
const UnregisterSchema = z.object({
  /** Widget ID to unregister */
  widgetId: z.string(),
});

/**
 * Widget activated payload schema.
 *
 * Emitted when a user clicks an activatable widget (one that has an `activate`
 * field on its `WidgetDefinition`). This is a renderer-scoped local event and
 * is never forwarded to transports.
 * @param widgetId - The widget definition ID
 * @param instanceId - The specific widget instance ID within the layout
 */
const ActivatedPayloadSchema = z.object({
  /** Widget definition ID */
  widgetId: z.string(),
  /** Widget instance ID within the layout */
  instanceId: z.string(),
});

/**
 * List request/response schemas.
 */
const ListRequestSchema = z.object({
  /** Widget scope to filter by */
  scope: WidgetScopeSchema.optional(),
});

const ListResponseSchema = z.object({
  /** Array of widget definitions */
  widgets: z.array(WidgetDefinitionSchema),
});

/**
 * Widget domain schemas.
 *
 * Subjects for widget-related bus communication.
 * Each key becomes a subject identifier as: `widget.{key}`
 *
 * All widget subjects are marked as local because widget definitions contain
 * React components which cannot be serialized for transport (SharedWorker, WebSocket).
 * @example
 * ```typescript
 * // List all global widgets
 * const result = await bus.request(WidgetSubjects.list, {
 *   scope: 'global',
 * });
 * ```
 */
export const WidgetSchemas = {
  /**
   * Register a widget.
   *
   * Subject: `widget.register`
   * Type: Local event (fire-and-forget, never sent to transports)
   * Purpose: Plugins or built-in widgets emit this to register themselves.
   * @example
   * ```typescript
   * bus.emit(WidgetSubjects.register, {
   *   id: 'project-picker',
   *   name: 'Project Picker',
   *   scope: 'global',
   *   supportedSizes: ['small', 'medium'],
   *   defaultSize: 'medium',
   *   component: ProjectPickerComponent,
   * });
   * ```
   */
  register: localSubject(WidgetDefinitionSchema),

  /**
   * Unregister a widget.
   *
   * Subject: `widget.unregister`
   * Type: Local event (fire-and-forget, never sent to transports)
   * Purpose: Remove a widget from the registry by ID.
   * @param widgetId - Widget ID to unregister
   * @example
   * ```typescript
   * bus.emit(WidgetSubjects.unregister, {
   *   widgetId: 'project-picker',
   * });
   * ```
   */
  unregister: localSubject(UnregisterSchema),

  /**
   * List all registered widgets.
   *
   * Subject: `widget.list`
   * Type: Local request (RPC, never sent to transports)
   * Purpose: Query available widgets, optionally filtered by scope.
   * @param scope - Widget scope to filter by (optional)
   * @returns Array of widget definitions
   * @example
   * ```typescript
   * // List all widgets
   * const allWidgets = await bus.request(WidgetSubjects.list, {});
   *
   * // List only global widgets
   * const globalWidgets = await bus.request(WidgetSubjects.list, {
   *   scope: 'global',
   * });
   * ```
   */
  list: localSubject({
    request: ListRequestSchema,
    response: ListResponseSchema,
  }),

  /**
   * Emitted when a user activates a widget by clicking it.
   *
   * Subject: `widget.activated`
   * Type: Local event (fire-and-forget, never sent to transports)
   * Purpose: Signals that a widget with an `activate` field was clicked.
   *   Consumers (e.g. analytics, debug tooling) can subscribe to this event
   *   to observe widget activation without coupling to the grid implementation.
   * @param widgetId - The widget definition ID
   * @param instanceId - The widget instance ID within the layout
   * @example
   * ```typescript
   * bus.on(WidgetSubjects.activated, (ctx) => {
   *   console.log(`Widget activated: ${ctx.payload.widgetId}`);
   * });
   * ```
   */
  activated: localSubject(ActivatedPayloadSchema),
} satisfies SchemaRecord;

/**
 * Raw (unwrapped) schemas for direct validation in tests.
 *
 * Use these for schema validation tests. For bus communication,
 * use WidgetSubjects from namespace.ts.
 * @internal
 */
export const WidgetRawSchemas = {
  register: WidgetDefinitionSchema,
  unregister: UnregisterSchema,
  list: {
    request: ListRequestSchema,
    response: ListResponseSchema,
  },
  activated: ActivatedPayloadSchema,
} as const;

/**
 * Type exports for external use.
 *
 * These types are inferred from the Zod schemas and provide
 * type safety when working with widget-related bus messages.
 */
export type WidgetDefinitionPayload = z.infer<typeof WidgetDefinitionSchema>;
export type WidgetScope = z.infer<typeof WidgetScopeSchema>;
export type UnregisterPayload = z.infer<typeof UnregisterSchema>;
export type ListWidgetsRequest = z.infer<typeof ListRequestSchema>;
export type ListWidgetsResponse = z.infer<typeof ListResponseSchema>;
/** Payload of the `widget.activated` event. */
export type WidgetActivatedPayload = z.infer<typeof ActivatedPayloadSchema>;
