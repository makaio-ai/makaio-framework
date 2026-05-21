/**
 * Pure-data descriptor for Makaio extensions.
 *
 * Maps 1:1 to `descriptor.json` shipped in the extension package root.
 * Extends {@link ExtensionManifest} with distribution-only fields: version,
 * entry points, execution mode, and version compatibility gate.
 *
 * The loading bridge reads this descriptor, validates it, and dynamically
 * imports the appropriate entry point to produce a {@link MakaioExtension}.
 * Descriptor `contributions` are intentionally not merged into that executable
 * extension; they remain pre-load metadata for discovery and inspection.
 */

import { z } from 'zod';
import type { ExtensionManifest } from './manifest.js';
import { ExtensionManifestSchema } from './manifest.js';
import type { VersionRange } from '../version/index.js';
import { VersionLiteralSchema, VersionRangeSchema } from '../version/index.js';

// ---------------------------------------------------------------------------
// Detached transport
// ---------------------------------------------------------------------------

/**
 * Shared fields for process-based transports.
 *
 * `command` is the executable to spawn (must be non-empty).
 * `args` are additional arguments forwarded to the child process.
 * `env` is a key-value map of environment variables to inject.
 * `healthTimeoutMs` limits how long the runtime waits for the child to become
 * healthy before treating startup as failed.
 * `shutdownTimeoutMs` limits how long the runtime waits for a graceful stop.
 */
const ProcessTransportBaseSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  healthTimeoutMs: z.number().int().positive().optional(),
  shutdownTimeoutMs: z.number().int().positive().optional(),
});

/**
 * Restart policy for supervised child processes.
 *
 * - `'none'` — never restart (default).
 * - `'on-crash'` — restart only on non-zero exit.
 * - `'always'` — restart unconditionally.
 */
const RestartPolicySchema = z.enum(['none', 'on-crash', 'always']);

const BusProcessTransportSchema = ProcessTransportBaseSchema.extend({
  restartPolicy: RestartPolicySchema.optional(),
});

/**
 * Discriminated union of supported transports for detached extensions.
 *
 * - `bus-stdio` — bidirectional Makaio bus over stdin/stdout.
 * - `bus-websocket` — bidirectional Makaio bus over a WebSocket connection.
 * - `mcp-stdio` — MCP protocol over stdin/stdout (no restart policy).
 */
export const DetachedTransportSchema = z.discriminatedUnion('type', [
  BusProcessTransportSchema.extend({ type: z.literal('bus-stdio') }),
  BusProcessTransportSchema.extend({ type: z.literal('bus-websocket') }),
  ProcessTransportBaseSchema.extend({ type: z.literal('mcp-stdio') }),
]);

/** Inferred type from {@link DetachedTransportSchema}. */
export type DetachedTransportConfig = z.infer<typeof DetachedTransportSchema>;

/**
 * Convention-based entrypoint declarations for each runtime surface.
 *
 * `true` means "use the surface name as the stem". A string value is a custom
 * stem whose final path segment names the file (e.g. `"cli/index"` resolves to
 * `src/cli/index.ts` in dev or `dist/cli/index.mjs` in production). Omit
 * surfaces the extension does not target.
 *
 * The runtime resolves the stem by trying `src/{stem}.ts` first (dev), then
 * `dist/{stem}.mjs` (production). No path prefix or file extension should be
 * included in the descriptor — those are added by convention.
 */
export interface ExtensionEntrypoints {
  /** Server entry — exports a {@link MakaioExtension} as default export. */
  readonly server?: true | string;
  /** Browser entry — bundled JS loaded in the renderer. */
  readonly browser?: true | string;
  /** CLI entry — exports an `ExtensionCliContribution` as default export. */
  readonly cli?: true | string;
}

/**
 * Check whether a descriptor entrypoint value is a valid stem.
 *
 * A valid stem:
 * - Uses `/` for nested stem segments, never platform-specific separators
 * - Does not start with `./`, `../`, or `/` (no explicit path context)
 * - Does not contain empty, `.`, or `..` path segments
 * - Does not contain a dotted final segment (no file extension or dotted basename)
 * - Does not contain the reserved segments `src` or `dist`, which are added
 *   by convention and must not appear in the stem itself
 * @param stem - Raw string value from `descriptor.json` entrypoints.
 * @returns Whether the value is a valid entrypoint stem.
 */
