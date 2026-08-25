import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CodeExecutionVirtualPathSchema,
  type CodeExecutionFailedOutcomeCode,
  type CodeExecutionProgram,
} from '@makaio/contracts';
import { isNpmPackageName, NPM_PACKAGE_NAME_MAX_LENGTH } from '@makaio/utils';
import { collectPathVariants, toPathSpellings } from './path-spellings.js';
import { CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT } from './types.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Materializes a prepared virtual TypeScript/ESM module set into a private
// temporary directory so the worker thread can import it as an ordinary ESM
// program. The materialized root owns three names: the generated `package.json`
// that marks the root as ESM, the `node_modules` tree that carries the
// host-configured package links, and the generated entry-namespace module the
// worker imports instead of the program's own entry.
//
// Every virtual path is validated through the contract's own virtual-path
// schema before anything else reasons about it, and containment is re-checked
// against the resolved root immediately before every directory creation, file
// write, and package link. Neither step assumes the caller already parsed the
// request: this module is safe to call directly, not only safe when reached
// through the contract. This keeps materialization well-defined; it is not
// runtime filesystem isolation, and executed code retains full access to the
// host filesystem.
//
// Resolved pathname length is this module's half of a two-layer bound. The
// contract bounds the relative virtual path, because that is all a portable
// program owns; only this module knows the root it prepends, so it bounds the
// resolved pathname — for every path it creates, once the root exists and
// before anything is written below it.
//
// No failure leaves this module carrying the temporary root. Filesystem errors
// name the absolute path they operated on, and the caller has no redactions for
// a root whose handle it never received, so a raw error is reduced to a
// path-free domain failure and the detail is kept in local diagnostics.

/**
 * Prefix of every per-invocation temporary program root.
 *
 * Exported because identifying a leftover root means matching the literal the
 * materializer created it with; a second copy of this string would let the two
 * drift apart and quietly turn "no root was left behind" into a claim about a
 * prefix nothing uses.
 */
export const TEMP_DIRECTORY_PREFIX = 'makaio-code-execution-';

/** Generated manifest that marks the materialized program root as ESM. */
const PROGRAM_MANIFEST = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;

/** File name of the generated manifest the materializer owns. */
const MANIFEST_FILE = 'package.json';

/** Directory name reserved for host-configured package links. */
const MODULES_DIRECTORY = 'node_modules';

/**
 * File name of the generated module that re-exports the program's entry namespace.
 *
 * Deliberately spelled so no ordinary source file collides with it by accident,
 * because the name is reserved: a program declaring it at the root is rejected.
 */
const ENTRY_NAMESPACE_FILE = '__makaio-entry-namespace.mjs';

/**
 * Root segments the materializer owns, keyed by their {@link foldPathCase} spelling.
 *
 * Lookups are case-insensitive on purpose. Virtual paths may contain uppercase
 * letters, and `Package.JSON` or `Node_Modules/…` are too close to names this
 * module generates to be portable. Comparing through one conservative fold
 * makes rejection a property of the program rather than of the host filesystem.
 *
 * The keys are already in folded spelling, which is what the lookup compares.
 */
const RESERVED_ROOT_SEGMENTS: ReadonlyMap<string, string> = new Map([
  [foldPathCase(MANIFEST_FILE), 'the generated program manifest'],
  [foldPathCase(MODULES_DIRECTORY), 'provider-configured package links'],
  [foldPathCase(ENTRY_NAMESPACE_FILE), 'the generated entry namespace module'],
]);

/**
 * Source file extensions this provider executes.
 *
 * The materialized root is ESM, and its sources are transpiled by a TypeScript
 * loader on import, so these four are exactly the shapes that composition
 * describes: `.ts` and `.mts` for TypeScript, `.js` and `.mjs` for JavaScript.
 * The provider advertises `moduleFormat: 'esm'`, and `.cts` / `.cjs` would
 * execute as CommonJS while `.tsx` would pull in a JSX dialect the provider
 * never claimed — each of them a program running under semantics no requirement
 * pinned. Everything else simply has no loader behind it and would fail later as
 * a transpilation error naming nothing an author can act on.
 *
 * This is the provider's rule rather than the contract's, and the split is
 * deliberate: which languages a set of sources can be executed as is a property
 * of whoever runs them, declared by the provider's `language` and `moduleFormat`
 * tags. The contract bounds path *portability*, which is a property of the path.
 */
const SUPPORTED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.mts', '.js', '.mjs']);

/** The supported extensions as the rejection message lists them. */
const SUPPORTED_SOURCE_EXTENSION_SUMMARY = [...SUPPORTED_SOURCE_EXTENSIONS].join(', ');

