import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonValueSchema, rejectingLossyJsonValues } from '../shared/json-value.js';
import {
  CODE_EXECUTION_FAILED_OUTCOME_CODES,
  CODE_EXECUTION_FAILURE_CODES,
  CODE_EXECUTION_TRUST_LEVELS,
  type CodeExecutionFailure,
  type CodeExecutionFailureCode,
  type CodeExecutionOutcome,
  type CodeExecutionProgram,
  type CodeExecutionRequest,
  type CodeExecutionRequirements,
} from './types.js';

/**
 * Maximum length of a {@link CodeExecutionFailure} message.
 *
 * Failures travel over the bus and into logs, so their size is bounded at
 * the contract boundary rather than by convention. Producers holding larger
 * diagnostics must reduce them to a summary within this bound.
 */
export const CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH = 512;

/**
 * Maximum UTF-8 byte length of one segment in a
 * {@link CodeExecutionVirtualPathSchema | virtual path}.
 *
 * 255 bytes is the name-component limit on every filesystem the framework
 * targets (ext4, APFS, NTFS). The filesystem measures bytes, not characters:
 * a segment that is fewer than 255 characters but encodes to more than 255
 * UTF-8 bytes must also be rejected — otherwise the same program is valid on
 * the caller's host and unwritable on the runner's.
 */
export const VIRTUAL_PATH_SEGMENT_MAX_BYTES = 255;

/**
 * Maximum UTF-8 byte length of a complete
 * {@link CodeExecutionVirtualPathSchema | virtual path}.
 *
 * Measured in bytes for the same reason as
 * {@link VIRTUAL_PATH_SEGMENT_MAX_BYTES}: filesystems bound pathnames in bytes,
 * so a path of fewer than 1024 UTF-16 code units can still encode to more than
 * 1024 UTF-8 bytes and be unwritable on the host that runs it.
 *
 * This bounds the *portable relative* path, and nothing more. The length that
 * finally reaches the filesystem also carries the materialization root the
 * runner prepends, which is a property of that host and unknowable at the
 * contract boundary. So this ceiling does not stand in for the resolved length,
 * and does not promise it: a path near the ceiling still fails under a long
 * enough root, and one at the ceiling fails under every root, because no root is
 * empty. The provider that owns the root is what admits or refuses the resolved
 * pathname, and it reports that refusal as an invalid program rather than as a
 * filesystem error. What this figure is for is judging the program itself,
 * wherever it is submitted and whichever host would run it.
 */
export const VIRTUAL_PATH_MAX_BYTES = 1024;

/**
 * Maximum length of the identity strings a request carries, in UTF-16 code units.
 *
 * These are the free-text fields that name something rather than carry payload:
 * the invocation's correlation id, the invoked export, and each selection pin in
 * {@link CodeExecutionRequirementsSchema}. None of them is measured by any other
 * budget — a provider bounds the program's sources and the invocation's
 * arguments, and nothing bounds these — while every one of them is retained for
 * as long as the request is, and the export name is copied again into whatever a
 * provider hands its execution host. A schema-valid request carrying a
 * multi-megabyte export name would therefore cost a queued invocation that much
 * memory apiece, so the ceiling belongs at the contract boundary where the field
 * is defined rather than at each provider that happens to retain it.
 *
 * 256 is generous for every one of them: a named export is an ECMAScript
 * identifier, and the runtime, language, module-format, and provider pins are
 * short tags a host chose. The figure is a ceiling on abuse, not a style rule.
 */
export const CODE_EXECUTION_IDENTIFIER_MAX_LENGTH = 256;

/** Matches a leading Windows drive-letter prefix (e.g. `C:`). */
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

/**
 * Characters no supported host can carry inside a path component.
 *
 * The explicit set is what Windows refuses; `\p{Cc}` covers every control
 * character, which no filesystem represents usefully. Written as a Unicode
 * property escape rather than a literal code-point range so the class stays
 * readable in source.
 */
