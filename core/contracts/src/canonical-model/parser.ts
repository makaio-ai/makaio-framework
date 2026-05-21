import type { CanonicalModelParseError, CanonicalModelParseErrorCode, CanonicalModelParseResult } from './types.js';

/**
 * Matches a valid routing segment: starts with `[a-z0-9]`, followed by
 * `[a-z0-9._-]*`.
 *
 * Exported so other schema layers can share the same routing constraint.
 */
export const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Matches a valid virtual model name: starts with `[a-z0-9]`, followed by
 * `[a-z0-9_-]*`.
 *
 * Exported so host-owned virtual-model schemas can enforce the same naming
 * rule at write time.
 */
export const VIRTUAL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Build a {@link CanonicalModelParseError} value.
 * @param code - Machine-readable error category
 * @param message - Human-readable description of the problem
 * @param input - The verbatim input string that triggered the error
 * @returns A well-typed parse error object
 */
function parseError(code: CanonicalModelParseErrorCode, message: string, input: string): CanonicalModelParseError {
  return { kind: 'parse-error', code, message, input };
}

/**
 * Parse a canonical model string into a structured reference.
 *
 * The grammar is:
 * ```
 * canonical          := "~" virtual_model_name
 *                     | routing "::" model_name
 *                     | model_name
 *
 * routing            := segment
 *                     | segment "/" segment
 *
 * segment            := [a-z0-9][a-z0-9._-]*
 * model_name         := <any non-empty string>
 * virtual_model_name := [a-z0-9][a-z0-9_-]*
 * ```
 *
 * Routing segments are lowercased during parsing because they are
 * case-insensitive for matching purposes. Model names are passed through
 * verbatim as they are provider-defined and case-sensitive.
 * @param input - The canonical model string to parse
 * @returns A parsed reference or a parse error
 */
export function parseCanonicalModel(input: string): CanonicalModelParseResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return parseError('empty', 'Canonical model string must not be empty.', input);
  }

  if (trimmed.startsWith('~')) {
    const name = trimmed.slice(1);

    if (name.length === 0) {
      return parseError('empty-virtual-name', "Virtual model reference '~' must be followed by a name.", input);
    }

    if (!VIRTUAL_NAME_RE.test(name)) {
      return parseError(
        'invalid-virtual-name',
        `Invalid virtual model name '${name}': must match [a-z0-9][a-z0-9_-]*.`,
        input,
      );
    }

    return { kind: 'virtual', name };
  }

  const separatorIndex = trimmed.indexOf('::');

  if (separatorIndex === -1) {
    return { kind: 'bare', model: trimmed };
  }

  const routingPart = trimmed.slice(0, separatorIndex);
  const modelPart = trimmed.slice(separatorIndex + 2);

  if (routingPart.length === 0) {
    return parseError('empty-routing', "Canonical model string must have a routing segment before '::'.", input);
  }

  if (modelPart.length === 0) {
    return parseError('empty-model', "Canonical model string must have a model name after '::'.", input);
  }

  const segments = routingPart.toLowerCase().split('/');

  for (const segment of segments) {
    if (segment.length === 0) {
      return parseError(
        'empty-segment',
        "Routing segment must not be empty - check for consecutive '/' characters.",
        input,
      );
    }
  }

  if (segments.length > 2) {
    return parseError(
      'too-many-segments',
      `Routing part '${routingPart}' has ${segments.length} segments; at most 2 are allowed.`,
      input,
    );
  }

  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      return parseError(
        'invalid-segment',
        `Routing segment '${segment}' is invalid: must match [a-z0-9][a-z0-9._-]*.`,
        input,
      );
    }
  }

  return {
    kind: 'qualified',
    segment1: segments[0],
    segment2: segments.length > 1 ? segments[1] : undefined,
    model: modelPart,
  };
}

/**
 * Type guard for distinguishing parse errors from successful parse results.
 * @param result - The parse result to check
 * @returns `true` when the result is a parse error
 */
export function isCanonicalModelParseError(result: CanonicalModelParseResult): result is CanonicalModelParseError {
  return result.kind === 'parse-error';
}
