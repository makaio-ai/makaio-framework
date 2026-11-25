import type { z } from 'zod';
import type { MakaioBusLike, RegistrableBusNamespaceDefinition } from '@makaio/core';
import type { ExtensionManifest, StorageManifest } from './manifest.js';
import type { ExtensionContext, NodeExtensionContext } from './extension-context.js';
import type { ExtensionService } from './extension-lifecycle.js';
import type { OpenContributions } from './open-contributions.js';
import type { ExtensionRuntimeOwnership } from './extension-runtime-boot.js';
import type { ExtensionCliContribution } from './extension-cli.js';
import type {
  AdapterContribution,
  ExtensionClientHookResponsesContribution,
  ExtensionHashTriggersContribution,
  ExtensionNamespaceContribution,
  ExtensionSessionEventActionsContribution,
  ExtensionToolsContribution,
  ExtensionUiContribution,
  LogImportContribution,
} from './extension-contributions.js';
import type { ClientDefinition } from '../client/definition.js';
import type { CredentialResolverContribution } from '../credential/resolver-contribution.js';
import type { WriteParticipantContribution } from '../journal/write-participant.js';
import type { WriterContribution } from '../journal/writer.js';
import type { AccountResolverContribution, InboundEdgeContribution } from '../journal/edge.js';
import type { ReaderContribution } from '../journal/reader.js';
import type { ProviderDefinitionInput } from '../provider/definition.js';
import type { EntityUIConfig } from '../shared/ui-config.js';
import type { ExtensionBootstrap } from './contributions/bootstrap-types.js';
import type { ExtensionWorkflowBlocksContribution } from './contributions/workflow-block-types.js';
import type { AnyArtifactKindDefinition } from '../artifact/index.js';
import type { ArtifactLifecycleHookRegistration } from '../artifact/lifecycle-hooks.js';
import type { FacetNamespaceDefinition } from '../facet/index.js';
import type { ExtensionReactionsContribution } from '../reaction/index.js';
import type { SurfaceBindingDefinition } from '../materialization/definition.js';
import type { ExtensionAutomationTriggersContribution } from '../automation-trigger/contribution.js';
import type { ExtensionArtifactViewBuildersContribution } from '../materialization/view-builder.js';
import type {
  ExtensionTransitionActionsContribution,
  ExtensionTransitionRulesContribution,
} from '../workflow/transition.js';
import type { RightContribution, RightsSourceContribution } from '../rights/right.js';
import type {
  GroupStrategyContribution,
  LookupContribution,
  RuleBlockContribution,
  RuleSourceContribution,
  TriggerContribution,
} from '../rules/index.js';

/**
 * Awaited contribution processor registered with the runtime coordinator.
 *
 * Processors are registered before package startup and are invoked when a
 * package activates or stops. A processor can filter the packages it handles
 * by inspecting the executable {@link MakaioExtension} manifest.
 * Processors run inside a host lifecycle step whose context belongs to the host carrier and cannot cross
 * to another carrier, so processors that send mint `ctx.bus.own('start'|'stop')` on the activated extension's bus.
 * A future toggle carrying a principal would require an attestation to the processor's carrier; none exists today.
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
 * Executable facet namespace contribution declared by an extension package.
 */
export interface ExtensionFacetNamespacesContribution {
  /**
   * Facet namespace definitions to register during extension activation.
   */
  readonly namespaces?: readonly FacetNamespaceDefinition[];
}

/**
 * Executable surface bindings contribution declared by an extension package.
 */
export interface ExtensionSurfaceBindingsContribution {
  /**
   * Surface binding definitions to register during extension activation.
   */
  readonly bindings?: readonly SurfaceBindingDefinition[];
}

/**
 * Context supplied to the `createHooks` factory of an
 * {@link ExtensionArtifactLifecycleHooksContribution}.
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface ArtifactLifecycleHooksContributionContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Runtime bus available during hook factory invocation. */
  readonly bus: TBus;
  /** Name of the owning extension, used for hook ID namespacing. */
  readonly extensionName: string;
}

