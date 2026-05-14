/**
 * Maps changed file paths (relative to the framework repo root) to the
 * publishable npm package names they belong to.
 *
 * The mapping is purely convention-based — no filesystem reads are performed.
 * The `@makaio/*` names are the framework distribution's public npm artifact
 * names, not product descriptors. Keeping this mapper convention-based lets
 * trusted workflow code evaluate PR diffs without reading PR-modified package
 * metadata.
 *
 * Published package conventions:
 * - `packages/contracts/`                        → `@makaio/contracts`
 * - `adapters/implementations/<name>/`           → `@makaio/adapter-<name>`
 * - `clients/<name>/`                            → `@makaio/client-<name>`
 * - `providers/<name>/`                          → `@makaio/provider-<name>`
 * - `extensions/<name>/`                         → `@makaio/extension-<name>`
 * - `sdks/typescript/`                           → `@makaio/sdk`
 * - `.github/`, `docs/`                          → non-publishable (skipped)
 * - Everything else under the framework root     → `@makaio/framework`
 * @packageDocumentation
 */

/** Directory prefixes that are never part of a publishable package. */
const NON_PUBLISHABLE_PREFIXES = ['.github/', 'docs/'] as const;

/**
 * Attempts to derive a publishable package name from a single file path.
 * @param file - File path relative to the framework repository root.
 * @returns The package name, or `undefined` if the file is non-publishable.
 */
function resolvePackageName(file: string): string | undefined {
  // Non-publishable directories — skip entirely.
  for (const prefix of NON_PUBLISHABLE_PREFIXES) {
    if (file.startsWith(prefix)) {
      return undefined;
    }
  }

  // packages/contracts/ → @makaio/contracts
  if (file.startsWith('packages/contracts/')) {
    return '@makaio/contracts';
  }

  // adapters/implementations/<name>/ → @makaio/adapter-<name>
  const adapterMatch = /^adapters\/implementations\/([^/]+)\//.exec(file);
  if (adapterMatch) {
    return `@makaio/adapter-${adapterMatch[1]}`;
  }

  // clients/<name>/ → @makaio/client-<name>
  const clientMatch = /^clients\/([^/]+)\//.exec(file);
  if (clientMatch) {
    return `@makaio/client-${clientMatch[1]}`;
  }

  // providers/<name>/ → @makaio/provider-<name>
  const providerMatch = /^providers\/([^/]+)\//.exec(file);
  if (providerMatch) {
    return `@makaio/provider-${providerMatch[1]}`;
  }

  // extensions/<name>/ → @makaio/extension-<name>
  const extensionMatch = /^extensions\/([^/]+)\//.exec(file);
  if (extensionMatch) {
    return `@makaio/extension-${extensionMatch[1]}`;
  }

  // sdks/typescript/ → @makaio/sdk
  if (file.startsWith('sdks/typescript/')) {
    return '@makaio/sdk';
  }

  // Everything else under the framework root → @makaio/framework
  return '@makaio/framework';
}

/**
 * Maps changed file paths to the publishable npm packages they belong to.
 * @param files - File paths relative to the framework repository root.
 * @returns Deduplicated, sorted list of affected publishable package names.
 */
export function mapFilesToPackages(files: readonly string[]): string[] {
  const packages = new Set<string>();

  for (const file of files) {
    const name = resolvePackageName(file);
    if (name !== undefined) {
      packages.add(name);
    }
  }

  return [...packages].sort();
}
