import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  CODE_EXECUTION_IDENTIFIER_MAX_LENGTH,
  CodeExecutionOutcomeSchema,
  type CodeExecutionOutcome,
  type CodeExecutionProgram,
  type CodeExecutionProviderContext,
  type CodeExecutionRequest,
  type JsonValue,
} from '@makaio/contracts';
import { PiscinaCodeExecutionProvider } from '../piscina-code-execution-provider.js';
import type { PiscinaCodeExecutionProviderOptions } from '../types.js';
import { RESOLVED_PATH_MAX_BYTES, TEMP_DIRECTORY_PREFIX } from '../virtual-program-materializer.js';
import {
  createCodeExecutionScratch,
  NEVER_RETURNING_PROGRAM,
  waitForPath,
  waitUntil,
  type CodeExecutionScratch,
} from './helpers/execution-fixtures.js';

// End-to-end coverage of the real provider: a real Piscina worker pool, a real
// TypeScript entrypoint transpiled on import, and real abort handling. Nothing
// in this file is mocked.

const TEST_TIMEOUT_MS = 30_000;

/**
 * How long to wait for an executing program to announce that it started.
 *
 * Deliberately well below {@link TEST_TIMEOUT_MS}: a program that never starts
 * must fail with the waiter's own diagnostic and still leave the case room to
 * tear its provider down, rather than being cut off by the outer timeout.
 */
const PROGRAM_START_TIMEOUT_MS = TEST_TIMEOUT_MS / 2;

/** Environment variable the host sets so the worker can be shown not to see it. */
const HOST_ONLY_VARIABLE = 'MAKAIO_CODE_EXECUTION_HOST_ONLY';

/**
 * A package name this repository's own tsconfig maps onto a source file.
 *
 * The cases below configure the test package under this name so that the
 * host's ambient alias and the materialized package link compete for the same
 * specifier. A name with no ambient alias would let both cases pass without
 * testing anything, so this must stay a name the root tsconfig actually
 * declares in `paths`.
 */
const ALIASED_PACKAGE_NAME = '@makaio/contracts';

let scratch: CodeExecutionScratch;
let packageRoot = '';
/** Symlink pointing at {@link packageRoot}, so the two spell the same package differently. */
let linkedPackageRoot = '';
let previousHostOnly: string | undefined;

const providers: PiscinaCodeExecutionProvider[] = [];

beforeAll(async () => {
  scratch = await createCodeExecutionScratch();
  // Borrowed, not claimed: the variable is restored to whatever the host had,
  // so this file cannot silently erase a value another suite depends on.
  previousHostOnly = process.env[HOST_ONLY_VARIABLE];
  process.env[HOST_ONLY_VARIABLE] = 'host-secret';

  packageRoot = join(scratch.root, 'packages', 'demo');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', main: 'index.js' }),
    'utf8',
  );
  await writeFile(join(packageRoot, 'index.js'), 'export const greet = (name) => `hello ${name}`;\n', 'utf8');
  // The loader resolves a package through its real path, so this is the only
  // spelling of the package root an executing program can ever observe — and
  // therefore the only one it can put into a diagnostic.
  await writeFile(join(packageRoot, 'where.js'), 'export const where = import.meta.url;\n', 'utf8');
  linkedPackageRoot = join(scratch.root, 'packages', 'demo-link');
  await symlink(packageRoot, linkedPackageRoot, 'junction');
});

afterAll(async () => {
  if (previousHostOnly === undefined) delete process.env[HOST_ONLY_VARIABLE];
  else process.env[HOST_ONLY_VARIABLE] = previousHostOnly;
  await scratch.dispose();
});

afterEach(async () => {
  while (providers.length > 0) {
    await providers.pop()?.dispose();
  }
  // Every terminal path must leave the temporary base empty again.
  expect(await scratch.listProgramRoots()).toEqual([]);
});

/**
 * Create a provider that is disposed automatically after the test.
 * @param options - Overrides layered on the shared test defaults.
 * @returns A tracked provider instance.
 */
function createProvider(options: PiscinaCodeExecutionProviderOptions = {}): PiscinaCodeExecutionProvider {
  const provider = new PiscinaCodeExecutionProvider({ maxConcurrency: 1, idleTimeoutMs: 1_000, ...options });
  providers.push(provider);
  return provider;
}

/**
 * Build a request for a single-source program.
 * @param files - Virtual module set keyed by canonical virtual path.
 * @param input - JSON argument handed to the invoked export.
 * @param exportName - Name of the export to invoke.
 * @returns A prepared execution request.
 */
function createRequest(
  files: Record<string, string>,
  input: JsonValue = null,
  exportName = 'handler',
): CodeExecutionRequest {
  const program: CodeExecutionProgram = { files, entryFile: 'entry.ts', exportName };
  return { invocationId: randomUUID(), program, arguments: input, timeoutMs: TEST_TIMEOUT_MS };
}

/** A cancellation context together with the controller that drives it. */
interface TestExecutionContext {
  readonly context: CodeExecutionProviderContext;
  readonly controller: AbortController;
}

/**
 * Build an execution context with an explicit deadline.
 * @param deadlineOffsetMs - Offset from now for the effective deadline.
 * @returns The provider context and its abort controller.
 */
function createContext(deadlineOffsetMs: number): TestExecutionContext {
  const controller = new AbortController();
  return { controller, context: { signal: controller.signal, deadlineEpochMs: Date.now() + deadlineOffsetMs } };
}

/**
 * Assert the outcome satisfies the contract schema and return it.
 * @param outcome - Outcome produced by the provider.
 * @returns The same outcome, after contract validation.
 */
function assertContractOutcome(outcome: CodeExecutionOutcome): CodeExecutionOutcome {
  expect(CodeExecutionOutcomeSchema.safeParse(outcome).success).toBe(true);
  return outcome;
}

/**
 * Composition options that must be rejected before a pool can exist.
 *
 * Each entry pairs the option name with a value that would otherwise disable a
 * comparison silently, leave the provider unselectable for its whole lifetime,
 * or surface much later as an opaque provider failure.
 */
