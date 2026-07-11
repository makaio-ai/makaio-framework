/**
 * Pure-data contribution manifest types and Zod schemas for Makaio extensions.
 *
 * Extensions may declare which adapters, clients, providers, triggers, log
 * importers, session event actions, and artifact lifecycle hooks they contribute
 * through the `contributions` field on
 * {@link ExtensionManifest}. This is discovery-time metadata only — fully
 * serializable and safe to inspect without executing any extension code.
 *
 * Source-of-truth rule: descriptor `contributions` is for discovery,
 * cataloging, filtering, and package inspection before code load. Runtime
 * activation and registration read the executable fields on
 * `MakaioExtension` (`adapters`, `clients`, `providers`, `tools`, `ui`, and
 * related surfaces). Loaders must not synthesize executable contributions from
 * this manifest; if both forms are present, authoring or packaging validation
 * should keep them aligned.
 * @see {@link ContributionManifest} for the top-level container.
 * @see {@link AdapterManifest} for adapter contribution declarations.
 * @see {@link ClientManifest} for client contribution declarations.
 * @see {@link ProviderManifest} for provider contribution declarations.
 * @see {@link TriggerManifest} for hash trigger contribution declarations.
 * @see {@link LogImporterManifest} for log importer contribution declarations.
 * @see {@link SessionEventActionManifest} for session event action declarations.
 * @see {@link ArtifactLifecycleHookManifest} for artifact lifecycle hook declarations.
 * @see {@link UiSurfaceFlags} for browser UI surface flag declarations.
 */

import { z } from 'zod';
import { type ArtifactLifecycleHookEvent } from '../artifact/lifecycle-hooks.js';
import { type ProtocolId, ProtocolIdSchema } from '../provider/definition.js';
import { type VersionLiteral, type VersionRange, VersionRangeSchema, VersionLiteralSchema } from '../version/index.js';

// ---------------------------------------------------------------------------
// ProtocolConfig
// ---------------------------------------------------------------------------

/**
 * Protocol-specific configuration for an adapter contribution.
 *
 * Currently supports endpoint overrides and acts as a seam for additional
 * protocol-level settings such as auth overrides or timeout policies.
 */
export interface ProtocolConfig {
  /** Optional custom endpoint URL overriding the protocol default. */
  readonly endpoint?: string;
}

/** Zod schema for {@link ProtocolConfig}. */
export const ProtocolConfigSchema = z.object({
  endpoint: z.string().url().optional(),
}) satisfies z.ZodType<ProtocolConfig>;

// ---------------------------------------------------------------------------
// ProtocolRef
// ---------------------------------------------------------------------------

/**
 * Reference to a supported wire protocol, with optional per-protocol config.
 *
 * - **Simple string** — use the protocol with default settings: `'anthropic'`.
 * - **Config object** — declare one or more protocols with overrides:
 *   `{ anthropic: { endpoint: 'https://custom.host/v1' } }`.
 *
 * Both forms are valid in the `protocols` array on {@link AdapterManifest}.
 * @example Simple form
 * ```json
 * "protocols": ["anthropic", "openai"]
 * ```
 * @example Config form
 * ```json
 * "protocols": [{ "anthropic": { "endpoint": "https://custom.host/v1" } }]
 * ```
 */
export type ProtocolRef = ProtocolId | { readonly [K in ProtocolId]?: ProtocolConfig };

/** Zod schema for {@link ProtocolRef}. */
export const ProtocolRefSchema = z.union([
  ProtocolIdSchema,
  z
    .object({
      anthropic: ProtocolConfigSchema.optional(),
      openai: ProtocolConfigSchema.optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'ProtocolRef config object must specify at least one protocol',
    }),
]) satisfies z.ZodType<ProtocolRef>;

// ---------------------------------------------------------------------------
// AdapterClientRef
// ---------------------------------------------------------------------------

/**
 * Reference from an adapter to a client package it depends on.
 *
 * The `version` field follows npm/package.json semver range syntax so the
 * executable adapter contribution can verify compatibility against the
 * installed client (npm package) version. The optional `binaryVersion` field
 * constrains the version of the shipped binary separately — useful when the
 * npm package version and the embedded binary version diverge.
 * @example `{ id: 'claude-code', version: '^1.5.0' }`
 * @example `{ id: 'claude-code', version: '^1.5.0', binaryVersion: '>=1.0.0 <1.2.0' }`
 */