/**
 * Maximum UTF-8 byte length of a pathname this module creates below a program root.
 *
 * macOS declares `PATH_MAX` as 1024 bytes in `<sys/syslimits.h>`; Linux allows
 * 4096. The smaller figure is the budget applied on every platform, so that a
 * program's fate stays a property of the program rather than of whichever host
 * happened to run it.
 *
 * `PATH_MAX` counts the terminating NUL, so this is the first length the kernel
 * refuses rather than the last one it accepts: a pathname of exactly this many
 * bytes is already one too long, and the check below rejects at the figure
 * rather than above it.
 *
 * The contract bounds the relative virtual path at the same figure, which is
 * all a portable program can be judged on: only this module knows the temporary
 * root it prepends. Bounding the resolved pathname here is what turns "accepted
 * by the contract, unwritable under this root" into a coded rejection instead
 * of a raw filesystem error.
 *
 * The two bounds being equal means a relative path at the contract's own maximum
 * can never materialize, under any non-empty root. That is deliberate, and
 * neither bound is lowered to close it. No relative bound could: the root is a
 * host property, so any figure chosen here would still be unmaterializable under
 * some longer root and needlessly restrictive under a shorter one. The bounds
 * answer different questions — the contract's is a portability ceiling on the
 * program itself, judged where no root is known, and this one is a host
 * admission check that classifies the shortfall as `invalid_program` against the
 * root actually in hand.
 *
 * It stays a conservative bound rather than a guarantee. A kernel measures the
 * root's real spelling — a temporary base reached through a symlinked prefix
 * resolves longer than the path `mkdtemp` handed back — and bounds name
 * components separately, so filesystem errors are still reduced to path-free
 * failures rather than assumed away.
 *
 * Exported because the tests size a program against this budget; a second copy
 * of the figure would let the two drift and quietly stop testing the bound.
 */
export const RESOLVED_PATH_MAX_BYTES = 1024;

/** Number of retries made by Node's recursive-removal implementation. */
const ROOT_REMOVAL_MAX_RETRIES = 2;

/** Pause between program-root removal attempts, in milliseconds. */
const ROOT_REMOVAL_RETRY_DELAY_MS = 25;

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

/**
 * Failure raised while validating or materializing a virtual program.
 *
 * Carries the contract failure code the provider should report, so
 * classification is decided where the invariant is known rather than
 * re-derived from message text.
 */
export class VirtualProgramError extends Error {
  /**
   * @param code - Contract failure code the provider reports for this failure.
   * @param message - Short, path-free description of the violated invariant.
   */
  public constructor(
    public readonly code: CodeExecutionFailedOutcomeCode,
    message: string,
  ) {
    super(message);
    this.name = 'VirtualProgramError';
  }
}

/**
 * Failure whose partially materialized root still needs an owner.
 *
 * The materializer normally removes a root before it throws. If that bounded
 * removal fails, the provider must retain the cleanup work through its normal
 * lifecycle instead of the materializer merely logging and forgetting it.
 * The lease is internal runtime state: its path never contributes to this
 * error's message and therefore never reaches a bus outcome.
 */
export class UnreleasedProgramRootError extends VirtualProgramError {
  /**
   * @param failure - Path-free failure that the invocation reports.
   * @param rootLease - Cleanup work transferred to the caller that owns the invocation lifecycle.
   */
  public constructor(
    failure: VirtualProgramError,
    public readonly rootLease: ProgramRootLease,
  ) {
    super(failure.code, failure.message);
    this.name = 'UnreleasedProgramRootError';
  }
}

/**
 * Reduce a failure raised while building a program root to a path-free domain error.
 *
 * Every filesystem error Node raises names the absolute path it was operating
 * on, and inside this module that path is the temporary program root — exactly
 * what a bus-bound failure must never carry. The provider cannot redact it
 * either: a failure raised before {@link materializeVirtualProgram} returns
 * leaves it without the handle carrying that root's redactions, so it would
 * sanitize against an empty per-invocation set. The root therefore never leaves
 * this module at all — the detailed cause stays in local diagnostics, and the
 * caller receives the classification without the path.
 *
 * Errors this module raised itself are already path-free by construction and
 * pass through unchanged, keeping their own classification.
 * @param error - Value raised while creating or populating the program root.
 * @returns The domain error to propagate to the provider.
 */
function toVirtualProgramFailure(error: unknown): VirtualProgramError {
  if (error instanceof VirtualProgramError) return error;
  console.warn('[code-execution] Failed to materialize a program root: %s', error);
  return new VirtualProgramError('provider_failed', 'The program root could not be materialized.');
}

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/** Inputs required to materialize one prepared program. */
export interface MaterializeVirtualProgramOptions {
  /** Prepared virtual module set to materialize. */
  readonly program: CodeExecutionProgram;
  /** Validated ordinary package names mapped to absolute package roots. */
  readonly packageRoots: ReadonlyMap<string, string>;
  /** Maximum number of virtual files the program may contain. */
  readonly maxProgramFiles: number;
  /** Maximum aggregate UTF-8 size of the program's sources, in bytes. */
  readonly maxSourceBytes: number;
}

/** Minimal ownership handle for a temporary program root. */
export interface ProgramRootLease {
  /** Absolute path to the temporary program root. */
  readonly root: string;
  /**
   * Remove the entire program root.
   *
   * Safe to call on every terminal path — success, failure, timeout, and
   * cancellation alike — and safe to call again on a root that is already gone.
   *
   * Never throws, and never conceals a failure either: a root the bounded
   * retries could not remove is still on disk, so the caller is told and can
   * keep it as pending work rather than being left to assume it is gone.
   * @returns Promise resolving to whether the root is gone.
   */
  cleanup(): Promise<boolean>;
}

