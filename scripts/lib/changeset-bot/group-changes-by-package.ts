/**
 * Groups CodeRabbit change rows by publishable package.
 *
 * Takes the parsed per-row data from the Changes table and the
 * file-to-package mapping to produce per-package summaries suitable
 * for changelog entries.
 * @packageDocumentation
 */

import type { CodeRabbitChangeRow } from './parse-coderabbit-summary.js';
import { mapFilesToPackages } from './map-files-to-packages.js';

/** Aggregated change summary for one publishable package. */
export interface PackageChangeSummary {
  readonly packageName: string;
  readonly summaries: readonly string[];
}

/**
 * Groups CodeRabbit change rows by their publishable package.
 *
 * Each row's paths are mapped to packages. The row's summary is appended
 * to every package it touches. Summaries are deduplicated per package.
 * @param rows - Parsed change rows from CodeRabbit.
 * @param stripPrefix - Prefix to strip from paths before mapping (e.g. `'framework'`).
 * @returns Per-package summaries, sorted by package name.
 */
export function groupChangesByPackage(
  rows: readonly CodeRabbitChangeRow[],
  stripPrefix: string,
): PackageChangeSummary[] {
  const map = new Map<string, Set<string>>();

  for (const row of rows) {
    const stripped = row.paths
      .filter((p) => !stripPrefix || p.startsWith(stripPrefix + '/'))
      .map((p) => (stripPrefix ? p.slice(stripPrefix.length + 1) : p));
    if (stripped.length === 0) continue;
    const packages = mapFilesToPackages(stripped);

    for (const pkg of packages) {
      let summaries = map.get(pkg);
      if (!summaries) {
        summaries = new Set();
        map.set(pkg, summaries);
      }
      summaries.add(row.summary);
    }
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([packageName, summaries]) => ({
      packageName,
      summaries: [...summaries],
    }));
}