export interface AdapterClientRef {
  /** Stable client identifier matching {@link ClientManifest.id}. */
  readonly id: string;
  /**
   * Semver range the adapter is compatible with for the npm package version.
   *
   * Uses the same syntax as `package.json` dependency fields
   * (e.g., `'^1.5.0'`, `'>=2.0.0'`, `'*'`).
   */
  readonly version: VersionRange;
  /**
   * Optional semver range constraining the binary version separately from the
   * npm package version. The adapter subsystem evaluates this field at
   * activation time by resolving the active client binary.
   *
   * Omit when the binary version is assumed to match the npm package version.
   */
  readonly binaryVersion?: VersionRange;
}

/** Zod schema for {@link AdapterClientRef}. */
export const AdapterClientRefSchema = z.object({
  id: z.string().min(1),
  version: VersionRangeSchema,
  binaryVersion: VersionRangeSchema.optional(),
}) satisfies z.ZodType<AdapterClientRef>;

// ---------------------------------------------------------------------------
// AdapterManifest
// ---------------------------------------------------------------------------

/**
 * Describes an adapter contributed by an extension.
 *
 * Serializable metadata for discovery, filtering, and inspection. The
 * executable runtime source is `MakaioExtension.adapters[].manifest`, paired
 * with its adapter definition; descriptor-level contributions do not register
 * adapters by themselves.
 *
 * The `protocols` field is required because an adapter must declare at least
 * which wire protocol(s) it implements; all other fields are optional metadata.
 */
export interface AdapterManifest {
  /**
   * Stable machine identifier for this adapter contribution (e.g., `'claude-code'`).
   *
   * Used as the key in adapter registries. Must be unique within the declaring
   * extension.
   */
  readonly name: string;
  /** Human-readable display name shown in the UI (e.g., `'Claude Code'`). */
  readonly displayName?: string;
  /** Short description of what this adapter does. */
  readonly description?: string;
  /**
   * Client packages this adapter depends on.
   *
   * Each entry declares a required client by ID and semver range. Executable
   * adapter processors verify that referenced clients are installed and
   * compatible before activating the adapter.
   */
  readonly clients?: readonly AdapterClientRef[];
  /**
   * Wire protocol(s) this adapter implements.
   *
   * Each entry is either a plain {@link ProtocolId} string or a
   * {@link ProtocolRef} config object with per-protocol overrides. An empty
   * array explicitly identifies an SDK-native adapter that does not implement
   * a framework wire protocol.
   */
  readonly protocols: readonly ProtocolRef[];
  /**
   * Identifier of the provider this adapter defaults to.
   *
   * When omitted, the runtime or user selects the provider. Must reference a
   * registered provider definition `id`.
   */
  readonly defaultProvider?: string;
}

/** Zod schema for {@link AdapterManifest}. */
export const AdapterManifestSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  clients: z.array(AdapterClientRefSchema).readonly().optional(),
  protocols: z.array(ProtocolRefSchema).readonly(),
  defaultProvider: z.string().min(1).optional(),
}) satisfies z.ZodType<AdapterManifest>;

// ---------------------------------------------------------------------------
// ClientManifest
// ---------------------------------------------------------------------------

/**
 * Describes a client binary contributed by an extension.
 *
 * A "client" is a standalone executable (e.g., the Claude Code CLI) that an
 * adapter delegates work to. This manifest is discovery-time metadata;
 * executable `MakaioExtension.clients` definitions are the runtime source for
 * locating, verifying, and managing the binary lifecycle.
 */
export interface ClientManifest {
  /**
   * Stable machine identifier for this client (e.g., `'claude-code'`).
   *
   * Must be unique within the declaring extension. Referenced by
   * {@link AdapterClientRef.id} to express adapter-to-client dependencies.
   */
  readonly id: string;
  /** Human-readable display name (e.g., `'Claude Code'`). */
  readonly name: string;
  /** Short description of what this client binary does. */
  readonly description?: string;
  /**
   * Binary identity for this client.
   *
   * When present, carries the executable name used for PATH detection.
   * When `managed` is `true`, `version` is also required and records the
   * exact binary version the framework should install and activate.
   * @example Unmanaged binary
   * ```ts
   * { name: 'claude' }
   * ```
   * @example Managed binary with pinned version
   * ```ts
   * { name: 'claude', managed: true, version: '2.1.143' }
   * ```
   */
  readonly binary?: {
    readonly name: string;
    /** Whether the framework manages the installation of this binary. */
    readonly managed?: boolean;
    /**
     * Exact semver version of the binary to install and activate.
     * Required when `managed` is `true`.
     */
    readonly version?: VersionLiteral;
  };
}