/** Handle to one materialized program root and its lifetime. */
export interface MaterializedVirtualProgram extends ProgramRootLease {
  /**
   * `file:` URL prefixes identifying the modules that belong to this program.
   *
   * Every spelling of the root, each ending in a slash. Both parts matter. The
   * module loader reports a module under a symlinked prefix by its *real* path
   * — which on macOS is every program root, since the temporary base is reached
   * through a symlink — so matching only the created spelling would recognize
   * no module at all. And the trailing slash is what stops a sibling root whose
   * name merely starts the same way from matching.
   */
  readonly rootUrls: readonly string[];
  /**
   * `file:` URL of the generated module that re-exports the entry namespace.
   *
   * The worker imports this rather than the program's own entry module, and
   * reads the namespace off {@link CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT}. A
   * program is free to export a callable `then` from its entry, and a dynamic
   * import of such a module resolves to whatever that `then` decides instead of
   * to the namespace — so the entry is reached through a module the program does
   * not author, whose namespace nothing can assimilate.
   */
  readonly entryNamespaceUrl: string;
  /** `file:` URL of the generated manifest, used as the importing parent. */
  readonly parentUrl: string;
  /** Program paths and URLs to strip from diagnostics before they leave the provider. */
  readonly redactedPaths: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Package map validation
// ─────────────────────────────────────────────────────────────

/**
 * Validate and normalize the host-configured package map.
 *
 * A malformed package map is a host composition error, not a request failure,
 * so this throws eagerly rather than producing an execution outcome.
 *
 * "Malformed" includes a name no program root could ever carry: every entry
 * becomes a link below every root, so a name that cannot be linked is a map that
 * cannot be materialized, and the honest place to say so is where it was
 * configured. Deferring it would turn one composition mistake into an
 * indistinguishable `provider_failed` on every invocation for the life of the
 * process — see {@link NPM_PACKAGE_NAME_MAX_LENGTH}.
 * @param packageRoots - Ordinary bare package names mapped to package roots.
 * @returns Validated map of package names to resolved absolute package roots.
 * @throws {@link Error} When a package name is not an ordinary bare specifier,
 * is longer than a package name may be, or a package root is not absolute.
 */
export function normalizePackageRoots(
  packageRoots: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  const normalized = new Map<string, string>();
  for (const [name, packageRoot] of Object.entries(packageRoots ?? {})) {
    if (!isNpmPackageName(name)) {
      throw new Error(`Configured package name "${name}" is not an ordinary bare package specifier.`);
    }
    if (name.length > NPM_PACKAGE_NAME_MAX_LENGTH) {
      throw new Error(
        `Configured package name is ${name.length} characters, which exceeds the limit of ${NPM_PACKAGE_NAME_MAX_LENGTH}.`,
      );
    }
    if (!isAbsolute(packageRoot)) {
      throw new Error(`Configured package root for "${name}" must be an absolute path.`);
    }
    normalized.set(name, resolve(packageRoot));
  }
  return normalized;
}

// ─────────────────────────────────────────────────────────────
// Budget and shape validation
// ─────────────────────────────────────────────────────────────

/**
 * Fold a virtual path into the spelling a case-insensitive filesystem compares.
 *
 * Two virtual paths that differ only in case, or only in Unicode composition,
 * can name the same file on commonly deployed case-insensitive filesystems.
 * Program validation therefore compares a deliberately conservative portable
 * fold, so a module set that risks losing a source is rejected as an invalid
 * program on *every* host — including a case-sensitive one, where it might
 * happen to write out cleanly. This is not an emulation of any filesystem's
 * case-folding algorithm; it is one stable, stricter-than-necessary rule for
 * a portable program contract.
 *
 * Both axes are folded here, in one place, because both feed the reserved-name
 * check and collision detection alike. Composition is normalized first: macOS
 * stores names decomposed and compares them by composition, so a precomposed
 * `é.ts` and a decomposed `é.ts` name the same file even though their code-point
 * sequences differ — and two program files that name the same file are written
 * concurrently, so an undetected collision would not even fail loudly, it would
 * let one module's source silently win over the other's.
 *
 * Lowercasing and then uppercasing creates a stable conservative collision key:
 * it merges final and ordinary sigma, and `ẞ` / `ß` / `ss`, all of which a
 * lower-only comparison leaves apart. Normalization is applied at both ends so
 * composition variants reach the same key as well.
 *
 * Canonical, well-formed input is a precondition, established by
 * {@link assertCanonicalPaths} before anything is folded. Neither normalization
 * nor case folding touches an unpaired surrogate, so this function cannot see
 * the one merge a filesystem performs that it does not.
 * @param value - Canonical virtual path or path prefix.
 * @returns The path in the single spelling conflict detection compares.
 */
function foldPathCase(value: string): string {
  return value.normalize('NFC').toLowerCase().toUpperCase().normalize('NFC');
}

/**
 * Reject programs that exceed their budgets, declare a non-canonical path,
 * declare a source this provider cannot execute, claim a name the materializer
 * owns, or declare paths that cannot all become distinct files.
 *
 * Pure, and cheap relative to what it guards, so it is deliberately called
 * twice: the provider runs it before it waits for an admission slot, so an
 * inadmissible program is not parked behind a busy gate, and
 * {@link materializeVirtualProgram} runs it again before any temporary
 * directory exists. Exported for the first of those callers; keeping it inside
 * materialization as well is what makes this module safe to call directly,
 * rather than only safe when reached through the provider.
 *
 * The order is load-bearing. The two budgets come first, because they bound how
 * much work the rules below can be made to do. Path canonicalization comes next,
 * because every remaining rule reasons about canonical paths and silently
 * mis-reasons about anything else — and it is the last rule that inspects
 * `entryFile` separately, because entry membership immediately after it makes
 * the entry one of the file keys. Names the materializer owns are decided before
 * extensions, so a path claiming one is told what it collided with rather than
 * being turned away for its extension; collisions come last.
 * @param program - Prepared virtual module set to validate.
 * @param maxProgramFiles - Maximum number of virtual files allowed.
 * @param maxSourceBytes - Maximum aggregate UTF-8 source size allowed, in bytes.
 * @throws {@link VirtualProgramError} Coded `invalid_program` for every violation.
 */
export function assertProgramWithinBudget(
  program: CodeExecutionProgram,
  maxProgramFiles: number,
  maxSourceBytes: number,
): void {
  const virtualPaths = Object.keys(program.files);
  if (virtualPaths.length > maxProgramFiles) {
    throw new VirtualProgramError(
      'invalid_program',
      `Program declares ${virtualPaths.length} files, which exceeds the limit of ${maxProgramFiles}.`,
    );
  }

  let totalBytes = 0;
  for (const source of Object.values(program.files)) {
    if (!source.isWellFormed()) {
      throw new VirtualProgramError(
        'invalid_program',
        'A program source is not well-formed Unicode (no unpaired surrogates).',
      );
    }
    totalBytes += Buffer.byteLength(source, 'utf8');
    if (totalBytes > maxSourceBytes) {
      throw new VirtualProgramError(
        'invalid_program',
        `Program sources exceed the aggregate limit of ${maxSourceBytes} UTF-8 bytes.`,
      );
    }
  }

  assertCanonicalPaths([...virtualPaths, program.entryFile]);
  assertEntryDeclared(program);
  assertNoReservedPaths(virtualPaths);
  assertSupportedSourceExtensions(virtualPaths);
  assertNoPathConflicts(virtualPaths);
}

/**
 * Reject a program whose entry module is not one of its own files.
 *
 * The contract states this as a cross-field rule and refuses the program at the
 * bus boundary, and this module mirrors it for the same reason it mirrors the
 * path rules: a host holding the provider directly never runs that schema. The
 * classification is what makes the mirror worth having. Without it such a program
 * materializes, and the worker then fails to resolve a module that was never
 * written — reported as `unsupported_import`, which describes what the *program*
 * did wrong while the actual fault is that its entry was never declared.
 *
 * Membership is exact: `files` is a record whose keys are the module set, so
 * naming a key in a different case or a different Unicode composition names no
 * key at all. Accepting a folded match instead would contradict the rule
 * directly above it — {@link assertNoPathConflicts} rejects two *distinct*
 * spellings that fold together precisely because the record's keys, not the
 * host filesystem's folding, are what the program promised.
 *
 * Every remaining rule therefore validates the entry as one of the file keys,
 * rather than checking it a second time in its own right.
 * @param program - Prepared virtual module set with canonical paths.
 * @throws {@link VirtualProgramError} Coded `invalid_program` when the entry file
 * is not one of the declared program files.
 */
function assertEntryDeclared(program: CodeExecutionProgram): void {
  if (Object.hasOwn(program.files, program.entryFile)) return;
  throw new VirtualProgramError(
    'invalid_program',
    `Entry file "${program.entryFile}" is not one of the declared program files.`,
  );
}

/**
 * Reject sources this provider does not execute.
 *
 * The provider advertises one runtime, one language, and one module format, and
 * a selection that pinned those was promised a program run under them. A `.cjs`
 * or `.cts` file would execute as CommonJS instead, and a `.tsx` file would be
 * compiled as a JSX dialect — each of them semantics the provider never claimed
 * and no requirement can ask for. Every other extension has no loader behind it
 * at all and would surface much later as a transpilation error naming a
 * construct rather than the real problem, which is that the file was never
 * executable here. Both are the same fact about the submitted program, so both
 * are `invalid_program`, decided before anything is written.
 *
 * The entry module needs no separate check: {@link assertEntryDeclared} has
 * already established that it is one of these keys.
 *
 * The comparison is case-sensitive, unlike the reserved-name and collision
 * rules. Those two ask what the *filesystem* would merge, which varies by host
 * and must not decide a program's validity. This one asks what the TypeScript
 * loader recognizes, which is the same everywhere: it matches extensions
 * exactly, so admitting `entry.TS` would only move the rejection to a later,
 * less informative one.
 * @param virtualPaths - Canonical virtual paths declared by the program.
 * @throws {@link VirtualProgramError} Coded `invalid_program` when a path does
 * not carry a supported source extension.
 */
function assertSupportedSourceExtensions(virtualPaths: readonly string[]): void {
  for (const virtualPath of virtualPaths) {
    // `extname` reports no extension for a leading-dot file name, so a path such
    // as `.ts` is a dotfile rather than a TypeScript source — which is exactly
    // how a filesystem and a module loader read it too.
    const extension = extname(virtualPath);
    if (!SUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
      const carried = extension === '' ? 'carries no file extension' : `carries the extension "${extension}"`;
      throw new VirtualProgramError(
        'invalid_program',
        `Virtual path "${virtualPath}" ${carried}; this provider executes ${SUPPORTED_SOURCE_EXTENSION_SUMMARY} sources.`,
      );
    }
  }
}

/**
 * Reject virtual paths the contract's own path rules would not have admitted.
 *
 * Every rule after this one reasons about *canonical* paths, and none of them
 * degrades gracefully without that. Reserved-name detection compares the first
 * `/`-separated segment; collision detection compares folded whole paths. Both
 * treat `a/b.ts` and `a//b.ts` as two unrelated keys — while `resolveContainedPath`
 * maps them onto one and the same target, so the module set passes collision
 * detection and its two sources then race for a single concurrent write, with
 * the later one silently winning. `b.ts` against `a/../b.ts` merges the same way.
 * An unpaired surrogate merges for a different reason and with the same result:
 * it has no UTF-8 encoding, so every encoder between here and the disk
 * substitutes U+FFFD, and folding cannot see the difference either.
 *
 * The contract schema already refuses all of those spellings, and this runs that
 * very schema rather than a second opinion about what canonical means — a
 * hand-rolled mirror is precisely how the two would drift apart. Mirroring at all
 * is what makes this module safe to call directly, for the same reason
 * containment is re-checked before every write.
 *
 * The rejection names the violated rule and never the offending path: a path can
 * be up to a kilobyte, and the one shape whose distinguishing character nothing
 * downstream can render is exactly the one that most needs describing.
 * @param virtualPaths - Virtual paths declared by the program, plus its entry file.
 * @throws {@link VirtualProgramError} Coded `invalid_program` when a path is not
 * a canonical virtual path.
 */
function assertCanonicalPaths(virtualPaths: readonly string[]): void {
  for (const virtualPath of virtualPaths) {
    const parsed = CodeExecutionVirtualPathSchema.safeParse(virtualPath);
    if (!parsed.success) {
      const rule = parsed.error.issues[0]?.message ?? 'it violates the virtual path rules';
      throw new VirtualProgramError('invalid_program', `A virtual path is not canonical: ${rule}.`);
    }
  }
}

/**
 * Reject virtual paths that would displace a name the materializer owns.
 *
 * Only the root segment is reserved, so a nested `lib/package.json` stays a
 * legitimate program file. The comparison is case-insensitive so the same
 * program is rejected on every host, rather than materializing cleanly on a
 * case-sensitive filesystem and overwriting the generated manifest or the
 * package-link tree on a case-insensitive one.
 * @param virtualPaths - Canonical virtual paths declared by the program.
 * @throws {@link VirtualProgramError} Coded `invalid_program` when a reserved name is used.
 */
function assertNoReservedPaths(virtualPaths: readonly string[]): void {
  for (const virtualPath of virtualPaths) {
    const rootSegment = virtualPath.split('/')[0] ?? '';
    const reservedFor = RESERVED_ROOT_SEGMENTS.get(foldPathCase(rootSegment));
    if (reservedFor !== undefined) {
      throw new VirtualProgramError(
        'invalid_program',
        `Virtual path "${virtualPath}" claims the root name "${rootSegment}", which is reserved for ${reservedFor}.`,
      );
    }
  }
}

/**
 * Reject module sets whose virtual paths cannot all become distinct files.
 *
 * Two shapes make a module set unwritable: one virtual path that is also an
 * ancestor directory of another, and two virtual paths that name the same file.
 * Both comparisons run on {@link foldPathCase} spellings, because the program's
 * distinct record keys are what the module set promises — and a case-insensitive
 * host cannot keep that promise. Program files are written concurrently, so a
 * collision the check let through would not even fail loudly: the writes would
 * race and one module's source would silently win over the other's.
 *
 * Comparing spellings is only a complete answer because the paths are canonical
 * by the time they arrive: {@link assertCanonicalPaths} has already refused the
 * variant spellings — an extra separator, a `..` segment, a lone surrogate —
 * that name an existing file while folding apart from it, so no such pair can
 * reach here and pass as two distinct keys.
 *
 * Each conflict names both original spellings, since the folded form appears
 * nowhere in the submitted program and would leave the author guessing.
 * @param virtualPaths - Canonical virtual paths declared by the program.
 * @throws {@link VirtualProgramError} Coded `invalid_program` when two paths
 * collide, or when one path is both a file and a directory.
 */
function assertNoPathConflicts(virtualPaths: readonly string[]): void {
  const sortedPaths = virtualPaths
    .map((original) => ({
      original,
      originalSegments: original.split('/'),
      foldedSegments: original.split('/').map(foldPathCase),
    }))
    .sort(compareFoldedVirtualPaths);
  let previous: (typeof sortedPaths)[number] | undefined;
  for (const current of sortedPaths) {
    if (previous !== undefined && haveSameFoldedSegments(previous.foldedSegments, current.foldedSegments)) {
      throw new VirtualProgramError(
        'invalid_program',
        `Virtual paths "${previous.original}" and "${current.original}" name the same file.`,
      );
    }
    if (previous !== undefined && isFoldedAncestor(previous.foldedSegments, current.foldedSegments)) {
      const directory = current.originalSegments.slice(0, previous.originalSegments.length).join('/');
      throw new VirtualProgramError(
        'invalid_program',
        `Virtual path "${previous.original}" is declared as a file and as the directory "${directory}".`,
      );
    }
    previous = current;
  }
}

/**
 * Compare virtual paths segment by segment in their portable collision spelling.
 * @param left - First folded virtual path.
 * @param right - Second folded virtual path.
 * @returns Negative, zero, or positive according to their sort order.
 */
function compareFoldedVirtualPaths(
  left: { readonly foldedSegments: readonly string[] },
  right: { readonly foldedSegments: readonly string[] },
): number {
  for (let index = 0; index < Math.min(left.foldedSegments.length, right.foldedSegments.length); index += 1) {
    const leftSegment = left.foldedSegments[index] ?? '';
    const rightSegment = right.foldedSegments[index] ?? '';
    if (leftSegment < rightSegment) return -1;
    if (leftSegment > rightSegment) return 1;
  }
  return left.foldedSegments.length - right.foldedSegments.length;
}

/**
 * Determine whether two virtual paths have exactly the same folded segments.
 * @param left - First folded segment sequence.
 * @param right - Second folded segment sequence.
 * @returns Whether the paths name the same portable file.
 */
function haveSameFoldedSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * Determine whether one folded path is a strict ancestor of another.
 * @param ancestor - Candidate ancestor segment sequence.
 * @param descendant - Candidate descendant segment sequence.
 * @returns Whether the first path would need to be both a file and a directory.
 */
function isFoldedAncestor(ancestor: readonly string[], descendant: readonly string[]): boolean {
  return ancestor.length < descendant.length && ancestor.every((segment, index) => segment === descendant[index]);
}

// ─────────────────────────────────────────────────────────────
// Containment
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a root-relative path and verify it can exist strictly inside the root.
 *
 * Two properties are checked, both of the *resolved* path: that it stays inside
 * the root, and that it stays strictly below {@link RESOLVED_PATH_MAX_BYTES} —
 * strictly, because that figure counts the terminating NUL the kernel appends.
 * Re-checked immediately before every write and link so the contract schema is
 * never the only boundary check.
 *
 * Neither failure message names the resolved path, so both are safe to hand to
 * the provider: the length failure reports the budget it did not fit inside,
 * which is what an author can act on, rather than the root it was measured
 * against.
 * @param root - Absolute program root the path must stay within.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @param relativePath - Root-relative POSIX path to resolve.
 * @param label - Human-readable label used in the failure message.
 * @param code - Contract failure code to report when the path is unusable.
 * @returns Absolute path inside the program root.
 * @throws {@link VirtualProgramError} When the resolved path is not inside the
 * root or reaches the resolved-pathname budget.
 */
function resolveContainedPath(
  root: string,
  rootVariants: readonly string[],
  relativePath: string,
  label: string,
  code: CodeExecutionFailedOutcomeCode,
): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  if (!target.startsWith(resolvedRoot + sep)) {
    throw new VirtualProgramError(code, `${label} "${relativePath}" resolves outside the program root.`);
  }
  for (const rootVariant of rootVariants) {
    const resolvedVariant = resolve(rootVariant);
    const variantTarget = resolve(resolvedVariant, relativePath);
    if (!variantTarget.startsWith(resolvedVariant + sep)) {
      throw new VirtualProgramError(code, `${label} "${relativePath}" resolves outside the program root.`);
    }
    const targetBytes = Buffer.byteLength(variantTarget, 'utf8');
    if (targetBytes >= RESOLVED_PATH_MAX_BYTES) {
      throw new VirtualProgramError(
        code,
        `${label} resolves to ${targetBytes} UTF-8 bytes once the program root is prepended, ` +
          `which leaves no room inside the ${RESOLVED_PATH_MAX_BYTES}-byte budget.`,
      );
    }
  }
  return target;
}