const INVALID_OPTIONS: ReadonlyArray<readonly [string, PiscinaCodeExecutionProviderOptions]> = [
  ['maxConcurrency', { maxConcurrency: 0 }],
  ['maxConcurrency', { maxConcurrency: Number.NaN }],
  ['idleTimeoutMs', { idleTimeoutMs: -1 }],
  ['maxProgramFiles', { maxProgramFiles: 1.5 }],
  ['maxSourceBytes', { maxSourceBytes: Number.POSITIVE_INFINITY }],
  ['maxResultBytes', { maxResultBytes: 0 }],
  ['maxArgumentBytes', { maxArgumentBytes: 0 }],
  ['maxInvocationsPerWorker', { maxInvocationsPerWorker: 0 }],
  // Zero is a valid queue cap — refuse rather than queue — so only a negative
  // or fractional value is a composition error here.
  ['maxQueuedInvocations', { maxQueuedInvocations: -1 }],
  ['maxQueuedInvocations', { maxQueuedInvocations: 1.5 }],
  ['priority', { priority: Number.NaN }],
  // An empty identity is not a cosmetic defect: the selector refuses a
  // registration whose `id` is unusable, so this provider would register
  // successfully and then lose every selection pass as `invalid_provider`.
  ['id', { id: '' }],
  ['id', { id: '   ' }],
  ['id', { id: 'x'.repeat(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH + 1) }],
  ['displayName', { displayName: '' }],
];

/**
 * Package maps that must be refused before a pool can exist.
 *
 * Kept out of {@link INVALID_OPTIONS} because these are validated by the package
 * map's own rules and reported in that vocabulary — the entry that is wrong is
 * named, not the option it arrived under — while the matrix above asserts the
 * `Option "<name>"` convention every scalar option follows.
 */
const INVALID_PACKAGE_ROOTS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>, RegExp]> = [
  [
    'a name that is not an ordinary bare specifier',
    { 'Has Space': '/packages/demo' },
    /ordinary bare package specifier/,
  ],
  ['a root that is not absolute', { demo: './packages/demo' }, /must be an absolute path/],
  // Pattern-valid and unlinkable: the name becomes a `node_modules/<name>` path
  // component below every program root, which no filesystem accepts at this
  // length. Left to run, it would fail every invocation at link time as an
  // opaque provider fault rather than naming the misconfiguration once.
  ['a name no program root could carry', { ['a'.repeat(215)]: '/packages/demo' }, /exceeds the limit of 214/],
];

/**
 * Argument carrying a `__proto__` own key one level down.
 *
 * Built with `Object.defineProperty` rather than parsed from JSON text so the
 * key is unambiguously an own property in every engine, and so the fixture does
 * not depend on how `JSON.parse` chooses to install it.
 * @returns An otherwise ordinary object whose nested member carries the key.
 */
const NESTED_PROTOTYPE_KEY_ARGUMENT: JsonValue = ((): JsonValue => {
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { nested };
})();

/** Segments {@link UNMATERIALIZABLE_PATH} is built from; five is enough to reach the budget. */
const UNMATERIALIZABLE_PATH_SEGMENTS = 5;

/**
 * Virtual path the contract accepts and no program root can carry.
 *
 * Exactly {@link RESOLVED_PATH_MAX_BYTES} of ASCII, split into segments well
 * inside the 255-byte name-component limit and ending in a source extension the
 * provider executes — so every rule that judges the path on its own terms passes
 * it, and the pre-admission budget check therefore lets the program through. It
 * becomes unusable only once a root is prepended, which no root can avoid: the
 * two bounds are equal, so nothing fits after a non-empty root. That makes it the
 * one path whose rejection proves materialization actually ran, and the failure
 * it produces is raised after the root exists but before any handle carrying that
 * root's redactions does.
 */
const UNMATERIALIZABLE_PATH = ((): string => {
  const segmentBytes =
    (RESOLVED_PATH_MAX_BYTES - (UNMATERIALIZABLE_PATH_SEGMENTS - 1)) / UNMATERIALIZABLE_PATH_SEGMENTS;
  const directories = new Array<string>(UNMATERIALIZABLE_PATH_SEGMENTS - 1).fill('a'.repeat(segmentBytes));
  return [...directories, `${'a'.repeat(segmentBytes - '.ts'.length)}.ts`].join('/');
})();

/** Program whose handler reports the id of the worker thread it ran on. */
const THREAD_ID_PROGRAM: Record<string, string> = {
  'entry.ts': [
    "import { threadId } from 'node:worker_threads';",
    'export const handler = (): number => threadId;',
  ].join('\n'),
};

/** Program whose handler announces that it started and blocks until released. */
const GATED_PROGRAM: Record<string, string> = {
  'entry.ts': [
    "import { existsSync, writeFileSync } from 'node:fs';",
    'interface Input { readonly startedPath: string; readonly releasePath: string }',
    'export const handler = (input: Input): string => {',
    "  writeFileSync(input.startedPath, 'started');",
    '  const deadline = Date.now() + 20_000;',
    '  while (!existsSync(input.releasePath) && Date.now() < deadline) {',
    '    // Busy wait: the host releases this handler by creating the file.',
    '  }',
    "  return 'done';",
    '};',
  ].join('\n'),
};

/** Number of padding modules in {@link BULKY_PROGRAM}. */
const BULKY_MODULE_COUNT = 200;

/** Padding carried by each module of {@link BULKY_PROGRAM}, as a single comment line. */
const BULKY_MODULE_PADDING = '// '.padEnd(8 * 1024, 'x');

/**
 * Program whose module set takes long enough to build and remove to be observed.
 *
 * The materializer creates the program root before it writes anything into it,
 * so a set this size — comfortably inside the default file and source budgets —
 * gives a test a window in which the root provably exists while nothing has
 * been dispatched yet. The writes themselves are concurrent, so the window is
 * bounded by how long the whole set takes, not by any one file.
 *
 * Removal has the same property from the other end: every module has to be
 * unlinked before the root directory itself can go, so the root stays visible
 * for the whole removal. Shrinking this set narrows both windows — the cases
 * that watch a root appear, and the one that watches a settled outcome
 * overtake a root's removal.
 */
const BULKY_PROGRAM: Record<string, string> = {
  'entry.ts': 'export const handler = (): number => 1;',
  ...Object.fromEntries(
    Array.from({ length: BULKY_MODULE_COUNT }, (_, index) => [
      `lib/module-${index}.ts`,
      `${BULKY_MODULE_PADDING}\nexport const value${index} = ${index};`,
    ]),
  ),
};

