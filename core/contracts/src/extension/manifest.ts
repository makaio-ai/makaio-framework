/**
 * Pure-data manifest types and Zod schemas for Makaio extensions.
 *
 * All types in this module are fully serializable — no functions, no class
 * instances. They are safe to inspect, gate, and transmit across process
 * boundaries. The manifest layer sits below {@link MakaioExtension} and is the
 * source of truth for what an extension declares about itself structurally
 * before executable code is loaded. Runtime wiring remains owned by the
 * executable `MakaioExtension` fields.
 * @see {@link MakaioExtension} for the executable extension of these types.
 */

import { z } from 'zod';
import type { BrowserEntrypoint } from './browser-entrypoint.js';
import { BrowserEntrypointSchema } from './browser-entrypoint.js';
import { CapabilityTokenSchema, type CapabilityToken } from './capability-token.js';
import type { ContributionManifest } from './contribution-manifest.js';
import { ContributionManifestSchema } from './contribution-manifest.js';
import { type VersionLiteral, VersionLiteralSchema, type VersionRange, VersionRangeSchema } from '../version/index.js';

// ---------------------------------------------------------------------------
// Window manifest
// ---------------------------------------------------------------------------

/**
 * Visual presentation style for an extension window.
 *
 * - `'tray-popover'` — small overlay anchored to the system tray icon.
 * - `'utility'` — standalone auxiliary window (e.g., settings panel).
 * - `'panel'` — docked or floating workspace panel.
 */
export type WindowStyle = 'tray-popover' | 'utility' | 'panel';

/**
 * Describes a window surface an extension can open.
 *
 * The shell uses this declaration to pre-register the window and manage
 * its lifecycle without requiring the extension to be initialized first.
 */
export interface WindowManifest {
  /**
   * Identifier unique within the declaring extension.
   * Referenced by {@link TrayManifest.opensWindow} to associate tray
   * actions with specific windows.
   */
  readonly id: string;
  /** Visual presentation style that governs how the shell positions and sizes the window. */
  readonly style: WindowStyle;
  /** Preferred initial width in logical pixels. */
  readonly width?: number;
  /** Preferred initial height in logical pixels. */
  readonly height?: number;
  /**
   * When `true`, the shell ensures at most one instance of this window is
   * open at a time, focusing the existing window instead of opening a new one.
   */
  readonly singleton?: boolean;
  /**
   * Named route parameters this window accepts.
   * The shell uses these to map URL path segments to query params and
   * to generalize window deduplication without hardcoding host IDs.
   */
  readonly params?: readonly WindowParamSpec[];
}

/**
 * Specification for a named window route parameter.
 */
export interface WindowParamSpec {
  /** Parameter name (e.g. `'projectId'`). */
  readonly name: string;
  /** Whether this parameter is required for window creation. */
  readonly required?: boolean;
}

/** Zod schema for {@link WindowParamSpec}. */
export const WindowParamSpecSchema = z.object({
  name: z.string().min(1),
  required: z.boolean().optional(),
}) satisfies z.ZodType<WindowParamSpec>;

