import type {
  ExtensionOperatorConfigEntry,
  ExtensionOperatorConfigFailure,
  ExtensionOperatorConfigFailureReason,
  ExtensionOperatorConfigValue,
} from '@makaio/contracts';
import { MakaioError } from '@makaio/core';
import { getErrorString, summarizeDiagnosticText } from '@makaio/utils';
import type { z } from 'zod';

/** Constructor fields for an {@link ExtensionOperatorConfigError}. */
export interface ExtensionOperatorConfigErrorInput {
  /** Extension whose configuration could not be resolved. */
  readonly extensionName: string;
  /** Opaque origin label copied from the operator entry. */
  readonly source: string;
  /**
   * Human-readable description of what is wrong, already bounded and flattened,
   * phrased to follow the extension and source prefix.
   */
  readonly summary: string;
  /**
   * Underlying error, preserved unbounded for callers that inspect it rather
   * than print it.
   */
  readonly cause?: unknown;
}

/**
 * Raised when an extension's operator-supplied configuration cannot be
 * honoured, either because the operator entry itself is unusable or because the
 * configuration it takes part in is rejected by the extension's config schema.
 *
 * Carries the extension name and the entry's `source` label so the operator
 * can find the offending input. In `'activate'` mode it is thrown, and the
 * coordinator routes it through the same criticality rules as any other
 * activation failure: a non-critical extension fails alone, a `critical: true`
 * extension aborts startup. In `'observe'` mode it is constructed but never
 * thrown — only its message is used, as the text of a warning — because a
 * caller that is not driving the lifecycle has no criticality rule to apply.
 */
export class ExtensionOperatorConfigError extends MakaioError {
  /** Name of the extension whose configuration could not be resolved. */
  public readonly extensionName: string;
  /** Opaque origin label copied from the operator entry. */
  public readonly source: string;