/**
 * Resolve the generated manifest below a program root.
 *
 * A manifest path this module cannot create means the root itself is already
 * near the platform's limit, which is a property of the runner rather than of
 * the submitted program.
 * @param root - Absolute program root.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @returns Absolute path of the generated manifest.
 * @throws {@link VirtualProgramError} Coded `provider_failed` when unusable.
 */
function resolveManifestPath(root: string, rootVariants: readonly string[]): string {
  return resolveContainedPath(root, rootVariants, MANIFEST_FILE, 'Program manifest', 'provider_failed');
}

/**
 * Resolve the generated entry-namespace module below a program root.
 *
 * A name this module owns, like the manifest, so a path it cannot create is a
 * property of the runner rather than of the submitted program.
 * @param root - Absolute program root.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @returns Absolute path of the generated entry-namespace module.
 * @throws {@link VirtualProgramError} Coded `provider_failed` when unusable.
 */
function resolveEntryNamespacePath(root: string, rootVariants: readonly string[]): string {
  return resolveContainedPath(root, rootVariants, ENTRY_NAMESPACE_FILE, 'Entry namespace module', 'provider_failed');
}

/**
 * Generate the module that re-exports one program's entry namespace.
 *
 * A static namespace import and a single named re-export, nothing else: the
 * generated module's own namespace therefore has no `then` export whatever the
 * program declares, so the promise machinery cannot assimilate it, and the
 * program's namespace arrives as an ordinary property untouched.
 *
 * The entry is named by absolute `file:` URL rather than by a relative
 * specifier, so the generated module says the same thing regardless of how
 * deeply the entry is nested, and the URL is spelled through `JSON.stringify` so
 * no character in a path can escape the specifier it sits in.
 * @param entryPath - Absolute path of the materialized entry module.
 * @returns Source of the generated entry-namespace module.
 */
