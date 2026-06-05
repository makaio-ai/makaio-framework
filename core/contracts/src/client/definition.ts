/**
 * Client definition contracts for the Makaio client registry.
 *
 * A "client" is a first-party AI coding agent binary (e.g. Claude Code, Codex)
 * that Makaio can harness. These schemas describe the static definition shape
 * contributed by each client package and stored in the `clients` table.
 * @packageDocumentation
 */

import { z } from 'zod';
import { ApprovalPolicySchema } from '../harness/schemas.js';
import { isPortableAbsolutePath, NonEmptyStringSchema } from './primitives.js';
import { VersionLiteralSchema, type VersionRange, VersionRangeSchema } from '../version/index.js';

/**
 * Schema for a capability annotation attached to a native client tool.
 *
 * Captures a capability tag (e.g. `'shell.execute'`) and an optional
 * human-readable description so the Harness UI can explain what a tool does
 * without coupling to the platform capability taxonomy.
 */
export const ClientToolCapabilityAnnotationSchema = z.object({
  /** Capability tag (e.g. `'shell.execute'`, `'file.write'`). */
  tag: z.string(),
  /** Human-readable description of what this capability allows. */
  description: z.string().optional(),
});

export type ClientToolCapabilityAnnotation = z.infer<typeof ClientToolCapabilityAnnotationSchema>;

/**
 * Schema for a single native tool provided by a client binary.
 *
 * Native tools are those the client binary exposes directly (e.g. `bash`,
 * `file_edit`). They are declared by the client package and seeded into
 * the harness at startup.
 */
export const ClientToolDefinitionSchema = z.object({
  /**
   * Tool identifier as reported by the binary (e.g. `'bash'`, `'file_edit'`).
   */
  name: z.string(),
  /** Human-readable label for Harness UI (e.g. `'Bash Shell'`). */
  friendlyName: z.string(),
  /** What this tool does. */
  description: z.string().optional(),
  /** Category for UI grouping (e.g. `'System'`, `'Files'`). */
  category: z.string().optional(),
  /**
   * Capability tags for policy expansion.
   * Maps to the platform capability taxonomy (e.g. `'shell.execute'`,
   * `'file.write'`) and drives approval-policy resolution.
   */
  capabilities: z.array(ClientToolCapabilityAnnotationSchema).default([]),
});

export type ClientToolDefinition = z.infer<typeof ClientToolDefinitionSchema>;

/**
 * Schema for a log source definition contributed by a client package.
 *
 * Log sources describe where the client binary writes conversation logs so the
 * Makaio log-import service can discover and ingest them.
 */
export const LogSourceDefinitionSchema = z.object({
  /** Stable source identifier (e.g. `'claude-code-projects'`). */
  id: z.string(),
  /** Human-readable name shown in the import UI. */
  name: z.string(),
  /** Description of the log source. */
  description: z.string().optional(),
  /**
   * File glob pattern for discovery
   * (e.g. `'~/.claude/projects/**\/*.jsonl'`).
   */
  glob: z.string().optional(),
});

export type LogSourceDefinition = z.infer<typeof LogSourceDefinitionSchema>;

/**
 * Schema for a hook event declaration on a client definition.
 *
 * Declares which native hook events the client binary fires. Used by the
 * wiring layer to know what hooks to install, and by the UI to display
 * available events.
 */
export const ClientHookEventDeclarationSchema = z.object({
  /** Native event name as emitted by the binary (e.g. `'PreToolUse'`). */
  name: z.string().min(1),
  /**
   * Global framework subject this event maps to, when one exists.
   * Omit for client-specific events with no global counterpart.
   *
   * Intentionally an open string — the contracts layer does not constrain
   * the set of framework subjects because new subjects may be added by
   * extensions without updating client definitions. Typo prevention is
   * handled by hook-event-sync integration tests in each client package.
   */
  frameworkSubject: z.string().min(1).optional(),
  /**
   * Hook interaction mode for this event.
   *
   * - `'event'` (default) — fire-and-forget: the wiring layer installs
   *   `makaio hook received ...` for this event. The client binary does
   *   not wait for a response.
   * - `'request'` — request/response: the wiring layer installs
   *   `makaio hook handle ...` for this event. The client binary blocks
   *   until the command exits and reads its stdout as the response.
   */
  mode: z.enum(['event', 'request']).default('event'),
});

export type ClientHookEventDeclaration = z.infer<typeof ClientHookEventDeclarationSchema>;

// ---------------------------------------------------------------------------
// Config isolation descriptor
// ---------------------------------------------------------------------------