/** Zod schema for {@link ClientManifest}. */
export const ClientManifestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    binary: z
      .object({
        name: z.string().min(1),
        /** Whether the framework manages the installation of this binary. */
        managed: z.boolean().optional(),
        /**
         * Exact semver version of the binary to install and activate.
         * Required when `managed` is `true`.
         */
        version: VersionLiteralSchema.optional(),
      })
      .strict()
      .refine((binary) => binary.managed !== true || binary.version !== undefined, {
        message: 'binary.version is required when binary.managed is true',
        path: ['version'],
      })
      .refine((binary) => binary.version === undefined || binary.managed === true, {
        message: 'binary.managed must be true when binary.version is provided',
        path: ['managed'],
      })
      .optional(),
  })
  .strict() satisfies z.ZodType<ClientManifest>;

// ---------------------------------------------------------------------------
// ProviderManifest
// ---------------------------------------------------------------------------

/**
 * Describes a model provider contributed by an extension.
 *
 * A "provider" is an inference backend (e.g., Anthropic, OpenAI, Z.AI) that
 * adapters use to route model requests. This manifest is discovery-time
 * metadata; executable `MakaioExtension.providers` definitions are the
 * runtime source for credential resolution and model catalog registration.
 * @example
 * ```json
 * { "id": "anthropic", "name": "Anthropic", "description": "Official Anthropic API" }
 * ```
 */
export interface ProviderManifest {
  /**
   * Stable machine identifier for this provider (e.g., `'anthropic'`).
   *
   * Must be unique within the declaring extension. Used as the primary key
   * in provider registries and referenced by
   * {@link AdapterManifest.defaultProvider}.
   */
  readonly id: string;
  /** Human-readable display name (e.g., `'Anthropic'`). */
  readonly name: string;
  /** Short description of this provider. */
  readonly description?: string;
}

/** Zod schema for {@link ProviderManifest}. */
export const ProviderManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
}) satisfies z.ZodType<ProviderManifest>;

// ---------------------------------------------------------------------------
// TriggerManifest
// ---------------------------------------------------------------------------

/**
 * Pipeline stage a hash trigger participates in.
 *
 * Mirrors {@link HashTriggerStage} from the runtime contribution types.
 * Kept as a local type alias so this manifest module remains self-contained.
 */
export type TriggerStage = 'gather' | 'transform' | 'action';

/**
 * Describes a hash trigger contributed by an extension.
 *
 * Serializable metadata for discovery and introspection. The executable
 * runtime source is `MakaioExtension.triggers.createTriggers()`; descriptor
 * contributions are not a registration fallback.
 */
export interface TriggerManifest {
  /**
   * Prefix token this trigger responds to (e.g., `'loop'`, `'file'`).
   *
   * Must be unique within the declaring extension. Used by the hash trigger
   * service to route `#prefix:argument` directives.
   */
  readonly prefix: string;
  /** Human-readable description of what this trigger does. */
  readonly description?: string;
  /**
   * Pipeline stage this trigger participates in.
   *
   * Defaults to `'action'` when omitted.
   */
  readonly stage?: TriggerStage;
}

/** Zod schema for {@link TriggerManifest}. */
export const TriggerManifestSchema = z.object({
  prefix: z.string().min(1),
  description: z.string().optional(),
  stage: z.enum(['gather', 'transform', 'action']).optional(),
}) satisfies z.ZodType<TriggerManifest>;

// ---------------------------------------------------------------------------
// LogImporterManifest
// ---------------------------------------------------------------------------

/**
 * Describes a log importer contributed by an extension.
 *
 * Serializable metadata for discovery, filtering, and inspection. The
 * executable runtime source is `MakaioExtension.logImport`; descriptor
 * contributions are not a registration fallback.
 */
export interface LogImporterManifest {
  /**
   * Adapter name used for attribution (e.g., `'plugin:opencode'`).
   *
   * Must be unique within the declaring extension.
   */
  readonly adapterName: string;
  /** Human-readable display name (e.g., `'OpenCode'`). */
  readonly displayName: string;
  /**
   * Glob pattern matching importable log files.
   *
   * Discovery tooling can use this pattern to filter file system entries
   * without loading the extension code.
   * @example `'** /storage/session/* /*.json'`
   */
  readonly logFilePattern?: string;
}