function buildEntryNamespaceModule(entryPath: string): string {
  const specifier = JSON.stringify(pathToFileURL(entryPath).href);
  return `import * as entry from ${specifier};\nexport const ${CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT} = entry;\n`;
}

/**
 * Resolve one virtual module path below a program root.
 * @param root - Absolute program root.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @param virtualPath - Canonical virtual path declared by the program.
 * @returns Absolute path of the module below the program root.
 * @throws {@link VirtualProgramError} Coded `invalid_program` when unusable.
 */
function resolveVirtualPath(root: string, rootVariants: readonly string[], virtualPath: string): string {
  return resolveContainedPath(root, rootVariants, virtualPath, 'Virtual path', 'invalid_program');
}

/**
 * Resolve the link that exposes one configured package below a program root.
 *
 * A package the host configured is a composition input, so a link path this
 * module cannot create is a composition error, not a property of the submitted
 * program.
 * @param root - Absolute program root.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @param name - Validated ordinary bare package name.
 * @returns Absolute path of the link inside the materialized package tree.
 * @throws {@link VirtualProgramError} Coded `provider_failed` when unusable.
 */
function resolvePackageLinkPath(root: string, rootVariants: readonly string[], name: string): string {
  return resolveContainedPath(root, rootVariants, `${MODULES_DIRECTORY}/${name}`, 'Package link', 'provider_failed');
}

