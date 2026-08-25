import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeExecutionProgram, JsonValue } from '@makaio/contracts';
import { executeCodeInWorker } from '../worker-entry.js';
import { materializeVirtualProgram, type MaterializedVirtualProgram } from '../virtual-program-materializer.js';
import { CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT, type CodeExecutionWorkerOutcome } from '../types.js';
import { createCodeExecutionScratch, type CodeExecutionScratch } from './helpers/execution-fixtures.js';

// These tests exercise the real worker entry — a real materialized program on
// disk, the real scoped TypeScript loader, and the real export invocation. Only
// the Piscina hop is absent; that is covered by the integration test.

const NO_PACKAGES: ReadonlyMap<string, string> = new Map();
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;

/** Package installed above the program root, which no test ever configures. */
const AMBIENT_PACKAGE = 'ambient-package';

/** Program whose only ordinary import is the ambient package. */
const AMBIENT_IMPORT_PROGRAM = [
  `import { marker } from '${AMBIENT_PACKAGE}';`,
  'export const handler = (): string => marker;',
].join('\n');

const materialized: MaterializedVirtualProgram[] = [];

afterEach(async () => {
  while (materialized.length > 0) {
    await materialized.pop()?.cleanup();
  }
});

interface RunOptions {
  readonly files: Record<string, string>;
  readonly entryFile?: string;
  readonly exportName?: string;
  readonly input?: JsonValue;
  readonly maxResultBytes?: number;
  readonly packageRoots?: ReadonlyMap<string, string>;
  /**
   * Allowlist handed to the worker, when it must differ from `packageRoots`.
   *
   * Only the ambient-resolution cases need the two to disagree: allowing a name
   * the provider never linked is what proves an unlisted import would otherwise
   * have resolved through an ancestor `node_modules`.
   */
  readonly allowedPackages?: readonly string[];
}

const run = async (options: RunOptions): Promise<CodeExecutionWorkerOutcome> => {
  const program: CodeExecutionProgram = {
    files: options.files,
    entryFile: options.entryFile ?? 'entry.ts',
    exportName: options.exportName ?? 'handler',
  };
  const packageRoots = options.packageRoots ?? NO_PACKAGES;
  const materializedProgram = await materializeVirtualProgram({
    program,
    packageRoots,
    maxProgramFiles: 32,
    maxSourceBytes: 1024 * 1024,
  });
  materialized.push(materializedProgram);

  return executeCodeInWorker({
    entryNamespaceUrl: materializedProgram.entryNamespaceUrl,
    parentUrl: materializedProgram.parentUrl,
    programRootUrls: materializedProgram.rootUrls,
    allowedPackages: options.allowedPackages ?? [...packageRoots.keys()],
    exportName: program.exportName,
    arguments: options.input ?? null,
    namespace: `worker-entry-test-${randomUUID()}`,
    maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    redactedPaths: materializedProgram.redactedPaths,
  });
};

/**
 * The program the most recent {@link run} materialized and executed.
 * @returns The materialized program still tracked for this case.
 * @throws {@link Error} When nothing has been materialized yet.
 */
const lastMaterializedProgram = (): MaterializedVirtualProgram => {
  const program = materialized.at(-1);
  if (program === undefined) throw new Error('No program has been materialized in this case.');
  return program;
};

const expectFailure = (outcome: CodeExecutionWorkerOutcome, code: string): string => {
  expect(outcome).toMatchObject({ kind: 'failed', code });
  if (outcome.kind !== 'failed') throw new Error('unreachable');
  return outcome.message;
};

