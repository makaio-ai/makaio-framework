/**
 * Generalized import-rewriting map for `@makaio/framework` distribution.
 *
 * Provides utilities to detect and rewrite workspace package import specifiers
 * to their stable `@makaio/framework/<subpath>` counterparts in built output.
 *
 * This module is intentionally free of side effects so it can be imported in
 * both build plugins and declaration post-processors.
 * @packageDocumentation
 */

import {
  FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS,
  type FrameworkPublicPackageSubpath,
} from '@makaio/build-tooling/framework-public-surface';

/**
 * Describes a single workspace-package → umbrella-subpath rewrite rule.
 */
export interface FrameworkImportRewrite {
  /** The bare workspace package name (e.g. `@makaio/bus-core`). */
  readonly packageName: string;
  /** The framework umbrella subpath (e.g. `bus`). */
  readonly frameworkSubpath: string;
}

/**
 * The complete set of import-rewrite rules derived from
 * {@link FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS}.
 *
 * Each rule maps a workspace package name to its primary `@makaio/framework`
 * subpath. Packages with multiple dist entries (e.g. `tools/testing`) are
 * represented by their primary subpath only; subpath suffix passthrough is
 * handled at rewrite time.
 */
export const FRAMEWORK_IMPORT_REWRITES: readonly FrameworkImportRewrite[] = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.map(
  ({ packageName, frameworkSubpath }) => ({
    packageName,
    frameworkSubpath,
  }),
);

const REWRITES_BY_LENGTH = FRAMEWORK_IMPORT_REWRITES.slice().sort(
  (a, b) => b.packageName.length - a.packageName.length,
);

const PRECOMPILED_REWRITE_REGEXES = FRAMEWORK_IMPORT_REWRITES.map((rewrite) => ({
  regex: new RegExp(`(['"])${rewrite.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:/[^'"]*)?)\\1`, 'g'),
  replacement: `@makaio/framework/${rewrite.frameworkSubpath}`,
}));

/**
 * Rewrites a single import specifier if it refers to a framework-owned package.
 *
 * Handles both root imports (`@makaio/bus-core`) and subpath imports
 * (`@makaio/bus-core/types`) by appending the suffix to the rewritten base.
 * Uses longest-prefix-first matching so that more-specific package names
 * (e.g. `@makaio/ai-adapters-stream-session`) are always preferred over
 * shorter ones (e.g. `@makaio/ai-adapters-core`).
 * @param source - The raw import specifier as it appears in source code.
 * @returns The rewritten specifier, or `undefined` if no rule applies.
 */
export function rewriteFrameworkImportSpecifier(source: string): string | undefined {
  const rewrite = REWRITES_BY_LENGTH.find(
    (entry) => source === entry.packageName || source.startsWith(`${entry.packageName}/`),
  );

  if (!rewrite) return undefined;
  const suffix = source === rewrite.packageName ? '' : source.slice(rewrite.packageName.length);
  return `@makaio/framework/${rewrite.frameworkSubpath}${suffix}`;
}

/**
 * Returns `true` if the given import specifier refers to a framework-owned
 * workspace package that will be rewritten in built output.
 * @param source - The raw import specifier.
 * @returns `true` if the specifier maps to a framework umbrella subpath.
 */
export function isFrameworkOwnedImport(source: string): boolean {
  return rewriteFrameworkImportSpecifier(source) !== undefined;
}

/**
 * Rewrites all framework-owned import specifiers found in a block of source
 * or declaration text.
 *
 * Applies every rule from {@link FRAMEWORK_IMPORT_REWRITES} using a regex that
 * matches both `'@makaio/pkg'` and `'@makaio/pkg/subpath'` string literals
 * (single- or double-quoted). Safe to apply to `.d.mts` / `.d.ts` files that
 * rolldown-plugin-dts emits without `resolveId` interception.
 * @param sourceText - The full text content to transform.
 * @returns The transformed text (identical to input if no rewrites applied).
 */
export function rewriteFrameworkImportsInText(sourceText: string): string {
  return PRECOMPILED_REWRITE_REGEXES.reduce((text, { regex, replacement }) => {
    regex.lastIndex = 0;
    return text.replace(regex, (_match, quote: string, suffix: string) => `${quote}${replacement}${suffix}${quote}`);
  }, sourceText);
}

/**
 * Deduplicated list of workspace package names that belong to the framework
 * public surface. Used by host build scripts to populate `external` arrays.
 * @param mapping - The framework public package subpath mapping.
 * @returns Deduplicated array of workspace package names.
 */
export function frameworkExternalPackageNames(
  mapping: readonly FrameworkPublicPackageSubpath[] = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS,
): string[] {
  return [...new Set(mapping.map((entry) => entry.packageName))];
}