/**
 * Reject a program whose paths cannot all exist below this host's program root.
 *
 * Runs once the root is known and before anything is created below it, so a
 * program the contract accepted but this root cannot carry fails as a coded
 * rejection rather than part-way through materialization as a raw filesystem
 * error. Every pathname this module creates is covered: the generated manifest,
 * each virtual module, and each package link, which all resolve under the same
 * root and therefore share the same budget.
 * @param root - Absolute program root created for this invocation.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @param program - Prepared virtual module set about to be materialized.
 * @param packageRoots - Validated package names mapped to absolute package roots.
 * @throws {@link VirtualProgramError} When any path escapes the root or reaches
 * {@link RESOLVED_PATH_MAX_BYTES}.
 */
function assertPathsResolvableUnderRoot(
  root: string,
  rootVariants: readonly string[],
  program: CodeExecutionProgram,
  packageRoots: ReadonlyMap<string, string>,
): void {
  resolveManifestPath(root, rootVariants);
  resolveEntryNamespacePath(root, rootVariants);
  for (const virtualPath of Object.keys(program.files)) resolveVirtualPath(root, rootVariants, virtualPath);
  for (const name of packageRoots.keys()) resolvePackageLinkPath(root, rootVariants, name);
}

// ─────────────────────────────────────────────────────────────
// Materialization
// ─────────────────────────────────────────────────────────────