describe('executeCodeInWorker', () => {
  it('transpiles TypeScript, follows a relative import, and returns the JSON result', async () => {
    const outcome = await run({
      files: {
        'entry.ts': [
          "import { twice } from './lib/math.js';",
          'interface Input { readonly n: number }',
          'export const handler = async (input: Input): Promise<{ doubled: number }> => ({',
          '  doubled: twice(input.n),',
          '});',
        ].join('\n'),
        'lib/math.ts': 'export const twice = (value: number): number => value * 2;',
      },
      input: { n: 21 },
    });

    expect(outcome).toEqual({ kind: 'completed', value: { doubled: 42 } });
  });

  it('invokes the default export when it is requested by name', async () => {
    const outcome = await run({
      files: { 'entry.ts': 'export default (input: unknown): unknown => input;' },
      exportName: 'default',
      input: ['a', 1, true, null],
    });

    expect(outcome).toEqual({ kind: 'completed', value: ['a', 1, true, null] });
  });

  // A dynamic import resolves its promise *with* the module namespace, so a
  // namespace carrying a callable `then` is assimilated: the importer receives
  // whatever that `then` resolves with instead of the namespace, and the export
  // it asked for is reported missing or substituted. The entry is therefore
  // reached through a generated module the program does not author.
  it('invokes the requested export when the entry also exports a callable then', async () => {
    const outcome = await run({
      files: {
        'entry.ts': [
          'export const then = (resolve: (value: unknown) => void): void => { resolve({ hijacked: true }); };',
          'export const handler = (input: unknown): unknown => ({ received: input });',
        ].join('\n'),
      },
      input: { n: 1 },
    });

    expect(outcome).toEqual({ kind: 'completed', value: { received: { n: 1 } } });
  });

  // The same hazard in its worst spelling: a `then` that never calls back leaves
  // an assimilated import promise pending forever, so the invocation would only
  // end when its budget expired — reported as a timeout rather than as anything
  // about the program.
  it('invokes the requested export when the entry exports a then that never settles', async () => {
    const outcome = await run({
      files: {
        'entry.ts': ['export const then = (): void => {};', 'export const handler = (): number => 7;'].join('\n'),
      },
    });

    expect(outcome).toEqual({ kind: 'completed', value: 7 });
  });

  // The materializer is the only thing that writes the generated module, so a
  // task pointing somewhere else is an internal composition fault, not anything
  // the submitted program did. Pointing the task at the program's own entry is
  // exactly that situation, and is also what the indirection exists to prevent
  // the worker from doing on its own.
  it('reports a task that bypasses the generated entry namespace as provider_failed', async () => {
    const program = await materializeVirtualProgram({
      program: {
        files: { 'entry.ts': 'export const handler = (): number => 1;' },
        entryFile: 'entry.ts',
        exportName: 'handler',
      },
      packageRoots: NO_PACKAGES,
      maxProgramFiles: 32,
      maxSourceBytes: 1024,
    });
    materialized.push(program);

    const outcome = await executeCodeInWorker({
      entryNamespaceUrl: pathToFileURL(join(program.root, 'entry.ts')).href,
      parentUrl: program.parentUrl,
      programRootUrls: program.rootUrls,
      allowedPackages: [],
      exportName: 'handler',
      arguments: null,
      namespace: `worker-entry-test-${randomUUID()}`,
      maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
      redactedPaths: program.redactedPaths,
    });

    expect(expectFailure(outcome, 'provider_failed')).toContain(CODE_EXECUTION_ENTRY_NAMESPACE_EXPORT);
  });

  it('reports a missing export as entrypoint_not_found', async () => {
    const outcome = await run({ files: { 'entry.ts': 'export const other = (): number => 1;' } });

    expect(expectFailure(outcome, 'entrypoint_not_found')).toContain('is not exported');
  });

  it('reports a non-callable export as entrypoint_not_found', async () => {
    const outcome = await run({ files: { 'entry.ts': 'export const handler = 42;' } });

    expect(expectFailure(outcome, 'entrypoint_not_found')).toContain('not a function');
  });

  it('reports a transpilation failure as compilation_failed', async () => {
    const outcome = await run({ files: { 'entry.ts': 'export const handler = (: => {' } });

    expectFailure(outcome, 'compilation_failed');
  });

  // Import classification asks the thrown error for its Node `code` to tell an
  // unresolved specifier from every other import-phase failure. The value it
  // asks is one the program threw, so the program decides what answering costs:
  // a getter that raises turns the question itself into a throw, out of the very
  // `catch` that was choosing the classification. The program's
  // `compilation_failed` would then be reported as the provider's own fault.
  it('reports a module whose thrown error has a throwing code getter as compilation_failed', async () => {
    const outcome = await run({
      files: {
        'entry.ts': [
          "const failure = new Error('module evaluation failed');",
          "Object.defineProperty(failure, 'code', {",
          '  enumerable: true,',
          "  get: (): never => { throw new Error('the code getter itself throws'); },",
          '});',
          'throw failure;',
        ].join('\n'),
      },
    });

    // Named by its own message, not by the getter's: the classification failed
    // to read a code, which is not the same as the module failing differently.
    expect(expectFailure(outcome, 'compilation_failed')).toContain('module evaluation failed');
  });

  it('does not treat an evaluation error carrying a resolver code as an unsupported import', async () => {
    const outcome = await run({
      files: {
        'entry.ts': [
          "const failure = new Error('module evaluation failed');",
          "Object.assign(failure, { code: 'ERR_MODULE_NOT_FOUND' });",
          'throw failure;',
        ].join('\n'),
      },
    });

    expect(expectFailure(outcome, 'compilation_failed')).toContain('module evaluation failed');
  });

  it('reports an ordinary package that is not linked as unsupported_import', async () => {
    const outcome = await run({
      files: {
        'entry.ts': ["import value from 'definitely-not-linked';", 'export const handler = (): unknown => value;'].join(
          '\n',
        ),
      },
    });

    expectFailure(outcome, 'unsupported_import');
  });

  // Node resolves a bare specifier by walking *up* from the importing module,
  // so a `node_modules` directory above the temporary program root satisfies an
  // import the host never configured. The scratch workspace puts one exactly
  // there, one level above where program roots are materialized. The
  // `allowedPackages` control is what makes the pair discriminating: with the
  // ambient package allowed the very same import resolves — through the
  // ancestor directory, since nothing was ever linked into the program root —
  // which proves the rejection below is the guard's doing and not a package
  // that simply was not installed.
  describe('with an unconfigured package in an ancestor node_modules', () => {
    let scratch: CodeExecutionScratch | undefined;

    beforeEach(async () => {
      scratch = await createCodeExecutionScratch();
      const ambientRoot = join(scratch.temporaryBase, 'node_modules', AMBIENT_PACKAGE);
      await mkdir(ambientRoot, { recursive: true });
      const manifest = { name: AMBIENT_PACKAGE, version: '1.0.0', type: 'module', main: 'index.js' };
      await writeFile(join(ambientRoot, 'package.json'), JSON.stringify(manifest), 'utf8');
      await writeFile(join(ambientRoot, 'index.js'), 'export const marker = "ambient";', 'utf8');
    });

    afterEach(async () => {
      await scratch?.dispose();
      scratch = undefined;
    });

    it('rejects the import as unsupported_import', async () => {
      const outcome = await run({ files: { 'entry.ts': AMBIENT_IMPORT_PROGRAM } });

      expect(expectFailure(outcome, 'unsupported_import')).toContain(AMBIENT_PACKAGE);
    });

    it('resolves the very same import once the package is allowed', async () => {
      const outcome = await run({
        files: { 'entry.ts': AMBIENT_IMPORT_PROGRAM },
        allowedPackages: [AMBIENT_PACKAGE],
      });

      expect(outcome).toEqual({ kind: 'completed', value: 'ambient' });
    });
  });

  it('redacts the materialized program path out of a module resolution diagnostic', async () => {
    // The loader names both the missing module and its importer by absolute
    // path, so this is where a temporary path would leak if it were not redacted.
    const outcome = await run({ files: { 'entry.ts': "export { handler } from './missing.js';" } });

    const message = expectFailure(outcome, 'unsupported_import');
    expect(message).toContain('<redacted>');
    // Asserted against this invocation's own program root rather than against
    // the shape of a temporary path: a `/var|/private|/tmp` pattern holds
    // vacuously wherever `TMPDIR` points somewhere else, and would keep passing
    // on a host that materializes outside those directories.
    for (const redaction of lastMaterializedProgram().redactedPaths) {
      expect(message).not.toContain(redaction);
    }
  });

  it('reports a throwing handler as handler_failed', async () => {
    const outcome = await run({
      files: { 'entry.ts': "export const handler = (): never => { throw new Error('boom'); };" },
    });

    expect(expectFailure(outcome, 'handler_failed')).toBe('Error: boom');
  });

  it('reports a rejected handler as handler_failed', async () => {
    const outcome = await run({
      files: { 'entry.ts': "export const handler = async (): Promise<never> => { throw new TypeError('nope'); };" },
    });

    expect(expectFailure(outcome, 'handler_failed')).toContain('TypeError: nope');
  });

  it('reports a handler that throws a value with no string form as handler_failed', async () => {
    // `Object.create(null)` inherits no `toString`, so coercing it to a string
    // throws. Describing it is the last thing the handler's own catch does, so
    // a throw there escapes that catch entirely and the failure is re-reported
    // as a provider fault — the program's failure attributed to the provider.
    const outcome = await run({
      files: { 'entry.ts': 'export const handler = (): never => { throw Object.create(null); };' },
    });

    expect(expectFailure(outcome, 'handler_failed')).toContain('no string representation');
  });

  it('rejects a result whose toJSON throws a value with no string form', async () => {
    // The same hazard on the result path, and reachable the same way: the
    // serialization probe runs the returned value's own `toJSON`, so the value
    // it throws is the program's choice too.
    const outcome = await run({
      files: {
        'entry.ts': [
          'export const handler = (): unknown => ({',
          '  toJSON: (): never => { throw Object.create(null); },',
          '});',
        ].join('\n'),
      },
    });

    expect(expectFailure(outcome, 'invalid_result')).toContain('not JSON-safe');
  });

  it('rejects a cyclic result before it can be transferred', async () => {
    const outcome = await run({
      files: {
        'entry.ts': [
          'export const handler = (): unknown => {',
          '  const node: Record<string, unknown> = {};',
          '  node["self"] = node;',
          '  return node;',
          '};',
        ].join('\n'),
      },
    });

    expect(expectFailure(outcome, 'invalid_result')).toContain('non-serializable');
  });

  it('rejects a cycle concealed by toJSON as invalid_result', async () => {
    // `JSON.stringify` sees only what `toJSON` returns, so the cycle survives
    // the serialization probe and the recursive JSON schema walks the raw
    // object into a stack overflow. That is a property of the returned value,
    // and must not escape the worker as a provider fault.
    const outcome = await run({
      files: {
        'entry.ts': [
          'export const handler = (): unknown => {',
          '  const node: Record<string, unknown> = {};',
          '  node["self"] = node;',
          '  node["toJSON"] = (): Record<string, unknown> => ({});',
          '  return node;',
          '};',
        ].join('\n'),
      },
    });

    expect(expectFailure(outcome, 'invalid_result')).toContain('non-serializable cyclic');
  });

  it('rejects a result with no JSON representation', async () => {
    const outcome = await run({ files: { 'entry.ts': 'export const handler = (): void => undefined;' } });

    expect(expectFailure(outcome, 'invalid_result')).toContain('no JSON representation');
  });

  it('rejects a result that serializes but is not JSON-safe', async () => {
    // `JSON.stringify` silently coerces a non-finite number to `null`, so the
    // schema check is what catches it.
    const outcome = await run({ files: { 'entry.ts': 'export const handler = (): number => Number.NaN;' } });

    expect(expectFailure(outcome, 'invalid_result')).toContain('not JSON-safe');
  });

  it('rejects a negative-zero result before JSON would rewrite it to zero', async () => {
    const outcome = await run({ files: { 'entry.ts': 'export const handler = (): number => -0;' } });

    expect(expectFailure(outcome, 'invalid_result')).toContain('-0');
  });

  // Mirrors the request boundary, which rejects a `__proto__` own key in
  // `arguments` for the same reason: the JSON schema drops the key rather than
  // copying it, so accepting the result would hand the caller a value the
  // handler never returned — silently, and at any depth.
  it.each([
    ['at the top level', 'JSON.parse(\'{"__proto__":{"polluted":true}}\')'],
    ['nested in an object', 'JSON.parse(\'{"outer":{"__proto__":{"polluted":true}}}\')'],
    ['nested in an object inside an array', 'JSON.parse(\'{"items":[{"__proto__":{"polluted":true}}]}\')'],
  ])('rejects a result carrying a __proto__ own key %s', async (_case, expression) => {
    const outcome = await run({
      files: { 'entry.ts': `export const handler = (): unknown => ${expression};` },
    });

    expect(expectFailure(outcome, 'invalid_result')).toContain('__proto__');
  });

  // The JSON schema rebuilds an object from its own enumerable string-keyed
  // fields, so a value that is not a plain object would be *rewritten* rather
  // than transported: a `Date` whose JSON form is a string would arrive as one.
  it.each([
    ['a Date', 'new Date(0)'],
    ['a Map', 'new Map([["a", 1]])'],
    ['an object holding a class instance', '({ point: new (class { public x = 1; })() })'],
  ])('rejects %s as invalid_result', async (_case, expression) => {
    const outcome = await run({
      files: { 'entry.ts': `export const handler = (): unknown => ${expression};` },
    });

    expect(expectFailure(outcome, 'invalid_result')).toContain('not JSON data');
  });

  // The control for the rule above: plain objects and arrays nest freely.
  it('accepts a plain result nesting objects and arrays', async () => {
    const outcome = await run({
      files: { 'entry.ts': 'export const handler = (): unknown => ({ items: [{ deep: [null, 1] }], ok: true });' },
    });

    expect(outcome).toEqual({ kind: 'completed', value: { items: [{ deep: [null, 1] }], ok: true } });
  });

  it('rejects a result larger than the configured budget', async () => {
    const outcome = await run({
      files: { 'entry.ts': "export const handler = (): string => 'x'.repeat(4096);" },
      maxResultBytes: 512,
    });

    expect(expectFailure(outcome, 'invalid_result')).toContain('exceeds the limit of 512');
  });

  it('accepts a result exactly at the configured budget', async () => {
    // 32 characters plus the two JSON quotes.
    const outcome = await run({
      files: { 'entry.ts': "export const handler = (): string => 'x'.repeat(32);" },
      maxResultBytes: 34,
    });

    expect(outcome).toEqual({ kind: 'completed', value: 'x'.repeat(32) });
  });

  it('does not share a module cache between invocations of the same materialized program', async () => {
    const program = await materializeVirtualProgram({
      program: {
        files: {
          'entry.ts': [
            'let calls = 0;',
            'export const handler = (): number => {',
            '  calls += 1;',
            '  return calls;',
            '};',
          ].join('\n'),
        },
        entryFile: 'entry.ts',
        exportName: 'handler',
      },
      packageRoots: NO_PACKAGES,
      maxProgramFiles: 32,
      maxSourceBytes: 1024,
    });
    materialized.push(program);

    const invoke = (namespace: string): Promise<CodeExecutionWorkerOutcome> =>
      executeCodeInWorker({
        entryNamespaceUrl: program.entryNamespaceUrl,
        parentUrl: program.parentUrl,
        programRootUrls: program.rootUrls,
        allowedPackages: [],
        exportName: 'handler',
        arguments: null,
        namespace,
        maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
        redactedPaths: program.redactedPaths,
      });

    // Same module URL, different per-invocation namespaces: module state must
    // not carry over from the first invocation to the second.
    expect(await invoke(`worker-entry-test-${randomUUID()}`)).toEqual({ kind: 'completed', value: 1 });
    expect(await invoke(`worker-entry-test-${randomUUID()}`)).toEqual({ kind: 'completed', value: 1 });
  });
});