/** Zod schema for {@link LogImporterManifest}. */
export const LogImporterManifestSchema = z.object({
  adapterName: z.string().min(1),
  displayName: z.string().min(1),
  logFilePattern: z.string().min(1).optional(),
}) satisfies z.ZodType<LogImporterManifest>;

// ---------------------------------------------------------------------------
// SessionEventActionManifest
// ---------------------------------------------------------------------------

/**
 * Describes a session event action contributed by an extension.
 *
 * Serializable metadata for discovery and introspection. The executable
 * runtime source is `MakaioExtension.sessionEventActions.createActions()`;
 * descriptor contributions are not a registration fallback.
 */
export interface SessionEventActionManifest {
  /**
   * Unique action identifier within the declaring extension
   * (e.g., `'pin-message:pin'`).
   */
  readonly id: string;
  /** Display label shown in action menus. */
  readonly label: string;
  /** Optional human-readable description. */
  readonly description?: string;
  /** Optional icon identifier. */
  readonly icon?: string;
  /**
   * Whether the action operates on a single event or multiple events.
   *
   * - `'single'` — immediate execution from a kebab menu.
   * - `'multi'` — opens a picker modal for multi-event selection.
   */
  readonly selectionMode: 'single' | 'multi';
  /**
   * Message roles the action applies to.
   *
   * Maps to the `entrypoint.messageRole` field on the runtime action options.
   */
  readonly messageRoles?: readonly ('user' | 'assistant')[];
}

/** Zod schema for {@link SessionEventActionManifest}. */
export const SessionEventActionManifestSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().min(1).optional(),
  selectionMode: z.enum(['single', 'multi']),
  messageRoles: z
    .array(z.enum(['user', 'assistant']))
    .readonly()
    .optional(),
}) satisfies z.ZodType<SessionEventActionManifest>;

// ---------------------------------------------------------------------------
// ArtifactLifecycleHookManifest
// ---------------------------------------------------------------------------

export type { ArtifactLifecycleHookEvent };

/** Zod schema for {@link ArtifactLifecycleHookEvent}. */
export const ArtifactLifecycleHookEventSchema = z.enum([
  'beforeCreate',
  'beforeRevise',
  'afterCreate',
  'afterRevise',
  'afterStatusChanged',
  'afterObservationAdded',
]);

/**
 * Describes a single artifact lifecycle hook entry declared by an extension.
 *
 * This is serializable discovery-time metadata only — it does NOT carry the
 * hook handler function. The executable runtime source is
 * `MakaioExtension.artifactLifecycleHooks.createHooks()`; descriptor
 * contributions are not a registration fallback.
 *
 * When `kind` is omitted, the hook applies to all registered artifact kinds.
 * When `schemaVersion` is omitted, the hook applies to all schema versions of
 * the targeted kind.
 */
export interface ArtifactLifecycleHookManifest {
  /**
   * Stable identifier for this hook entry within the declaring extension.
   *
   * Must be unique within the extension's `artifactLifecycleHooks` array.
   */
  readonly id: string;
  /** Artifact lifecycle event this hook responds to. */
  readonly event: ArtifactLifecycleHookEvent;
  /**
   * Artifact kind discriminator this hook targets.
   *
   * When omitted, the hook applies across all registered kinds.
   */
  readonly kind?: string;
  /**
   * Schema version constraint for the targeted kind.
   *
   * When omitted, the hook applies to all schema versions of the targeted kind.
   */
  readonly schemaVersion?: string;
}

/** Zod schema for {@link ArtifactLifecycleHookManifest}. */
export const ArtifactLifecycleHookManifestSchema = z.object({
  id: z.string().min(1),
  event: ArtifactLifecycleHookEventSchema,
  kind: z.string().min(1).optional(),
  schemaVersion: z.string().min(1).optional(),
}) satisfies z.ZodType<ArtifactLifecycleHookManifest>;

// ---------------------------------------------------------------------------
// UiSurfaceFlags
// ---------------------------------------------------------------------------

/**
 * Discovery-time flags for browser UI contribution surfaces.
 *
 * Each boolean flag indicates that the extension's executable
 * {@link ExtensionUiContribution} declares the corresponding surface.
 * Absent or `false` means the surface is not contributed.
 */