/**
 * Executable artifact lifecycle hooks contribution declared by an extension package.
 *
 * The `createHooks` factory is called during extension activation with the
 * runtime context and must return the set of hook registrations to install.
 * Returning a `Promise` allows async resource acquisition (e.g. lazy loading).
 * @typeParam TBus - Concrete bus type supplied by the host runtime.
 */
export interface ExtensionArtifactLifecycleHooksContribution<TBus extends MakaioBusLike = MakaioBusLike> {
  /**
   * Factory that produces the hook registrations for this extension.
   *
   * Called once during extension activation. The returned hooks are registered
   * with the artifact lifecycle hook registry and unregistered when the
   * extension stops.
   * @param ctx - Activation context supplying the bus and extension name.
   * @returns Hook registrations or a promise that resolves to them.
   */
  readonly createHooks: (
    ctx: ArtifactLifecycleHooksContributionContext<TBus>,
  ) => readonly ArtifactLifecycleHookRegistration<TBus>[] | Promise<readonly ArtifactLifecycleHookRegistration<TBus>[]>;
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
   * Executable storage contribution. Requires the capability `storage.drizzle`.
   *
   * For surface-matching extensions, an unavailable storage capability fails
   * startup with an `ExtensionStorageCapabilityError` naming the affected
   * extensions and their required dependents. Storage handlers require a host database.
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
  // Journal contribution surfaces
  // ---------------------------------------------------------------------------

  /**
   * Executable inbound edge contributions installed during activation.
   *
   * The core validates at activation that each edge accepts only recorded
   * subjects owned by the contributing extension.
   */
  readonly edges?: readonly InboundEdgeContribution[];

  /** Journal readers installed and withdrawn with this extension. */
  readonly readers?: readonly ReaderContribution[];

  /**
   * Executable contribution that maps witnessed accounts to parties of the host.
   *
   * At most one account resolver can be active per host.
   */
  readonly accountResolver?: AccountResolverContribution;

  /** External writers published while this extension is active. */
  readonly writers?: readonly WriterContribution[];

  /** Participants in the state transitions of this extension's write intents. */
  readonly writeParticipants?: readonly WriteParticipantContribution[];

  /** Singleton host provider for purpose-based credential resolution. */
  readonly credentialResolver?: CredentialResolverContribution;

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

  /**
   * Client hook response contribution surface for this extension.
   *
   * When present, the runtime calls `createContributors(ctx)` once during
   * extension activation and validates the returned contributor definitions
   * against the active provider contract catalog before installing them in
   * the hook response pipeline.
   *
   * Contributors declared here respond to client hook events with canonical
   * effects (e.g. `context.append`) or provider-specific contribution
   * envelopes. Descriptor metadata is discovery-only; executable callbacks
   * are not serialized.
   */
  readonly clientHookResponses?: ExtensionClientHookResponsesContribution<THostContext>;

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
   * When present, the runtime calls `createHashTriggers(bus)` after all
   * dependencies are loaded, then registers the returned triggers with
   * `HashTriggerService`.
   *
   * Extensions declaring hash triggers should depend on `'hash-trigger'` to
   * ensure the service exists when triggers are registered.
   */
  readonly hashTriggers?: ExtensionHashTriggersContribution<THostContext['bus']>;

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
   * Workflow step block declarations for the workflow builder.
   *
   * When present, the runtime reads `blocks` during extension activation and
   * registers each block with the workflow block registry. Blocks are purely
   * declarative — no runtime context is required. Use {@link WorkflowStepBlock}
   * to define blocks with typed Zod schemas. Workflow start conditions are
   * contributed through {@link automationTriggers} instead.
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
   * Artifact lifecycle hook factory contributed by this extension.
   *
   * When present, the runtime calls `createHooks(ctx)` during extension
   * activation and registers the returned hooks with the artifact lifecycle
   * hook registry. Hooks are unregistered when the extension stops.
   *
   * Hooks are live-only and must not be included in serializable registration
   * payloads. The `ArtifactLifecycleHookRegistry` package must be started
   * before any extension that declares lifecycle hooks.
   */
  readonly artifactLifecycleHooks?: ExtensionArtifactLifecycleHooksContribution<THostContext['bus']>;

