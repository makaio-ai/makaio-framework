import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// One answer to "in how many ways can this path be written?", shared by
// everything in the CodeExecution provider that has to recognize a path it did
// not spell itself.
//
// Two callers depend on that answer and would be quietly wrong without it. A
// diagnostic redaction is substring replacement, so a path arriving in an
// unlisted spelling crosses the bus verbatim. The import allowlist matches the
// importing module against the program root, so a root in an unlisted spelling
// silently disables the guard.
//
// A path has more than one spelling for two independent reasons. It may be
// reached through a symlink — `/tmp` and `/var` are symlinks on macOS, so every
// temporary program root has two spellings, and a host may equally configure a
// symlinked package root — and the module loader resolves modules through the
// real path, so that is the spelling both the loader and the executing program
// see. And paths appear in module diagnostics as `file:` URLs rather than as
// filesystem paths.

/**
 * Collect the filesystem spellings of one absolute path.
 *
 * The given path and its real path, in that order, de-duplicated — so a path
 * reached without a symlink yields exactly one entry.
 *
 * A path that cannot be resolved contributes what is known rather than failing:
 * it may not exist yet, or have been removed again, and a caller is strictly
 * better off with the spellings that could be established than with an error.
 * A relative value has no real path worth establishing and is returned
 * unchanged, so callers do not have to pre-filter what they hand in.
 * @param value - Path to spell out.
 * @returns Distinct filesystem spellings of the path.
 */
export async function collectPathVariants(value: string): Promise<readonly string[]> {
  if (!isAbsolute(value)) return [value];
  const variants = new Set<string>([value]);
  try {
    variants.add(await realpath(value));
  } catch {
    // Absent or unreadable; the given spelling is all that can be established.
  }
  return [...variants];
}

/**
 * Write one filesystem path in both the forms a diagnostic can name it in.
 * @param path - Filesystem path, in one particular spelling.
 * @returns The path itself and its `file:` URL form.
 */
export function toPathSpellings(path: string): readonly string[] {
  return isAbsolute(path) ? [path, pathToFileURL(path).href] : [path];
}

/**
 * Collect every spelling of one path that could appear in a diagnostic.
 *
 * The composition of {@link collectPathVariants} and {@link toPathSpellings}:
 * every filesystem spelling, in both filesystem and `file:` URL form.
 * @param value - Path to spell out.
 * @returns Distinct spellings to strip from diagnostics.
 */
export async function collectPathSpellings(value: string): Promise<readonly string[]> {
  return (await collectPathVariants(value)).flatMap(toPathSpellings);
}