export interface UiSurfaceFlags {
  /** Extension contributes one or more tile declarations. */
  readonly tiles?: boolean;
  /** Extension contributes one or more widget declarations. */
  readonly widgets?: boolean;
  /** Extension contributes one or more page declarations. */
  readonly pages?: boolean;
  /** Extension contributes one or more web UI routes. */
  readonly routes?: boolean;
}

/** Zod schema for {@link UiSurfaceFlags}. */
export const UiSurfaceFlagsSchema = z.object({
  tiles: z.boolean().optional(),
  widgets: z.boolean().optional(),
  pages: z.boolean().optional(),
  routes: z.boolean().optional(),
}) satisfies z.ZodType<UiSurfaceFlags>;

// ---------------------------------------------------------------------------
// ContributionManifest
// ---------------------------------------------------------------------------

/**
 * Top-level container for all contributions an extension declares.
 *
 * Added as an optional field on {@link ExtensionManifest}. Extensions that do
 * not need discovery-time contribution metadata may omit this field entirely.
 * This manifest is intentionally not a runtime wiring surface; it mirrors the
 * executable contribution fields only for pre-load introspection.
 *
 * Rich metadata fields ({@link adapters}, {@link clients}, {@link providers},
 * {@link triggers}, {@link logImporters}, {@link sessionEventActions}) carry
 * structured data for discovery and filtering. Boolean surface flags
 * ({@link create}, {@link tools}, {@link bootstrap}, etc.) declare which
 * executable surfaces the extension contributes without duplicating runtime
 * detail.
 * @example Extension contributing an adapter and a client
 * ```json
 * {
 *   "contributions": {
 *     "adapters": [
 *       {
 *         "name": "claude-code",
 *         "protocols": ["anthropic"],
 *         "clients": [{ "id": "claude-code", "version": "^1.5.0" }]
 *       }
 *     ],
 *     "clients": [
 *       { "id": "claude-code", "name": "Claude Code", "binary": { "name": "claude" } }
 *     ]
 *   }
 * }
 * ```
 * @example Extension contributing hash triggers and tools
 * ```json
 * {
 *   "contributions": {
 *     "triggers": [
 *       { "prefix": "loop", "description": "Retry-until-success execution", "stage": "action" }
 *     ],
 *     "create": true,
 *     "tools": true,
 *     "configSchema": true,
 *     "ui": { "widgets": true }
 *   }
 * }
 * ```
 */
export interface ContributionManifest {
  /** Adapter contributions declared by this extension. */
  readonly adapters?: readonly AdapterManifest[];
  /** Client binary contributions declared by this extension. */
  readonly clients?: readonly ClientManifest[];
  /** Provider contributions declared by this extension. */
  readonly providers?: readonly ProviderManifest[];
  /** Hash trigger contributions declared by this extension. */
  readonly triggers?: readonly TriggerManifest[];
  /** Log importer contribution declared by this extension. */
  readonly logImporters?: readonly LogImporterManifest[];
  /** Session event action contributions declared by this extension. */
  readonly sessionEventActions?: readonly SessionEventActionManifest[];
  /**
   * Artifact lifecycle hook entries declared by this extension.
   *
   * Each entry is serializable discovery-time metadata. The executable runtime
   * source is `MakaioExtension.artifactLifecycleHooks.createHooks()`; this
   * field is for pre-load introspection only.
   */
  readonly artifactLifecycleHooks?: readonly ArtifactLifecycleHookManifest[];

  // -- Boolean surface flags ------------------------------------------------

  /** Extension provides a service factory ({@link MakaioExtension.create}). */
  readonly create?: boolean;
  /** Extension contributes one or more toolsets ({@link MakaioExtension.tools}). */
  readonly tools?: boolean;
  /** Extension contributes bootstrap import/export ({@link MakaioExtension.bootstrap}). */
  readonly bootstrap?: boolean;
  /** Extension declares a bus namespace ({@link MakaioExtension."namespace"}). */
  readonly namespace?: boolean;
  /** Extension declares a config schema ({@link MakaioExtension.configSchema}). */
  readonly configSchema?: boolean;
  /** Extension declares UI config overrides ({@link MakaioExtension.uiConfig}). */
  readonly uiConfig?: boolean;
  /** Browser UI surface flags ({@link MakaioExtension.ui}). */
  readonly ui?: UiSurfaceFlags;
}

