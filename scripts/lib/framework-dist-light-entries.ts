/**
 * Light dist entry invariant of the framework distribution: the import graph
 * reachable from a hook-loaded entry may only touch its allowlisted externals.
 *
 * Relative chunks are followed transitively. `@makaio/framework/*` self-imports
 * are treated as allowed leaves and not walked; their own weight (e.g. the bus
 * entry inlining contracts) is tracked in FACT-392, which will extend the walk
 * through the umbrella exports map.
 * @packageDocumentation
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { FrameworkDistIssue } from './framework-dist-verifier.js';

/**
 * Matches static and dynamic import specifiers in built ESM output, including
 * the minified forms `from"…"`, `import"…"`, and `` import(`…`) ``. The
 * negative lookbehind skips method calls such as `Buffer.from("…")` in
 * inlined library code.
 */
export const IMPORT_SPECIFIER_PATTERN = /(?<!\.)\b(?:from|import|require)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g;

/**
 * Reports every import specifier reachable from a light dist entry that its
 * allowlist does not name.
 *
 * Relative imports (`./x.mjs`, `../chunk-<hash>.mjs`) are followed recursively,
 * resolved against the importing file and cycle-safe. The non-relative
 * specifiers of the entry and of every reached chunk form the set checked
 * against the allowlist; a relative import that resolves to no file is reported.
 * @param root - Absolute framework package root.
 * @param lightEntries - Light entry paths mapped to their allowed specifiers.
 * @param issues - Issue sink to append findings to.
 */
export function checkLightEntries(
  root: string,
  lightEntries: Readonly<Record<string, readonly string[]>>,
  issues: FrameworkDistIssue[],
): void {
  for (const [entry, allowed] of Object.entries(lightEntries)) {
    const entryPath = resolve(root, entry);
    if (!existsSync(entryPath)) continue;

    const visited = new Set<string>([entryPath]);
    const queue: string[] = [entryPath];
    const reported = new Set<string>();
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const modulePath = relative(root, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      for (const specifier of new Set(Array.from(content.matchAll(IMPORT_SPECIFIER_PATTERN), (match) => match[1]))) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          const chunkPath = resolve(dirname(file), specifier);
          if (existsSync(chunkPath) && statSync(chunkPath).isFile()) {
            if (!visited.has(chunkPath)) {
              visited.add(chunkPath);
              queue.push(chunkPath);
            }
          } else {
            issues.push({
              exportKey: specifier,
              kind: 'light-entry-import',
              message: `Light entry "${entry}": module "${modulePath}" imports "${specifier}" which does not resolve to a file`,
              target: modulePath,
            });
          }
          continue;
        }
        if (allowed.includes(specifier) || reported.has(specifier)) continue;
        reported.add(specifier);
        issues.push({
          exportKey: specifier,
          kind: 'light-entry-import',
          message:
            `Light entry "${entry}" imports "${specifier}" (in "${modulePath}") — allowed imports: ` +
            `[${allowed.map((name) => `"${name}"`).join(', ')}], because CLI hook processes load it on every call`,
          target: modulePath,
        });
      }
    }
  }
}