  /**
   * Artifact view builder factory contributed by this extension.
   *
   * When present, the runtime calls `createBuilders()` during extension
   * activation and registers the returned builders with the artifact view
   * builder registry under the extension's owner key. Builders are
   * unregistered when the extension stops.
   *
   * Builders are live extension contributions; only serializable
   * requests/responses cross the bus. The `ArtifactViewBuilderRegistry`
   * service must be started before any extension that declares builders.
   */
  readonly artifactViewBuilders?: ExtensionArtifactViewBuildersContribution;

  /**
   * Facet namespace definitions contributed by this extension.
   *
   * Each entry is an executable {@link FacetNamespaceDefinition} produced by
   * {@link defineFacetNamespace}. The facet namespace contribution processor reads
   * this field during extension activation and registers each namespace directly
   * with the {@link FacetNamespaceRegistry} service.
   *
   * Facet namespace registrations are permanent — there is no deregister
   * operation. This is runtime registration data, not descriptor metadata. The
   * `FacetNamespaceRegistry` package must be started before any extension that
   * declares facet namespaces.
   */
  readonly facetNamespaces?: ExtensionFacetNamespacesContribution;

  /**
   * Surface binding definitions contributed by this extension.
   *
   * Each entry is an executable {@link SurfaceBindingDefinition} produced by
   * {@link defineSurfaceBinding}. The surface binding contribution processor reads
   * this field during extension activation and registers each binding directly
   * with the {@link SurfaceBindingRegistry} service.
   *
   * Surface binding registrations are permanent — there is no deregister
   * operation. This is runtime registration data, not descriptor metadata. The
   * `SurfaceBindingRegistry` package must be started before any extension that
   * declares surface bindings.
   */
  readonly surfaceBindings?: ExtensionSurfaceBindingsContribution;

  /**
   * Reaction factory contributed by this extension.
   *
   * When present, the runtime calls `createReactions(ctx)` during extension
   * activation and registers the returned {@link ReactionDefinition}s with the
   * Reaction registry. Reactions are namespaced `<extension-name>.<reaction-name>`;
   * the registry enforces the prefix at contribution time.
   *
   * Reaction definitions carry live Zod parameter schemas and trusted
   * handlers — they are runtime values and must never be included in
   * serializable descriptor metadata. Descriptor metadata may advertise a
   * Reaction for discovery, but only this executable surface installs it.
   */
  readonly reactions?: ExtensionReactionsContribution<THostContext>;

  /**
   * Automation trigger factory contributed by this extension.
   *
   * When present, the runtime calls `createAutomationTriggers(ctx)` during
   * extension activation and registers the returned
   * {@link AutomationTriggerType}s with the automation trigger registry.
   * Trigger `kind` values must be owned by the extension as `localContributionName` defines it (prefix `'<extensionName>.'` and a non-empty rest);
   * the registry enforces this at contribution time.
   *
   * Trigger definitions carry live Zod parameter and event schemas plus a
   * trusted `activate` factory — they are runtime values and must never be
   * included in serializable descriptor metadata. Use
   * {@link createAutomationTriggerDescriptor} to produce the serializable
   * representation for Builder discovery.
   */
  readonly automationTriggers?: ExtensionAutomationTriggersContribution<THostContext>;

  // ---------------------------------------------------------------------------
  // Rules contribution surfaces
  // ---------------------------------------------------------------------------

  /**
   * Trigger contributions declared by this extension.
   *
   * Purely declarative: a trigger is only a projection (it translates a
   * journal entry or a message into facts) and carries no active part, so
   * these entries need no factory or runtime context. Every `kind` must be
   * owned by the extension as `localContributionName` defines it (prefix
   * `'<extensionName>.'` and a non-empty rest); the trigger registry enforces
   * this at contribution time.
   */
  readonly triggers?: readonly TriggerContribution[];

  /**
   * Lookup contributions declared by this extension.
   *
   * Purely declarative. Every `kind` must be owned by the extension as
   * `localContributionName` defines it (prefix `'<extensionName>.'` and a
   * non-empty rest); the lookup registry enforces this at contribution time.
   */
  readonly lookups?: readonly LookupContribution[];

