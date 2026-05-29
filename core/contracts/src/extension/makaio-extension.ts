import type { z } from 'zod';
import type { MakaioBusLike, RegistrableBusNamespaceDefinition } from '@makaio/core';
import type { ExtensionManifest, StorageManifest } from './manifest.js';
import type { ExtensionContext, NodeExtensionContext } from './extension-context.js';
import type { ExtensionService } from './extension-lifecycle.js';
import type { ExtensionRuntimeOwnership } from './extension-runtime-boot.js';
import type { ExtensionCliContribution } from './extension-cli.js';
import type {
  AdapterContribution,
  ExtensionNamespaceContribution,
  ExtensionSessionEventActionsContribution,
  ExtensionToolsContribution,
  ExtensionTriggersContribution,
  ExtensionUiContribution,
  LogImportContribution,
} from './extension-contributions.js';
import type { ClientDefinition } from '../client/definition.js';
import type { ProviderDefinitionInput } from '../provider/definition.js';
import type { EntityUIConfig } from '../shared/ui-config.js';
import type { ExtensionBootstrap } from './contributions/bootstrap-types.js';
import type { ExtensionWorkflowBlocksContribution } from './contributions/workflow-block-types.js';
import type { AnyArtifactKindDefinition } from '../artifact/index.js';

/**
 * Awaited contribution processor registered with the runtime coordinator.
 *
 * Processors are registered before package startup and are invoked when a
 * package activates or stops. A processor can filter the packages it handles
 * by inspecting the executable {@link MakaioExtension} manifest.
 * @typeParam THostContext - Host context supplied to active extensions.
 */
export interface ExtensionContributionProcessor<THostContext extends ExtensionContext = NodeExtensionContext> {
  /**
   * Optional activation filter.
   * @param pkg - Extension manifest to evaluate.
   * @returns `true` when this processor should handle the extension.
   */
  readonly filter?: (pkg: MakaioExtension<THostContext>) => boolean;
  /**
   * Called when an extension is being activated.
   * @param name - Extension package name.
   * @param pkg - Extension manifest.
   * @param ctx - Per-extension runtime context.
   */
  readonly processActivated: (name: string, pkg: MakaioExtension<THostContext>, ctx: THostContext) => Promise<void>;
  /**
   * Called when an extension is stopped or disabled.
   * @param name - Extension package name.
   */
  readonly processStopped?: (name: string) => Promise<void>;
}

/**
 * Context for executable boot contributions declared by extension packages.
 *
 * This seam runs after all packages have been loaded into the coordinator and
 * before startup begins, so packages can register contribution processors for
 * extension surfaces they own.
 * @typeParam THostContext - Host context supplied to contribution processors.
 */
export interface ExtensionRuntimeBootContext<THostContext extends ExtensionContext = NodeExtensionContext> {
  /** Runtime bus. */
  readonly bus: THostContext['bus'];
  /**
   * Register a contribution processor before package startup.
   * @param processor - Processor to add to the coordinator.
   */
  readonly registerContributionProcessor: (processor: ExtensionContributionProcessor<THostContext>) => void;
  /**
   * Enumerate active extensions lazily after startup.
   * @param callback - Called for each active extension with its context.
   */
  readonly forEachActiveExtension: (
    callback: (name: string, pkg: MakaioExtension<THostContext>, ctx: THostContext) => void,
  ) => void;
}

/**
 * Executable boot contribution declared by an extension package.
 *
 * Use this for runtime wiring that must be installed before
 * {@link ExtensionContributionProcessor} activation starts, such as registering
 * processors for extension-owned contribution surfaces.
 * @typeParam THostContext - Host context supplied by the runtime.
 */
export interface ExtensionRuntimeBootContribution<THostContext extends ExtensionContext = NodeExtensionContext> {
  /**
   * Configure the runtime coordinator before package startup.
   * @param context - Minimal boot context supplied by the host runtime.
   * @returns Optional cleanup callback or callbacks for runtime shutdown.
   */
  readonly configure: (
    context: ExtensionRuntimeBootContext<THostContext>,
  ) => void | (() => void) | readonly (() => void)[];
}