function isSafeEntrypointStem(stem: string): boolean {
  if (stem.includes('\\') || stem.startsWith('./') || stem.startsWith('../') || stem.startsWith('/')) {
    return false;
  }

  // Reserve src/ and dist/ as convention-owned segments and reject
  // normalization aliases before filesystem resolution sees them.
  const segments = stem.split('/');
  const basename = segments.at(-1);
  if (!basename || basename.includes('.')) {
    return false;
  }

  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'src' && segment !== 'dist',
  );
}

const EntrypointStemSchema = z.union([
  z.literal(true),
  z.string().min(1).refine(isSafeEntrypointStem, {
    message:
      'entrypoint stem must use forward-slash path stems, must not contain empty, . or .. segments, must not include a dotted final segment, and must not contain src or dist segments',
  }),
]);

// Individual entrypoint fields remain optional so one descriptor can target
// only the surfaces it needs, but at least one surface must be declared.
/** Zod schema for {@link ExtensionEntrypoints}. */
export const ExtensionEntrypointsSchema = z
  .object({
    server: EntrypointStemSchema.optional(),
    browser: EntrypointStemSchema.optional(),
    cli: EntrypointStemSchema.optional(),
  })
  .refine(
    (entrypoints) =>
      entrypoints.server !== undefined || entrypoints.browser !== undefined || entrypoints.cli !== undefined,
    {
      message: 'at least one entrypoint must be declared',
    },
  ) satisfies z.ZodType<ExtensionEntrypoints>;

/**
 * Shared base fields for all extension descriptors.
 *
 * Contains the fields common to both embedded and detached descriptors,
 * excluding `entrypoints` and `transport` which differ per execution mode.
 */
export interface ExtensionDescriptorBase extends ExtensionManifest {
  /** SemVer version of the extension package. */
  readonly version: string;
  /** Framework version range required (npm semver range, e.g. `">=1.0.0 <2.0.0"`). */
  readonly makaio: { readonly framework: VersionRange };
  /**
   * Default configuration values for this extension.
   *
   * Applied when no stored config exists. Keys should match the properties
   * in the extension's `configSchema` (declared on its {@link MakaioExtension}).
   * The Zod schema's own `.default()` values layer on top of these.
   */
  readonly config?: {
    readonly defaults?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Descriptor for extensions running in the host process (default mode).
 *
 * `entrypoints` is required; `execution` is `'embedded'` or omitted.
 * `transport` must be absent.
 */
export interface EmbeddedDescriptor extends ExtensionDescriptorBase {
  /**
   * Handler execution mode — `'embedded'` or omitted (defaults to embedded).
   * Code is `import()`'d directly into the host process.
   */
  readonly execution?: 'embedded';
  /**
   * Convention-based entrypoint stems and enabled-surface flags per runtime
   * surface. Required for embedded extensions.
   */
  readonly entrypoints: ExtensionEntrypoints;
  /** Must be absent for embedded extensions. */
  readonly transport?: undefined;
}

/**
 * Descriptor for extensions running as child processes.
 *
 * `transport` is required; `execution` must be `'detached'`.
 * `entrypoints` must be absent.
 */
export interface DetachedDescriptor extends ExtensionDescriptorBase {
  /**
   * Handler execution mode — must be `'detached'` for subprocess extensions.
   * The extension runs as a child process communicating via the chosen transport.
   */
  readonly execution: 'detached';
  /**
   * Transport configuration for detached extensions.
   *
   * Specifies the IPC mechanism and process lifecycle options for the child
   * process.
   */
  readonly transport: DetachedTransportConfig;
  /** Must be absent for detached extensions. */
  readonly entrypoints?: undefined;
}

/**
 * Discriminated union of extension descriptor shapes.
 *
 * Narrows automatically via `execution` check:
 * - `descriptor.execution === 'detached'` → `DetachedDescriptor`
 * - Otherwise (including `undefined`) → `EmbeddedDescriptor`
 *
 * Use {@link isDetachedDescriptor} for an explicit type guard.
 */
export type ExtensionDescriptor = EmbeddedDescriptor | DetachedDescriptor;

/**
 * Type guard for detached extension descriptors.
 *
 * After this guard returns `true`, TypeScript narrows the descriptor to
 * {@link DetachedDescriptor} where `transport` is required and `entrypoints`
 * is absent.
 * @param descriptor - The extension descriptor to check.
 * @returns Whether the descriptor is for a detached (subprocess) extension.
 */
export function isDetachedDescriptor(descriptor: ExtensionDescriptor): descriptor is DetachedDescriptor {
  return descriptor.execution === 'detached';
}

/**
 * Zod schema for {@link ExtensionDescriptor}.
 *
 * Enforces execution-mode invariants via `superRefine`:
 * - `execution === 'detached'` requires `transport`; `entrypoints` is optional.
 * - All other modes (including the default embedded mode) require `entrypoints`.
 *
 * Note: `satisfies z.ZodType<ExtensionDescriptor>` is intentionally omitted
 * because `superRefine` wraps the schema in `ZodEffects`, which is incompatible
 * with that constraint.
 */
export const ExtensionDescriptorSchema = ExtensionManifestSchema.extend({
  version: VersionLiteralSchema,
  makaio: z
    .object({
      framework: VersionRangeSchema,
    })
    .strict()
    .readonly(),
  entrypoints: ExtensionEntrypointsSchema.optional(),
  execution: z.enum(['embedded', 'detached']).optional(),
  transport: DetachedTransportSchema.optional(),
  config: z
    .object({
      defaults: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
}).superRefine((descriptor, ctx) => {
  if (descriptor.execution === 'detached') {
    if (descriptor.transport === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "detached extensions must declare a 'transport' config",
        path: ['transport'],
      });
    }
    if (descriptor.entrypoints !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'detached extensions must not declare entrypoints',
        path: ['entrypoints'],
      });
    }
  } else {
    if (descriptor.entrypoints === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'embedded extensions must declare at least one entrypoint',
        path: ['entrypoints'],
      });
    }
    if (descriptor.transport !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'embedded extensions must not declare a transport config',
        path: ['transport'],
      });
    }
  }
});