/**
 * List the leftover program roots without yielding to the event loop.
 *
 * The asynchronous helper would cost a full turn, which is exactly the window a
 * concurrent removal needs. Reading the directory synchronously is what makes
 * "the root still existed when the outcome arrived" an observation about the
 * settlement rather than about scheduling.
 * @returns Names of the program roots present at this instant.
 */
function listProgramRootsNow(): string[] {
  return readdirSync(scratch.temporaryBase).filter((entry) => entry.startsWith(TEMP_DIRECTORY_PREFIX));
}

// ─────────────────────────────────────────────────────────────
// Unremovable program roots
// ─────────────────────────────────────────────────────────────

// A program root is only ever unremovable for a reason that is expected to
// pass — a worker thread that has not finished exiting is still holding a file
// open, which on Windows blocks unlink outright. That race cannot be staged
// reliably, so a non-writable subdirectory stands in for it: removal needs write
// permission on the directory holding an entry, so it produces exactly the same
// failure, on demand and for exactly as long as the case wants it.

/** Whether this process can be denied a directory removal by permission bits at all. */
const CANNOT_LOCK_DIRECTORIES = process.platform === 'win32' || process.getuid?.() === 0;

/** Diagnostic the provider logs once a root has outlived its own removal attempts. */
const RETAINED_ROOT_WARNING = 'Retained a program root';

/**
 * Program materialized purely for the shape of its root.
 *
 * The entry holds a real worker until cancellation. What matters is that the
 * root contains a subdirectory: removal needs write permission on the directory
 * holding an entry, so `lib` is what the lock is applied to.
 */
const UNREMOVABLE_ROOT_PROGRAM: Readonly<Record<string, string>> = {
  'entry.ts': [
    "import { writeFileSync } from 'node:fs';",
    'export const handler = (input: { readonly startedPath: string }): Promise<never> => {',
    "  writeFileSync(input.startedPath, 'started');",
    '  return new Promise(() => {});',
    '};',
  ].join('\n'),
  'lib/held.ts': 'export const held = true;\n',
};

/** A retained root, together with the lock holding it and the spy that observed it. */
interface RetainedRootCase {
  /** Non-writable subdirectory that makes the root unremovable; restore it to release. */
  readonly locked: string;
  /** Spy over `console.warn`; still installed, so the caller restores it. */
  readonly warn: MockInstance<typeof console.warn>;
}

/**
 * Run one invocation whose program root cannot be removed, and leave it retained.
 *
 * Returns only once the provider has logged {@link RETAINED_ROOT_WARNING},
 * which it does after the invocation's own bounded attempts have all failed.
 * Waiting for that is what makes the caller's assertions deterministic: while
 * those attempts are still in flight, restoring the permission bits would let
 * the invocation remove the root itself and the case would prove nothing about
 * retention.
 * @param provider - Provider to run the invocation on; not disposed here.
 * @returns The lock to release and the `console.warn` spy to restore.
 */
async function retainAnUnremovableRoot(provider: PiscinaCodeExecutionProvider): Promise<RetainedRootCase> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const startedPath = scratch.path('started');
  const { context, controller } = createContext(TEST_TIMEOUT_MS);

  const pending = provider.execute(createRequest(UNREMOVABLE_ROOT_PROGRAM, { startedPath }), context);
  await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

  const [root] = await scratch.listProgramRoots();
  if (root === undefined) throw new Error('The invocation materialized no program root.');
  const locked = join(scratch.temporaryBase, root, 'lib');
  await chmod(locked, 0o500);

  controller.abort('cancellation');
  // A cleanup that cannot succeed must not hold up the outcome either.
  expect(assertContractOutcome(await pending)).toMatchObject({ status: 'cancelled' });

  await waitUntil(
    () =>
      Promise.resolve(
        warn.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes(RETAINED_ROOT_WARNING)),
        ),
      ),
    PROGRAM_START_TIMEOUT_MS,
    'the provider to retain the program root it could not remove',
  );
  return { locked, warn };
}