  /**
   * Group-strategy contributions declared by this extension.
   *
   * Purely declarative. Every `strategy` must be owned by the extension as
   * `localContributionName` defines it (prefix `'<extensionName>.'` and a
   * non-empty rest); the group-strategy registry enforces this at
   * contribution time.
   */
  readonly groupStrategies?: readonly GroupStrategyContribution[];

  /**
   * This extension's own rule block, at most one, always read under the
   * extension's own key on `ReactionRule.extensions`.
   *
   * There is no `extension` field on {@link RuleBlockContribution} itself:
   * the kernel knows the contributing extension from the key the block is
   * registered under.
   */
  readonly ruleBlock?: RuleBlockContribution;

  /**
   * The host's rule source: which rules apply to an occasion, which groups
   * and exclusions are in effect, and which triggers the rule set in effect
   * declares.
   *
   * At most one per installation — a second extension registering one while
   * another's is still active is rejected visibly.
   */
  readonly ruleSource?: RuleSourceContribution;

  // ---------------------------------------------------------------------------
  // Transition Pipeline contribution surfaces
  // ---------------------------------------------------------------------------

  /**
   * Declarative transition rules contributed by this extension.
   *
   * Rules are purely serializable — no functions. The transition contribution
   * processor reads `transitionRules.rules` during extension activation and
   * registers each rule with {@link TransitionRuleRegistry}.
   *
   * All rule IDs must be owned by the extension as `localContributionName` defines it (prefix `'<extensionName>.'` and a non-empty rest).
   * Duplicate IDs across all sources hard-fail activation.
   *
   * The `transition-pipeline` service must be started before any extension
   * that declares transition rules.
   */
  readonly transitionRules?: ExtensionTransitionRulesContribution;

  /**
   * Executable transition action factories contributed by this extension.
   *
   * Factories provide custom action semantics beyond the built-in
   * `workflow.start` action. The transition contribution processor registers
   * each factory with {@link TransitionActionRegistry} during extension activation.
   *
   * All action type keys must be owned by the extension as `localContributionName` defines it (prefix `'<extensionName>.'` and a non-empty rest).
   * Duplicate type keys across all sources hard-fail activation.
   */
  readonly transitionActions?: ExtensionTransitionActionsContribution;

  /**
   * Rights this extension declares in code, under its own namespace.
   *
   * A right name is owned by the declaring extension (`localContributionName`:
   * prefix `'<extensionName>.'` and a non-empty rest). The kernel folds these
   * into the directory of declared rights on activation and removes them when
   * the extension stops. A right without any answer source is granted; see
   * {@link RightsSourceContribution} for how a source restricts it.
   */
  readonly rights?: readonly RightContribution[];

  /**
   * Answer sources this extension contributes, each answering questions about
   * the rights whose names its patterns cover.
   *
   * A source can only restrict: once a source exists for a right, the right is
   * denied by default and granted only when every source for it answers yes.
   * The kernel registers these on activation and removes them when the
   * extension stops.
   */
  readonly rightsSources?: readonly RightsSourceContribution[];

  /**
   * Bus namespace introspection for this extension.
   *
   * The domain is auto-prefixed to `'extension:NAME'` to avoid collisions.
   * Register schemas statically in a `namespace.ts` file for type-safe
   * subjects, then reference them here for documentation and introspection.
   */
  readonly namespace?: ExtensionNamespaceContribution;

  /**
   * Open slot: entries this extension contributes to contribution kinds declared
   * by any extension.
   *
   * Each key is `<declaring extension>.<kind>`; each value is an array of entries.
   * Any extension may contribute entries under a key. Only the declaring
   * extension (the one whose name is the key's prefix) reads and checks them,
   * through `ExtensionContext.openContributions`. The host checks only the shape
   * of the slot (keys are contribution names, values are arrays) and does not
   * interpret any entry.
   *
   * This is unrelated to {@link MakaioExtension.contributions}, which is the strict
   * discovery manifest.
   */
  readonly openContributions?: OpenContributions;

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
