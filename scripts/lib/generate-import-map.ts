/**
 * Build script that reads Vite's output manifest and generates an import map
 * for shared dependencies.
 *
 * Used in production only. In dev mode, Vite resolves all specifiers through
 * its transform pipeline and no import map is needed.
 *
 * Can be imported as a module or executed directly as a CLI tool:
 * ```
 * tsx scripts/lib/generate-import-map.ts <manifest-path> <output-path> [base-path]
 * ```
 * @packageDocumentation
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARED_BROWSER_EXTERNALS,
  toSharedBrowserExternalEntryName,
  type SharedBrowserExternal,
} from '../../build-tooling/browser-shared-externals.js';

/**
 * Framework-owned shared browser dependencies that extension ESM bundles
 * import as bare specifiers. The import map resolves these to the shell's
 * bundled chunks so that the browser does not download duplicate copies.
 */
// react-router, zod, etc. are internal to the framework bundle - extensions
// don't import them directly, so they do not need import map entries.

/**
 * A single entry in Vite's `.vite/manifest.json`.
 *
 * Only the fields relevant to import map generation are declared here.
 * Vite may include additional fields (imports, css, etc.) that are ignored.
 */
interface ManifestEntry {
  /** Output file path relative to the build output directory. */
  file: string;
  /** Original source file path, present for user-authored modules. */
  src?: string;
}

/**
 * The structure of Vite's `.vite/manifest.json`.
 * Keys are source file paths or virtual module IDs.
 */
type ViteManifest = Record<string, ManifestEntry>;

/**
 * The generated import map structure as specified by the
 * {@link https://html.spec.whatwg.org/multipage/webappapis.html#import-maps | Import Maps} spec.
 */
interface ImportMap {
  /** Maps bare module specifiers to their resolved URLs. */
  imports: Partial<Record<SharedBrowserExternal, string>>;
}

/**
 * Checks whether a manifest path matches a given dependency specifier.
 *
 * Uses boundary-aware matching to avoid false positives where a shorter
 * specifier is a substring of a longer one (e.g., `'react'` matching
 * `'react-dom'`). A match is only accepted when the character immediately
 * following the specifier is a recognised boundary character or the end of
 * the string. `/` is intentionally a valid right boundary so that scoped
 * packages like `@makaio/web-framework` are matched correctly when they
 * appear as path segments (e.g. `node_modules/@makaio/web-framework/index.js`).
 *
 * Note: because `/` is a valid right boundary, `'react'` technically matches
 * a path like `react/jsx-runtime`. Callers that need the closest match should
 * prefer the shortest matching key rather than the first one found.
 * @param path - Manifest key or src path to check.
 * @param dep - Dependency specifier to match.
 * @returns True if the path contains `dep` at a word boundary.
 */
function matchesDep(path: string, dep: string): boolean {
  // `.` is intentionally NOT a boundary character. Vite manifests use
  // directory-style keys (e.g. `node_modules/react/jsx-runtime/index.js`),
  // not bare `react/jsx-runtime.js`. Treating `.` as a boundary would
  // create false positives where `react.production.min.js` matches `react`.
  const isBoundary = (ch: string | undefined): boolean =>
    ch === undefined || ch === '/' || ch === '\\' || ch === ':' || ch === '@';
  for (let start = 0; start < path.length; ) {
    const idx = path.indexOf(dep, start);
    if (idx === -1) return false;
    // Check both sides to avoid 'preact' matching 'react', etc.
    if (isBoundary(idx === 0 ? undefined : path[idx - 1]) && isBoundary(path[idx + dep.length])) {
      return true;
    }
    start = idx + 1;
  }
  return false;
}

/**
 * Checks whether a generated chunk path belongs to the synthetic shared facade
 * for the given entry name.
 * @param path - Chunk file path or module identifier to check.
 * @param entryName - Stable shared facade entry name.
 * @returns True when the path contains the exact generated entry segment.
 */
function matchesSharedEntry(path: string, entryName: string): boolean {
  const idx = path.indexOf(entryName);
  if (idx === -1) return false;

  const before = idx === 0 ? undefined : path[idx - 1];
  const after = path[idx + entryName.length];
  const isLeftBoundary = before === undefined || before === '/' || before === '\\';
  const isRightBoundary = after === undefined || after === '-' || after === '.' || after === '/';
  return isLeftBoundary && isRightBoundary;
}

/**
 * Reads a Vite manifest and generates an import map for shared dependencies.
 *
 * Extension browser bundles use bare specifiers (e.g., `import React from 'react'`)
 * that browsers cannot resolve natively. This function generates an import map
 * mapping those specifiers to the shell's bundled output chunks so the browser
 * can resolve them without duplicate downloads.
 *
 * A dependency is matched when its specifier appears in either the manifest key
 * or the `src` field of a manifest entry. When multiple manifest entries match
 * the same dep (e.g. both `react` and `react/jsx-runtime` can match `react`),
 * the entry with the **shortest key** wins. Shortest key is the closest
 * approximation of an exact match and makes selection deterministic regardless
 * of the iteration order of `Object.entries`.
 * @param manifestPath - Absolute or CWD-relative path to Vite's `.vite/manifest.json`.
 * @param outputPath - Absolute or CWD-relative path to write the generated import map JSON.
 * @param basePath - Base URL path prepended to each asset file reference. Defaults to `'./'`.
 */
