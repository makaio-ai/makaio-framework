import { chmodSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodeExecutionVirtualPathSchema } from '@makaio/contracts';
import type { CodeExecutionProgram } from '@makaio/contracts';
import {
  assertProgramWithinBudget,
  materializeVirtualProgram,
  normalizePackageRoots,
  RESOLVED_PATH_MAX_BYTES,
  TEMP_DIRECTORY_PREFIX,
  UnreleasedProgramRootError,
  VirtualProgramError,
  type MaterializedVirtualProgram,
} from '../virtual-program-materializer.js';
import { CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT } from '../types.js';
import { createCodeExecutionScratch, type CodeExecutionScratch } from './helpers/execution-fixtures.js';

const NO_PACKAGES: ReadonlyMap<string, string> = new Map();

/** `cafe` with a precomposed acute accent (NFC), the spelling most tools produce. */
const COMPOSED_CAFE = 'caf\u00E9';

/** `cafe` with a combining acute accent (NFD), the spelling macOS stores on disk. */
const DECOMPOSED_CAFE = 'cafe\u0301';

/** `cafe` with a precomposed *grave* accent: a genuinely different name, not a variant spelling. */
const GRAVE_CAFE = 'caf\u00E8';

/** Segment size used to build long paths; comfortably inside the 255-byte name limit. */
const LONG_PATH_SEGMENT_BYTES = 200;

/** Source extension every generated long path ends in, so only its length is under test. */
const SOURCE_EXTENSION = '.ts';

/** Random characters `mkdtemp` appends to the prefix it is given. */
const MKDTEMP_SUFFIX_BYTES = 6;

/** Environment variables Node checks when resolving its temporary directory. */
const TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;

/** Two virtual paths differing only in which unpaired surrogate they carry. */
const LONE_SURROGATE_PATHS = ['\uD800.ts', '\uD801.ts'] as const;

/**
 * Bytes the kernel adds to a program root's spelling on this host.
 *
 * The materializer measures the root as `mkdtemp` handed it back, while the
 * kernel measures the root's *real* spelling — macOS reaches the temporary base
 * through a `/private` symlink, Linux usually does not. Measuring the difference
 * rather than reserving a guessed margin is what lets the case that must
 * materialize sit as close to the guard's boundary as the host allows, and land
 * exactly on it wherever the two spellings agree.
 *
 * Established in `beforeAll` from the scratch base: `mkdtemp` only appends a
 * plain name below it, so a root expands by exactly what its base does.
 */
let rootSpellingExpansionBytes = 0;

/**
 * Build a root-relative POSIX path of an exact ASCII byte length.
 *
 * Every segment stays well inside the 255-byte name-component limit, and the
 * last one carries a source extension the provider executes, so the only bound
 * the resulting path can put pressure on is the total-pathname one.
 * @param totalBytes - Exact byte length the returned path must have.
 * @returns Root-relative path of exactly `totalBytes` bytes.
 * @throws {@link Error} When the length leaves no room for the extension.
 */
const buildRelativePath = (totalBytes: number): string => {
  const segments: string[] = [];
  let remaining = totalBytes;
  while (remaining > LONG_PATH_SEGMENT_BYTES + 1) {
    segments.push('a'.repeat(LONG_PATH_SEGMENT_BYTES));
    remaining -= LONG_PATH_SEGMENT_BYTES + 1;
  }
  if (remaining <= SOURCE_EXTENSION.length) {
    throw new Error(`A path of ${totalBytes} bytes leaves no room for a "${SOURCE_EXTENSION}" name.`);
  }
  segments.push(`${'a'.repeat(remaining - SOURCE_EXTENSION.length)}${SOURCE_EXTENSION}`);
  return segments.join('/');
};

// The materializer creates its roots under `os.tmpdir()`. The shared scratch
// redirects that at a directory this file owns exclusively, which is what makes
// "no root was created" assertions exact instead of racing every other
// temporary directory on the machine.
let scratch: CodeExecutionScratch;

beforeAll(async () => {
  scratch = await createCodeExecutionScratch();
  rootSpellingExpansionBytes =
    Buffer.byteLength(await realpath(scratch.temporaryBase), 'utf8') - Buffer.byteLength(scratch.temporaryBase, 'utf8');
});

afterAll(async () => {
  await scratch.dispose();
});

const createProgram = (files: Record<string, string>, entryFile: string): CodeExecutionProgram => ({
  files,
  entryFile,
  exportName: 'handler',
});

const materialize = (
  program: CodeExecutionProgram,
  packageRoots: ReadonlyMap<string, string> = NO_PACKAGES,
): Promise<MaterializedVirtualProgram> =>
  materializeVirtualProgram({ program, packageRoots, maxProgramFiles: 16, maxSourceBytes: 4096 });