  /**
   * @param input - Extension identity, origin label, summary, and optional cause.
   */
  public constructor(input: ExtensionOperatorConfigErrorInput) {
    super(`Operator config for extension "${input.extensionName}" (source: ${input.source}) ${input.summary}`);
    this.extensionName = input.extensionName;
    this.source = input.source;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

/** Human-readable phrase for each operator entry failure reason. */
const FAILURE_PHRASES: Readonly<Record<ExtensionOperatorConfigFailureReason, string>> = {
  unreadable: 'could not be read',
  'invalid-json': 'is not valid JSON',
  'not-an-object': 'is not a JSON object',
};

/**
 * What the caller intends to do with the resolved configuration.
 *
 * The distinction exists because an operator-attributed failure is only
 * actionable where the runtime can act on it — by refusing to run the
 * extension. A caller that is merely reading an extension that is already
 * running has no such lever, and must not be handed an exception it can only
 * swallow.
 */
export type ExtensionConfigResolutionMode =
  /**
   * The caller is about to start, restart, or activate contributions for the
   * extension. An operator-attributed failure is thrown so the lifecycle can
   * fail the extension under its declared criticality.
   */
  | 'activate'
  /**
   * The caller is reading the configuration of an extension whose lifecycle it
   * is not driving. Resolution never throws: an operator-attributed failure
   * degrades to the same warn-and-default path as any other rejection.
   */
  | 'observe';

/** Inputs to {@link resolveConfig}, one per configuration layer plus identity. */
export interface ResolveConfigInput {
  /** Extension name used in diagnostics. */
  readonly name: string;
  /**
   * Zod schema declared on the extension's manifest, or `undefined` when the
   * extension has no config schema and therefore no configuration surface.
   */
  readonly configSchema: z.ZodType | undefined;
  /**
   * Lowest layer: the extension's own defaults combined with any host-supplied
   * defaults, pre-merged by the composition root.
   */
  readonly configDefaults: Readonly<Record<string, unknown>> | undefined;
  /** Middle layer: persisted configuration records. Overrides `configDefaults`. */
  readonly storedConfig: Record<string, unknown> | undefined;
  /**
   * Highest layer: the operator's entry for this extension, or `undefined`
   * when the operator supplied nothing.
   */
  readonly operatorEntry: ExtensionOperatorConfigEntry | undefined;
  /** Whether the caller can act on an operator-attributed failure. */
  readonly mode: ExtensionConfigResolutionMode;
}

/**
 * Resolve an extension's configuration by composing every configuration layer
 * and parsing the result through the extension's config schema.
 *
 * Layers are merged lowest to highest — `configDefaults`, then `storedConfig`,
 * then the operator entry — as a **shallow, one-level** spread. A higher layer
 * that declares a key replaces that key's value wholesale, including nested
 * objects.
 *
 * In `'activate'` mode, failure is loud wherever the operator's input is involved:
 *
 * - **Unusable operator entry.** Throws {@link ExtensionOperatorConfigError}.
 *   Operator input is an explicit, hand-authored decision, so discarding it and
 *   starting on schema defaults would silently drop stated intent. This is
 *   reported even when the extension declares no config schema, because the
 *   entry is broken regardless of who would have consumed it. A *usable* entry
 *   for such an extension has no effect, exactly like the other layers.
 * - **Schema rejection with an operator layer in play.** Throws the same error,
 *   naming the operator's source. Blame is not narrowed any further, because
 *   neither direction of that test is sound: lower layers that parse on their
 *   own do not prove the operator's values are at fault, and lower layers that
 *   do not parse do not clear them — an operator file is routinely the only
 *   place a required value is supplied, so the layers beneath it are expected
 *   to be incomplete. What is certain is that explicit, hand-authored input is
 *   part of a configuration the extension cannot accept, which is the
 *   operator's to see and correct. The schema's own rejection is reported in
 *   the message, so the failing field is visible next to the source.
 * - **Every other schema rejection.** With no operator layer, the failure is
 *   logged and the extension starts on the schema's own `.default()` values, so
 *   a stale stored record cannot brick an extension nobody touched.
 *
 * In `'observe'` mode nothing throws — every one of those conditions takes the
 * warn-and-default path instead. Whether a merged configuration parses depends
 * on `storedConfig`, which the storage tier may change at any time, so whether
 * a given resolution fails is not a stable property of the extension. Only a
 * caller that can fail the extension may act on it.
 * @param input - The extension identity, resolution mode, and one value per
 *   configuration layer.
 * @returns Parsed config object, `undefined` when the extension declares no
 *   config schema, and `undefined` when a parse failure has no usable
 *   schema-default fallback.
 * @throws ExtensionOperatorConfigError In `'activate'` mode, when the operator
 *   entry is unusable, or when an operator layer is present and the merged
 *   configuration fails the schema.
 */
export function resolveConfig(input: ResolveConfigInput): unknown {
  const { name, configSchema, configDefaults, storedConfig, operatorEntry, mode } = input;

  const operatorLayer = resolveOperatorLayer(name, operatorEntry, mode);
  if (!configSchema) return undefined;

  const merged = { ...(configDefaults ?? {}), ...(storedConfig ?? {}), ...(operatorLayer?.config ?? {}) };

  try {
    return configSchema.parse(merged);
  } catch (err) {
    const detail = summarizeDiagnosticText(getErrorString(err));
    if (mode === 'activate' && operatorLayer !== undefined) {
      throw new ExtensionOperatorConfigError({
        extensionName: name,
        source: operatorLayer.source,
        summary: `is part of a configuration rejected by the extension's config schema: ${detail}`,
        cause: err,
      });
    }
    console.warn(`[ExtensionCoordinator] Config parse failed for "${name}", starting with schema defaults:`, detail);
    try {
      return configSchema.parse({});
    } catch {
      console.warn(`[ExtensionCoordinator] Fallback config parse also failed for "${name}" — config will be absent`);
      return undefined;
    }
  }
}

/**
 * Reduce an operator entry to the layer it contributes.
 *
 * An unusable entry contributes nothing and is a failure in its own right,
 * independent of any schema: it is raised in `'activate'` mode and reported as
 * a warning in `'observe'` mode, where the remaining layers are resolved as if
 * the operator had supplied nothing.
 * @param name - Extension name used in diagnostics.
 * @param entry - The operator's entry for this extension, if any.
 * @param mode - Whether the caller can act on an operator-attributed failure.
 * @returns The operator's usable entry, or `undefined` when there is no layer
 *   to apply.
 * @throws ExtensionOperatorConfigError In `'activate'` mode, when the entry is unusable.
 */
function resolveOperatorLayer(
  name: string,
  entry: ExtensionOperatorConfigEntry | undefined,
  mode: ExtensionConfigResolutionMode,
): ExtensionOperatorConfigValue | undefined {
  if (entry === undefined) return undefined;
  if (entry.kind === 'config') return entry;

  const error = new ExtensionOperatorConfigError({
    extensionName: name,
    source: entry.source,
    summary: describeFailure(entry),
  });
  if (mode === 'activate') throw error;
  console.warn(`[ExtensionCoordinator] ${error.message} — resolving without the operator layer`);
  return undefined;
}

/**
 * Phrase an unusable operator entry for the error message.
 * @param failure - The operator entry that could not be used.
 * @returns Summary text describing the failure, with any underlying detail appended.
 */
function describeFailure(failure: ExtensionOperatorConfigFailure): string {
  const phrase = FAILURE_PHRASES[failure.reason];
  if (failure.detail === undefined) return phrase;
  const detail = summarizeDiagnosticText(failure.detail);
  return detail.length === 0 ? phrase : `${phrase}: ${detail}`;
}