export function generateImportMap(manifestPath: string, outputPath: string, basePath = './'): void {
  const manifest: ViteManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ViteManifest;

  const imports: Partial<Record<SharedBrowserExternal, string>> = {};
  // Ensure exactly one slash between base and file path (computed once).
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;

  for (const dep of SHARED_BROWSER_EXTERNALS) {
    let bestKey: string | undefined;
    let bestFile: string | undefined;

    for (const [key, entry] of Object.entries(manifest)) {
      if (matchesDep(key, dep) || (entry.src !== undefined && matchesDep(entry.src, dep))) {
        // Prefer the shortest key - closest to an exact match for this dep.
        if (bestKey === undefined || key.length < bestKey.length) {
          bestKey = key;
          bestFile = entry.file;
        }
      }
    }

    if (bestFile !== undefined) {
      imports[dep] = base + bestFile;
    } else {
      // Warn-only, not a hard failure. The production build pipeline is not
      // yet integrated (see docs/seams.md "Import map externals derivation").
      // During early development, partial import maps are expected when
      // running against incomplete build output.
      console.warn(`[generate-import-map] Shared dependency "${dep}" not found in manifest`);
    }
  }

  const importMap: ImportMap = { imports };

  writeFileSync(outputPath, `${JSON.stringify(importMap, null, 2)}\n`);
}

/**
 * Minimal structural type for a compiled output chunk.
 *
 * Declared locally to avoid coupling to a specific bundler's type definitions
 * (rollup vs rolldown). Only the fields consumed by
 * {@link generateImportMapFromBundle} are declared.
 */
interface BundleChunk {
  /** Discriminant that identifies this entry as a chunk (not an asset). */
  type: 'chunk';
  /** Output file name relative to the build output directory. */
  fileName: string;
  /**
   * Absolute path to the source module, or `null` for synthetic chunks
   * (e.g. dynamic-import code splits that have no single source entry).
   */
  facadeModuleId: string | null;
  /**
   * Module IDs included in this chunk. Present in Rollup/rolldown bundle output
   * and used as a fallback when generated entry chunks have synthetic facades.
   */
  moduleIds?: readonly string[];
}

/**
 * Minimal structural type for an output asset (not a chunk).
 *
 * Only the discriminant is needed - asset entries are skipped entirely.
 */
interface BundleAsset {
  type: 'asset';
}

/**
 * Structural bundle type accepted by {@link generateImportMapFromBundle}.
 *
 * Intentionally narrow - only the fields used by the function are required.
 * This makes the function compatible with both rollup and rolldown output
 * bundles without importing either bundler's full type definitions.
 */
export type OutputBundleLike = Record<string, BundleChunk | BundleAsset>;

/**
 * Generate an ES import map from a Rollup/rolldown output bundle.
 *
 * In-memory variant of {@link generateImportMap} for use in Vite extensions
 * where the bundle is available as a parameter (no filesystem reads needed).
 *
 * Matches each entry in `SHARED_BROWSER_EXTERNALS` against chunk
 * `facadeModuleId` values
 * using the same boundary-aware {@link matchesDep} logic as the manifest
 * variant. When multiple chunks match the same dep, the chunk with the
 * **shortest matching candidate** wins - closest approximation of an exact match.
 *
 * Assets are skipped; only chunk entries are matched.
 * @param bundle - The output bundle from a Vite/Rollup `generateBundle` hook.
 * @param basePath - Base path prepended to resolved output file URLs. Defaults to `'/'`.
 * @returns Import map object `{ imports: { [specifier]: url } }`.
 */
export function generateImportMapFromBundle(
  bundle: OutputBundleLike,
  basePath = '/',
): { imports: Record<string, string> } {
  const imports: Partial<Record<SharedBrowserExternal, string>> = {};
  // Ensure exactly one slash between base and file path.
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;

  for (const dep of SHARED_BROWSER_EXTERNALS) {
    let bestMatch: string | undefined;
    let bestFileName: string | undefined;

    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      const candidates = [
        ...(chunk.facadeModuleId === null ? [] : [chunk.facadeModuleId]),
        chunk.fileName,
        ...(chunk.moduleIds ?? []),
      ];
      const sharedEntryName = toSharedBrowserExternalEntryName(dep);
      const match = candidates.reduce<string | undefined>((shortestMatch, candidate) => {
        if (!matchesDep(candidate, dep) && !matchesSharedEntry(candidate, sharedEntryName)) {
          return shortestMatch;
        }
        if (shortestMatch === undefined || candidate.length < shortestMatch.length) {
          return candidate;
        }
        return shortestMatch;
      }, undefined);

      if (match !== undefined) {
        // Prefer the shortest matched candidate - closest to an exact match.
        if (bestMatch === undefined || match.length < bestMatch.length) {
          bestMatch = match;
          bestFileName = chunk.fileName;
        }
      }
    }

    if (bestFileName !== undefined) {
      imports[dep] = base + bestFileName;
    } else {
      console.warn(
        `[import-map] shared dep "${dep}" not found in bundle - extension imports of this specifier will fail at runtime`,
      );
    }
  }

  return { imports: imports as Record<string, string> };
}

// CLI entry point - only runs when this file is executed directly via tsx/node.
// The renderer build uses generateImportMapFromBundle through
// viteImportMapPlugin; this manifest-file CLI remains available for standalone
// build tooling that only has Vite's manifest output.
// `fileURLToPath` converts the ESM URL to an OS path so it can be compared
// against `process.argv[1]` reliably across platforms (including Windows, where
// URL encoding and drive-letter casing differ from `endsWith` comparisons).
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: generate-import-map <manifest-path> <output-path> [base-path]');
    process.exit(1);
  }
  generateImportMap(args[0], args[1], args[2]);
}