/**
 * Inferred flat output type from {@link ExtensionDescriptorSchema}.
 *
 * Zod's `superRefine` cannot narrow the output to a discriminated union, so
 * the raw inferred type has `entrypoints` and `transport` both optional. The
 * schema validates the execution-mode invariant at runtime, and callers should
 * use {@link parseExtensionDescriptor} or {@link safeParseExtensionDescriptor}
 * to obtain the properly typed {@link ExtensionDescriptor}.
 */
type RawDescriptorOutput = z.infer<typeof ExtensionDescriptorSchema>;

/**
 * Cast a validated raw descriptor output to the {@link ExtensionDescriptor}
 * discriminated union.
 *
 * This cast is safe because {@link ExtensionDescriptorSchema} enforces via
 * `superRefine` that embedded descriptors have `entrypoints` and detached
 * descriptors have `transport`, matching the union invariant exactly.
 * @param raw - The raw validated output from the schema.
 * @returns The descriptor cast to the discriminated union type.
 */
function castToDescriptor(raw: RawDescriptorOutput): ExtensionDescriptor {
  return raw as ExtensionDescriptor;
}

/**
 * Parse and validate an extension descriptor from raw JSON input.
 *
 * This is the typed wrapper around {@link ExtensionDescriptorSchema} that
 * returns the {@link ExtensionDescriptor} discriminated union. Throws a Zod
 * error on invalid input.
 * @param input - Raw JSON-like value to parse.
 * @returns Parsed and typed extension descriptor.
 */
export function parseExtensionDescriptor(input: unknown): ExtensionDescriptor {
  return castToDescriptor(ExtensionDescriptorSchema.parse(input));
}

/** Result shape returned by {@link safeParseExtensionDescriptor}. */
export type ExtensionDescriptorParseResult =
  | { readonly success: true; readonly data: ExtensionDescriptor }
  | { readonly success: false; readonly error: z.ZodError };

/**
 * Safely parse and validate an extension descriptor from raw JSON input.
 *
 * This is the typed wrapper around {@link ExtensionDescriptorSchema} that
 * returns a result with the {@link ExtensionDescriptor} discriminated union on
 * success.
 * @param input - Raw JSON-like value to parse.
 * @returns Parse result with `data` typed as {@link ExtensionDescriptor} on
 *   success, or a Zod error on failure.
 */
export function safeParseExtensionDescriptor(input: unknown): ExtensionDescriptorParseResult {
  const result = ExtensionDescriptorSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: castToDescriptor(result.data) };
  }
  return result;
}