/**
 * Executable artifact kind contribution declared by an extension package.
 */
export interface ExtensionArtifactKindsContribution {
  /**
   * Artifact kind definitions to register during extension activation.
   */
  readonly kinds?: readonly AnyArtifactKindDefinition[];
}

/**
 * Executable Makaio extension manifest.
 *
 * Extends {@link ExtensionManifest} with executable code: a service factory,
 * a CLI contribution with interactive TUI support, and a Drizzle storage
 * handler registration callback.
 *
 * Source-of-truth rule: fields on this executable extension are the runtime
 * wiring source. Serializable descriptor fields, including
 * {@link ExtensionManifest.contributions}, are discovery metadata and are not
 * promoted into executable contribution surfaces by the loader.
 *
 * The host runtime calls {@link create} (if defined) with a
 * {@link ExtensionContext} to instantiate the service. Window-only extensions
 * that have no background service may omit {@link create} entirely.
 * @typeParam THostContext - Concrete context shape supplied by the host
 *   runtime. Defaults to {@link NodeExtensionContext} because the current
 *   framework hosts are Node-based.
 * @example
 * ```ts
 * export const myExtension: MakaioExtension = {
 *   name: 'my-extension',
 *   displayName: 'My Extension',
 *   create: (ctx) => new MyService(ctx.bus),
 * };
 * ```
 */
