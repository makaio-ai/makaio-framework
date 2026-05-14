import type { MakaioBusLike, SubjectSchema } from '@makaio/core';
import type { Toolset } from '@makaio/tools-core';
import type { AdapterManifest } from './contribution-manifest.js';
import type { AdapterDefinitionContract } from './adapter-definition.js';
import type { ExtensionContext, NodeExtensionContext } from './extension-context.js';
import type {
  SessionEventActionContext,
  CreateSessionEventActionResult,
} from './contributions/session-event-action-types.js';
import type { HashTrigger } from './contributions/hash-trigger-types.js';
import type { TileDeclaration } from './contributions/tile-types.js';
import type { WidgetDeclaration } from './contributions/widget-types.js';
import type { PageDeclaration } from './contributions/page-types.js';
import type { ToolCallFormatterDeclaration } from './contributions/tool-formatter-types.js';
import type {
  MakaioWebUiRoute,
  MakaioWebUiActions,
  ExtensionConfigComponentLoader,
  ExtensionFieldTypeLoader,
} from './contributions/web-ui-types.js';

/**
 * Typed adapter contribution declared by an extension.
 *
 * The `manifest` field carries the adapter metadata that runtime processors
 * consume alongside the executable `definition`. Descriptor-level
 * `ExtensionManifest.contributions.adapters` may repeat this metadata for
 * pre-load discovery, but activation reads this executable surface.
 * @typeParam TAdapter - Concrete adapter instance type. Defaults to `unknown`
 *   for use in collections where the concrete type is not available.
 */
export interface AdapterContribution<TAdapter = unknown> {
  /** Runtime adapter metadata paired with the executable definition. */
  readonly manifest: AdapterManifest;
  /**
   * Full adapter runtime definition.
   *
   * Typed via {@link AdapterDefinitionContract} — the adapter subsystem
   * consumes this directly. The generic parameter allows higher-level types
   * (e.g., `AIAdapterDefinition`) to narrow the factory return type.
   */
  readonly definition: AdapterDefinitionContract<TAdapter>;
}

/**
 * Opaque log import contribution declared by an extension.
 *
 * Typed as `unknown` in the contracts layer to avoid importing from
 * `ai-adapters-core`. The log-import contribution processor narrows
 * this to `PluginLogImport` at processing time.
 */
export interface LogImportContribution {
  /** Adapter name for attribution (e.g. `'opencode'`). */
  readonly adapterName: string;
  /** Human-readable display name (e.g. `'OpenCode'`). */
  readonly displayName: string;
  /** Full log importer configuration, opaque in contracts. */
  readonly config: unknown;
}

/** Tool contribution surface declared by an extension. */
export interface ExtensionToolsContribution<THostContext extends ExtensionContext = NodeExtensionContext> {
  /**
   * Create toolsets for this extension.
   * @param ctx - Runtime context with bus, host details, and machine identity.
   * @returns Array of toolsets to register with `ToolRegistry`.
   */
  readonly createToolsets: (ctx: THostContext) => Toolset[];
}

/**
 * Hash trigger contribution surface declared by an extension.
 * @typeParam TBus - Host bus shape supplied by the runtime.
 */
export interface ExtensionTriggersContribution<TBus extends MakaioBusLike = MakaioBusLike> {
  /**
   * Create hash triggers for this extension.
   * @param bus - The bus instance for trigger operations.
   * @returns Array of hash triggers to register with `HashTriggerService`.
   */
  readonly createTriggers: (bus: TBus) => HashTrigger<TBus>[];
}

/**
 * Session event action contribution surface declared by an extension.
 * @typeParam TBus - Host bus shape supplied by the runtime.
 */
export interface ExtensionSessionEventActionsContribution<TBus extends MakaioBusLike = MakaioBusLike> {
  /**
   * Create session event actions for this extension.
   * @param ctx - Context with bus instance and extension metadata.
   * @returns Map of action ID to registration result (declaration + unregister).
   */
  readonly createActions: (ctx: SessionEventActionContext<TBus>) => Record<string, CreateSessionEventActionResult>;
}

/** Bus namespace introspection surface declared by an extension. */
export interface ExtensionNamespaceContribution {
  /**
   * Schema record for bus subject introspection.
   *
   * Keys are subject short-names; values are subject schema descriptors.
   */
  readonly schemas: Record<string, SubjectSchema>;
}

/** Browser UI contribution surface declared by an extension. */
export interface ExtensionUiContribution {
  /**
   * WebUI routes mounted under `/extensions/<extension-name>/`.
   *
   * Each route defines a path, an optional data loader, optional action
   * handlers, and a lazy-loaded React component.
   */
  readonly routes?: readonly MakaioWebUiRoute<unknown, MakaioWebUiActions | undefined>[];

  /**
   * Tile declarations for pane-placeable content.
   *
   * Tiles are registered with `TileRegistry` and shown in the "Add Pane"
   * palette. Each declaration includes metadata, an icon, and platform
   * renderers.
   */
  readonly tiles?: readonly TileDeclaration[];

  /**
   * Widget declarations for small dashboard cards.
   *
   * Widgets are registered in the global widget catalog. They are NOT pane
   * content — use `tiles` for pane-placeable content.
   */
  readonly widgets?: readonly WidgetDeclaration[];

  /**
   * Page declarations for the page registry and optional sidebar navigation.
   *
   * Pages are registered in the page registry. When `mode`, `level`, and
   * `component` are provided, the loader also registers the page in the
   * sidebar navigation (`PageDefinitionRegistry`).
   */
  readonly pages?: readonly PageDeclaration[];

  /**
   * Tool call formatter declarations.
   *
   * Formatters customize how specific tool calls are rendered in the chat
   * UI. Registered with `ToolCallFormatterRegistry` on extension load.
   */
  readonly toolFormatters?: readonly ToolCallFormatterDeclaration[];

  /**
   * Custom field type loaders for schema-driven forms.
   *
   * Maps field type identifiers to lazy-loaded React components that accept
   * `FormFieldProps`. Registered with `FormFieldRegistry` on extension load.
   * @example
   * ```typescript
   * fieldTypes: {
   *   'image-upload': () => import('./ui/ImageUploadField.js'),
   * }
   * ```
   */
  readonly fieldTypes?: Record<string, ExtensionFieldTypeLoader>;

  /**
   * Fully custom configuration component loader.
   *
   * When provided, the schema-driven form is bypassed entirely. Use this
   * for complex UIs where &gt;50% of fields need custom rendering.
   * @example
   * ```typescript
   * configComponent: () => import('./ui/CustomConfigPanel.js'),
   * ```
   */
  readonly configComponent?: ExtensionConfigComponentLoader;
}
