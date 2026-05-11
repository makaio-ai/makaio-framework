/**
 * Shared helpers for package `exports` source-entry resolution.
 * @packageDocumentation
 */

const SOURCE_EXPORT_CONDITIONS = ['source', 'default', 'import', 'require', 'types'] as const;

/** Package export value shapes understood by build tooling. */
export type PackageExportValue = string | PackageExportConditions;

/** Package `exports` field shape understood by build tooling. */
export type PackageExportsField = string | Readonly<Record<string, unknown>>;

/** Conditional package export object from a `package.json` manifest. */
export interface PackageExportConditions {
  readonly source?: unknown;
  readonly default?: unknown;
  readonly import?: unknown;
  readonly require?: unknown;
  readonly types?: unknown;
  readonly [condition: string]: unknown;
}

/**
 * Returns whether an export target points at a buildable TypeScript source file.
 * @param target - Package export target path.
 * @returns Whether the target is a source file tsdown should build directly.
 */
export function isBuildableSourceTarget(target: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(target) && !/\.d\.(?:ts|mts|cts)$/.test(target);
}

/**
 * Returns whether a manifest value is a supported package export target.
 * @param value - Candidate export target.
 * @returns Whether the value can be resolved by build tooling.
 */
function isPackageExportValue(value: unknown): value is PackageExportValue {
  return typeof value === 'string' || (typeof value === 'object' && value !== null && !Array.isArray(value));
}

/**
 * Normalizes a conditional export object while rejecting unsupported leaves.
 * @param exportKey - Export key being normalized.
 * @param value - Conditional export object.
 * @returns Conditional export map with string targets.
 */
function toStringConditionMap(exportKey: string, value: Readonly<Record<string, unknown>>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [condition, target] of Object.entries(value)) {
    if (typeof target !== 'string') {
      throw new Error(`Unsupported package export value for "${exportKey}" condition "${condition}".`);
    }
    normalized[condition] = target;
  }
  return normalized;
}

/**
 * Normalizes a package `exports` field into an export map.
 *
 * Node permits root shorthand forms such as `"exports": "./src/index.ts"`
 * and conditional root forms such as `"exports": { "import": "./src/index.ts" }`.
 * Build tooling operates on subpath maps, so root shorthand is normalized to
 * `{ ".": value }`. Mixed condition/subpath objects are rejected because their
 * meaning is ambiguous for build entry generation.
 * @param exportsField - Raw `exports` field from a package manifest.
 * @returns Export map keyed by package subpath.
 */
export function normalizePackageExports(
  exportsField: PackageExportsField | undefined,
): Record<string, PackageExportValue> {
  if (exportsField === undefined) return {};
  if (typeof exportsField === 'string') return { '.': exportsField };

  const entries = Object.entries(exportsField);
  if (entries.length === 0) return {};

  const hasSubpathKeys = entries.some(([key]) => key.startsWith('.'));
  const hasConditionKeys = entries.some(([key]) => !key.startsWith('.'));

  if (hasSubpathKeys && hasConditionKeys) {
    throw new Error('Package exports cannot mix subpath keys with root condition keys.');
  }

  if (!hasSubpathKeys) {
    const rootConditions: Record<string, string> = {};
    for (const [condition, value] of entries) {
      if (typeof value !== 'string') {
        throw new Error(`Unsupported package export value for root condition "${condition}".`);
      }
      rootConditions[condition] = value;
    }
    return { '.': rootConditions };
  }

  const normalized: Record<string, PackageExportValue> = {};
  for (const [key, value] of entries) {
    if (!isPackageExportValue(value)) {
      throw new Error(`Unsupported package export value for "${key}".`);
    }
    normalized[key] = typeof value === 'string' ? value : toStringConditionMap(key, value);
  }
  return normalized;
}

/**
 * Resolve the source file target from a package export value.
 *
 * Conditional source exports may use `source`, `default`, `import`, `require`,
 * or `types` depending on whether the package is authored for repo-local source
 * imports or publish-time dist imports. Build tooling only returns entries that
 * point at TypeScript source files, so dist declarations and JavaScript targets
 * are not treated as build inputs.
 * @param value - Export value from a package manifest.
 * @returns Buildable source target, when one is declared.
 */
export function resolvePackageExportSourceTarget(value: PackageExportValue | undefined): string | undefined {
  if (typeof value === 'string') {
    return isBuildableSourceTarget(value) ? value : undefined;
  }

  if (!value) return undefined;

  for (const condition of SOURCE_EXPORT_CONDITIONS) {
    const target = value[condition];
    if (typeof target === 'string' && isBuildableSourceTarget(target)) {
      return target;
    }
  }

  return undefined;
}