/** Contribution array paths that support uniqueness validation. */
type ContributionArrayPath =
  | 'adapters'
  | 'clients'
  | 'providers'
  | 'triggers'
  | 'logImporters'
  | 'sessionEventActions'
  | 'artifactLifecycleHooks';

/**
 * Singular label for each contribution array path, used in error messages.
 */
const CONTRIBUTION_SINGULAR_LABELS: Record<ContributionArrayPath, string> = {
  adapters: 'adapter',
  clients: 'client',
  providers: 'provider',
  triggers: 'trigger',
  logImporters: 'log importer',
  sessionEventActions: 'session event action',
  artifactLifecycleHooks: 'artifact lifecycle hook',
};

/**
 * Add a duplicate contribution issue to a manifest refinement context.
 * @param ctx - Zod refinement context receiving the issue.
 * @param path - Top-level contribution array path.
 * @param identifier - Duplicate contribution identifier.
 */
function addDuplicateIssue(ctx: z.RefinementCtx, path: ContributionArrayPath, identifier: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `Duplicate ${CONTRIBUTION_SINGULAR_LABELS[path]} contribution identifier "${identifier}"`,
  });
}

/**
 * Find all duplicate identifiers in an optional contribution array.
 * @typeParam T - Contribution item type.
 * @param items - Contribution items to scan.
 * @param getIdentifier - Identifier selector for each item.
 * @returns Duplicate identifiers in first duplicate occurrence order.
 */
function findDuplicateIdentifiers<T>(items: readonly T[] | undefined, getIdentifier: (item: T) => string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const identifiers: string[] = [];

  for (const item of items ?? []) {
    const identifier = getIdentifier(item);
    if (seen.has(identifier)) {
      if (!duplicates.has(identifier)) {
        duplicates.add(identifier);
        identifiers.push(identifier);
      }
      continue;
    }
    seen.add(identifier);
  }

  return identifiers;
}

/** Zod schema for {@link ContributionManifest}. */
export const ContributionManifestSchema = z
  .object({
    adapters: z.array(AdapterManifestSchema).readonly().optional(),
    clients: z.array(ClientManifestSchema).readonly().optional(),
    providers: z.array(ProviderManifestSchema).readonly().optional(),
    triggers: z.array(TriggerManifestSchema).readonly().optional(),
    logImporters: z.array(LogImporterManifestSchema).readonly().optional(),
    sessionEventActions: z.array(SessionEventActionManifestSchema).readonly().optional(),
    artifactLifecycleHooks: z.array(ArtifactLifecycleHookManifestSchema).readonly().optional(),
    create: z.boolean().optional(),
    tools: z.boolean().optional(),
    bootstrap: z.boolean().optional(),
    namespace: z.boolean().optional(),
    configSchema: z.boolean().optional(),
    uiConfig: z.boolean().optional(),
    ui: UiSurfaceFlagsSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    for (const duplicateAdapterName of findDuplicateIdentifiers(manifest.adapters, (adapter) => adapter.name)) {
      addDuplicateIssue(ctx, 'adapters', duplicateAdapterName);
    }

    for (const duplicateClientId of findDuplicateIdentifiers(manifest.clients, (client) => client.id)) {
      addDuplicateIssue(ctx, 'clients', duplicateClientId);
    }

    for (const duplicateProviderId of findDuplicateIdentifiers(manifest.providers, (provider) => provider.id)) {
      addDuplicateIssue(ctx, 'providers', duplicateProviderId);
    }

    for (const duplicateTriggerPrefix of findDuplicateIdentifiers(manifest.triggers, (trigger) => trigger.prefix)) {
      addDuplicateIssue(ctx, 'triggers', duplicateTriggerPrefix);
    }

    for (const duplicateImporterName of findDuplicateIdentifiers(
      manifest.logImporters,
      (importer) => importer.adapterName,
    )) {
      addDuplicateIssue(ctx, 'logImporters', duplicateImporterName);
    }

    for (const duplicateActionId of findDuplicateIdentifiers(manifest.sessionEventActions, (action) => action.id)) {
      addDuplicateIssue(ctx, 'sessionEventActions', duplicateActionId);
    }

    for (const duplicateHookId of findDuplicateIdentifiers(manifest.artifactLifecycleHooks, (hook) => hook.id)) {
      addDuplicateIssue(ctx, 'artifactLifecycleHooks', duplicateHookId);
    }
  }) satisfies z.ZodType<ContributionManifest>;