/**
 * Schema for the config isolation descriptor on a client definition.
 *
 * Describes the environment variable and default path the client binary uses
 * for config isolation. Most clients accept a directory path. Some clients only
 * expose a file-level override, so `pathKind` records which value shape the env
 * var expects.
 */
export const ConfigIsolationSchema = z.object({
  /**
   * Environment variable that overrides the client's config location.
   * Set by Makaio when launching a managed binary to isolate its config from the
   * user's global install (e.g. `'CLAUDE_CONFIG_DIR'`, `'CODEX_HOME'`).
   */
  envVar: NonEmptyStringSchema.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: 'envVar must be a valid environment variable name (letters, digits, underscores)',
  }),
  /**
   * Default config path used by the client when the env var is not set.
   * Used by `resolveBinary` to determine the config location for global
   * binaries and by wiring systems to know where to write native config when no
   * isolation is active (e.g. `'~/.claude'`, `'~/.codex'`).
   *
   * Must be an absolute path or start with `~/` (or equal `~` for a bare home
   * directory reference). Whitespace-only strings and relative paths are
   * rejected at parse time.
   */
  defaultPath: NonEmptyStringSchema.refine(
    (value) => value === '~' || value.startsWith('~/') || isPortableAbsolutePath(value),
    { message: "defaultPath must be absolute, '~', or start with '~/'" },
  ),
  /**
   * Shape expected by `envVar`.
   *
   * Directory targets receive the isolated config directory itself. File targets
   * receive a file path inside the isolated config directory using the basename
   * of `defaultPath`.
   */
  pathKind: z.enum(['directory', 'file']).default('directory'),
});

export type ConfigIsolation = z.infer<typeof ConfigIsolationSchema>;

/**
 * Return true when an npm package spec is only a package name, without an
 * inline version suffix.
 * @param value - Candidate npm package name.
 * @returns True when the value does not include a version suffix.
 */
function isBareNpmPackageName(value: string): boolean {
  if (!value.startsWith('@')) {
    return !value.includes('@');
  }
  const slashIndex = value.indexOf('/');
  return slashIndex > 1 && !value.slice(slashIndex + 1).includes('@');
}

// ---------------------------------------------------------------------------
// Managed install descriptors
// ---------------------------------------------------------------------------

/**
 * Install descriptor for the `npm` strategy.
 *
 * The manager runs a sandboxed `npm install --prefix <targetDir>` for the
 * pinned package version so managed installs do not mutate global npm state.
 * An exact version pin is required; floating ranges are not accepted so the
 * framework can reproduce the same binary across machines and time.
 */
export const NpmInstallDescriptorSchema = z.object({
  type: z.literal('npm'),
  /**
   * npm package name to install (e.g. `'@anthropic-ai/claude-code'`).
   * Must not include an inline `@version` suffix — use the `version` field.
   */
  package: z.string().min(1).refine(isBareNpmPackageName, {
    message: 'package must not include an inline `@version` suffix; use the version field instead',
  }),
  /**
   * Exact semver version of the package to install (e.g. `'1.2.3'`).
   * Required so managed installs are fully deterministic.
   */
  version: VersionLiteralSchema,
});

export type NpmInstallDescriptor = z.infer<typeof NpmInstallDescriptorSchema>;

/**
 * Install descriptor for the `signed-binary-bucket` strategy.
 *
 * The manager fetches a GPG-signed manifest from a versioned bucket path,
 * verifies the manifest signature against the declared public key, selects the
 * per-platform binary, downloads it, and verifies its checksum before
 * activating the install.
 *
 * All bucket paths are Go-style templates: `{version}` is replaced with the
 * resolved version string and `{platform}` / `{binary}` are replaced with the
 * per-platform values from the `platforms` map.
 */
