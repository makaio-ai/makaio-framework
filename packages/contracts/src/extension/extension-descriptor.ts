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

/**
 * Validate a plain SemVer version string without pulling server-only parsing
 * libraries into the shared contracts package.
 *
 * `descriptor.json` needs only a version literal here, not full range syntax.
 * The runtime keeps using `semver.satisfies()` for the actual compatibility
 * gate when loading extensions.
 * @param version - Raw `makaio.minVersion` value from descriptor.json.
 * @returns Whether the value is a valid SemVer version literal.
 */
function isValidSemverVersion(version: string): boolean {
  const semverVersionPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  return semverVersionPattern.test(version);
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
 * Descriptor for a Makaio extension.
 *
 * This is the JSON-serializable contract between extension authors and the
 * Makaio runtime. All fields from {@link ExtensionManifest} are valid, plus
 * distribution-specific fields for versioning, entry points, and execution.
 * Runtime contribution registration still comes from the imported
 * {@link MakaioExtension}; descriptor contributions are only metadata.
 */
export interface ExtensionDescriptor extends ExtensionManifest {
  /** SemVer version of the extension package. */
  readonly version: string;
  /** Minimum framework version required (plain SemVer version string). */
  readonly makaio: { readonly minVersion: string };
  /** Convention-based entrypoint stems and enabled-surface flags per runtime surface. */
  readonly entrypoints: ExtensionEntrypoints;
  /**
   * Handler execution mode.
   * - `'embedded'` (default) — code is `import()`'d into the host process.
   * - `'detached'` — reserved for future: isolated worker_thread.
   */
  readonly execution?: 'embedded' | 'detached';
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

/** Zod schema for {@link ExtensionDescriptor}. */
export const ExtensionDescriptorSchema = ExtensionManifestSchema.extend({
  version: z.string().min(1),
  makaio: z
    .object({
      minVersion: z.string().min(1).refine(isValidSemverVersion, {
        message: 'minVersion must be a valid semver version',
      }),
    })
    .readonly(),
  entrypoints: ExtensionEntrypointsSchema,
  execution: z.enum(['embedded', 'detached']).optional(),
  config: z
    .object({
      defaults: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
}) satisfies z.ZodType<ExtensionDescriptor>;