const REJECTED_SEGMENT_CHARACTERS = /[<>:"|?*]|\p{Cc}/u;

/** Segment Windows silently rewrites by trimming its trailing dots and spaces. */
const WINDOWS_TRIMMED_SEGMENT = /[. ]$/;

/**
 * Windows device names, reserved with or without an extension (e.g. `CON.ts`).
 *
 * The numbered devices take a superscript digit as readily as an ASCII one:
 * Windows resolves `COM¹` to the same device as `COM1`, and `LPT²` to the same
 * device as `LPT2`. `COM0` and `LPT0` are reserved as well. A class covering
 * only `1`-`9` therefore admits names the host still refuses at write time,
 * which is exactly the outcome these rules exist to prevent. The superscripts
 * are spelled as escapes rather than as literals so they cannot be read as
 * ordinary digits — or retyped as them.
 */
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[0-9\u00B9\u00B2\u00B3])(?:\.|$)/i;

/**
 * Reusable encoder for measuring UTF-8 byte length of paths and path segments.
 *
 * A single instance is allocated once rather than inside every refinement call.
 * `TextEncoder` is a standard Web API available in every supported runtime
 * without any Node.js import.
 */
const TEXT_ENCODER = new TextEncoder();

/**
 * Build a predicate that holds when every `/`-separated segment satisfies a rule.
 *
 * Every portability rule below is a property of one path component, so they all
 * split the path the same way rather than each spelling the traversal out.
 * @param isValid - Rule applied to one path segment.
 * @returns Predicate over a whole virtual path.
 */
const everySegment =
  (isValid: (segment: string) => boolean) =>
  (path: string): boolean =>
    path.split('/').every(isValid);

/**
 * Zod schema for a canonical virtual program path.
 *
 * Virtual paths are portable, host-independent input: the same program must be
 * valid or invalid everywhere, never valid on the host that submitted it and
 * unwritable on the host that runs it. So the rules are the intersection of what
 * every supported filesystem can represent, not what the current one accepts:
 *
 * - non-empty, and free of NUL bytes
 * - well-formed Unicode, so no unpaired surrogate code points
 * - POSIX separators only, so no backslashes
 * - relative, so no leading `/` and no drive-letter prefix
 * - normalized, so no empty, `.`, or `..` segments
 * - no segment containing `< > : " | ? *` or a control character
 * - no segment ending in a `.` or a space, which Windows trims away
 * - no segment naming a Windows device (`CON`, `PRN`, `AUX`, `NUL`,
 *   `COM0`-`COM9`, `LPT0`-`LPT9`, and the superscript spellings `COM¹`-`COM³`
 *   and `LPT¹`-`LPT³`, which name the same devices), with or without an
 *   extension
 * - no segment exceeding {@link VIRTUAL_PATH_SEGMENT_MAX_BYTES} UTF-8 bytes —
 *   the name-component limit on every supported filesystem
 * - total path at most {@link VIRTUAL_PATH_MAX_BYTES} UTF-8 bytes — a
 *   conservative ceiling on the *relative* path, which is the only part of the
 *   pathname a portable program can be judged on
 *
 * These rules exist because a host would otherwise reject or silently rewrite
 * the file: Windows refuses or trims certain names, and every filesystem
 * enforces per-component and total absolute-path length limits that vary by
 * platform. A contract-valid program must never degrade into a provider-side
 * write failure on one host while succeeding on another.
 *
 * The well-formedness rule guards the one shape that fails without a write
 * failure at all. An unpaired surrogate has no UTF-8 encoding, so every encoder
 * between a program and the disk substitutes U+FFFD for it: `"\uD800.ts"` and
 * `"\uD801.ts"` are two distinct strings that reach the filesystem as one and
 * the same name, on every platform. A module set carrying both would be accepted
 * as two files and materialize as one, with whichever write landed last silently
 * winning — so the paths are rejected here, where they are still distinguishable,
 * rather than downstream where they no longer are.
 *
 * The total-path rule is the one bound that cannot be completed here. The
 * pathname a host actually writes is its materialization root plus this
 * relative path, and the root belongs to the runner. So the contract bounds
 * what it owns, and the provider bounds the resolved pathname against its own
 * root before creating anything — the two together are what keep an accepted
 * program from degrading into a raw filesystem error.
 *
 * These rules keep module materialization well-defined; they do not create
 * runtime filesystem isolation.
 */