export const SignedBinaryBucketInstallDescriptorSchema = z.object({
  type: z.literal('signed-binary-bucket'),
  /**
   * Exact semver version of the binary to install (e.g. `'2.1.143'`).
   * Required so managed installs are fully deterministic.
   */
  version: VersionLiteralSchema,
  /** Bucket configuration required to locate and verify the binary. */
  config: z.object({
    /**
     * Base URL of the storage bucket
     * (e.g. `'https://downloads.claude.ai/claude-code-releases'`).
     */
    baseUrl: z.string().url(),
    /**
     * Bucket-relative path template for the per-version manifest JSON file.
     * (e.g. `'{version}/manifest.json'`).
     */
    manifestPathTemplate: z.string().min(1),
    /**
     * Bucket-relative path template for the detached GPG signature of the
     * manifest (e.g. `'{version}/manifest.json.sig'`).
     */
    manifestSignaturePathTemplate: z.string().min(1),
    /**
     * URL of the ASCII-armored public key used to verify the manifest
     * signature (e.g. `'https://downloads.claude.ai/keys/claude-code.asc'`).
     */
    publicKeyUrl: z.string().url(),
    /**
     * Full OpenPGP fingerprint of the expected signing key
     * (e.g. `'31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE'`).
     *
     * The install pipeline verifies that the downloaded key matches this
     * fingerprint before trusting the signature.
     */
    publicKeyFingerprint: z.string().min(1),
    /**
     * Bucket-relative path template for the binary to download.
     * (e.g. `'{version}/{platform}/{binary}'`).
     */
    binaryPathTemplate: z.string().min(1),
    /**
     * Mapping from platform key to the platform directory segment used in
     * bucket paths.
     *
     * Keys follow the `<os>-<arch>` convention used by Node.js
     * `process.platform` and `process.arch`, with an optional suffix for
     * libc variant (e.g. `'darwin-arm64'`, `'linux-x64-musl'`).
     * Values are the platform path segment as stored in the bucket.
     */
    platforms: z.record(z.string().min(1), z.string().min(1)),
  }),
});

export type SignedBinaryBucketInstallDescriptor = z.infer<typeof SignedBinaryBucketInstallDescriptorSchema>;

/**
 * Discriminated union of all supported managed install descriptors.
 *
 * Two strategies are supported:
 * - `npm`                  — npm registry installation with an exact version pin.
 * - `signed-binary-bucket` — signed static bucket download with an exact version pin.
 *
 * The descriptor is purely declarative; no runtime logic lives here.
 */
export const ManagedInstallDescriptorSchema = z.discriminatedUnion('type', [
  NpmInstallDescriptorSchema,
  SignedBinaryBucketInstallDescriptorSchema,
]);

export type ManagedInstallDescriptor = z.infer<typeof ManagedInstallDescriptorSchema>;

// ---------------------------------------------------------------------------
// Version command schema
// ---------------------------------------------------------------------------

/**
 * Platform-aware command descriptor for querying the installed binary version.
 *
 * The `executable` field may be a single relative path string (used on all
 * platforms) or a platform-keyed object that overrides the `default` executable
 * on specific operating systems.
 *
 * All executable values are resolved relative to the managed install directory
 * — absolute paths and parent-directory traversals (`..`) are rejected by the
 * `ClientDefinitionSchema` refinement.
 */
export const VersionCommandSchema = z
  .object({
    /**
     * Executable path, relative to the managed install directory.
     *
     * Provide a plain string to use the same executable on all platforms, or a
     * platform-keyed object to supply per-OS overrides (useful when the binary
     * has a platform-specific name or extension, e.g. `'bin/claude.exe'` on
     * Windows).
     */
    executable: z.union([
      z.string().min(1),
      z
        .object({
          /** Fallback executable when no platform-specific key matches. */
          default: z.string().min(1),
          /** macOS override (maps to `process.platform === 'darwin'`). */
          darwin: z.string().min(1).optional(),
          /** Linux override (maps to `process.platform === 'linux'`). */
          linux: z.string().min(1).optional(),
          /** Windows override (maps to `process.platform === 'win32'`). */
          win32: z.string().min(1).optional(),
        })
        .strict(),
    ]),
    /**
     * Arguments passed to the executable when querying the version.
     * Defaults to an empty array when omitted.
     */
    args: z.array(z.string()).default([]),
  })
  .strict();

export type VersionCommand = z.infer<typeof VersionCommandSchema>;

/**
 * Optional post-install action descriptor.
 *
 * Carries an open-ended `kind` string so the runtime can dispatch to a
 * registered post-install handler without the contracts layer enumerating
 * every possible action.
 */
