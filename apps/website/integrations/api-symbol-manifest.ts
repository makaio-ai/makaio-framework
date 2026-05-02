import fs from 'node:fs';
import path from 'node:path';

import { toApiSlug } from './api-route-utils.js';

const LINKABLE_CATEGORIES = new Set(['classes', 'interfaces', 'type-aliases', 'functions']);

/** Options for loading or creating the API symbol manifest. */
export interface ApiSymbolManifestOptions {
  /** Root of the generated TypeDoc Markdown output. */
  outputDir: string;
  /** Destination JSON manifest path. */
  manifestPath: string;
}

/**
 * Reads an existing API symbol manifest, or recreates it from generated API
 * Markdown when the manifest file is absent.
 * @param options - Manifest and generated API output paths.
 * @returns Map of symbol names to their API reference route paths.
 */
export function loadOrCreateApiSymbolManifest(options: ApiSymbolManifestOptions): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(options.manifestPath, 'utf-8')) as Record<string, string>;
  } catch {
    // Manifest doesn't exist or is invalid — try to rebuild from generated output.
  }

  try {
    return writeApiSymbolManifest(options.outputDir, options.manifestPath);
  } catch {
    return {};
  }
}

/**
 * Scans the generated API reference output and writes a JSON manifest mapping
 * symbol names to their website route paths.
 * @param outputDir - Root of the generated TypeDoc Markdown output.
 * @param manifestPath - Destination path for the JSON manifest.
 * @returns Generated symbol manifest.
 */
export function writeApiSymbolManifest(outputDir: string, manifestPath: string): Record<string, string> {
  const manifest: Record<string, string> = {};

  for (const pkgEntry of sortedDirents(fs.readdirSync(outputDir, { withFileTypes: true }))) {
    if (!pkgEntry.isDirectory()) continue;
    const pkgDir = path.join(outputDir, pkgEntry.name);

    for (const catEntry of sortedDirents(fs.readdirSync(pkgDir, { withFileTypes: true }))) {
      if (!catEntry.isDirectory() || !LINKABLE_CATEGORIES.has(catEntry.name)) continue;
      const catDir = path.join(pkgDir, catEntry.name);

      for (const file of fs.readdirSync(catDir).sort((left, right) => left.localeCompare(right))) {
        if (!file.endsWith('.md')) continue;
        const symbolName = file.replace(/\.md$/, '');
        if (manifest[symbolName]) continue;
        const slug = toApiSlug(symbolName);
        manifest[symbolName] = `/reference/api/${pkgEntry.name}/${catEntry.name}/${slug}/`;
      }
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Sort directory entries by name for deterministic first-wins manifest output.
 * @param entries - Directory entries to sort.
 * @returns Sorted copy of the input entries.
 */
function sortedDirents(entries: fs.Dirent[]): fs.Dirent[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}