export const CodeExecutionVirtualPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.includes('\0'), { message: 'virtual path must not contain NUL bytes' })
  // `isWellFormed` is ES2024 and is the whole rule, so no scan is written out
  // here; it is available in every runtime these contracts target, the same way
  // `TextEncoder` is.
  .refine((path) => path.isWellFormed(), {
    message: 'virtual path must be well-formed Unicode (no unpaired surrogates)',
  })
  .refine((path) => !path.includes('\\'), { message: 'virtual path must use POSIX separators (no backslashes)' })
  .refine((path) => !path.startsWith('/') && !DRIVE_LETTER_PREFIX.test(path), {
    message: 'virtual path must be relative (no leading / or drive letter)',
  })
  .refine(
    everySegment((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    { message: 'virtual path must be normalized (no empty, ".", or ".." segments)' },
  )
  .refine(
    everySegment((segment) => !REJECTED_SEGMENT_CHARACTERS.test(segment)),
    {
      message: 'virtual path must not contain < > : " | ? * or control characters',
    },
  )
  .refine(
    everySegment((segment) => !WINDOWS_TRIMMED_SEGMENT.test(segment)),
    {
      message: 'virtual path segments must not end with "." or a space',
    },
  )
  .refine(
    everySegment((segment) => !WINDOWS_DEVICE_NAME.test(segment)),
    {
      message:
        'virtual path must not use a reserved device name (CON, PRN, AUX, NUL, COM0-COM9, LPT0-LPT9, COM¹-COM³, LPT¹-LPT³)',
    },
  )
  .refine(
    everySegment((segment) => TEXT_ENCODER.encode(segment).byteLength <= VIRTUAL_PATH_SEGMENT_MAX_BYTES),
    {
      message: `virtual path segments must not exceed ${VIRTUAL_PATH_SEGMENT_MAX_BYTES} UTF-8 bytes`,
    },
  )
  .refine((path) => TEXT_ENCODER.encode(path).byteLength <= VIRTUAL_PATH_MAX_BYTES, {
    message: `virtual path must not exceed ${VIRTUAL_PATH_MAX_BYTES} UTF-8 bytes`,
  });

// Every field this namespace validates carries data authored on the far side of
// a trust boundary — the caller's program and arguments on the way in, the
// provider's result on the way out — and each of them must reach the other side
// unaltered, so every field that admits objects goes through
// `rejectingLossyJsonValues`.
//
// Source file *extensions* are deliberately not among the rules here. A virtual
// path is judged on portability, which is a property of the path itself; which
// languages and module formats a set of sources can be executed as is a property
// of the provider that runs them, declared by its `language` and `moduleFormat`
// tags and enforced where that provider admits a program. A contract rule would
// have to name one provider's answer for every provider.

/**
 * Zod schema for the virtual module set, keyed by canonical virtual path.
 *
 * A `__proto__` own key would otherwise make that module silently disappear
 * between input and parsed output, and a non-plain object would be reduced to
 * its own enumerable fields; see {@link rejectingLossyJsonValues}.
 */
/** Source text that survives UTF-8 encoding without replacement characters. */
const CodeExecutionProgramSourceSchema = z.string().refine((source) => source.isWellFormed(), {
  message: 'program source must be well-formed Unicode (no unpaired surrogates)',
});

const CodeExecutionProgramFilesSchema = rejectingLossyJsonValues(
  z.record(CodeExecutionVirtualPathSchema, CodeExecutionProgramSourceSchema),
  {
    prototypeKey: '"__proto__" is not a valid virtual path',
    nonPlainObject: 'the module set must be a plain object mapping virtual paths to sources',
    symbolKey: 'the module set carries a symbol-keyed property, which cannot be transported as JSON',
    nonEnumerableKey: 'the module set carries a non-enumerable property, which the record parse would drop',
    extraArrayKey: 'the module set must be a plain object, not an array with extra own properties',
  },
);

/**
 * Zod schema for the prepared, JSON-safe TypeScript/ESM module set.
 *
 * Every `files` key and the `entryFile` are validated as canonical virtual
 * paths, and the cross-field check requires `entryFile` to name one of
 * `files` — a program whose entry module is absent is invalid at the
 * contract boundary, not at the provider.
 */
export const CodeExecutionProgramSchema = z
  .strictObject({
    /** Virtual module set, keyed by canonical relative POSIX path. */
    files: CodeExecutionProgramFilesSchema,
    /** Virtual path of the entry module. */
    entryFile: CodeExecutionVirtualPathSchema,
    /**
     * Name of the export invoked on the entry module.
     *
     * Bounded by {@link CODE_EXECUTION_IDENTIFIER_MAX_LENGTH}: it is the one
     * program field no provider budget measures, and the one that is copied
     * again per invocation into whatever the provider hands its execution host.
     */
    exportName: z.string().min(1).max(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH),
  })
  .refine((program) => Object.hasOwn(program.files, program.entryFile), {
    message: 'entryFile must name one of the program files',
    path: ['entryFile'],
  }) satisfies z.ZodType<CodeExecutionProgram>;

/**
 * Zod schema for optional exact-match provider selection constraints.
 *
 * Omitted fields impose no constraint. Requirements never grant trust and
 * never enable a provider the host did not compose.
 *
 * Every pin is a tag a host chose for itself, so each is bounded by
 * {@link CODE_EXECUTION_IDENTIFIER_MAX_LENGTH} — a pin longer than any value it
 * could ever match is not a narrower constraint, only a larger retained request.
 */
export const CodeExecutionRequirementsSchema = z.strictObject({
  /** Exact provider identifier to pin. */
  providerId: z.string().min(1).max(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH).optional(),
  /** Required exact runtime tag. */
  runtime: z.string().min(1).max(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH).optional(),
  /** Required exact language tag. */
  language: z.string().min(1).max(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH).optional(),
  /** Required exact module format. */
  moduleFormat: z.string().min(1).max(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH).optional(),
  /** Required exact trust level. */
  trust: z.enum(CODE_EXECUTION_TRUST_LEVELS).optional(),
}) satisfies z.ZodType<CodeExecutionRequirements>;

/**
 * Zod schema for one prepared, JSON-safe invocation.
 *
 * Like every schema that backs a bus subject payload, this one infers its own
 * type instead of being annotated `z.ZodType<CodeExecutionRequest>`: subject
 * payloads must be index-signature-compatible object types, which a named
 * interface is not. The `satisfies` clause keeps the published
 * {@link CodeExecutionRequest} interface authoritative over the schema output.
 *
 * The subject's caller-facing payload type is this schema's input. Fidelity
 * checks inspect the raw runtime value without widening JSON-bearing fields to
 * `unknown`.
 */
export const CodeExecutionRequestSchema = z.strictObject({
  /**
   * Caller-supplied correlation identifier for this invocation.
   *
   * Bounded by {@link CODE_EXECUTION_IDENTIFIER_MAX_LENGTH}: it is retained for
   * the whole life of the request and repeated into every log line about it, so
   * an unbounded one costs both without correlating anything a bounded one
   * would not.
   */
  invocationId: z.string().min(1).max(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH),
  /** Prepared virtual TypeScript/ESM module set to execute. */
  program: CodeExecutionProgramSchema,
  /**
   * JSON-safe value passed to the invoked export as its single argument.
   *
   * Guarded the same way `program.files` is: the handler is invoked with what
   * the caller submitted, so a nested key Zod would drop — or a `Date` it would
   * reduce to `{}` — is a rejection rather than a quiet rewrite of the caller's
   * argument. A request delivered over the bus is deserialized JSON and is
   * therefore always plain; the guard is what makes the same promise hold for a
   * caller that hands this subject a live object in-process.
   */
  arguments: rejectingLossyJsonValues(JsonValueSchema, {
    prototypeKey: '"__proto__" is not a valid argument key',
    nonPlainObject: 'the invocation arguments must be JSON data: only plain objects and arrays are transportable',
    symbolKey: 'the invocation arguments carry a symbol-keyed property, which cannot be transported as JSON',
    nonEnumerableKey: 'the invocation arguments carry a non-enumerable property, which the record parse would drop',
    extraArrayKey:
      'the invocation arguments carry an array with extra own properties, which the array rebuild would drop',
  }),
  /** Optional exact-match constraints on provider selection. */
  requirements: CodeExecutionRequirementsSchema.optional(),
  /** Wall-clock budget for the execution, in milliseconds. */
  timeoutMs: z.number().int().positive(),
}) satisfies z.ZodType<CodeExecutionRequest>;

/**
 * Zod schema for the stable failure classification codes.
 */
export const CodeExecutionFailureCodeSchema = z.enum(CODE_EXECUTION_FAILURE_CODES);

/**
 * Zod schema for the failure codes valid on a `failed` outcome.
 *
 * Excludes `execution_timeout` and `cancelled`, which are pinned to the
 * `timed_out` and `cancelled` outcome variants respectively.
 */
export const CodeExecutionFailedOutcomeCodeSchema = z.enum(CODE_EXECUTION_FAILED_OUTCOME_CODES);

/**
 * Create a bounded failure schema narrowed to the given failure codes.
 *
 * The strict shape rejects the payloads that make failures unsafe on the
 * bus: stack traces, absolute temporary paths, environment values, and
 * provider-internal error objects have no field to land in. The message is
 * free text bounded only in length — its content rules are behavioral; see
 * {@link CodeExecutionFailure.message}.
 * @param code - Schema for the failure codes the variant admits.
 * @returns Strict failure schema narrowed to the given codes.
 */
const createCodeExecutionFailureSchema = <TCode extends CodeExecutionFailureCode>(code: z.ZodType<TCode>) =>
  z.strictObject({
    /** Stable failure classification. */
    code,
    /** Short, human-readable, non-secret summary of what went wrong. */
    message: z.string().min(1).max(CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH),
  }) satisfies z.ZodType<CodeExecutionFailure<TCode>>;

/**
 * Zod schema for the discriminated, JSON-safe union of terminal outcomes.
 *
 * `completed` carries the JSON-safe value returned by the invoked export;
 * every other status carries a bounded failure instead of a thrown error.
 * Each variant constrains its failure code: `timed_out` is always
 * `execution_timeout`, `cancelled` is always `cancelled`, and `failed`
 * admits only the codes without a dedicated variant.
 *
 * Inferred rather than annotated, for the same reason as
 * {@link CodeExecutionRequestSchema}: this schema is the response half of a
 * bus subject payload.
 */
export const CodeExecutionOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    /** Discriminant for a completed execution. */
    status: z.literal('completed'),
    /**
     * JSON-safe value returned by the invoked export.
     *
     * Guarded exactly like the request's `arguments`: this schema is what the
     * router validates a provider's outcome against, so a value carrying a
     * nested `__proto__` own key — or a non-plain object such as a `Date` —
     * would otherwise be handed to the caller rewritten. Rejecting it here turns
     * a third-party provider's unrepresentable result into `invalid_provider`
     * instead.
     */
    value: rejectingLossyJsonValues(JsonValueSchema, {
      prototypeKey: '"__proto__" is not a valid result key',
      nonPlainObject: 'the result must be JSON data: only plain objects and arrays are transportable',
      symbolKey: 'the result carries a symbol-keyed property, which cannot be transported as JSON',
      nonEnumerableKey: 'the result carries a non-enumerable property, which the record parse would drop',
      extraArrayKey: 'the result carries an array with extra own properties, which the array rebuild would drop',
    }),
  }),
  z.strictObject({
    /** Discriminant for a failed execution. */
    status: z.literal('failed'),
    /** Bounded failure describing why the execution failed. */
    error: createCodeExecutionFailureSchema(CodeExecutionFailedOutcomeCodeSchema),
  }),
  z.strictObject({
    /** Discriminant for a timed-out execution. */
    status: z.literal('timed_out'),
    /** Bounded failure describing the exceeded budget. */
    error: createCodeExecutionFailureSchema(z.literal('execution_timeout')),
  }),
  z.strictObject({
    /** Discriminant for a cancelled execution. */
    status: z.literal('cancelled'),
    /** Bounded failure describing the cancellation. */
    error: createCodeExecutionFailureSchema(z.literal('cancelled')),
  }),
]) satisfies z.ZodType<CodeExecutionOutcome>;

/**
 * CodeExecution domain schemas.
 *
 * Each key becomes a subject identifier as: `code-execution.{key}`.
 */
export const CodeExecutionSchemas = {
  /**
   * Execute one prepared program invocation.
   *
   * Subject: `code-execution.execute`
   * Type: Request (RPC)
   * Purpose: Routes one prepared, JSON-safe invocation to one locally
   * registered provider and returns one normalized terminal outcome.
   *
   * Providers themselves are registered locally through the capability
   * registry (`CapabilitySubjects.register`) as live runtime objects; a
   * provider object is never part of this subject's payload.
   */
  execute: {
    request: CodeExecutionRequestSchema,
    response: CodeExecutionOutcomeSchema,
  },
} satisfies SchemaRecord;