// WindowManifest, TrayManifest, and StorageManifest string fields do not
// enforce .min(1) here because these schemas predate the extension descriptor
// branch. The CLI manifest schemas were hardened with .min(1) because they
// were introduced on this branch. Tightening pre-existing schemas is a
// separate pass that should include a migration audit of existing descriptors.
/** Zod schema for {@link WindowManifest}. */
export const WindowManifestSchema = z
  .object({
    id: z.string(),
    style: z.enum(['tray-popover', 'utility', 'panel']),
    width: z.number().optional(),
    height: z.number().optional(),
    singleton: z.boolean().optional(),
    // Multi-param support is intentionally allowed by the schema. The Electron
    // navigation resolver currently assumes a single-param invariant (documented
    // in navigation-handler.ts) but enforcing .max(1) here would prevent
    // extension authors from declaring multi-param windows ahead of router support.
    params: z.array(WindowParamSpecSchema).readonly().optional(),
  })
  .superRefine((window, ctx) => {
    const seen = new Set<string>();
    for (const [index, param] of window.params?.entries() ?? []) {
      if (!seen.has(param.name)) {
        seen.add(param.name);
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate window param "${param.name}"`,
        path: ['params', index, 'name'],
      });
    }
  }) satisfies z.ZodType<WindowManifest>;

// ---------------------------------------------------------------------------
// Tray manifest
// ---------------------------------------------------------------------------

/**
 * Describes an extension's entry in the system tray menu.
 *
 * The shell renders tray items grouped by {@link section}. Only one of
 * {@link opensWindow} or {@link action} should be set; if both are present
 * the shell prefers {@link opensWindow}.
 */
export interface TrayManifest {
  /** Human-readable label shown in the tray menu. */
  readonly label: string;
  /**
   * Logical grouping for tray menu layout.
   *
   * - `'utilities'` — system / account tools (e.g., auth switcher).
   * - `'tools'` — productivity tools (e.g., code review).
   * - `'views'` — windows or panels that present content.
   */
  readonly section?: 'utilities' | 'tools' | 'views';
  /**
   * {@link WindowManifest.id} of the window to open when this tray item is
   * clicked. Takes precedence over {@link action} when both are defined.
   */
  readonly opensWindow?: string;
  /**
   * Opaque action identifier echoed in `host:tray.item.clicked` metadata when
   * this tray item is clicked.
   */
  readonly action?: string;
}

/** Zod schema for {@link TrayManifest}. */
export const TrayManifestSchema = z.object({
  label: z.string(),
  section: z.enum(['utilities', 'tools', 'views']).optional(),
  opensWindow: z.string().optional(),
  action: z.string().optional(),
}) satisfies z.ZodType<TrayManifest>;

// ---------------------------------------------------------------------------
// CLI manifest
// ---------------------------------------------------------------------------

/**
 * Describes a single positional argument or named option for a CLI subcommand.
 *
 * This is the serializable, framework-agnostic counterpart to
 * `CliSubcommandDefinition` — it carries only metadata, no handler.
 */
export interface CliArgManifest {
  /**
   * Argument or option name.
   * For positional args this is the display name shown in usage text.
   * For named options it is the schema field name. The CLI adapter converts it
   * to a kebab-case long flag when registering Commander options
   * (e.g. `'clientId'` -\> `--client-id`).
   */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** When `true`, the CLI parser rejects invocations that omit this argument. */
  readonly required?: boolean;
  /** When `true`, treat as a positional argument rather than a named option. */
  readonly positional?: boolean;
  /** Short single-character flag alias (e.g. `'-p'`). */
  readonly short?: string;
  /**
   * Value type for this argument or option.
   * Used by manifest-based CLI registration to determine whether an option
   * takes a value or is a boolean flag. Defaults to `'string'` when omitted.
   * Manifest-based registration also uses this metadata to coerce numeric
   * values before they reach the subcommand's Zod schema.
   */
  readonly type?: 'string' | 'boolean' | 'number';
}

/** Zod schema for {@link CliArgManifest}. */
export const CliArgManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  required: z.boolean().optional(),
  positional: z.boolean().optional(),
  short: z
    .string()
    .regex(/^-[A-Za-z0-9]$/, 'Expected a short flag like -p')
    .optional(),
  type: z.enum(['string', 'boolean', 'number']).optional(),
}) satisfies z.ZodType<CliArgManifest>;

/**
 * Describes a single subcommand nested under the extension's top-level CLI command.
 *
 * Pure metadata — no handler. Used for help generation and manifest inspection.
 */
export interface CliSubcommandManifest {
  /** Subcommand name (e.g. `'list'`, `'switch'`). */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** Arguments and options accepted by this subcommand. */
  readonly args?: readonly CliArgManifest[];
}

/** Zod schema for {@link CliSubcommandManifest}. */
export const CliSubcommandManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  args: z.array(CliArgManifestSchema).readonly().optional(),
}) satisfies z.ZodType<CliSubcommandManifest>;

/**
 * Describes the top-level CLI command an extension contributes.
 *
 * Serializable and framework-agnostic. The executable extension,
 * `ExtensionCliContribution`, adds the interactive handler and typed subcommand
 * definitions. The CLI router uses this manifest for help generation and
 * command discovery without loading handler code.
 */
export interface CliManifest {
  /** Top-level command name (e.g. `'account-manager'`). */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** Non-interactive subcommands registered under this command. */
  readonly subcommands?: readonly CliSubcommandManifest[];
  /**
   * Whether this extension provides an interactive TUI handler.
   *
   * When `true`, invoking the bare command (without a subcommand) launches
   * the interactive handler. When `false` or omitted, bare invocation shows
   * help. This is a serializable declaration in `descriptor.json`; the
   * executable handler itself lives in `ExtensionCliContribution.interactive`.
   *
   * Named `hasInteractive` (not `interactive`) to avoid a type conflict with
   * the `ExtensionCliContribution` property of the same short name, which carries
   * the function implementation rather than a boolean flag.
   */
  readonly hasInteractive?: boolean;
  /**
   * Pre-connection routing hint indicating that this extension can embed and
   * provide its own bus instance.
   *
   * When `true`, the CLI router may skip desktop auto-launch for a matching
   * local command after probing for an already-running external daemon. The
   * executable contribution can then bootstrap a self-contained bus for
   * standalone or embedded execution if no external bus connected.
   *
   * This is a serializable declaration only — it carries no executable startup
   * logic. The actual bus provisioning is performed by the executable
   * `CliContribution.provideBus` handler.
   */
  readonly canProvideBus?: boolean;
}

/** Zod schema for {@link CliManifest}. */
export const CliManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  subcommands: z.array(CliSubcommandManifestSchema).readonly().optional(),
  hasInteractive: z.boolean().optional(),
  canProvideBus: z.boolean().optional(),
}) satisfies z.ZodType<CliManifest>;

// ---------------------------------------------------------------------------
// Storage manifest
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the supported storage backend dialects.
 *
 * An identity vocabulary, not a runtime dialect branch: extensions declare
 * which dialect a migration chain targets. SQLite is the default dialect;
 * Postgres is opt-in. Consumers that need to enumerate every dialect (build
 * tooling, validators) iterate this list rather than re-typing the keys.
 */
export const STORAGE_DIALECTS = ['sqlite', 'postgres'] as const;

/**
 * Storage backend dialect identifier used in serializable manifests.
 *
 * Derived from {@link STORAGE_DIALECTS} so the type and the runtime list can
 * never drift.
 */
export type StorageDialect = (typeof STORAGE_DIALECTS)[number];

/**
 * Describes the storage requirements of an extension.
 *
 * Serializable metadata that the runtime uses to run migrations before
 * starting the extension's service. The migrations path is relative to the
 * extension root and resolved to an absolute path by the composition root.
 * Bundled hosts may also provide a stable `migrationSourceId` so migration
 * identity does not collapse onto packaged output paths.
 */
export interface StorageManifest {
  /**
   * Drizzle migration chain(s) for this extension, relative to the extension root.
   *
   * Two forms are accepted, mirroring the `makaio.drizzleSchema` object-form
   * precedent:
   *
   * - A bare string declares a single, dialect-agnostic chain that is applied
   *   on every active dialect (e.g. `'drizzle'`).
   * - An object maps a {@link StorageDialect} to the chain folder for that
   *   dialect (e.g. `{ sqlite: 'drizzle', postgres: 'drizzle-postgres' }`),
   *   letting an extension ship dialect-specific migration text.
   *
   * Each declared path is relative to the extension root; the composition root
   * resolves it to an absolute path per dialect and passes it to the
   * host-supplied `runMigrations` callback before any extension services are
   * started. The callback applies pending migrations against the shared
   * database using a per-extension tracking table to avoid filename collisions.
   * @example 'drizzle'
   * @example `{ sqlite: 'drizzle', postgres: 'drizzle-postgres' }`
   */
  readonly migrations?: string | Partial<Record<StorageDialect, string>>;
  /**
   * Stable runtime identity for the migration bundle.
   *
   * Hosts use this to key deduplication, ledger tables, and bundled migration
   * lookup independently of the on-disk discovery path. When omitted, the
   * resolved migration folder path remains the identity.
   */
  readonly migrationSourceId?: string;
}

/**
 * Resolve the dialect-agnostic primary migration chain folder from a declared
 * {@link StorageManifest.migrations} value.
 *
 * This collapses the widened declaration to the single chain folder a
 * dialect-agnostic consumer should use:
 *
 * - The bare-string form is returned verbatim.
 * - The object form prefers the `sqlite` entry (the baseline dialect), falling
 *   back to the first declared per-dialect entry so a single chain is still
 *   surfaced when only a non-default dialect is declared.
 * - An empty object form yields `undefined`, meaning "no chain declared".
 *
 * Composition roots that resolve every per-dialect path independently read the
 * object form directly; this helper exists for consumers that only need one
 * representative chain folder.
 * @param migrations - The declared `storage.migrations` value, or `undefined`.
 * @returns The relative chain folder, or `undefined` when no chain is declared.
 */
export function primaryMigrationsPath(migrations: StorageManifest['migrations']): string | undefined {
  if (migrations === undefined) return undefined;
  if (typeof migrations === 'string') return migrations;
  return migrations.sqlite ?? Object.values(migrations).find((value) => value !== undefined);
}

/**
 * Enumerate every distinct migration chain folder declared by a
 * {@link StorageManifest.migrations} value.
 *
 * Where {@link primaryMigrationsPath} collapses the declaration to a single
 * representative folder, this surfaces all of them — the bare-string form
 * yields its one folder, the object form yields each declared per-dialect
 * folder (deduplicated, so a chain shared across dialects is copied once).
 *
 * Bundlers use this to copy every chain the host may resolve at boot: the host
 * keeps the declaration intact and selects the active dialect's chain at apply
 * time, so a build that copied only the primary chain would strand the other
 * declared dialects with a missing migration journal.
 * @param migrations - The declared `storage.migrations` value, or `undefined`.
 * @returns The distinct relative chain folders in declaration order; empty when
 *   no chain is declared.
 */
export function allMigrationsPaths(migrations: StorageManifest['migrations']): readonly string[] {
  if (migrations === undefined) return [];
  if (typeof migrations === 'string') return [migrations];
  const seen = new Set<string>();
  for (const value of Object.values(migrations)) {
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
}

const RelativeManifestPathSchema = z
  .string()
  .min(1)
  .refine((value) => !/^(?:[\\/]|[A-Za-z]:)/.test(value), 'Expected a relative path')
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..'),
    'Path must not contain empty or dot segments',
  );

/** Zod schema for {@link StorageManifest}. */
export const StorageManifestSchema = z.object({
  migrations: z
    .union([
      RelativeManifestPathSchema,
      z
        .object({
          sqlite: RelativeManifestPathSchema.optional(),
          postgres: RelativeManifestPathSchema.optional(),
        })
        .strict()
        // An empty object declares the migrations field while supplying no
        // chain, which the host would silently treat as "no migrations" — a
        // generation bug or typo must fail validation rather than quietly drop
        // an extension's schema.
        .refine(
          (value) => Object.values(value).some((chain) => chain !== undefined),
          'Per-dialect storage.migrations must declare at least one chain',
        ),
    ])
    .optional(),
  migrationSourceId: z.string().min(1).optional(),
}) satisfies z.ZodType<StorageManifest>;

// ---------------------------------------------------------------------------
// Extension dependency
// ---------------------------------------------------------------------------

/**
 * A structured dependency declaration on another extension.
 *
 * Carries the dependency name, a semver version range the declared extension
 * must satisfy, and an optional `optional` flag for non-fatal dependencies.
 */
export interface ExtensionDependency {
  /** Discriminant — always `'extension'`. */
  readonly type: 'extension';
  /**
   * {@link ExtensionManifest.name} of the required extension.
   *
   * Accepts the same plain or scoped npm identifier format as
   * {@link ExtensionManifest.name}.
   */
  readonly name: string;
  /**
   * Semver range the installed extension version must satisfy.
   *
   * Uses the same syntax as npm range strings (e.g. `'>=1.0.0 <2.0.0'`,
   * `'^1.5.0'`).
   */
  readonly version: VersionRange;
  /**
   * When `true` the extension may start even if this dependency is absent or
   * fails to activate.
   *
   * Omitting this field is equivalent to `false`.
   */
  readonly optional?: boolean;
}

/** Zod schema for {@link ExtensionDependency}. */
export const ExtensionDependencySchema = z.object({
  type: z.literal('extension'),
  name: z.string().min(1),
  version: VersionRangeSchema,
  optional: z.boolean().optional(),
}) satisfies z.ZodType<ExtensionDependency>;

/** Default semver range for extension dependencies when no explicit range is provided. */
export const DEFAULT_EXTENSION_DEPENDENCY_RANGE: VersionRange = '>=0.1.0';

/**
 * Factory that creates an {@link ExtensionDependency} with `type: 'extension'`.
 *
 * Prefer this helper over inline object literals to keep dependency
 * declarations concise and consistent across package descriptors.
 * @param name - {@link ExtensionManifest.name} of the required extension.
 * @param version - Semver range the required extension must satisfy.
 * @param optional - When `true`, activation continues if the dependency is absent.
 * @returns A fully-typed {@link ExtensionDependency} object.
 * @example
 * dependencies: [dep('provider-anthropic'), dep('makaio.clients-core')]
 */
export function dep(
  name: string,
  version: VersionRange = DEFAULT_EXTENSION_DEPENDENCY_RANGE,
  optional?: boolean,
): ExtensionDependency {
  return optional !== undefined ? { type: 'extension', name, version, optional } : { type: 'extension', name, version };
}

// ---------------------------------------------------------------------------
// Runtime requirement
// ---------------------------------------------------------------------------

/**
 * A typed runtime-environment gate that an extension declares it needs before
 * the kernel will activate it.
 *
 * Two flavors are supported:
 * - `'host'` — the runtime host must be present (e.g. `{ type: 'host', id: 'node' }`).
 * - `'capability'` — the host must advertise the named capability token
 *   (e.g. `{ type: 'capability', id: 'storage.drizzle' }`). The optional
 *   `version` field requires the host capability to declare a satisfying
 *   concrete version.
 *
 * This is an environment compatibility gate, not an extension-to-extension
 * dependency. Use {@link ExtensionManifest.dependencies} for structural ordering.
 */
export type RuntimeRequirement =
  | { readonly type: 'host'; readonly id: string }
  | { readonly type: 'capability'; readonly id: string; readonly version?: VersionRange };

/** Zod schema for {@link RuntimeRequirement}. */
export const RuntimeRequirementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('host'),
    id: z.string().min(1),
  }),
  z.object({
    type: z.literal('capability'),
    id: z.string().min(1),
    version: VersionRangeSchema.optional(),
  }),
]) satisfies z.ZodType<RuntimeRequirement>;

// ---------------------------------------------------------------------------
// Extension manifest
// ---------------------------------------------------------------------------

/**
 * Pure-data manifest for a Makaio extension.
 *
 * Fully serializable and safe to inspect or transmit without executing any
 * extension code. The shell and registry use this to discover extension surfaces
 * (windows, tray, CLI, storage) before deciding whether to initialize them.
 * @see {@link MakaioExtension} for the executable extension that adds `create`,
 * typed CLI handlers, and storage registration.
 */
export interface ExtensionManifest {
  /**
   * Unique extension identifier.
   *
   * Accepts plain identifiers (e.g. `'account-manager'`) and npm-scoped
   * names (e.g. `'@acme/weather-tools'`). Used as the primary key in the
   * extension registry and as the top-level CLI command name when no
   * {@link cli} override is provided.
   */
  readonly name: string;
  /** Human-readable display name shown in UI surfaces (e.g. `'Auth Switcher'`). */
  readonly displayName: string;
  /**
   * SemVer version of this extension package.
   *
   * Descriptor-only synthesized packages receive this from `descriptor.json`;
   * code-defined executable packages declare the same field directly on their
   * package object.
   */
  readonly version: VersionLiteral;
  /**
   * Execution surface the extension targets.
   *
   * - `'interactive'` — requires a UI shell (e.g., Electron renderer).
   * - `'headless'` — suitable for daemon or CLI-only runtimes.
   * - `'any'` — works in any surface (default when omitted).
   */
  readonly surface?: 'interactive' | 'headless' | 'any';
  /**
   * Structured dependencies on other extensions.
   *
   * The registry ensures all listed extensions are initialized before this
   * extension starts. Each entry carries the dependency name, a semver version
   * range the installed extension must satisfy, and an optional `optional` flag.
   * @see {@link ExtensionDependency}
   */
  readonly dependencies?: readonly ExtensionDependency[];
  /**
   * Runtime-environment gates this extension must satisfy before the kernel
   * activates it.
   *
   * Each entry is a {@link RuntimeRequirement} that declares either a required
   * host identity (e.g. `'node'`) or a host-advertised capability token (e.g.
   * `'storage.drizzle'`). All entries must be satisfied (AND semantics).
   *
   * This is an environment compatibility gate, not an extension-to-extension
   * dependency. Use {@link dependencies} for structural extension ordering.
   */
  readonly requires?: readonly RuntimeRequirement[];
  /**
   * Capability tokens this extension provides when active.
   *
   * Consumers and onboarding surfaces can inspect these declarations to decide
   * whether a capability exists at all before prompting the user to configure it.
   */
  readonly provides?: readonly CapabilityToken[];
  /** Windows this extension can open, keyed by {@link WindowManifest.id}. */
  readonly windows?: readonly WindowManifest[];
  /** System tray entry for this extension. */
  readonly tray?: TrayManifest;
  /**
   * CLI command contributed by this extension.
   *
   * On {@link ExtensionManifest} this is pure metadata. On {@link MakaioExtension}
   * this is widened to `ExtensionCliContribution` with executable handlers.
   */
  readonly cli?: CliManifest;
  /** Storage requirements (migrations) declared by this extension. */
  readonly storage?: StorageManifest;
  /**
   * Browser entry point for this extension.
   * URL path the renderer fetches to load the extension's UI.
   * @example '/extensions/my-extension/browser/index.js'
   */
  readonly browser?: BrowserEntrypoint;
  /**
   * Adapters and client binaries contributed by this extension.
   *
   * Discovery-time metadata only — serializable and safe to inspect without
   * loading any extension code. Runtime activation and registration use the
   * executable contribution fields on {@link MakaioExtension}; descriptor
   * metadata may mirror those fields for pre-load introspection but is not
   * used as a fallback wiring source.
   */
  readonly contributions?: ContributionManifest;
}

/** Zod schema for {@link ExtensionManifest}. */
export const ExtensionManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^(@[^/\\]+\/)?[^/\\]+$/, 'Extension name must be a plain identifier or an npm-scoped name (@scope/pkg)')
    .refine((n) => {
      const parts = n.startsWith('@') ? n.split('/') : [n];
      return parts.every((p) => p !== '.' && p !== '..');
    }, 'Extension name must not be a dot-segment'),
  displayName: z.string().min(1),
  version: VersionLiteralSchema,
  surface: z.enum(['interactive', 'headless', 'any']).optional(),
  dependencies: z.array(ExtensionDependencySchema).readonly().optional(),
  requires: z.array(RuntimeRequirementSchema).readonly().optional(),
  provides: z.array(CapabilityTokenSchema).readonly().optional(),
  windows: z.array(WindowManifestSchema).readonly().optional(),
  tray: TrayManifestSchema.optional(),
  cli: CliManifestSchema.optional(),
  storage: StorageManifestSchema.optional(),
  browser: BrowserEntrypointSchema.optional(),
  contributions: ContributionManifestSchema.optional(),
}) satisfies z.ZodType<ExtensionManifest>;