export interface MakaioExtension<THostContext extends ExtensionContext = NodeExtensionContext>
  extends ExtensionManifest {
  /**
   * Bus namespace definitions owned by this extension.
   *
   * Registered by `ExtensionCoordinator` during extension activation, before
   * {@link create} is called, so handlers registered during construction can
   * rely on the namespace being available.
   *
   * Extensions that don't own bus namespaces omit this field.
   */
  readonly namespaces?: readonly RegistrableBusNamespaceDefinition[];

  /**
   * Factory that creates and returns the extension's service.
   *
   * Optional — window-only extensions that have no background service may omit
   * this field entirely. When present, the host calls this during startup; the
   * extension is responsible for all internal composition (choosing backends,
   * creating sources, etc.) based on the provided context.
   * @param ctx - Runtime context with bus, host details, and machine identity.
   * @returns The extension's service instance (not yet initialized — host calls `init`).
   */
  readonly create?: (ctx: THostContext) => ExtensionService | Promise<ExtensionService>;
  /**
   * Executable ownership declarations for runtime responsibilities that must
   * have exactly one owner in a booted runtime.
   */
  readonly runtimeOwnership?: ExtensionRuntimeOwnership;
  /**
   * Boot-time executable contribution for registering runtime processors or
   * services before package startup begins.
   */
  readonly runtimeBoot?: ExtensionRuntimeBootContribution<THostContext>;
  /**
   * When true, startup fails if this extension fails to initialize.
   *
   * Optional extensions default to isolated failure so one extension cannot
   * prevent the runtime from booting. Framework and host core extensions set
   * this to true when the runtime cannot safely continue without them.
   */
  readonly critical?: boolean;
  /**
   * Executable CLI contribution registered under `makaio <name>`.
   *
   * The runtime exposes the fully typed helper API through
   * `@makaio/kernel/cli` when authoring CLI commands. This manifest stores
   * only the type-erased executable shape used after loading.
   */
  readonly cli?: ExtensionCliContribution<THostContext['bus']>;
  /**
   * Server-side HTTP routes.
   * Hosts that support HTTP route contributions call `mount()` on a fresh,
   * rebuildable app graph as extensions activate or stop. Contracts keeps the
   * app type erased so this layer does not depend on Hono.
   * @param app - Host-owned HTTP app instance.
   */
  readonly http?: {
    readonly prefix: string;
    readonly mount: (app: unknown) => void;
  };
  /**
   * Executable storage contribution.
   *
   * Extends {@link StorageManifest} (migration paths) with a Drizzle handler
   * registration callback invoked by the composition root after migrations
   * have been applied but before services are started.
   *
   * The `db` parameter is typed as `unknown` in the contracts layer (which
   * does not take a drizzle dependency) — composition roots cast it to
   * `MakaioDatabase` before calling. The returned cleanup function is
   * invoked during graceful shutdown to unregister bus handlers.
   */
  readonly storage?: StorageManifest & {
    /**
     * Absolute extension root used to resolve relative storage asset paths.
     *
     * Required when a code-defined extension declares relative
     * {@link StorageManifest.migrations} paths, since there is no descriptor
     * file path for the runtime to infer from.
     */
    readonly packageRoot?: string;
    /**
     * Stable runtime identity for the migration bundle.
     *
     * Bundled hosts use this instead of packaged output paths when they need a
     * durable key for migration deduplication and embedded lookup.
     */
    readonly migrationSourceId?: string;
    /**
     * Registers Drizzle-backed bus storage handlers for this extension.
     * @param bus - The application bus instance.
     * @param db - The Drizzle database instance (typed opaquely here; cast at the call site).
     * @param ctx - Runtime extension context supplying host details and machine identity
     *   (e.g., for machine-scoped storage registration).
     * @returns Optional cleanup function called during shutdown to unregister handlers.
     */
    readonly registerHandlers?: (bus: THostContext['bus'], db: unknown, ctx: THostContext) => (() => void) | void;
  };
  /**
   * Zod schema describing this extension's configuration shape.
   *
   * When present, the coordinator:
   * 1. Exposes the schema as JSON Schema via `extension.getConfigSchema` RPC
   * 2. Loads stored config from `ExtensionConfigStorageSubjects` at boot
   * 3. Parses it through this schema and injects the result into
   *    {@link ExtensionContext.config}
   *
   * The schema should provide `.default()` values for all optional fields
   * so parsing `{}` always yields a valid config.
   */
  readonly configSchema?: z.ZodType;

  /**
   * UI configuration for schema-driven configuration forms.
   *
   * Controls how the config form is rendered: edit mode (slidePanel vs full),
   * which fields to hide, and per-field widget overrides (e.g. slider, color
   * picker). Only meaningful when {@link configSchema} is also declared.
   */
  readonly uiConfig?: EntityUIConfig;

  // ---------------------------------------------------------------------------
  // Client runtime definitions
  // ---------------------------------------------------------------------------

  /**
   * Client runtime definitions contributed by this extension.
   *
   * Loaded clients are passed to `createClientsCorePackage` during boot and
   * registered with the client bootstrap service. These definitions are the
   * runtime source of truth for client wiring; descriptor `contributions.clients`
   * is discovery metadata only.
   */
  readonly clients?: readonly ClientDefinition[];

  // ---------------------------------------------------------------------------
  // Provider contribution surface
  // ---------------------------------------------------------------------------

  /**
   * Provider definitions contributed by this extension.
   *
   * Each entry defines a model provider (e.g., Anthropic, OpenAI) with its
   * supported models, capabilities, and credential requirements. Loaded
   * providers are registered with the provider subsystem during boot.
   *
   * Provider definitions are executable extension contributions. Descriptor
   * `contributions.providers` may mirror provider identity metadata for
   * pre-load discovery, but is not a registration fallback.
   */
  readonly providers?: readonly ProviderDefinitionInput[];

  // ---------------------------------------------------------------------------
  // Adapter contribution surface
  // ---------------------------------------------------------------------------

  /**
   * Adapter runtime definitions contributed by this extension.
   *
   * Each entry pairs JSON-serializable discovery metadata with the full
   * runtime adapter definition typed via {@link AdapterDefinitionContract}.
   * The adapter contribution processor consumes this executable field directly;
   * descriptor `contributions.adapters` is not a registration fallback.
   */
  readonly adapters?: readonly AdapterContribution[];

  /**
   * Log import capability for external tool session import.
   *
   * Opaque in contracts. The log-import contribution processor narrows
   * `config` to `PluginLogImport` at processing time.
   */
  readonly logImport?: LogImportContribution;

  // ---------------------------------------------------------------------------
  // Tool contribution surface
  // ---------------------------------------------------------------------------

  /**
   * Tool contribution factory for this extension.
   *
   * When present, the runtime calls `createToolsets(ctx)` after all
   * dependencies are loaded and registers the returned toolsets with
   * `ToolRegistry`. Extensions that contribute tools should declare a dependency
   * on the tool-registry service if one is required for registration.
   */
  readonly tools?: ExtensionToolsContribution<THostContext>;

  // ---------------------------------------------------------------------------
  // Extension contribution surfaces
  // ---------------------------------------------------------------------------

  /**
   * Hash trigger factory for this extension.
   *
   * When present, the runtime calls `createTriggers(bus)` after all
   * dependencies are loaded, then registers the returned triggers with
   * `HashTriggerService`.
   *
   * Extensions declaring triggers should depend on `'hash-trigger'` to ensure
   * the service exists when triggers are registered.
   */
  readonly triggers?: ExtensionTriggersContribution<THostContext['bus']>;

  /**
   * Session event action factory for this extension.
   *
   * When present, the runtime calls `createActions(ctx)` after all
   * dependencies are loaded and registers the returned declarations with
   * `SessionEventActionService`. Unregister callbacks are stored for
   * shutdown cleanup.
   */
  readonly sessionEventActions?: ExtensionSessionEventActionsContribution<THostContext['bus']>;

  /**
   * Bootstrap capability for project config import/export.
   *
   * When present, this extension participates in:
   * - Project export: extension data can be saved to `.makaio/bootstrap/`
   * - Project import: extension data can be restored from `.makaio/bootstrap/`
   */
  readonly bootstrap?: ExtensionBootstrap<THostContext['bus']>;

  /**
   * Workflow trigger and step block declarations for the workflow builder.
   *
   * When present, the runtime reads `blocks` during extension activation and
   * registers each block with the workflow block registry. Blocks are purely
   * declarative — no runtime context is required. Use {@link WorkflowTriggerBlock}
   * and {@link WorkflowStepBlock} to define blocks with typed Zod schemas.
   */
  readonly workflowBlocks?: ExtensionWorkflowBlocksContribution;

  /**
   * Artifact kind definitions contributed by this extension.
   *
   * Each entry is an executable {@link AnyArtifactKindDefinition} produced by
   * {@link defineArtifactKind}. The artifact kind contribution processor reads
   * this field during extension activation and registers each kind with the
   * {@link ArtifactSchemaRegistry} via the `artifact.kind.register` bus RPC.
   *
   * This is runtime registration data, not descriptor metadata. The
   * `ArtifactSchemaRegistry` package must be started before any extension that
   * declares artifact kinds.
   */
  readonly artifactKinds?: ExtensionArtifactKindsContribution;

  /**
   * Bus namespace introspection for this extension.
   *
   * The domain is auto-prefixed to `'extension:NAME'` to avoid collisions.
   * Register schemas statically in a `namespace.ts` file for type-safe
   * subjects, then reference them here for documentation and introspection.
   */
  readonly namespace?: ExtensionNamespaceContribution;

  // ---------------------------------------------------------------------------
  // UI contribution surfaces
  // ---------------------------------------------------------------------------

  /**
   * Browser UI contributions for this extension.
   *
   * Groups all UI-layer contribution surfaces. Absent for headless-only
   * extensions. The coordinator passes this bag to the UI loader
   * which bridges each surface to the appropriate client-side registry.
   */
  readonly ui?: ExtensionUiContribution;
}

/**
 * Convenience executable extension type for Node hosts.
 *
 * Contracts stays independent of the concrete bus implementation; Node-based
 * packages bind `TBus` from their host layer (for example `IMakaioBus` from
 * `@makaio/bus-core`) when they need the full typed bus authoring surface.
 * @typeParam TBus - Concrete bus type supplied by the Node host.
 */
export type MakaioNodeExtension<TBus extends MakaioBusLike> = MakaioExtension<NodeExtensionContext<TBus>>;