/**
 * Byte length of the program root `mkdtemp` creates inside the scratch base.
 * @returns Byte length of the root path, before any relative path is appended.
 */
const programRootBytes = (): number =>
  Buffer.byteLength(scratch.temporaryBase, 'utf8') + 1 + TEMP_DIRECTORY_PREFIX.length + MKDTEMP_SUFFIX_BYTES;

/**
 * Restore a temporary-directory environment snapshot exactly.
 * @param environment - Exact temporary-directory environment to restore.
 */
const restoreTemporaryDirectoryEnvironment = (
  environment: Readonly<Record<(typeof TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS)[number], string | undefined>>,
): void => {
  for (const key of TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const cleanups: Array<() => Promise<boolean>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const track = (materialized: MaterializedVirtualProgram): MaterializedVirtualProgram => {
  cleanups.push(() => materialized.cleanup());
  return materialized;
};

describe('normalizePackageRoots', () => {
  it('accepts scoped and unscoped names with absolute roots', () => {
    const normalized = normalizePackageRoots({ zod: '/packages/zod', '@scope/demo': '/packages/demo/' });

    expect([...normalized.entries()]).toEqual([
      ['zod', '/packages/zod'],
      ['@scope/demo', '/packages/demo'],
    ]);
  });

  it('treats an omitted package map as no configured packages', () => {
    expect(normalizePackageRoots(undefined).size).toBe(0);
  });

  it.each([
    '../escape',
    'has space',
    './relative',
    '@scope',
    'UPPER',
    'lpt1.js',
    '',
  ])('rejects %j as an ordinary bare package name', (name) => {
    expect(() => normalizePackageRoots({ [name]: '/packages/demo' })).toThrow(/ordinary bare package specifier/);
  });

  it('rejects a package root that is not absolute', () => {
    expect(() => normalizePackageRoots({ demo: './packages/demo' })).toThrow(/must be an absolute path/);
  });

  // The shape rule alone says nothing about length, and a name becomes a
  // `node_modules/<name>` path component below every program root — which
  // filesystems bound at 255 bytes regardless of the whole-path budget. Deferred,
  // this would pass composition and then fail every invocation as an opaque
  // `provider_failed` at link time.
  it('rejects a pattern-valid package name no program root could carry', () => {
    expect(() => normalizePackageRoots({ ['a'.repeat(215)]: '/packages/demo' })).toThrow(/exceeds the limit of 214/);
    expect(() => normalizePackageRoots({ ['a'.repeat(214)]: '/packages/demo' })).not.toThrow();
  });
});

describe('assertProgramWithinBudget', () => {
  it('rejects a program with more files than the limit', () => {
    const files = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`file-${index}.ts`, '']));

    expect(() => assertProgramWithinBudget(createProgram(files, 'file-0.ts'), 3, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
  });

  it('measures the aggregate source limit in UTF-8 bytes, not code units', () => {
    const program = createProgram({ 'a.ts': 'ä'.repeat(30), 'b.ts': 'ä'.repeat(30) }, 'a.ts');

    expect(() => assertProgramWithinBudget(program, 16, 119)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
    expect(() => assertProgramWithinBudget(program, 16, 120)).not.toThrow();
  });

  it('rejects a malformed source when called without prior contract parsing', () => {
    const program = createProgram({ 'entry.ts': 'export const handler = "\uD800";' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({
        code: 'invalid_program',
        message: 'A program source is not well-formed Unicode (no unpaired surrogates).',
      }),
    );
  });

  // The virtual-path contract allows uppercase, and macOS and Windows are
  // case-insensitive by default, so a case variant of a reserved root segment
  // lands on exactly the entries the materializer generates. Rejection must be
  // a property of the program, not of the filesystem the test happens to run on.
  it.each([
    'package.json',
    'Package.JSON',
    'PACKAGE.JSON',
    'node_modules',
    'node_modules/demo/index.ts',
    'Node_Modules/unlisted/index.js',
    'NODE_MODULES/@scope/demo/index.ts',
    '__makaio-entry-namespace.mjs',
    '__MAKAIO-ENTRY-NAMESPACE.MJS',
  ])('rejects the reserved virtual path %j', (reserved) => {
    expect(() => assertProgramWithinBudget(createProgram({ [reserved]: '' }, reserved), 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
  });

  it('reserves only the root segment, so a nested one of the same name stays a program file', () => {
    const program = createProgram({ 'entry.ts': '', 'lib/node_modules/inner.ts': '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).not.toThrow();
  });

  // Reserved-name rejection has to name what the path collided with, so it is
  // decided before the extension rule — which would otherwise turn `package.json`
  // away for its extension and never mention the manifest it would have replaced.
  it('names the reserved entry rather than the extension when a path claims one', () => {
    const program = createProgram({ 'entry.ts': '', 'package.json': '{}' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining('reserved for') }),
    );
  });

  // Each of these executes under semantics this provider never advertised: `.cts`
  // and `.cjs` are CommonJS while the provider declares `moduleFormat: 'esm'`,
  // `.tsx` is a JSX dialect no requirement can pin, and the rest have no loader
  // behind them at all and would surface much later as a transpilation error.
  it.each([
    'entry.cts',
    'entry.cjs',
    'entry.tsx',
    'entry.jsx',
    'entry.json',
    'entry.txt',
    'entry.TS',
    'entry',
    '.ts',
  ])('rejects the unsupported source %j', (virtualPath) => {
    expect(() => assertProgramWithinBudget(createProgram({ [virtualPath]: '' }, virtualPath), 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program', message: expect.stringContaining('.ts, .mts, .js, .mjs') }),
    );
  });

  it.each(['entry.ts', 'entry.mts', 'entry.js', 'entry.mjs'])('accepts the supported source %j', (virtualPath) => {
    expect(() => assertProgramWithinBudget(createProgram({ [virtualPath]: '' }, virtualPath), 16, 1024)).not.toThrow();
  });

  // The entry file is checked against the module set, because this module does
  // not assume the contract's `entryFile must name one of files` rule already
  // ran. Without it such a program materializes and the worker then reports
  // `unsupported_import` for a module that was never declared — describing what
  // the program imported rather than what it failed to declare.
  it.each<[string, Record<string, string>, string]>([
    ['names no declared file at all', { 'entry.ts': '' }, 'other.ts'],
    ['differs from a declared file only in case', { 'Entry.ts': '' }, 'entry.ts'],
    [
      'differs from a declared file only in Unicode composition',
      { [`${COMPOSED_CAFE}.ts`]: '' },
      `${DECOMPOSED_CAFE}.ts`,
    ],
  ])('rejects an entry file that %s', (_case, files, entryFile) => {
    // Exact membership, deliberately: `files` is a record, so a key in another
    // case or another composition is not the same key — and the collision rule
    // rejects two *distinct* spellings that fold together for the same reason.
    expect(() => assertProgramWithinBudget(createProgram(files, entryFile), 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program', message: expect.stringContaining('declared program files') }),
    );
  });

  it('rejects a module set that uses one virtual path as both a file and a directory', () => {
    const program = createProgram({ 'lib.ts': 'export const a = 1;', 'lib.ts/inner.ts': '' }, 'lib.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program', message: expect.stringContaining('as the directory') }),
    );
  });

  // A submitted program is portable input: two record keys that differ only in
  // case are two modules on a case-sensitive filesystem and one file on the
  // macOS/Windows default. Because program files are written concurrently, a
  // host that merges them does not fail — one source silently overwrites the
  // other. Rejection is therefore a property of the program on every host.
  it.each<[string, Record<string, string>, string]>([
    [
      'two files differing only in case',
      { 'entry.ts': 'export const handler = () => 1;', 'Entry.ts': 'export const other = 2;' },
      'entry.ts',
    ],
    [
      'a nested file differing only in case from a sibling',
      { 'entry.ts': '', 'lib/math.ts': 'export const a = 1;', 'lib/Math.ts': 'export const b = 2;' },
      'entry.ts',
    ],
    [
      'a file whose case variant is the directory of another path',
      { SRC: 'export const a = 1;', 'src/inner.ts': '' },
      'SRC',
    ],
    [
      'a scoped-style nested directory reached through a case variant',
      { 'entry.ts': '', 'Lib/Deep': 'export const a = 1;', 'lib/deep/inner.ts': '' },
      'entry.ts',
    ],
  ])('rejects %s', (_case, files, entryFile) => {
    expect(() => assertProgramWithinBudget(createProgram(files, entryFile), 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
  });

  // The same argument as the case cases, on the other axis a filesystem folds:
  // macOS stores names decomposed and compares them by composition, so a
  // precomposed and a decomposed spelling of the same accented name are one
  // file there and two record keys everywhere. The spellings are built from
  // escapes on purpose: they are indistinguishable in source, and an editor or
  // a tool that normalizes the file would otherwise silently collapse the case
  // into one that tests nothing.
  it.each<[string, Record<string, string>, string]>([
    [
      'two files differing only in Unicode composition',
      {
        'entry.ts': '',
        [`${COMPOSED_CAFE}.ts`]: 'export const a = 1;',
        [`${DECOMPOSED_CAFE}.ts`]: 'export const b = 2;',
      },
      'entry.ts',
    ],
    [
      'a directory differing only in Unicode composition from a file',
      { 'entry.ts': '', [COMPOSED_CAFE]: 'export const a = 1;', [`${DECOMPOSED_CAFE}/inner.ts`]: '' },
      'entry.ts',
    ],
    [
      'a composition variant that also differs in case',
      {
        'entry.ts': '',
        [`${COMPOSED_CAFE.toUpperCase()}.ts`]: 'export const a = 1;',
        [`${DECOMPOSED_CAFE}.ts`]: 'export const b = 2;',
      },
      'entry.ts',
    ],
  ])('rejects %s', (_case, files, entryFile) => {
    // Guards the fixtures themselves: two spellings that collapsed into a
    // single record key would make the case pass without testing anything.
    expect(Object.keys(files)).toHaveLength(3);

    expect(() => assertProgramWithinBudget(createProgram(files, entryFile), 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
  });

  it('keeps genuinely different accented names apart', () => {
    // The discriminating half: folding composition must not fold *different*
    // characters together, or the guard would start rejecting portable programs.
    const program = createProgram(
      { 'entry.ts': '', [`${COMPOSED_CAFE}.ts`]: '', [`${GRAVE_CAFE}.ts`]: '' },
      'entry.ts',
    );

    expect(() => assertProgramWithinBudget(program, 16, 1024)).not.toThrow();
  });

  it('names both original spellings when two virtual paths collide', () => {
    const program = createProgram({ 'lib/math.ts': '', 'lib/Math.ts': '' }, 'lib/math.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(/"lib\/math\.ts" and "lib\/Math\.ts"/);
  });

  it('keeps distinct paths that share no folded spelling', () => {
    const program = createProgram({ 'entry.ts': '', 'lib/Math.ts': '', 'lib/matrix.ts': '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).not.toThrow();
  });

  it.each([
    ['ordinary and final sigma files', 'σ.ts', 'ς.ts'],
    ['capital sharp S and ss files', 'ẞ.ts', 'ss.ts'],
  ])('rejects %s that share the conservative portable collision fold', (_case, first, second) => {
    const program = createProgram({ 'entry.ts': '', [first]: '', [second]: '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program', message: expect.stringContaining('name the same file') }),
    );
  });

  it.each([
    ['ordinary and final sigma', 'Σ.ts', 'ς.ts/inner.ts'],
    ['capital sharp S and ss', 'ẞ.ts', 'ss.ts/inner.ts'],
  ])('rejects a file-directory collision through the conservative fold: %s', (_case, file, nestedFile) => {
    const program = createProgram({ 'entry.ts': '', [file]: '', [nestedFile]: '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({
        code: 'invalid_program',
        message: expect.stringContaining('declared as a file and as the directory'),
      }),
    );
  });

  it('names the original file and directory spellings for a folded file-directory collision', () => {
    const program = createProgram({ 'entry.ts': '', 'Foo.ts': '', 'foo.ts/inner.ts': '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({
        code: 'invalid_program',
        message: 'Virtual path "Foo.ts" is declared as a file and as the directory "foo.ts".',
      }),
    );
  });

  it('checks a deeply nested file-directory conflict without building repeated path prefixes', () => {
    const depth = 400;
    const file = `${Array.from({ length: depth }, () => 'a').join('/')}/leaf.ts`;
    const nestedFile = `${file}/inner.ts`;
    const program = createProgram({ 'entry.ts': '', [file]: '', [nestedFile]: '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({
        code: 'invalid_program',
        message: expect.stringContaining('declared as a file and as the directory'),
      }),
    );
  });

  // The one axis this module's path folding structurally cannot fold. An
  // unpaired surrogate has no UTF-8 encoding, so every encoder on the way to
  // disk substitutes U+FFFD — but neither NFC normalization nor case folding
  // touches it, so the two keys survive collision detection as distinct and the
  // concurrent writes race for a single file. The contract rejects this shape
  // too; asserted here because this module is safe to call directly, so its own
  // validation has to hold without it.
  it('rejects lone-surrogate paths, which collide as bytes while folding apart', () => {
    const [first, second] = LONE_SURROGATE_PATHS;
    // The discriminating half: the collision is invisible to every comparison
    // this module makes, and visible only once the paths are encoded.
    expect(first.normalize('NFC').toLowerCase()).not.toBe(second.normalize('NFC').toLowerCase());
    expect(Buffer.from(first, 'utf8')).toEqual(Buffer.from(second, 'utf8'));

    // Built from entries rather than as a literal on purpose: TypeScript folds
    // the two spellings into one property *name* and reports a duplicate key, so
    // the merge this check exists to prevent is not even unique to filesystems.
    const files = Object.fromEntries(LONE_SURROGATE_PATHS.map((path, index) => [path, `export const a = ${index};`]));
    // Guards the fixture itself: one surviving key would test nothing.
    expect(Object.keys(files)).toHaveLength(2);
    const program = createProgram(files, first);

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
    // Each is refused on its own, so the rejection is a property of the path
    // rather than of the pair happening to be submitted together.
    for (const path of LONE_SURROGATE_PATHS) {
      expect(() => assertProgramWithinBudget(createProgram({ [path]: '' }, path), 16, 1024)).toThrowError(
        expect.objectContaining({ code: 'invalid_program' }),
      );
    }
  });

  // The axis path folding cannot fold either, and for a plainer reason than a
  // lone surrogate: these pairs are two spellings of one *path*, so folding
  // compares them character by character and finds them different, while the
  // resolver maps them onto a single target. Both sources are written
  // concurrently to that one target, so the merge does not fail — the later
  // write silently wins. The contract refuses these spellings, and this module
  // now refuses them too rather than assuming the contract already ran.
  it.each<[string, Record<string, string>, string]>([
    ['an extra separator', { 'a/b.ts': 'export const first = 1;', 'a//b.ts': 'export const second = 2;' }, 'a/b.ts'],
    [
      'a traversal that returns to the root',
      { 'b.ts': 'export const first = 1;', 'a/../b.ts': 'export const second = 2;' },
      'b.ts',
    ],
  ])('rejects two virtual paths that fold apart and resolve to one file: %s', (_case, files, entryFile) => {
    const [first, second] = Object.keys(files);
    // Guards the fixture itself, and states the discriminating property: the
    // keys are distinct — and stay distinct through the folding this module
    // does — yet name the same target under any root at all.
    expect(Object.keys(files)).toHaveLength(2);
    if (first === undefined || second === undefined) throw new Error('unreachable');
    expect(first.normalize('NFC').toLowerCase()).not.toBe(second.normalize('NFC').toLowerCase());
    expect(resolve('/program-root', first)).toBe(resolve('/program-root', second));

    expect(() => assertProgramWithinBudget(createProgram(files, entryFile), 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
  });

  // The entry module is validated in its own right, so a caller reaching this
  // module directly cannot smuggle a non-canonical path in through the one
  // position the file keys do not cover.
  it('rejects a non-canonical entryFile even when every files key is canonical', () => {
    const program = createProgram({ 'b.ts': 'export const handler = () => 1;' }, 'a/../b.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).toThrowError(
      expect.objectContaining({ code: 'invalid_program' }),
    );
  });

  it('keeps paths whose surrogates are properly paired', () => {
    const astral = `lib/${String.fromCodePoint(0x1f600)}.ts`;
    const program = createProgram({ 'entry.ts': '', [astral]: '' }, 'entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).not.toThrow();
  });

  it('allows a nested module set within budget', () => {
    const program = createProgram({ 'a/b/entry.ts': 'export const handler = () => 1;' }, 'a/b/entry.ts');

    expect(() => assertProgramWithinBudget(program, 16, 1024)).not.toThrow();
  });
});

describe('materializeVirtualProgram', () => {
  it('writes the module set below a temporary root with an ESM manifest', async () => {
    const materialized = track(
      await materialize(
        createProgram(
          {
            'entry.ts': "export { twice } from './lib/math.ts';",
            'lib/math.ts': 'export const twice = (n: number): number => n * 2;',
          },
          'entry.ts',
        ),
      ),
    );

    const manifest = await readFile(join(materialized.root, 'package.json'), 'utf8');
    expect(JSON.parse(manifest)).toEqual({ type: 'module' });
    expect(await readFile(join(materialized.root, 'lib', 'math.ts'), 'utf8')).toContain('twice');
    expect(materialized.parentUrl).toBe(pathToFileURL(join(materialized.root, 'package.json')).href);
  });

  it('writes the source snapshot that passed the aggregate source budget', async () => {
    const sourceThatFits = 'export const handler = (): number => 1;';
    const files: Record<string, string> = {};
    let reads = 0;
    Object.defineProperty(files, 'entry.ts', {
      enumerable: true,
      get: (): string => {
        reads += 1;
        return reads === 1 ? sourceThatFits : 'x'.repeat(4097);
      },
    });

    const materialized = track(await materialize(createProgram(files, 'entry.ts')));

    expect(reads).toBe(1);
    expect(await readFile(join(materialized.root, 'entry.ts'), 'utf8')).toBe(sourceThatFits);
  });

  // The worker imports this module instead of the program's own entry, so that a
  // program exporting a callable `then` cannot hijack the import promise. What
  // makes that work is the generated module declaring one named export and
  // nothing the program authored, so both halves are asserted here.
  it('writes an entry-namespace module that re-exports the entry under a fixed name', async () => {
    const materialized = track(
      await materialize(createProgram({ 'a/b/entry.ts': 'export const handler = () => 1;' }, 'a/b/entry.ts')),
    );

    const generatedPath = join(materialized.root, '__makaio-entry-namespace.mjs');
    expect(materialized.entryNamespaceUrl).toBe(pathToFileURL(generatedPath).href);
    const generated = await readFile(generatedPath, 'utf8');
    expect(generated).toBe(
      `import * as entry from ${JSON.stringify(pathToFileURL(join(materialized.root, 'a', 'b', 'entry.ts')).href)};\n` +
        `export const ${CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT} = entry;\n`,
    );
  });

  it('creates only the configured package links, including scoped layout', async () => {
    const packageHome = await mkdtemp(join(tmpdir(), 'makaio-ce-packages-'));
    try {
      const scopedRoot = join(packageHome, 'scoped');
      const plainRoot = join(packageHome, 'plain');
      await mkdir(scopedRoot, { recursive: true });
      await mkdir(plainRoot, { recursive: true });

      const materialized = track(
        await materialize(
          createProgram({ 'entry.ts': 'export const handler = () => 1;' }, 'entry.ts'),
          new Map([
            ['@scope/demo', scopedRoot],
            ['plain', plainRoot],
          ]),
        ),
      );

      // Compared through `realpath` on both sides rather than by reading the
      // link target back: a Windows junction stores a normalized target, so
      // `readlink` there returns a different spelling of the same directory.
      // Resolving both ends asserts what the link is for — that the name inside
      // `node_modules` reaches the configured package root.
      const modulesRoot = join(materialized.root, 'node_modules');
      expect(await realpath(join(modulesRoot, '@scope', 'demo'))).toBe(await realpath(scopedRoot));
      expect(await realpath(join(modulesRoot, 'plain'))).toBe(await realpath(plainRoot));
      expect((await readdir(modulesRoot)).sort()).toEqual(['@scope', 'plain']);
    } finally {
      await rm(packageHome, { recursive: true, force: true });
    }
  });

  it('creates no package tree when no package is configured', async () => {
    const materialized = track(await materialize(createProgram({ 'entry.ts': '' }, 'entry.ts')));

    expect((await readdir(materialized.root)).sort()).toEqual([
      '__makaio-entry-namespace.mjs',
      'entry.ts',
      'package.json',
    ]);
  });

  it('rejects a virtual path that escapes the program root and leaves no partial root behind', async () => {
    // Deliberately bypasses the contract schema: a path that leaves the program
    // root must be refused by this module's own validation, not delegated to
    // request parsing — and refused before a root exists to be left behind.
    const program = createProgram({ '../escaped.ts': 'export const handler = () => 1;' }, '../escaped.ts');

    await expect(materialize(program)).rejects.toThrowError(expect.objectContaining({ code: 'invalid_program' }));
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  it('rejects a malformed source before creating a temporary root', async () => {
    const program = createProgram({ 'entry.ts': 'export const handler = "\uD800";' }, 'entry.ts');

    await expect(materialize(program)).rejects.toThrowError(
      expect.objectContaining({
        code: 'invalid_program',
        message: 'A program source is not well-formed Unicode (no unpaired surrogates).',
      }),
    );
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  it('does not create a temporary root for an over-budget program', async () => {
    await expect(
      materializeVirtualProgram({
        program: createProgram({ 'entry.ts': 'x'.repeat(64) }, 'entry.ts'),
        packageRoots: NO_PACKAGES,
        maxProgramFiles: 16,
        maxSourceBytes: 8,
      }),
    ).rejects.toBeInstanceOf(VirtualProgramError);
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  // The contract bounds the relative virtual path, because that is the only
  // part of the pathname a portable program owns. The pathname the filesystem
  // sees also carries this host's program root, so a path the contract accepts
  // at its own maximum cannot fit under any root at all. Closing that gap is
  // this module's half of the bound, and it must produce a coded rejection
  // rather than a raw filesystem error.
  it('rejects a program whose path only exceeds the budget once the root is prepended', async () => {
    const virtualPath = buildRelativePath(RESOLVED_PATH_MAX_BYTES);
    // The discriminating half: the contract is satisfied, so only the resolved
    // pathname can be what makes this program unmaterializable.
    expect(CodeExecutionVirtualPathSchema.safeParse(virtualPath).success).toBe(true);

    const thrown: unknown = await materialize(createProgram({ 'entry.ts': '', [virtualPath]: '' }, 'entry.ts')).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(VirtualProgramError);
    if (!(thrown instanceof VirtualProgramError)) throw new Error('unreachable');
    expect(thrown.code).toBe('invalid_program');
    // The summary names the budget, never the root it was measured against.
    expect(thrown.message).toContain(`${RESOLVED_PATH_MAX_BYTES}-byte budget`);
    expect(thrown.message).not.toMatch(/[/\\]/);
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  // `PATH_MAX` counts the terminating NUL, so a pathname of exactly that many
  // bytes is the first length the kernel refuses, not the last one it accepts.
  // This is the case that separates the two readings of the budget: it is
  // admitted by a `>` comparison and rejected by the `>=` the limit calls for.
  it('rejects a resolved pathname of exactly the budget, which the kernel has no room for', async () => {
    const virtualPath = buildRelativePath(RESOLVED_PATH_MAX_BYTES - programRootBytes() - 1);

    const thrown: unknown = await materialize(createProgram({ [virtualPath]: '' }, virtualPath)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(VirtualProgramError);
    if (!(thrown instanceof VirtualProgramError)) throw new Error('unreachable');
    // Coded, not a raw ENAMETOOLONG: the guard runs before anything is written.
    expect(thrown.code).toBe('invalid_program');
    expect(thrown.message).toContain(`${RESOLVED_PATH_MAX_BYTES} UTF-8 bytes`);
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  // The other side of that boundary, and the guard against over-correcting it:
  // one byte below the budget must still materialize. Where the root's created
  // and real spellings agree this is exactly `RESOLVED_PATH_MAX_BYTES - 1`; on a
  // host that reaches its temporary base through a symlink the kernel measures
  // the longer spelling, so the case backs off by that measured difference and
  // by nothing else.
  it('materializes a resolved pathname one byte below what this host can carry', async () => {
    const virtualPath = buildRelativePath(
      RESOLVED_PATH_MAX_BYTES - programRootBytes() - 1 - 1 - rootSpellingExpansionBytes,
    );

    const materialized = track(
      await materialize(createProgram({ [virtualPath]: 'export const handler = () => 1;' }, virtualPath)),
    );

    const target = join(materialized.root, virtualPath);
    expect(Buffer.byteLength(target, 'utf8')).toBe(RESOLVED_PATH_MAX_BYTES - 1 - rootSpellingExpansionBytes);
    // What the kernel actually measured, terminating NUL included, is the limit.
    expect(Buffer.byteLength(await realpath(target), 'utf8')).toBe(RESOLVED_PATH_MAX_BYTES - 1);
    expect(await readFile(target, 'utf8')).toContain('handler');
  });

  it('checks pathname budgets against a symlink root’s real spelling before writing', async () => {
    const symlinkedTemporaryBase = join(scratch.root, 't');
    const environment = Object.fromEntries(
      TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
    ) as Readonly<Record<(typeof TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS)[number], string | undefined>>;
    await symlink(scratch.temporaryBase, symlinkedTemporaryBase, 'junction');
    for (const key of TEMPORARY_DIRECTORY_ENVIRONMENT_KEYS) process.env[key] = symlinkedTemporaryBase;

    try {
      expect(tmpdir()).toBe(symlinkedTemporaryBase);
      const rootBytes =
        Buffer.byteLength(symlinkedTemporaryBase, 'utf8') + 1 + TEMP_DIRECTORY_PREFIX.length + MKDTEMP_SUFFIX_BYTES;
      const virtualPath = buildRelativePath(RESOLVED_PATH_MAX_BYTES - rootBytes - 1);

      await expect(materialize(createProgram({ 'entry.ts': '', [virtualPath]: '' }, 'entry.ts'))).rejects.toThrowError(
        expect.objectContaining({ code: 'invalid_program' }),
      );
      expect(await scratch.listProgramRoots()).toEqual([]);
    } finally {
      restoreTemporaryDirectoryEnvironment(environment);
      await rm(symlinkedTemporaryBase, { recursive: true, force: true });
    }
  });

  // A path component past the platform's name limit is a portability defect,
  // not a filesystem accident: it exceeds the contract's own segment bound, so
  // it is refused as an invalid program on every host — including one whose
  // filesystem would have accepted it — and refused before a root exists.
  it('rejects an over-long path component as an invalid program, without creating a root', async () => {
    const program = createProgram({ 'entry.ts': '', [`${'x'.repeat(300)}.ts`]: '' }, 'entry.ts');

    await expect(materialize(program)).rejects.toThrowError(expect.objectContaining({ code: 'invalid_program' }));
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  // Every filesystem error Node raises names the absolute path it was operating
  // on, and inside this module that path is always somewhere under the temporary
  // base — exactly what a bus-bound failure must never carry, and what the
  // caller cannot redact because the handle carrying the redactions does not
  // exist yet. `mkdtemp` names the whole template it failed on, base and prefix
  // together, so denying it is the shortest route to a raw failure that would
  // leak both if it were not reduced.
  //
  // Staged with permission bits for the same reason an unremovable root is: no
  // input to this module can provoke a genuine filesystem failure any more, now
  // that every path is validated against the contract's rules before anything is
  // created. Skipped where the process can bypass permission bits entirely.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reduces a filesystem failure to a path-free domain error and leaves no root behind',
    async () => {
      await chmod(scratch.temporaryBase, 0o500);
      try {
        const thrown: unknown = await materialize(createProgram({ 'entry.ts': '' }, 'entry.ts')).catch(
          (error: unknown) => error,
        );

        expect(thrown).toBeInstanceOf(VirtualProgramError);
        if (!(thrown instanceof VirtualProgramError)) throw new Error('unreachable');
        expect(thrown.code).toBe('provider_failed');
        expect(thrown.message).not.toContain(scratch.temporaryBase);
        expect(thrown.message).not.toContain(TEMP_DIRECTORY_PREFIX);
      } finally {
        await chmod(scratch.temporaryBase, 0o700);
      }
      expect(await scratch.listProgramRoots()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'transfers a partially materialized root when its immediate cleanup fails',
    async () => {
      const packageRoots = new Map<string, string>();
      // `assertPathsResolvableUnderRoot` calls `keys()` only after `mkdtemp`
      // created the root. Locking its parent then makes the catch-path removal
      // fail, while this throw supplies a deterministic materialization error.
      packageRoots.keys = () => {
        chmodSync(scratch.temporaryBase, 0o500);
        throw new Error('configured package traversal failed');
      };

      let thrown: unknown;
      try {
        thrown = await materializeVirtualProgram({
          program: createProgram({ 'entry.ts': '' }, 'entry.ts'),
          packageRoots,
          maxProgramFiles: 16,
          maxSourceBytes: 4096,
        }).catch((error: unknown) => error);
      } finally {
        chmodSync(scratch.temporaryBase, 0o700);
      }

      expect(thrown).toBeInstanceOf(UnreleasedProgramRootError);
      if (!(thrown instanceof UnreleasedProgramRootError)) throw new Error('unreachable');
      expect(thrown.message).not.toContain(scratch.temporaryBase);
      expect(thrown.rootLease.root).toContain(TEMP_DIRECTORY_PREFIX);
      await expect(thrown.rootLease.cleanup()).resolves.toBe(true);
      expect(await scratch.listProgramRoots()).toEqual([]);
    },
  );

  it('reports every spelling of the program root as a diagnostic redaction', async () => {
    const materialized = track(await materialize(createProgram({ 'entry.ts': '' }, 'entry.ts')));
    const realRoot = await realpath(materialized.root);

    expect(materialized.redactedPaths).toContain(materialized.root);
    expect(materialized.redactedPaths).toContain(pathToFileURL(materialized.root).href);
    expect(materialized.redactedPaths).toContain(realRoot);
    expect(materialized.redactedPaths).toContain(pathToFileURL(realRoot).href);
  });

  it('removes the program root on cleanup without following package links', async () => {
    const packageHome = await mkdtemp(join(tmpdir(), 'makaio-ce-packages-'));
    try {
      const packageRoot = join(packageHome, 'demo');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'index.js'), 'export default 1;\n', 'utf8');

      const materialized = await materialize(
        createProgram({ 'entry.ts': '' }, 'entry.ts'),
        new Map([['demo', packageRoot]]),
      );
      await materialized.cleanup();

      await expect(stat(materialized.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(packageRoot, 'index.js'))).resolves.toMatchObject({});
      expect(await scratch.listProgramRoots()).toEqual([]);
    } finally {
      await rm(packageHome, { recursive: true, force: true });
    }
  });

  // Removal needs write permission on the directory holding an entry, so a
  // non-writable subdirectory reproduces a genuine removal failure — the same
  // shape as a worker that still holds a file when an aborted run resolves.
  // Skipped where the process can bypass permission bits entirely.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports failure without throwing when a root cannot be removed',
    async () => {
      const materialized = await materialize(createProgram({ 'entry.ts': '', 'lib/inner.ts': '' }, 'entry.ts'));
      const locked = join(materialized.root, 'lib');
      await chmod(locked, 0o500);

      try {
        // Reporting the failure is what lets the caller keep the removal as
        // pending work; resolving `undefined` either way would lose it.
        await expect(materialized.cleanup()).resolves.toBe(false);
        // Giving up must leave the root observable rather than pretend success.
        await expect(stat(materialized.root)).resolves.toMatchObject({});
      } finally {
        await chmod(locked, 0o700);
        await rm(materialized.root, { recursive: true, force: true });
      }
    },
  );

  it('is safe to clean up a root that is already gone', async () => {
    const materialized = await materialize(createProgram({ 'entry.ts': '' }, 'entry.ts'));

    await expect(materialized.cleanup()).resolves.toBe(true);
    // A root that is already gone still satisfies "the root is gone", so a
    // second cleanup must not report it as retained work.
    await expect(materialized.cleanup()).resolves.toBe(true);
  });
});
