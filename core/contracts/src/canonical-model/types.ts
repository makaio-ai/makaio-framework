import { z } from 'zod';

// ── Parse Error Types ───────────────────────────────────────────────────────

/** Exhaustive tuple of all {@link CanonicalModelParseErrorCode} values. */
export const CANONICAL_MODEL_PARSE_ERROR_CODES = [
  'empty',
  'empty-model',
  'empty-routing',
  'empty-segment',
  'too-many-segments',
  'invalid-segment',
  'invalid-virtual-name',
  'empty-virtual-name',
] as const;

/**
 * Error codes produced by the canonical model parser.
 *
 * Each code identifies a distinct malformed-input condition:
 * - `'empty'` - empty or whitespace-only input
 * - `'empty-model'` - `'::'` present with nothing after it
 * - `'empty-routing'` - `'::'` present with nothing before it
 * - `'empty-segment'` - consecutive slashes produce an empty routing segment
 * - `'too-many-segments'` - more than two routing segments before `'::'`
 * - `'invalid-segment'` - routing segment contains characters outside `[a-z0-9._-]`
 * - `'invalid-virtual-name'` - virtual model name contains characters outside `[a-z0-9_-]`
 * - `'empty-virtual-name'` - bare `'~'` sigil with no name following it
 */
export type CanonicalModelParseErrorCode = (typeof CANONICAL_MODEL_PARSE_ERROR_CODES)[number];

/** Zod schema for {@link CanonicalModelParseErrorCode}. */
export const CanonicalModelParseErrorCodeSchema = z.enum(CANONICAL_MODEL_PARSE_ERROR_CODES);

/**
 * Parse error returned by the canonical model parser.
 *
 * Discriminated by `kind: 'parse-error'` so it can be combined into
 * {@link CanonicalModelParseResult} and narrowed with a type guard.
 */
export interface CanonicalModelParseError {
  readonly kind: 'parse-error';
  /** Machine-readable error category. */
  readonly code: CanonicalModelParseErrorCode;
  /** Human-readable description of the problem. */
  readonly message: string;
  /** The verbatim input string that produced the error. */
  readonly input: string;
}

/** Zod schema for {@link CanonicalModelParseError}. */
export const CanonicalModelParseErrorSchema = z.object({
  kind: z.literal('parse-error'),
  code: CanonicalModelParseErrorCodeSchema,
  message: z.string(),
  input: z.string(),
});

// ── Parsed Model Types ──────────────────────────────────────────────────────

/**
 * Bare model reference - no routing qualifier.
 *
 * The entire input is treated as the verbatim model name and resolved
 * against the default adapter/provider at runtime.
 */
export interface BareModelRef {
  readonly kind: 'bare';
  /** Verbatim model name as provided by the caller (for example `'sonnet'`). */
  readonly model: string;
}

/** Zod schema for {@link BareModelRef}. */
export const BareModelRefSchema = z.object({
  kind: z.literal('bare'),
  model: z.string(),
});

/**
 * Qualified model reference - one or two routing segments followed by `'::'` and a model name.
 *
 * Routing segments are case-normalised to lowercase during parsing.
 * The model name is passed through verbatim.
 */
export interface QualifiedModelRef {
  readonly kind: 'qualified';
  /** First routing segment - adapter or provider slug, lowercased. */
  readonly segment1: string;
  /** Second routing segment - provider slug when `segment1` is an adapter, lowercased. */
  readonly segment2?: string;
  /** Verbatim model name appearing after `'::'`. */
  readonly model: string;
}

/** Zod schema for {@link QualifiedModelRef}. */
export const QualifiedModelRefSchema = z.object({
  kind: z.literal('qualified'),
  segment1: z.string(),
  segment2: z.string().optional(),
  model: z.string(),
});

/**
 * Virtual model reference - a logical alias introduced with the `'~'` sigil.
 *
 * Hosts may translate this higher-level reference through the existing
 * virtual-model resolution seam. The framework-owned canonical-model resolver
 * intentionally does not consume this parsed form.
 */
export interface VirtualModelRef {
  readonly kind: 'virtual';
  /** Virtual model name without the leading `'~'` sigil. */
  readonly name: string;
}

/** Zod schema for {@link VirtualModelRef}. */
export const VirtualModelRefSchema = z.object({
  kind: z.literal('virtual'),
  name: z.string(),
});

/**
 * Discriminated union of all successfully parsed canonical model forms.
 *
 * Narrow with `result.kind` or use the {@link isCanonicalModelParseError} type
 * guard to separate success from failure.
 */
export type ParsedCanonicalModel = BareModelRef | QualifiedModelRef | VirtualModelRef;

/** Zod schema for {@link ParsedCanonicalModel}. */
export const ParsedCanonicalModelSchema = z.discriminatedUnion('kind', [
  BareModelRefSchema,
  QualifiedModelRefSchema,
  VirtualModelRefSchema,
]);

/**
 * Framework-resolvable parsed canonical model forms.
 *
 * Host-only `kind: 'virtual'` expansion is intentionally excluded from the
 * framework resolver contract.
 */
export type ResolvableCanonicalModel = BareModelRef | QualifiedModelRef;

/** Zod schema for {@link ResolvableCanonicalModel}. */
export const ResolvableCanonicalModelSchema = z.discriminatedUnion('kind', [
  BareModelRefSchema,
  QualifiedModelRefSchema,
]);

/**
 * Result of parsing a canonical model string.
 *
 * Either a successfully parsed {@link ParsedCanonicalModel} or a
 * {@link CanonicalModelParseError} describing why parsing failed.
 */
export type CanonicalModelParseResult = ParsedCanonicalModel | CanonicalModelParseError;

/** Zod schema for {@link CanonicalModelParseResult}. */
export const CanonicalModelParseResultSchema = z.discriminatedUnion('kind', [
  BareModelRefSchema,
  QualifiedModelRefSchema,
  VirtualModelRefSchema,
  CanonicalModelParseErrorSchema,
]);