/**
 * Materialize a prepared virtual program into a private temporary root.
 *
 * Budgets are enforced before the root is created, every pathname the program
 * needs is proved resolvable under that root before anything is written below
 * it, the generated manifest marks the root as ESM, program files and package
 * links are written under a re-checked containment boundary, the generated
 * entry-namespace module is written last because it names the entry it found,
 * and a partially written root is either removed before the failure propagates
 * or transferred as cleanup work to the caller's lifecycle.
 *
 * Nothing escapes this function raw: root creation and every write below it are
 * covered by one boundary, so a filesystem error naming the temporary root is
 * reduced to a path-free domain failure instead of travelling on as itself.
 * @param options - Program, package map, and budgets for this invocation.
 * @returns Handle carrying the entry URL, diagnostic redactions, and cleanup.
 * @throws {@link VirtualProgramError} For every failure, whether it came from
 * validation, containment, or the filesystem.
 */
export async function materializeVirtualProgram(
  options: MaterializeVirtualProgramOptions,
): Promise<MaterializedVirtualProgram> {
  const program = snapshotProgramSources(options.program);
  assertProgramWithinBudget(program, options.maxProgramFiles, options.maxSourceBytes);

  // Tracked outside the boundary purely so a root that was created before the
  // failure can still be removed; `root` below is the binding everything else
  // uses, so the handle never closes over a possibly-absent value.
  let createdRoot: string | undefined;
  try {
    const root = await mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
    createdRoot = root;
    const rootPaths = await collectPathVariants(root);
    assertPathsResolvableUnderRoot(root, rootPaths, program, options.packageRoots);
    const manifestPath = resolveManifestPath(root, rootPaths);
    await writeFile(manifestPath, PROGRAM_MANIFEST, 'utf8');
    await writeProgramFiles(root, rootPaths, program.files);
    await linkConfiguredPackages(root, rootPaths, options.packageRoots);

    // Resolved as one more virtual path, because that is exactly what it is:
    // `assertProgramWithinBudget` has established that the entry names one of
    // `files`, so this repeats a resolution `assertPathsResolvableUnderRoot`
    // already proved and can no longer fail. It is repeated rather than
    // remembered because the containment boundary is re-checked immediately
    // before every use, never carried forward from an earlier check.
    const entryPath = resolveVirtualPath(root, rootPaths, program.entryFile);
    const entryNamespacePath = resolveEntryNamespacePath(root, rootPaths);
    await writeFile(entryNamespacePath, buildEntryNamespaceModule(entryPath), 'utf8');
    return {
      root,
      rootUrls: rootPaths.map((path) => pathToFileURL(`${path}${sep}`).href),
      entryNamespaceUrl: pathToFileURL(entryNamespacePath).href,
      parentUrl: pathToFileURL(manifestPath).href,
      redactedPaths: rootPaths.flatMap(toPathSpellings),
      cleanup: () => removeProgramRoot(root),
    };
  } catch (error) {
    // A failed materialization never handed its root to a worker, but bounded
    // removal can still lose to a transient filesystem condition. If it does,
    // the error transfers that root lease to the provider, which is the owner
    // able to retain and retry it through disposal. The public failure remains
    // path-free either way.
    const failure = toVirtualProgramFailure(error);
    if (createdRoot !== undefined) {
      const root = createdRoot;
      const rootLease: ProgramRootLease = { root, cleanup: () => removeProgramRoot(root) };
      if (!(await rootLease.cleanup())) {
        console.warn('[code-execution] Failed to remove a partially materialized program root: %s', createdRoot);
        throw new UnreleasedProgramRootError(failure, rootLease);
      }
    }
    throw failure;
  }
}