export const PostInstallDescriptorSchema = z.object({
  /**
   * Stable identifier for the post-install handler
   * (e.g. `'set-permissions'`, `'run-script'`).
   */
  kind: z.string().min(1),
  /** Arbitrary handler-specific payload. */
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type PostInstallDescriptor = z.infer<typeof PostInstallDescriptorSchema>;

/**
 * Declarative runtime capability flags for a client package.
 *
 * These flags are static declarations contributed by the client package.
 * They inform Makaio which observation and launch mechanisms the client
 * supports so the framework can activate the appropriate producers and
 * adapt its behaviour without runtime probing.
 *
 * All flags default to `false` so packages only need to opt in to what they
 * actually support.
 */
export const ClientRuntimeCapabilitiesSchema = z
  .object({
    /**
     * The client binary supports native hook callbacks (e.g. `PostToolUse`,
     * `Stop`) that Makaio can use to observe session lifecycle events.
     */
    supportsHooks: z.boolean().default(false),
    /**
     * The client binary exposes a statusline or process-watcher interface
     * that Makaio can poll or subscribe to for runtime state.
     */
    supportsStatusline: z.boolean().default(false),
    /**
     * Makaio can launch this client binary as a supervised child process,
     * enabling direct PID tracking and stdin/stdout piping.
     */
    supportsSupervisorLaunch: z.boolean().default(false),
    /**
     * Makaio manages the client binary installation and updates (e.g. via
     * a bundled binary or a managed package install step).
     */
    supportsManagedBinary: z.boolean().default(false),
    /**
     * Declared hook events when supportsHooks is true.
     * Lists which native event names the binary fires so the wiring layer
     * knows what hooks to install. Must be empty when supportsHooks is false.
     */
    hookEvents: z.array(ClientHookEventDeclarationSchema).default([]),
  })
  .refine((v) => v.supportsHooks || v.hookEvents.length === 0, {
    message: 'hookEvents must be empty when supportsHooks is false',
    path: ['hookEvents'],
  });

export type ClientRuntimeCapabilities = z.infer<typeof ClientRuntimeCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Binary compatibility descriptor
// ---------------------------------------------------------------------------

/**
 * Binary compatibility descriptor for a client definition.
 *
 * Groups all binary-related compatibility information: the executable name
 * used for PATH detection and the version range the framework supports.
 */
export interface ClientBinaryCompatibility {
  /** Binary name used for CLI detection (e.g. `'claude'` for the `claude` binary on `PATH`). */
  readonly name: string;
  /**
   * npm semver range of supported binary versions
   * (e.g. `'>=1.0.0'`, `'^2.0.0'`).
   */
  readonly supportedVersions: VersionRange;
}

/** Zod schema for {@link ClientBinaryCompatibility}. */
export const ClientBinaryCompatibilitySchema = z
  .object({
    name: z.string().min(1),
    supportedVersions: VersionRangeSchema,
  })
  .strict() satisfies z.ZodType<ClientBinaryCompatibility>;

/**
 * Static definition for a Makaio client package.
 *
 * Each client package (e.g. `@makaio/client-claude-code`) exports exactly one
 * `ClientDefinition` object. The bootstrap service discovers and seeds these
 * definitions into the `clients` storage table on startup.
 *
 * Key fields:
 * - `runtimeCapabilities` — capability flags (hooks, managed binary, etc.)
 * - `managedInstall` — install descriptor when Makaio manages the binary.
 * - `configIsolation` — env var and default path for config isolation.
 *   Used by both managed and global binaries; see {@link ConfigIsolationSchema}.
 */
export const ClientDefinitionSchema = z
  .object({
    /**
     * Stable string ID — must match the client package name suffix
     * (e.g. `'claude-code'` for `@makaio/client-claude-code`).
     */
    id: z.string(),
    /** Display name shown in the UI (e.g. `'Claude Code'`). */
    name: z.string(),
    /** SemVer version of the client definition contract. */
    version: VersionLiteralSchema,
    /** Short human-readable description for UI surfaces. */
    description: z.string().optional(),
    /**
     * Binary compatibility descriptor for this client.
     *
     * When present, declares the binary name for PATH detection and the
     * supported version range. Omit for clients that do not expose a
     * named binary on `PATH` (e.g. purely-managed or embedded clients).
     */
    binary: ClientBinaryCompatibilitySchema.optional(),
    /** Native tools the binary exposes to the harness. */
    nativeTools: z.array(ClientToolDefinitionSchema).default([]),
    /**
     * Recommended default approval policy applied when creating a harness for
     * this client.
     */
    defaultApprovalPolicy: ApprovalPolicySchema,
    /** Log source definitions used by the log-import service. */
    logSources: z.array(LogSourceDefinitionSchema).optional(),
    /**
     * Provider definition ID to use for client-managed auth (sentinel
     * ProviderConfig). References a ProviderDefinition.id.
     */
    defaultProviderId: z.string().optional(),
    /**
     * Declarative runtime capability flags for this client.
     *
     * Omitting this field or passing `{}` applies `false` to every flag.
     * Individual flags can be opted into independently.
     */
    runtimeCapabilities: ClientRuntimeCapabilitiesSchema.optional().transform((v) =>
      ClientRuntimeCapabilitiesSchema.parse(v ?? {}),
    ),
    /**
     * Declarative install descriptor used by the binary manager when
     * `runtimeCapabilities.supportsManagedBinary` is `true`.
     *
     * Exactly one supported managed install strategy must be provided.
     * Omit this field for clients that are not managed by Makaio.
     */
    managedInstall: ManagedInstallDescriptorSchema.optional(),
    /**
     * Command descriptor used to query the installed binary version.
     *
     * The `executable` field is resolved **relative to the managed install
     * directory** (i.e. the versioned directory written by the install
     * strategy after `postInstall` runs), not looked up on `PATH`.
     * Absolute paths and parent-directory traversals (`..`) are rejected.
     *
     * Required whenever `managedInstall` is provided.
     * @example
     * ```ts
     * versionCommand: { executable: 'bin/claude', args: ['--version'] }
     * ```
     * @example Platform-specific executables
     * ```ts
     * versionCommand: {
     *   executable: { default: 'bin/claude', win32: 'bin/claude.exe' },
     *   args: ['--version'],
     * }
     * ```
     */
    versionCommand: VersionCommandSchema.optional(),
    /**
     * Optional post-install action to run after the binary is written to disk
     * but before it is activated.
     *
     * Omit when no post-install step is required.
     */
    postInstall: PostInstallDescriptorSchema.optional(),
    /**
     * Config isolation descriptor for this client.
     *
     * Describes the environment variable and default path used by the client
     * binary for its config location. Optional for all clients — both managed
     * and global binaries benefit from this descriptor:
     * - For managed binaries, the wiring system sets `envVar` to an isolated
     *   directory or file path so the binary does not share config with the
     *   user's global install.
     * - For global binaries, `defaultPath` tells the wiring system where to
     *   write hooks when no isolation is active.
     */
    configIsolation: ConfigIsolationSchema.optional(),
  })
  .strict()
  .refine(
    (definition) => !definition.runtimeCapabilities.supportsManagedBinary || definition.managedInstall !== undefined,
    {
      message: 'managedInstall is required when runtimeCapabilities.supportsManagedBinary is true',
      path: ['managedInstall'],
    },
  )
  .refine(
    (definition) => definition.managedInstall === undefined || definition.runtimeCapabilities.supportsManagedBinary,
    {
      message: 'runtimeCapabilities.supportsManagedBinary must be true when managedInstall is provided',
      path: ['runtimeCapabilities', 'supportsManagedBinary'],
    },
  )
  .refine((definition) => definition.managedInstall === undefined || definition.versionCommand !== undefined, {
    message: 'versionCommand is required when managedInstall is provided',
    path: ['versionCommand'],
  })
  .superRefine((definition, ctx) => {
    if (definition.managedInstall === undefined || definition.versionCommand === undefined) {
      return;
    }

    // Collect all executable candidates — both the cross-platform default and
    // any per-OS overrides — so every path is validated uniformly.
    const { executable } = definition.versionCommand;
    const candidates: Array<{ path: string; issuePath: Array<string | number> }> =
      typeof executable === 'string'
        ? [{ path: executable, issuePath: ['versionCommand', 'executable'] }]
        : [
            { path: executable.default, issuePath: ['versionCommand', 'executable', 'default'] },
            ...(executable.darwin !== undefined
              ? [{ path: executable.darwin, issuePath: ['versionCommand', 'executable', 'darwin'] }]
              : []),
            ...(executable.linux !== undefined
              ? [{ path: executable.linux, issuePath: ['versionCommand', 'executable', 'linux'] }]
              : []),
            ...(executable.win32 !== undefined
              ? [{ path: executable.win32, issuePath: ['versionCommand', 'executable', 'win32'] }]
              : []),
          ];

    for (const { path: execPath, issuePath } of candidates) {
      const isAbsolutePosix = execPath.startsWith('/');
      const isWindowsDrivePrefixed = /^[A-Za-z]:/.test(execPath);
      const isAbsoluteWindowsRooted = execPath.startsWith('\\');

      // Validate Windows forms explicitly even on POSIX hosts; client
      // definitions are portable contracts, not host-local path strings.
      if (isAbsolutePosix || isWindowsDrivePrefixed || isAbsoluteWindowsRooted) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: `${issuePath.join('.')} must be a relative path within the install directory`,
        });
        continue;
      }

      const segments = execPath.split(/[/\\]/);
      const hasTraversal = segments.some((segment) => segment === '..');

      if (hasTraversal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: `${issuePath.join('.')} must be a relative path within the install directory`,
        });
      }
    }
  });

export type ClientDefinitionInput = z.input<typeof ClientDefinitionSchema>;
export type ClientDefinition = z.infer<typeof ClientDefinitionSchema>;
