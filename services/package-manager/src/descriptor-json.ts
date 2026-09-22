/**
 * Shared `descriptor.json` JSON parsing for the offline listing producers.
 *
 * Both {@link YarnPackageManager.readInstalledExtensionDescriptor} (npm
 * installs) and `LocalPathInstaller.readLocalEntry` (local installs) read a
 * descriptor file, then hand it to `safeParseExtensionDescriptor` for schema
 * validation. `JSON.parse` failing (truncated write, corrupted file) is a
 * distinct failure from schema validation failing: both leave the extension
 * out of the listing, but only this one has no schema error to report, so it
 * needs its own warning to avoid vanishing from listings without a trace —
 * the same rationale the schema-invalid warning already documents at each
 * call site.
 * @packageDocumentation
 */

/**
 * Outcome of {@link parseDescriptorJson}.
 *
 * Discriminated on `ok` rather than collapsing to a bare `null` sentinel: a
 * descriptor file whose valid JSON content is the literal `null` would
 * otherwise be indistinguishable from a parse failure, causing both
 * producers to return before `safeParseExtensionDescriptor` ever runs — the
 * schema-invalid descriptor would then vanish from listings with no warning
 * at all, defeating the exact "don't vanish without a trace" rationale this
 * module documents.
 */
export type DescriptorJsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error };

/**
 * Parse a descriptor.json file's raw contents, warning distinctly from a
 * schema-invalid descriptor when the JSON itself cannot be parsed.
 * @param raw - Raw file contents already read from disk.
 * @param descriptorPath - Absolute path to the descriptor file, included in the warning.
 * @param label - Log prefix identifying the caller (e.g. `'[YarnPackageManager] @acme/weather-tools'`).
 * @returns `{ ok: true, value }` with the parsed JSON value — including a
 *   literal `null` — on success, or `{ ok: false, error }` when parsing
 *   failed (already logged via `console.warn`).
 */
export function parseDescriptorJson(raw: string, descriptorPath: string, label: string): DescriptorJsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    console.warn(`${label}: Skipping unparsable descriptor.json at ${descriptorPath}:`, normalizedError.message);
    return { ok: false, error: normalizedError };
  }
}