/**
 * Copy a program's own enumerable module sources into an ordinary owned record.
 *
 * The direct provider API accepts runtime values in addition to schema-parsed
 * bus requests. A source accessor could otherwise present one value to the
 * source budget and a different value to the later filesystem write. Reading
 * each declared source once here makes validation and materialization operate
 * on the same module set. A null-prototype record preserves a literal
 * `__proto__` virtual path as data rather than invoking an inherited setter.
 * @param program - Program whose module sources are about to be materialized.
 * @returns Program with an owned, stable module-source record.
 */
function snapshotProgramSources(program: CodeExecutionProgram): CodeExecutionProgram {
  const sourceFiles = program.files;
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const virtualPath of Object.keys(sourceFiles)) {
    files[virtualPath] = sourceFiles[virtualPath];
  }
  return { files, entryFile: program.entryFile, exportName: program.exportName };
}

/**
 * Run independent writes into one program root concurrently.
 *
 * Every write is settled before the first failure is re-thrown, deliberately.
 * `Promise.all` surfaces a rejection while its siblings are still writing, and
 * the caller removes the program root the moment it sees one — a sibling
 * landing after that removal would recreate part of the root that was just torn
 * down, and "a failed materialization leaves no root behind" would stop holding.
 * @param writes - Independent write operations for one program root.
 * @returns Promise that resolves once every write succeeded.
 * @throws The first rejection, once every write has settled.
 */
async function settleContainedWrites(writes: readonly Promise<void>[]): Promise<void> {
  for (const result of await Promise.allSettled(writes)) {
    if (result.status === 'rejected') throw result.reason;
  }
}

/**
 * Write every virtual module below the program root.
 *
 * The modules are written concurrently: each is an independent file under its
 * own re-checked containment boundary, and a recursive `mkdir` of a directory
 * two modules share is idempotent rather than a conflict.
 * @param root - Absolute program root.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @param files - Virtual module set keyed by canonical virtual path.
 * @returns Promise that resolves once every module is written.
 */
function writeProgramFiles(
  root: string,
  rootVariants: readonly string[],
  files: Readonly<Record<string, string>>,
): Promise<void> {
  return settleContainedWrites(
    Object.entries(files).map(async ([virtualPath, source]) => {
      const target = resolveVirtualPath(root, rootVariants, virtualPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }),
  );
}

/**
 * Link the host-configured packages into the materialized `node_modules` tree.
 *
 * Linking is what makes a configured package resolvable; it is not what makes
 * an unconfigured one unresolvable. Node resolves a bare specifier by walking
 * *up* from the importing module, so a `node_modules` directory anywhere above
 * the temporary root — ambient host state this module never chose — would
 * satisfy an unlisted import. The worker's resolve guard is what closes that
 * walk; see `import-allowlist-guard.ts`. Node built-ins, absolute specifiers,
 * and direct filesystem access are unaffected by either.
 *
 * The links are created concurrently: package names are unique, so every link
 * path is distinct, and the scope directories they share are created with an
 * idempotent recursive `mkdir`.
 * @param root - Absolute program root.
 * @param rootVariants - Every lexical and real spelling of the program root.
 * @param packageRoots - Validated package names mapped to absolute package roots.
 * @returns Promise that resolves once every configured package is linked.
 */
function linkConfiguredPackages(
  root: string,
  rootVariants: readonly string[],
  packageRoots: ReadonlyMap<string, string>,
): Promise<void> {
  return settleContainedWrites(
    [...packageRoots].map(async ([name, packageRoot]) => {
      const linkPath = resolvePackageLinkPath(root, rootVariants, name);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(packageRoot, linkPath, 'junction');
    }),
  );
}

/**
 * Remove a program root and everything below it.
 *
 * Package links are removed as links, so configured package roots outside the
 * program root are never traversed or deleted.
 *
 * Removal is retried a bounded number of times because an aborted invocation
 * resolves before its worker thread has finished terminating: a file the
 * program still holds open can make the first attempt fail — reliably on
 * Windows, where an open handle blocks unlink. Retrying converts that race into
 * a short delay instead of a permanently leaked root.
 *
 * The bound is deliberately short, so this never delays a settled outcome. When
 * it is not enough, the answer is `false` rather than a throw or a log: the
 * root is still on disk and removing it is still owed, and only the caller
 * knows when the handle that blocked it might be gone. Exported so a caller
 * holding a retained root can retry it later without a second copy of the
 * retry policy.
 * @param root - Absolute program root to remove.
 * @returns Whether the root is gone.
 */
export async function removeProgramRoot(root: string): Promise<boolean> {
  try {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: ROOT_REMOVAL_MAX_RETRIES,
      retryDelay: ROOT_REMOVAL_RETRY_DELAY_MS,
    });
    return true;
  } catch {
    return false;
  }
}