describe('PiscinaCodeExecutionProvider', () => {
  it('declares trusted-code-only Node/TypeScript/ESM metadata', () => {
    const provider = createProvider({ id: 'custom-id', displayName: 'Custom', priority: 7 });

    expect(provider).toMatchObject({
      id: 'custom-id',
      displayName: 'Custom',
      priority: 7,
      runtime: 'node',
      language: 'typescript',
      moduleFormat: 'esm',
      trust: 'trusted-code-only',
    });
  });

  it(
    'executes a TypeScript entrypoint with a relative import and a provided package import',
    async () => {
      const provider = createProvider({ packageRoots: { demo: packageRoot } });
      const request = createRequest(
        {
          'entry.ts': [
            "import { greet } from 'demo';",
            "import { shout } from './lib/format.js';",
            'interface Input { readonly name: string }',
            'export const handler = async (input: Input): Promise<{ message: string }> => ({',
            '  message: shout(greet(input.name)),',
            '});',
          ].join('\n'),
          'lib/format.ts': 'export const shout = (value: string): string => `${value}!`;',
        },
        { name: 'world' },
      );

      const outcome = assertContractOutcome(await provider.execute(request, createContext(TEST_TIMEOUT_MS).context));

      expect(outcome).toEqual({ status: 'completed', value: { message: 'hello world!' } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps Node built-ins and filesystem access available to trusted code',
    async () => {
      // The documented boundary: supplied virtual paths and ordinary package
      // availability are controlled, everything else a Node worker can do stays
      // available. This provider is not a sandbox.
      const provider = createProvider();
      const witness = scratch.path('witness');
      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest(
            {
              'entry.ts': [
                "import { writeFileSync, readFileSync } from 'node:fs';",
                "import { platform } from 'node:os';",
                'interface Input { readonly witness: string }',
                'export const handler = (input: Input): { readonly echoed: string; readonly platform: string } => {',
                "  writeFileSync(input.witness, 'written by executed code');",
                '  return { echoed: readFileSync(input.witness, "utf8"), platform: platform() };',
                '};',
              ].join('\n'),
            },
            { witness },
          ),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'completed', value: { echoed: 'written by executed code' } });
      await expect(stat(witness)).resolves.toMatchObject({});
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hands the worker the configured environment instead of the host environment',
    async () => {
      const provider = createProvider({ environment: { MAKAIO_CODE_EXECUTION_ALLOWED: 'yes' } });
      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              'export const handler = (): Record<string, string | null> => ({',
              '  allowed: process.env["MAKAIO_CODE_EXECUTION_ALLOWED"] ?? null,',
              `  hostOnly: process.env[${JSON.stringify(HOST_ONLY_VARIABLE)}] ?? null,`,
              '});',
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toEqual({ status: 'completed', value: { allowed: 'yes', hostOnly: null } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'snapshots the configured environment at composition time',
    async () => {
      // The pool is created lazily at the first execution, so the options object
      // stays reachable to its owner across that window. Whatever the worker is
      // launched with must be what the redaction set was derived from.
      const environment: Record<string, string> = { MAKAIO_CODE_EXECUTION_TOKEN: 'composition-time-secret' };
      const provider = createProvider({ environment });
      environment['MAKAIO_CODE_EXECUTION_TOKEN'] = 'mutated-after-composition';

      const observed = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              'export const handler = (): string | null =>',
              "  process.env['MAKAIO_CODE_EXECUTION_TOKEN'] ?? null;",
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(observed).toEqual({ status: 'completed', value: 'composition-time-secret' });

      // And the value the worker did receive is the one the provider redacts:
      // a snapshot the redaction set had not seen would cross the bus verbatim.
      const leaked = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              'export const handler = (): never => {',
              "  throw new Error('env=' + (process.env['MAKAIO_CODE_EXECUTION_TOKEN'] ?? ''));",
              '};',
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(leaked).toMatchObject({ status: 'failed', error: { code: 'handler_failed' } });
      if (leaked.status !== 'failed') throw new Error('unreachable');
      expect(leaked.error.message).not.toContain('composition-time-secret');
      expect(leaked.error.message).toContain('<redacted>');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a materialization failure without naming the temporary program root',
    async () => {
      // A path that only becomes unusable once the root is prepended is refused
      // after the program root already exists — the one window in which the
      // provider has no per-invocation redactions yet, because the handle
      // carrying them was never returned. The failure summary must therefore be
      // path-free at the source rather than sanitized here.
      const provider = createProvider();
      // Guards the fixture: a path short enough to fit would be refused nowhere.
      expect(Buffer.byteLength(UNMATERIALIZABLE_PATH, 'utf8')).toBe(RESOLVED_PATH_MAX_BYTES);

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): number => 1;', [UNMATERIALIZABLE_PATH]: '' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.error.message).not.toContain(scratch.temporaryBase);
      expect(outcome.error.message).not.toContain(TEMP_DIRECTORY_PREFIX);
      // No absolute path of any spelling: the summary names the failure, not a place.
      expect(outcome.error.message).not.toMatch(/[/\\]/);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['entrypoint_not_found', { 'entry.ts': 'export const other = (): number => 1;' }],
    ['compilation_failed', { 'entry.ts': 'export const handler = (: => {' }],
    ['handler_failed', { 'entry.ts': "export const handler = (): never => { throw new Error('boom'); };" }],
    ['invalid_result', { 'entry.ts': 'export const handler = (): void => undefined;' }],
    [
      'unsupported_import',
      { 'entry.ts': ["import x from 'not-provided';", 'export const handler = (): unknown => x;'].join('\n') },
    ],
  ])(
    'reports %s as a failed outcome',
    async (code, files) => {
      const provider = createProvider();

      const outcome = assertContractOutcome(
        await provider.execute(createRequest(files), createContext(TEST_TIMEOUT_MS).context),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves a configured package through its link even when the host tsconfig aliases the same name',
    async () => {
      // The package map is the truth about *which* names resolve — the resolve
      // guard enforces that above every loader — but that says nothing about
      // *where* an allowed name resolves to. In the source layout a process-wide
      // TypeScript loader sits beneath the guard, and a `paths` alias in the
      // tsconfig it discovers is applied ahead of Node's own `node_modules`
      // lookup: for a name the host configured, the alias would win over the
      // materialized link and hand the program the host repository's own source
      // instead. This repository's tsconfig aliases exactly this name, which is
      // what makes the case discriminating rather than hypothetical.
      const provider = createProvider({ packageRoots: { [ALIASED_PACKAGE_NAME]: packageRoot } });

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              `import { greet } from '${ALIASED_PACKAGE_NAME}';`,
              'export const handler = (): unknown => greet("world");',
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toEqual({ status: 'completed', value: 'hello world' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an unconfigured bare import the host tsconfig aliases',
    async () => {
      // The other half of the same guarantee, and the one the guard owns: a name
      // the host did not configure is refused even though the ambient tsconfig
      // could resolve it, because the guard classifies the specifier before any
      // loader beneath it is consulted.
      const provider = createProvider();

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              `import * as aliased from '${ALIASED_PACKAGE_NAME}';`,
              'export const handler = (): number => Object.keys(aliased).length;',
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'unsupported_import' } });
    },
    TEST_TIMEOUT_MS,
  );

  it.each<[string, JsonValue]>([
    // `JsonValue`'s object branch is deliberately broad, so every one of these
    // type-checks as an argument and only the runtime rule refuses it.
    ['a Date', new Date(0)],
    ['a Map', new Map([['a', 1]])],
    ['a nested class instance', { at: new Date(0) }],
    ['a nested "__proto__" own key', NESTED_PROTOTYPE_KEY_ARGUMENT],
  ])(
    'rejects %s argument a direct caller submitted, as invalid_program',
    async (_case, input) => {
      // The routing service parses every request against the contract, whose
      // `arguments` field rejects exactly these. A host holding the provider
      // directly does not — and the pool transports the argument by structured
      // clone, which reproduces a `Date` or a `Map` faithfully, so the handler
      // would receive a value the contract promised it could never see. The byte
      // budget cannot stand in for this: `JSON.stringify` measures a `Map` as
      // two bytes.
      const provider = createProvider();

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (input: unknown): unknown => input;' }, input),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
    },
    TEST_TIMEOUT_MS,
  );

  it.each<[string, JsonValue]>([
    // Leaves, not shapes. The fidelity walk judges object shapes and never
    // inspects a leaf, so each of these reaches it intact and only the schema
    // parse refuses it.
    ['a nested function value', { fn: (): string => 'nope' }],
    ['undefined inside an array', [undefined]],
    ['a nested bigint leaf', { big: 1n }],
    ['a nested non-finite number', { ratio: Number.POSITIVE_INFINITY }],
  ])(
    'rejects %s a direct caller submitted, as invalid_program',
    async (_case, input) => {
      // Without the schema parse these pass admission: a function serializes as
      // `{}` and `undefined` as `null`, so the byte budget sees nothing, and the
      // structured clone then either fails outright — reported as a provider
      // fault for an argument the caller was never allowed to submit — or
      // carries the value through to a handler the contract promised could never
      // receive it. The bus path already refuses all four at the contract.
      const provider = createProvider();

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (input: unknown): unknown => input;' }, input),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({
        status: 'failed',
        error: { code: 'invalid_program', message: expect.stringContaining('no JSON form') },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'passes an ordinary nested JSON argument through unchanged',
    async () => {
      // The discriminating half: the fidelity rule must reject values that are
      // not JSON data, not ordinary nested payloads that merely contain objects.
      const provider = createProvider();
      const input: JsonValue = { list: [1, 'two', null, { deep: true }], flag: false };

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (input: unknown): unknown => input;' }, input),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toEqual({ status: 'completed', value: input });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'dispatches the one-read argument snapshot from a direct caller',
    async () => {
      const provider = createProvider();
      let reads = 0;
      const input: JsonValue = {};
      Object.defineProperty(input, 'value', {
        enumerable: true,
        get: (): string => {
          reads += 1;
          return reads === 1 ? 'admitted' : 'changed';
        },
      });

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest(
            { 'entry.ts': 'export const handler = (input: { readonly value: string }): string => input.value;' },
            input,
          ),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(reads).toBe(1);
      expect(outcome).toEqual({ status: 'completed', value: 'admitted' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an over-budget program as invalid_program without starting a worker',
    async () => {
      const provider = createProvider({ maxProgramFiles: 1 });

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = () => 1;', 'extra.ts': '' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a timeout abort reason as timed_out and reuses the pool afterwards',
    async () => {
      const provider = createProvider();
      const startedPath = scratch.path('started');
      // The deadline is far in the future, so only the typed reason can produce
      // a timeout here. Classifying against the wall clock would report a
      // cancellation instead.
      const { context, controller } = createContext(TEST_TIMEOUT_MS);

      const pending = provider.execute(createRequest(NEVER_RETURNING_PROGRAM, { startedPath }), context);
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);
      controller.abort('timeout');

      expect(assertContractOutcome(await pending)).toEqual({
        status: 'timed_out',
        error: { code: 'execution_timeout', message: expect.any(String) },
      });

      const reused = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): number => 7;' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(reused).toEqual({ status: 'completed', value: 7 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retires a generation after a worker exits and serves a later invocation from a fresh pool',
    async () => {
      const provider = createProvider();
      const crashed = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): never => process.exit(1);' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(crashed).toMatchObject({ status: 'failed', error: { code: 'provider_failed' } });

      const recovered = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): number => 42;' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(recovered).toEqual({ status: 'completed', value: 42 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a cancellation abort reason as cancelled even past the deadline',
    async () => {
      const provider = createProvider();
      const startedPath = scratch.path('started');
      // The deadline is already behind us, so a wall-clock classification would
      // mislabel this cancellation as a timeout.
      const { context, controller } = createContext(0);

      const pending = provider.execute(createRequest(NEVER_RETURNING_PROGRAM, { startedPath }), context);
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);
      controller.abort('cancellation');

      expect(assertContractOutcome(await pending)).toEqual({
        status: 'cancelled',
        error: { code: 'cancelled', message: expect.any(String) },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'falls back to the deadline for a foreign signal that carries no typed reason',
    async () => {
      // Not every caller is the router: a host-supplied signal aborts with the
      // platform's own reason, and the deadline is the only evidence left.
      const provider = createProvider();
      const startedPath = scratch.path('started');
      const { context, controller } = createContext(0);

      const pending = provider.execute(createRequest(NEVER_RETURNING_PROGRAM, { startedPath }), context);
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);
      controller.abort();

      expect(assertContractOutcome(await pending)).toMatchObject({ status: 'timed_out' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'observes an abort that lands between admission and materialization',
    async () => {
      // One of the program's paths cannot fit under a program root, which is a
      // failure only materialization can see: it is measured against the
      // resolved root, so the pre-admission budget check passes the program
      // through. Reaching `invalid_program` is exactly what must NOT happen —
      // the signal settled before materialization began, so the invocation is
      // over and no work may be started for it. The unusable path is the
      // discriminator: it turns "materialization ran" into a visible outcome.
      const provider = createProvider();
      const { context, controller } = createContext(TEST_TIMEOUT_MS);

      // Aborting synchronously after `execute()` lands the abort while the
      // invocation is suspended on its already-resolved admission slot.
      const pending = provider.execute(
        createRequest({ 'entry.ts': 'export const handler = (): number => 1;', [UNMATERIALIZABLE_PATH]: '' }),
        context,
      );
      controller.abort('cancellation');

      expect(assertContractOutcome(await pending)).toEqual({
        status: 'cancelled',
        error: { code: 'cancelled', message: expect.any(String) },
      });
      expect(await scratch.listProgramRoots()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports the typed abort for a signal that settles while the program materializes',
    async () => {
      // Covers the window between the program root appearing and the task
      // reaching a worker. The pool short-circuits an already-aborted run of its
      // own accord, so this pins the classification through that window rather
      // than the pool itself; the case above is the one that discriminates
      // whether work is started at all.
      const provider = createProvider();
      const { context, controller } = createContext(TEST_TIMEOUT_MS);

      const pending = provider.execute(createRequest(BULKY_PROGRAM), context);
      await waitUntil(
        async () => (await scratch.listProgramRoots()).length === 1,
        PROGRAM_START_TIMEOUT_MS,
        'the invocation to create its program root',
      );
      controller.abort('cancellation');

      expect(assertContractOutcome(await pending)).toEqual({
        status: 'cancelled',
        error: { code: 'cancelled', message: expect.any(String) },
      });
      // The root is released after the outcome is reported, not before it, so
      // what is asserted here is that the abort path releases it at all. That
      // it is gone by the time the provider is disposed is the barrier's
      // promise, and `afterEach` holds it to that.
      await waitUntil(
        async () => (await scratch.listProgramRoots()).length === 0,
        PROGRAM_START_TIMEOUT_MS,
        'the cancelled invocation to release its program root',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'materializes no more program roots than the configured concurrency allows',
    async () => {
      // A worker pool only bounds dispatch, so without an admission bound every
      // concurrent caller would already hold a temporary program root by the
      // time the first one reaches a worker.
      const provider = createProvider({ maxConcurrency: 1 });
      const startedPath = scratch.path('started');
      const releasePath = scratch.path('release');
      const invoke = (): Promise<CodeExecutionOutcome> =>
        provider.execute(
          createRequest(GATED_PROGRAM, { startedPath, releasePath }),
          createContext(TEST_TIMEOUT_MS).context,
        );

      const running = invoke();
      const queued = [invoke(), invoke()];

      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);
      expect(await scratch.listProgramRoots()).toHaveLength(1);

      await writeFile(releasePath, 'go', 'utf8');
      const outcomes = await Promise.all([running, ...queued]);

      expect(outcomes.map(assertContractOutcome)).toEqual([
        { status: 'completed', value: 'done' },
        { status: 'completed', value: 'done' },
        { status: 'completed', value: 'done' },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent on dispose and refuses executions afterwards',
    async () => {
      const provider = createProvider();
      await provider.execute(
        createRequest({ 'entry.ts': 'export const handler = (): number => 1;' }),
        createContext(TEST_TIMEOUT_MS).context,
      );

      await expect(provider.dispose()).resolves.toBeUndefined();
      await expect(provider.dispose()).resolves.toBeUndefined();

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): number => 1;' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'disposes cleanly when it was never used',
    async () => {
      const provider = createProvider();

      await expect(provider.dispose()).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is a barrier: disposal drains an execution that is still materializing',
    async () => {
      // The case that pins the drain itself. The invocation is past admission
      // and has created its program root, but nothing has been dispatched yet,
      // so no worker pool exists — destroying the pool therefore cannot settle
      // it, and only waiting for the tracked invocation can.
      const provider = createProvider();
      let settled = false;
      const pending = provider
        .execute(createRequest(BULKY_PROGRAM), createContext(TEST_TIMEOUT_MS).context)
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      await waitUntil(
        async () => (await scratch.listProgramRoots()).length === 1,
        PROGRAM_START_TIMEOUT_MS,
        'the invocation to create its program root',
      );

      await provider.dispose();

      expect(settled).toBe(true);
      expect(await scratch.listProgramRoots()).toEqual([]);
      expect(assertContractOutcome(await pending)).toMatchObject({
        status: 'failed',
        error: { code: 'provider_unavailable' },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is a barrier for a retired worker generation that is still running an execution',
    async () => {
      // A generation is retired the moment it has served its last invocation,
      // which leaves it *closing* while that invocation is still running — and
      // closing waits for the program, which this one never ends. Disposal must
      // therefore terminate a retired generation exactly as it terminates the
      // current one, or the barrier would inherit the program's own lifetime.
      const provider = createProvider({ maxInvocationsPerWorker: 1 });
      const startedPath = scratch.path('started');
      const pending = provider.execute(
        createRequest(NEVER_RETURNING_PROGRAM, { startedPath }),
        createContext(TEST_TIMEOUT_MS).context,
      );
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

      await provider.dispose();

      expect(assertContractOutcome(await pending)).toMatchObject({
        status: 'failed',
        error: { code: 'provider_unavailable' },
      });
      expect(await scratch.listProgramRoots()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is a barrier for every caller: disposal tears down a running worker and leaves no program root',
    async () => {
      const provider = createProvider();
      const startedPath = scratch.path('started');
      let settled = false;
      const pending = provider
        .execute(createRequest(NEVER_RETURNING_PROGRAM, { startedPath }), createContext(TEST_TIMEOUT_MS).context)
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      // Disposal must land on an execution that has provably passed admission,
      // materialized its program root, and reached a running worker. Disposing
      // straight after `execute()` would instead be observed at the admission
      // gate, before the invocation had built anything, and every assertion
      // below would then hold vacuously.
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

      const first = provider.dispose();
      const second = provider.dispose();

      // A second, concurrent caller awaits the same barrier: it must not
      // resolve before the execution the first call is draining has settled.
      await second;
      expect(settled).toBe(true);
      await first;

      // The program never returns on its own, so it can only have settled
      // because disposal tore its worker down — and the root it had already
      // materialized is gone again.
      expect(assertContractOutcome(await pending)).toMatchObject({
        status: 'failed',
        error: { code: 'provider_unavailable' },
      });
      expect(await scratch.listProgramRoots()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'redacts configured environment values and package roots out of a handler diagnostic',
    async () => {
      // The handler is trusted code that happens to name values the provider
      // itself configured. Those the provider knows, so those it must strip.
      const provider = createProvider({
        environment: { MAKAIO_CODE_EXECUTION_TOKEN: 'super-secret-token-value' },
        packageRoots: { demo: packageRoot },
      });

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              'export const handler = (): never => {',
              "  const token = process.env['MAKAIO_CODE_EXECUTION_TOKEN'] ?? '';",
              `  throw new Error('env=' + token + ' root=' + ${JSON.stringify(packageRoot)});`,
              '};',
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'handler_failed' } });
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.error.message).not.toContain('super-secret-token-value');
      expect(outcome.error.message).not.toContain(packageRoot);
      expect(outcome.error.message).toContain('<redacted>');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'redacts a configured value whose whitespace the diagnostic collapse rewrites',
    async () => {
      // Sanitizing folds every whitespace run in the message onto a single
      // space. A configured value carrying a tab or a double space therefore no
      // longer occurs in the message it was meant to be matched against, so it
      // has to be folded the same way before matching — otherwise the secret
      // crosses the bus in the one spelling that survives the collapse.
      const token = 'super  secret\ttoken-value';
      const provider = createProvider({ environment: { MAKAIO_CODE_EXECUTION_TOKEN: token } });

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              'export const handler = (): never => {',
              "  throw new Error('env=' + (process.env['MAKAIO_CODE_EXECUTION_TOKEN'] ?? ''));",
              '};',
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'handler_failed' } });
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.error.message).not.toContain('token-value');
      expect(outcome.error.message).toContain('<redacted>');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'redacts the target of a symlinked package root out of a diagnostic',
    async () => {
      // The host configured the link; the loader resolves the target. A program
      // that reaches the package therefore observes a spelling of the package
      // root the configured value never carried, and can put it straight into a
      // failure message. Redaction has to hold for that spelling too, or a host
      // that happens to configure a symlinked root leaks its layout.
      const provider = createProvider({ packageRoots: { demo: linkedPackageRoot } });

      const outcome = assertContractOutcome(
        await provider.execute(
          createRequest({
            'entry.ts': [
              "import { where } from 'demo/where.js';",
              "export const handler = (): never => { throw new Error('at ' + where); };",
            ].join('\n'),
          }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'handler_failed' } });
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.error.message).toContain('<redacted>');
      // The discriminator: the target is what the program saw, and the
      // configured link spelling would not have matched it.
      expect(outcome.error.message).not.toContain(packageRoot);
      expect(outcome.error.message).not.toContain(linkedPackageRoot);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pins a configured symlink target before a later rotation',
    async () => {
      const replacementRoot = join(scratch.root, 'packages', 'demo-replacement');
      await mkdir(replacementRoot, { recursive: true });
      await writeFile(
        join(replacementRoot, 'package.json'),
        JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', main: 'index.js' }),
        'utf8',
      );
      await writeFile(join(replacementRoot, 'index.js'), "export const greet = (): string => 'replacement';\n", 'utf8');
      const provider = createProvider({ packageRoots: { demo: linkedPackageRoot } });
      const program = {
        'entry.ts': ["import { greet } from 'demo';", 'export const handler = (): string => greet();'].join('\n'),
      };

      const first = assertContractOutcome(
        await provider.execute(createRequest(program), createContext(TEST_TIMEOUT_MS).context),
      );
      expect(first).toEqual({ status: 'completed', value: 'hello undefined' });

      try {
        await rm(linkedPackageRoot, { recursive: true, force: true });
        await symlink(replacementRoot, linkedPackageRoot, 'junction');
        const second = assertContractOutcome(
          await provider.execute(createRequest(program), createContext(TEST_TIMEOUT_MS).context),
        );
        expect(second).toEqual({ status: 'completed', value: 'hello undefined' });
      } finally {
        await rm(linkedPackageRoot, { recursive: true, force: true });
        await symlink(packageRoot, linkedPackageRoot, 'junction');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retries configuration resolution after a missing package root becomes available',
    async () => {
      const delayedPackageRoot = join(scratch.root, 'packages', 'late-demo');
      const provider = createProvider({ packageRoots: { late: delayedPackageRoot } });
      const program = {
        'entry.ts': ["import { answer } from 'late';", 'export const handler = (): number => answer;'].join('\n'),
      };

      const unavailable = assertContractOutcome(
        await provider.execute(createRequest(program), createContext(TEST_TIMEOUT_MS).context),
      );
      expect(unavailable).toMatchObject({ status: 'failed', error: { code: 'provider_failed' } });

      await mkdir(delayedPackageRoot, { recursive: true });
      await writeFile(
        join(delayedPackageRoot, 'package.json'),
        JSON.stringify({ name: 'late', version: '1.0.0', type: 'module', main: 'index.js' }),
        'utf8',
      );
      await writeFile(join(delayedPackageRoot, 'index.js'), 'export const answer = 42;\n', 'utf8');

      const recovered = assertContractOutcome(
        await provider.execute(createRequest(program), createContext(TEST_TIMEOUT_MS).context),
      );
      expect(recovered).toEqual({ status: 'completed', value: 42 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retires a worker after the configured number of invocations',
    async () => {
      // Every invocation permanently adds a module graph to its worker's module
      // map, so a worker that is never idle must still be replaced. The reported
      // thread id is the evidence: two invocations share a thread, and the third
      // — the first past the bound — reports a different one. All three complete,
      // which is what rules out "retirement broke the pool" as the explanation.
      const provider = createProvider({ maxConcurrency: 1, maxInvocationsPerWorker: 2 });
      const runOnThread = async (): Promise<number> => {
        const outcome = assertContractOutcome(
          await provider.execute(createRequest(THREAD_ID_PROGRAM), createContext(TEST_TIMEOUT_MS).context),
        );
        expect(outcome.status).toBe('completed');
        if (outcome.status !== 'completed') throw new Error('unreachable');
        expect(typeof outcome.value).toBe('number');
        return outcome.value as number;
      };

      const [first, second, third] = [await runOnThread(), await runOnThread(), await runOnThread()];

      expect(second).toBe(first);
      expect(third).not.toBe(first);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an over-budget program or argument without waiting for an admission slot',
    async () => {
      // The gate holds a single slot and the first program never returns, so an
      // invocation that waited for admission would not settle until the case
      // timed out. All three budget checks are pure and decide the outcome on
      // their own, so all three must run before the wait — and all three are
      // exercised against the one occupied gate, because the position in the
      // sequence is the property under test, not the budget arithmetic.
      //
      // `maxArgumentBytes` leaves room for the blocking invocation's own
      // argument, which carries an absolute scratch path, so the only
      // rejections here are the ones the case is about.
      const provider = createProvider({
        maxConcurrency: 1,
        maxProgramFiles: 1,
        maxArgumentBytes: 1_024,
      });
      const startedPath = scratch.path('started');
      const { context: blockingContext, controller } = createContext(TEST_TIMEOUT_MS);
      const blocked = provider.execute(createRequest(NEVER_RETURNING_PROGRAM, { startedPath }), blockingContext);
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

      const overBudgetProgram = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): number => 1;', 'extra.ts': '' }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      // Nothing but this budget measures the argument, and a queued invocation
      // would hold it from admission all the way to the worker.
      const overBudgetArgument = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': 'export const handler = (): number => 1;' }, 'x'.repeat(4_096)),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      // The export name is the other request field nothing else measures, and
      // the one the provider *copies*: it is retained from admission until
      // dispatch and then structured-cloned into the worker task. The contract
      // bounds it, so this is what a direct caller who never parsed the contract
      // is held to instead.
      const overBudgetExportName = assertContractOutcome(
        await provider.execute(
          createRequest(
            { 'entry.ts': 'export const handler = (): number => 1;' },
            null,
            'x'.repeat(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH + 1),
          ),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );

      expect(overBudgetProgram).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
      expect(overBudgetArgument).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
      expect(overBudgetExportName).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
      controller.abort();
      await blocked;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports its outcome without waiting for the program root to be removed',
    async () => {
      // A caller races this promise against its deadline — that is what the
      // routing service does — so an outcome that is only reported once the
      // temporary root is gone makes a finished execution's fate depend on
      // filesystem latency, and a slow removal turns it into `timed_out`.
      //
      // Cancelling an invocation that has already built its root is the
      // cheapest witness of that ordering: every terminal path leaves through
      // the one `finally` that hands the root over, and this one gets there
      // without spawning a worker.
      const provider = createProvider();
      const { context, controller } = createContext(TEST_TIMEOUT_MS);

      const pending = provider.execute(createRequest(BULKY_PROGRAM), context);
      await waitUntil(
        async () => (await scratch.listProgramRoots()).length === 1,
        PROGRAM_START_TIMEOUT_MS,
        'the invocation to create its program root',
      );
      controller.abort('cancellation');
      const outcome = assertContractOutcome(await pending);

      // Which terminal path it took is deliberately not pinned: the abort races
      // the rest of materialization, and the release this case is about is the
      // same either way. The cases above own the classification.
      expect(['cancelled', 'completed']).toContain(outcome.status);
      // The discriminator: removal has to unlink every module in a set this
      // size before the root directory itself can go, which takes orders of
      // magnitude longer than the synchronous read below. A root present here
      // therefore proves the outcome did not wait for it — had cleanup been
      // awaited before settling, the root would already be gone.
      expect(listProgramRootsNow()).toHaveLength(1);

      // And the release is owned, not merely started: the barrier waits for it,
      // even though no pool was ever created for this invocation.
      await provider.dispose();
      expect(listProgramRootsNow()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(INVALID_OPTIONS)('rejects an unusable %s at composition time', (label, options) => {
    expect(() => new PiscinaCodeExecutionProvider(options)).toThrow(new RegExp(`Option "${label}"`));
  });

  it.each(
    INVALID_PACKAGE_ROOTS,
  )('rejects a package map with %s at composition time', (_case, packageRoots, message) => {
    expect(() => new PiscinaCodeExecutionProvider({ packageRoots })).toThrow(message);
  });

  it(
    'refuses an invocation that arrives at a full queue and still serves the queued one',
    async () => {
      const provider = createProvider({ maxConcurrency: 1, maxQueuedInvocations: 1 });
      const startedPath = scratch.path('started');
      const occupying = createContext(TEST_TIMEOUT_MS);

      const occupier = provider.execute(createRequest(NEVER_RETURNING_PROGRAM, { startedPath }), occupying.context);
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

      // Fills the single queue position. Nothing can admit it until the
      // occupier lets go, so it must still be pending below. Its argument is
      // what the worker echoes back, so the value it completes with is what
      // names *which* invocation the released slot went on to serve.
      const queued = provider.execute(
        createRequest({ 'entry.ts': "export const handler = (): string => 'queued';" }),
        createContext(TEST_TIMEOUT_MS).context,
      );
      let queuedSettled = false;
      void queued.then(() => {
        queuedSettled = true;
      });

      // The discriminator: this arrives at a full queue and comes back with an
      // outcome while the queued one is still waiting. An unbounded queue would
      // have parked it here for the rest of the occupier's life.
      const refused = assertContractOutcome(
        await provider.execute(
          createRequest({ 'entry.ts': "export const handler = (): string => 'refused';" }),
          createContext(TEST_TIMEOUT_MS).context,
        ),
      );
      expect(refused).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });
      expect(queuedSettled).toBe(false);
      // A refused invocation never materialized anything, so the only root in
      // existence is still the occupier's.
      expect(listProgramRootsNow()).toHaveLength(1);

      occupying.controller.abort('cancellation');
      expect(assertContractOutcome(await occupier)).toMatchObject({ status: 'cancelled' });

      // And the refusals leaked no slot: the invocation that did hold a queue
      // position runs to completion once the occupier releases it.
      expect(assertContractOutcome(await queued)).toEqual({ status: 'completed', value: 'queued' });
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(CANNOT_LOCK_DIRECTORIES)(
    'retries a program root it could not remove and clears it at disposal',
    async () => {
      const provider = createProvider();
      const { locked, warn } = await retainAnUnremovableRoot(provider);

      try {
        // Every attempt this invocation owned has now been made and lost, and a
        // single invocation leaves nothing "earlier" for the opportunistic
        // retry to pick up — so from here the disposal barrier is the only
        // thing that can still remove this directory.
        expect(await scratch.listProgramRoots()).toHaveLength(1);

        await chmod(locked, 0o700);
        await provider.dispose();

        // The discriminator: a failure that was merely logged and forgotten
        // would leave the root here forever.
        expect(await scratch.listProgramRoots()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(CANNOT_LOCK_DIRECTORIES)(
    'resolves disposal and reports the residual when a retained root is still unremovable',
    async () => {
      const provider = createProvider();
      const { locked, warn } = await retainAnUnremovableRoot(provider);

      try {
        // Disposal must resolve rather than wait on a filesystem that is never
        // going to cooperate — and must say so rather than resolve silently.
        await provider.dispose();

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('still on disk after disposal'),
          expect.stringContaining(TEMP_DIRECTORY_PREFIX),
        );
        expect(await scratch.listProgramRoots()).toHaveLength(1);
      } finally {
        warn.mockRestore();
        // Restores the empty-temporary-base precondition the shared `afterEach`
        // asserts; this residual is the case's own doing.
        await chmod(locked, 0o700);
        for (const root of await scratch.listProgramRoots()) {
          await rm(join(scratch.temporaryBase, root), { recursive: true, force: true });
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
