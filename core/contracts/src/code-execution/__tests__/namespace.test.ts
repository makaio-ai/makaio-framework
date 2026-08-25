import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MakaioBusLike } from '@makaio/core';
import { FrameworkContractNamespaces } from '../../namespace-catalog.js';
import {
  CODE_EXECUTION_CAPABILITY_ID,
  CODE_EXECUTION_FAILED_OUTCOME_CODES,
  CODE_EXECUTION_FAILURE_CODES,
  CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH,
  CODE_EXECUTION_IDENTIFIER_MAX_LENGTH,
  CODE_EXECUTION_OUTCOME_STATUSES,
  CODE_EXECUTION_TRUST_LEVELS,
  CodeExecutionFailureCodeSchema,
  CodeExecutionOutcomeSchema,
  CodeExecutionProgramSchema,
  CodeExecutionRequestSchema,
  CodeExecutionRequirementsSchema,
  CodeExecutionSchemas,
  CodeExecutionSubjects,
  CodeExecutionVirtualPathSchema,
  codeExecutionAbortOutcomeForReason,
  registerCodeExecutionProvider,
  unregisterCodeExecutionProvider,
  VIRTUAL_PATH_MAX_BYTES,
  VIRTUAL_PATH_SEGMENT_MAX_BYTES,
} from '../index.js';
import type {
  CodeExecutionAbortReason,
  CodeExecutionFailedOutcomeCode,
  CodeExecutionFailureCode,
  CodeExecutionOutcome,
  CodeExecutionProviderContext,
  CodeExecutionRequest,
  ICodeExecutionProvider,
} from '../index.js';

/**
 * Encode a path the way every layer between the contract and the disk does.
 *
 * `TextEncoder` rather than `Buffer`: these contracts are runtime-neutral, and
 * the schema under test measures the same way.
 * @param value - Virtual path or path segment to encode.
 * @returns UTF-8 bytes of the value.
 */
const utf8Bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Measure a path the way a filesystem does, so byte bounds are asserted in bytes.
 * @param value - Virtual path or path segment to measure.
 * @returns UTF-8 byte length of the value.
 */
const utf8ByteLength = (value: string): number => utf8Bytes(value).byteLength;

/** Two virtual paths differing only in which unpaired surrogate they carry. */
const LONE_SURROGATE_PATHS = ['\uD800.ts', '\uD801.ts'] as const;

/**
 * Superscript one, two, and three: Windows device-number suffixes.
 *
 * Spelled as escapes for the same reason the schema spells them that way — in
 * source they are hard to tell from the ASCII digits, and a tool or an editor
 * that "corrected" them would silently turn these cases into duplicates of the
 * ASCII ones and stop testing anything.
 */
const SUPERSCRIPT_DIGITS = ['\u00B9', '\u00B2', '\u00B3'] as const;

/** Minimal valid program fixture reused across request assertions. */
const PROGRAM = {
  files: { 'src/entry.ts': 'export const run = (input: unknown) => input;' },
  entryFile: 'src/entry.ts',
  exportName: 'run',
};

/**
 * Labelled matrix of every invalid virtual-path shape, exercised both in the
 * `entryFile` position and in the `files` record-key position.
 *
 * The Windows-portability entries are here for the same reason as the rest: a
 * submitted program is host-independent input, so a path no supported host can
 * write must be rejected by the contract rather than degrade into a provider
 * write failure on whichever host happens to run it.
 */
const INVALID_VIRTUAL_PATHS: readonly [label: string, path: string][] = [
  ['absolute path', '/abs/entry.ts'],
  ['drive-letter path', 'C:/entry.ts'],
  ['traversal segment', 'src/../entry.ts'],
  ['non-normalized dot segment', './entry.ts'],
  ['non-normalized empty segment', 'src//entry.ts'],
  ['trailing separator', 'src/entry.ts/'],
  ['backslash separator', 'src\\entry.ts'],
  ['NUL byte', 'src/entry\0.ts'],
  ['empty path', ''],
  ['colon inside a segment', 'src/a:b.ts'],
  ['angle brackets inside a segment', 'src/<entry>.ts'],
  ['double quote inside a segment', 'src/a"b.ts'],
  ['pipe inside a segment', 'src/a|b.ts'],
  ['question mark inside a segment', 'src/a?b.ts'],
  ['asterisk inside a segment', 'src/a*b.ts'],
  ['control character inside a segment', 'src/a\u0001b.ts'],
  ['segment ending in a dot', 'src/entry.ts.'],
  ['directory segment ending in a dot', 'src./entry.ts'],
  ['segment ending in a space', 'src/entry.ts '],
  ['directory segment ending in a space', 'src /entry.ts'],
  ['reserved device name with an extension', 'CON.ts'],
  ['reserved device name without an extension', 'src/NUL'],
  ['reserved device name in lower case', 'src/aux.ts'],
  ['numbered reserved device name', 'src/COM1.ts'],
  ['reserved device name as a directory segment', 'lpt9/entry.ts'],
  ['zero-numbered reserved device name', 'src/COM0.ts'],
  ['zero-numbered reserved device as a directory segment', 'lpt0/entry.ts'],
  // Windows numbers its devices with superscripts as well as ASCII digits, so
  // these name exactly the devices the ASCII cases above do. A rule covering
  // only `1`-`9` accepts them here and then loses the write on the one platform
  // the whole device rule exists for.
  ['superscript-numbered reserved device name', `COM${SUPERSCRIPT_DIGITS[0]}.ts`],
  ['superscript-numbered reserved device name in lower case', `src/lpt${SUPERSCRIPT_DIGITS[1]}.js`],
  ['superscript-numbered reserved device name as a directory segment', `COM${SUPERSCRIPT_DIGITS[2]}/entry.ts`],
  ['superscript-numbered reserved device name without an extension', `src/LPT${SUPERSCRIPT_DIGITS[0]}`],
  // Length-limit portability: a 256-byte ASCII segment exceeds every
  // filesystem's 255-byte name-component limit.
  ['over-long segment (256 ASCII bytes)', 'x'.repeat(256)],
  // A deep path whose total byte count exceeds VIRTUAL_PATH_MAX_BYTES even
  // though every individual segment is well under 255 bytes.
  ['over-long total path', 'abc/'.repeat(256) + 'x.ts'],
  // Unpaired surrogates: distinct strings with no distinct UTF-8 encoding, so
  // both positions must refuse them before they reach anything that encodes.
  ['lone high surrogate', LONE_SURROGATE_PATHS[0]],
  ['second lone high surrogate', LONE_SURROGATE_PATHS[1]],
  ['lone low surrogate', 'src/\uDC00.ts'],
  ['unpaired surrogate inside an otherwise valid name', 'src/entry\uD83D.ts'],
];

/** Minimal valid request fixture reused across request assertions. */
const REQUEST = {
  invocationId: 'inv-1',
  program: PROGRAM,
  arguments: { input: [1, 'two', null] },
  timeoutMs: 5_000,
};

/**
 * Give a container a `__proto__` own key the way only code can.
 *
 * `JSON.parse` produces the key on objects, which is how a request off the wire
 * carries it, but never on an array — an array's JSON text has no place to spell
 * a named key, so `Object.defineProperty` is the only route onto one. Both
 * containers lose the key identically when the schema rebuilds them, which is
 * why the array case is worth pinning alongside the wire cases.
 * @param container - Object or array to give the key to.
 * @param value - Value stored under the key.
 * @returns The same container, now carrying a `__proto__` own key.
 */
function withPrototypeOwnKey<TContainer extends object>(container: TContainer, value: unknown): TContainer {
  Object.defineProperty(container, '__proto__', { value, enumerable: true, configurable: true, writable: true });
  return container;
}

describe('CodeExecution namespace', () => {
  it('registers the execute subject under the code-execution namespace', () => {
    expect(CodeExecutionSubjects.execute.$meta.namespace).toBe('code-execution');
    expect(CodeExecutionSubjects.execute.subject).toBe('execute');
  });

  it('is a member of FrameworkContractNamespaces', () => {
    const names = FrameworkContractNamespaces.map((ns) => ns.name);
    expect(names).toContain('code-execution');
  });

  it('uses the stable code-execution capability id', () => {
    expect(CODE_EXECUTION_CAPABILITY_ID).toBe('code-execution');
  });
});

describe('CodeExecution program contract', () => {
  it('accepts a single-file program', () => {
    expect(CodeExecutionProgramSchema.safeParse(PROGRAM).success).toBe(true);
  });

  it('accepts a multi-file program graph across every supported source extension', () => {
    const program = {
      files: {
        'entry.ts': "export { run } from './lib/handler.mts';",
        'lib/handler.mts': "import helper from './helper.mjs'; export const run = helper;",
        'lib/helper.mjs': "export default await import('./legacy.js');",
        'lib/legacy.js': 'export const legacy = true;',
        'data/.fixtures.ts': 'export const fixtures = [];',
      },
      entryFile: 'entry.ts',
      exportName: 'run',
    };
    expect(CodeExecutionProgramSchema.safeParse(program).success).toBe(true);
  });

  it('rejects a source with an unpaired surrogate instead of silently replacing it during UTF-8 encoding', () => {
    const program = {
      files: { 'entry.ts': 'export const run = "\uD800";' },
      entryFile: 'entry.ts',
      exportName: 'run',
    };

    const parsed = CodeExecutionProgramSchema.safeParse(program);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ['files', 'entry.ts'],
      message: 'program source must be well-formed Unicode (no unpaired surrogates)',
    });
  });

  it.each(INVALID_VIRTUAL_PATHS)('rejects a program whose entryFile is invalid: %s', (_label, entryFile) => {
    const program = { files: { 'src/valid.ts': 'export const run = 1;' }, entryFile, exportName: 'run' };
    expect(CodeExecutionVirtualPathSchema.safeParse(entryFile).success).toBe(false);
    expect(CodeExecutionProgramSchema.safeParse(program).success).toBe(false);
  });

  it.each(INVALID_VIRTUAL_PATHS)('rejects a program whose files key is invalid: %s', (_label, path) => {
    const program = {
      files: { 'entry.ts': 'export const run = 1;', [path]: 'export const nope = 1;' },
      entryFile: 'entry.ts',
      exportName: 'run',
    };
    const parsed = CodeExecutionProgramSchema.safeParse(program);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['files', path]);
  });

  // The device-name and trailing-character rules are narrow by design: they may
  // not spill onto ordinary module names that merely start the same way.
  it('accepts names that only resemble a reserved or trimmed segment', () => {
    const program = {
      files: {
        'entry.ts': "export { run } from './lib/console.ts';",
        'lib/console.ts': 'export const run = 1;',
        'comX.ts': 'export const notNumberedAtAll = 1;',
        'lpt.ts': 'export const alsoNotADevice = 1;',
        'nuller/aux-helpers.ts': 'export const helpers = [];',
        '.prn.ts': 'export const leadingDot = 1;',
        // A superscript that is not a device suffix: the rule matches one digit
        // followed by a dot or the end of the segment, so widening it to accept
        // superscripts must not start swallowing names that merely contain one.
        [`com${SUPERSCRIPT_DIGITS[0]}${SUPERSCRIPT_DIGITS[1]}.ts`]: 'export const twoSuperscripts = 1;',
        [`super${SUPERSCRIPT_DIGITS[2]}.ts`]: 'export const notADeviceEither = 1;',
      },
      entryFile: 'entry.ts',
      exportName: 'run',
    };
    expect(CodeExecutionProgramSchema.safeParse(program).success).toBe(true);
  });

  // 'ä' (U+00E4) encodes to 2 UTF-8 bytes. The schema must measure bytes, not
  // character count, for the segment limit to be meaningful across platforms.
  it('enforces the segment byte limit at the UTF-8 character boundary, not the char count', () => {
    // 127 × 'ä' = 127 characters but 254 bytes: under the limit.
    expect(CodeExecutionVirtualPathSchema.safeParse('ä'.repeat(127)).success).toBe(true);
    // 128 × 'ä' = 128 characters but 256 bytes: over the limit even though
    // the character count is well under 255 — this is the discriminating case.
    expect(CodeExecutionVirtualPathSchema.safeParse('ä'.repeat(128)).success).toBe(false);
    // 255 ASCII characters = 255 bytes: exactly at the limit, must pass.
    expect(CodeExecutionVirtualPathSchema.safeParse('a'.repeat(VIRTUAL_PATH_SEGMENT_MAX_BYTES)).success).toBe(true);
  });

  it('accepts a total path of exactly VIRTUAL_PATH_MAX_BYTES', () => {
    // 'abc/' × 255 (1020 bytes) + 'x.ts' (4 bytes) = 1024 bytes exactly.
    const path = 'abc/'.repeat(255) + 'x.ts';
    expect(utf8ByteLength(path)).toBe(VIRTUAL_PATH_MAX_BYTES);
    expect(CodeExecutionVirtualPathSchema.safeParse(path).success).toBe(true);
  });

  // The total-path bound is measured in the unit the filesystem measures, for
  // the same reason the segment bound is: a path can sit far inside the limit
  // when counted as UTF-16 code units and still be unwritable as bytes. Each
  // segment here is 254 bytes, so the segment rule cannot account for the
  // rejection — only the total-path rule can.
  it('enforces the total-path budget in UTF-8 bytes, not code units', () => {
    const segment = 'ä'.repeat(127); // 127 code units, 254 UTF-8 bytes.
    const withinBudget = new Array<string>(4).fill(segment).join('/');
    expect(utf8ByteLength(withinBudget)).toBeLessThanOrEqual(VIRTUAL_PATH_MAX_BYTES);
    expect(CodeExecutionVirtualPathSchema.safeParse(withinBudget).success).toBe(true);

    // 5 × 254 bytes + 4 separators = 1274 bytes, but only 639 code units — well
    // under 1024 by the measure a code-unit bound would have used.
    const overBudget = new Array<string>(5).fill(segment).join('/');
    expect(overBudget.length).toBeLessThan(VIRTUAL_PATH_MAX_BYTES);
    expect(utf8ByteLength(overBudget)).toBeGreaterThan(VIRTUAL_PATH_MAX_BYTES);
    expect(CodeExecutionVirtualPathSchema.safeParse(overBudget).success).toBe(false);
  });

  // The rule that has nothing to do with length or with what a host refuses:
  // an unpaired surrogate has no UTF-8 encoding, so every encoder between a
  // program and the disk substitutes U+FFFD for it. Two such paths stay two
  // record keys and become one filename, and because program files are written
  // concurrently the merge does not even fail — the later write silently wins.
  it('rejects lone-surrogate paths, which are distinct strings with one UTF-8 encoding', () => {
    const [first, second] = LONE_SURROGATE_PATHS;
    // The discriminating half: nothing about these paths is over budget or
    // unrepresentable in isolation, and they are distinct as strings — it is
    // only the encoding they share that makes the pair unmaterializable.
    expect(first).not.toBe(second);
    expect(utf8Bytes(first)).toEqual(utf8Bytes(second));
    expect(utf8ByteLength(first)).toBeLessThan(VIRTUAL_PATH_SEGMENT_MAX_BYTES);

    for (const path of LONE_SURROGATE_PATHS) {
      expect(CodeExecutionVirtualPathSchema.safeParse(path).success).toBe(false);
    }

    // Both together are what a caller would submit to provoke the collision.
    // Built from entries rather than as a literal on purpose: TypeScript folds
    // the two spellings into one property *name* and reports a duplicate key, so
    // the merge this rule exists to prevent is not even unique to filesystems.
    const files = Object.fromEntries(LONE_SURROGATE_PATHS.map((path, index) => [path, `export const run = ${index};`]));
    // Guards the fixture itself: one surviving key would test nothing.
    expect(Object.keys(files)).toHaveLength(2);

    const program = { files, entryFile: first, exportName: 'run' };
    expect(CodeExecutionProgramSchema.safeParse(program).success).toBe(false);
  });

  // The other side of the same rule: a *paired* surrogate is ordinary text, and
  // rejecting it would put every astral character out of reach of a portable
  // program for no reason a filesystem would recognize.
  it('accepts multibyte paths whose surrogates are properly paired', () => {
    const astral = 'src/\u{1F600}-\u{1D11E}.ts';
    expect(astral.isWellFormed()).toBe(true);
    expect(utf8ByteLength(astral)).toBeGreaterThan(astral.length);
    expect(CodeExecutionVirtualPathSchema.safeParse(astral).success).toBe(true);

    const program = { files: { [astral]: 'export const run = 1;' }, entryFile: astral, exportName: 'run' };
    expect(CodeExecutionProgramSchema.safeParse(program).success).toBe(true);
  });

  it('reports representative virtual-path rejections with the violated rule', () => {
    const traversal = CodeExecutionVirtualPathSchema.safeParse('src/../entry.ts');
    expect(traversal.error?.issues[0]?.message).toBe(
      'virtual path must be normalized (no empty, ".", or ".." segments)',
    );
    const absolute = CodeExecutionVirtualPathSchema.safeParse('/abs/entry.ts');
    expect(absolute.error?.issues[0]?.message).toBe('virtual path must be relative (no leading / or drive letter)');
    const colon = CodeExecutionVirtualPathSchema.safeParse('src/a:b.ts');
    expect(colon.error?.issues[0]?.message).toBe('virtual path must not contain < > : " | ? * or control characters');
    const trailingDot = CodeExecutionVirtualPathSchema.safeParse('src/entry.ts.');
    expect(trailingDot.error?.issues[0]?.message).toBe('virtual path segments must not end with "." or a space');
    const device = CodeExecutionVirtualPathSchema.safeParse('CON.ts');
    expect(device.error?.issues[0]?.message).toBe(
      `virtual path must not use a reserved device name (CON, PRN, AUX, NUL, COM0-COM9, LPT0-LPT9, ` +
        `COM${SUPERSCRIPT_DIGITS[0]}-COM${SUPERSCRIPT_DIGITS[2]}, ` +
        `LPT${SUPERSCRIPT_DIGITS[0]}-LPT${SUPERSCRIPT_DIGITS[2]})`,
    );
    const loneSurrogate = CodeExecutionVirtualPathSchema.safeParse(LONE_SURROGATE_PATHS[0]);
    expect(loneSurrogate.error?.issues[0]?.message).toBe(
      'virtual path must be well-formed Unicode (no unpaired surrogates)',
    );
  });

  it('rejects a program whose files carry a __proto__ own key instead of dropping it', () => {
    const files = withPrototypeOwnKey<Record<string, string>>(
      { 'entry.ts': 'export const run = 1;' },
      'export const polluted = 1;',
    );
    expect(Object.hasOwn(files, '__proto__')).toBe(true);
    const parsed = CodeExecutionProgramSchema.safeParse({ files, entryFile: 'entry.ts', exportName: 'run' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['files', '__proto__']);
    // Sanity: the guard does not disturb programs without a __proto__ own key.
    expect(CodeExecutionProgramSchema.safeParse(PROGRAM).success).toBe(true);
  });

  it('still requires the files key, which the prototype-key guard must not make optional', () => {
    // `files` is wrapped in a `z.preprocess` step, which widens its declared
    // input type to `unknown`. That widening must not reach requiredness: an
    // omitted key has to fail with the record schema's own issue, at its own
    // path, exactly as it would without the wrapper.
    const parsed = CodeExecutionProgramSchema.safeParse({ entryFile: 'entry.ts', exportName: 'run' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0]).toMatchObject({ code: 'invalid_type', path: ['files'] });
  });

  it('rejects a program whose entryFile is not one of the files', () => {
    const program = {
      files: { 'src/other.ts': 'export const run = 1;' },
      entryFile: 'src/entry.ts',
      exportName: 'run',
    };
    const parsed = CodeExecutionProgramSchema.safeParse(program);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['entryFile']);
    expect(parsed.error?.issues[0]?.message).toBe('entryFile must name one of the program files');
  });

  it('rejects a program with an empty export name', () => {
    expect(CodeExecutionProgramSchema.safeParse({ ...PROGRAM, exportName: '' }).success).toBe(false);
  });

  // The export name is the program field no provider budget measures: sources
  // are bounded by aggregate size and arguments by their serialization, while
  // this one is retained for as long as the request is and copied again into
  // whatever the provider hands its execution host. The bound is the contract's
  // because that is where the field is defined.
  it('bounds the export name at the identifier limit, and accepts a name exactly at it', () => {
    const atLimit = 'x'.repeat(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH);

    expect(CodeExecutionProgramSchema.safeParse({ ...PROGRAM, exportName: atLimit }).success).toBe(true);
    expect(CodeExecutionProgramSchema.safeParse({ ...PROGRAM, exportName: `${atLimit}x` }).success).toBe(false);
  });

  it('rejects a program with unknown keys', () => {
    expect(CodeExecutionProgramSchema.safeParse({ ...PROGRAM, cwd: '/tmp' }).success).toBe(false);
  });
});

describe('CodeExecution request contract', () => {
  it('accepts a request without requirements', () => {
    expect(CodeExecutionRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it('accepts a request with exact-match requirements', () => {
    const request = {
      ...REQUEST,
      requirements: {
        providerId: 'makaio.runtime-node.piscina-code-execution',
        runtime: 'node',
        language: 'typescript',
        moduleFormat: 'esm',
        trust: 'trusted-code-only',
      },
    };
    expect(CodeExecutionRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejects requirements with unknown keys or unknown trust values', () => {
    expect(CodeExecutionRequirementsSchema.safeParse({ sandbox: true }).success).toBe(false);
    expect(CodeExecutionRequirementsSchema.safeParse({ trust: 'untrusted' }).success).toBe(false);
  });

  it('rejects non-JSON argument values', () => {
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: { fn: () => 1 } }).success).toBe(false);
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: [undefined] }).success).toBe(false);
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });

  it.each<[string, unknown, readonly (string | number)[]]>([
    ['at the root', -0, ['arguments']],
    ['nested in an object', { value: -0 }, ['arguments', 'value']],
  ])('rejects arguments carrying negative zero %s', (_case, argumentsValue, issuePath) => {
    const parsed = CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: argumentsValue });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  // Zod drops a `__proto__` own key while parsing a record, so without a guard
  // the handler would be invoked with arguments the caller never sent — and the
  // caller would never learn of the difference. `JSON.parse` is how that key
  // arrives in practice: it is exactly what a request off the wire carries.
  it.each<[string, string, readonly (string | number)[]]>([
    ['at the top level', '{"__proto__":{"polluted":true}}', ['arguments', '__proto__']],
    ['nested in an object', '{"outer":{"__proto__":{"polluted":true}}}', ['arguments', 'outer', '__proto__']],
    [
      'nested in an object inside an array',
      '{"items":[{"__proto__":{"polluted":true}}]}',
      ['arguments', 'items', 0, '__proto__'],
    ],
  ])('rejects arguments carrying a __proto__ own key %s', (_case, wire, issuePath) => {
    const args: unknown = JSON.parse(wire);

    const parsed = CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: args });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  // An array never picks the key up from wire text, so these cases build it the
  // only way it can exist there. `z.array()` rebuilds the array from its
  // elements and drops the key exactly as `z.record()` drops it from an object,
  // so the caller would again be handed a value it never sent.
  it.each<[string, unknown, readonly (string | number)[]]>([
    ['is the argument itself', withPrototypeOwnKey(['kept'], { polluted: true }), ['arguments', '__proto__']],
    [
      'is nested under an object key',
      { items: withPrototypeOwnKey(['kept'], { polluted: true }) },
      ['arguments', 'items', '__proto__'],
    ],
  ])('rejects arguments carrying a __proto__ own key on an array that %s', (_case, args, issuePath) => {
    const parsed = CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: args });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  // A request delivered over the bus is deserialized JSON and therefore always
  // plain; a caller handing this subject a live object in-process is not. Such a
  // value is rebuilt from its own enumerable fields, so the handler would be
  // invoked with something other than what the caller passed — a `Date` whose
  // JSON form is a string arriving as `{}`.
  it.each<[string, unknown, readonly (string | number)[]]>([
    ['a Date', new Date(0), ['arguments']],
    ['a Map', new Map([['a', 1]]), ['arguments']],
    ['a class instance nested under an object key', { at: new Date(0) }, ['arguments', 'at']],
    ['a class instance nested in an array', [new Map()], ['arguments', 0]],
  ])('rejects arguments carrying %s', (_case, args, issuePath) => {
    const parsed = CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: args });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  it('still requires the arguments key, which the fidelity guard must not make optional', () => {
    const parsed = CodeExecutionRequestSchema.safeParse({
      invocationId: REQUEST.invocationId,
      program: PROGRAM,
      timeoutMs: REQUEST.timeoutMs,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0]?.path).toEqual(['arguments']);
  });

  it('reports a prototype-key rejection as exactly one issue, never combined with the inner schema', () => {
    // The guard runs as a preprocess step, and `z.preprocess` is a pipe whose
    // second stage never runs once the first reported an issue. The control is
    // what makes that visible: the same value without the key does fail the
    // inner schema, so the single issue below is the abort, not a value the
    // inner schema would have accepted anyway.
    const notJson = { render: () => 1 };
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: notJson }).success).toBe(false);

    const parsed = CodeExecutionRequestSchema.safeParse({
      ...REQUEST,
      arguments: withPrototypeOwnKey({ ...notJson }, { polluted: true }),
    });

    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0]).toMatchObject({ code: 'custom', path: ['arguments', '__proto__'] });
  });

  it('accepts deeply nested arguments that carry no __proto__ own key', () => {
    const args: unknown = JSON.parse('{"a":{"b":[1,"two",null,{"c":{"d":[]}}]},"e":false}');

    const parsed = CodeExecutionRequestSchema.safeParse({ ...REQUEST, arguments: args });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.arguments).toEqual(args);
  });

  it('rejects a non-positive or fractional timeout', () => {
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, timeoutMs: 0 }).success).toBe(false);
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, timeoutMs: -1 }).success).toBe(false);
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, timeoutMs: 10.5 }).success).toBe(false);
  });

  it('rejects an empty invocation id and unknown request keys', () => {
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, invocationId: '' }).success).toBe(false);
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, provider: {} }).success).toBe(false);
  });

  // Every free string a request carries that names something rather than
  // carrying payload is bounded, and bounded by the same figure. Each is
  // retained for the whole life of the request while no other budget measures
  // any of them — a selection pin longer than any value it could match narrows
  // nothing and only enlarges what a queued invocation holds.
  it('bounds the invocation id and every selection pin at the identifier limit', () => {
    const atLimit = 'x'.repeat(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH);
    const overLimit = `${atLimit}x`;

    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, invocationId: atLimit }).success).toBe(true);
    expect(CodeExecutionRequestSchema.safeParse({ ...REQUEST, invocationId: overLimit }).success).toBe(false);

    for (const pin of ['providerId', 'runtime', 'language', 'moduleFormat'] as const) {
      expect(CodeExecutionRequirementsSchema.safeParse({ [pin]: atLimit }).success).toBe(true);
      expect(CodeExecutionRequirementsSchema.safeParse({ [pin]: overLimit }).success).toBe(false);
    }
  });
});

describe('CodeExecution outcome contract', () => {
  const failure = { code: 'handler_failed', message: 'The invoked export rejected.' };

  it('accepts every terminal outcome variant', () => {
    expect(CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value: { ok: true } }).success).toBe(true);
    expect(CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value: null }).success).toBe(true);
    expect(CodeExecutionOutcomeSchema.safeParse({ status: 'failed', error: failure }).success).toBe(true);
    expect(
      CodeExecutionOutcomeSchema.safeParse({
        status: 'timed_out',
        error: { code: 'execution_timeout', message: 'Execution exceeded 5000ms.' },
      }).success,
    ).toBe(true);
    expect(
      CodeExecutionOutcomeSchema.safeParse({
        status: 'cancelled',
        error: { code: 'cancelled', message: 'Invocation cancelled by caller.' },
      }).success,
    ).toBe(true);
  });

  it('accepts every stable failure code on its owning outcome variant', () => {
    for (const code of CODE_EXECUTION_FAILURE_CODES) {
      expect(CodeExecutionFailureCodeSchema.safeParse(code).success).toBe(true);
    }
    for (const code of CODE_EXECUTION_FAILED_OUTCOME_CODES) {
      expect(CodeExecutionOutcomeSchema.safeParse({ status: 'failed', error: { code, message: 'x' } }).success).toBe(
        true,
      );
    }
    // `execution_timeout` and `cancelled` are accepted on their dedicated
    // variants in the terminal-outcome test above.
  });

  it('rejects contradictory status/failure-code pairings', () => {
    expect(
      CodeExecutionOutcomeSchema.safeParse({ status: 'timed_out', error: { code: 'handler_failed', message: 'x' } })
        .success,
    ).toBe(false);
    expect(
      CodeExecutionOutcomeSchema.safeParse({ status: 'cancelled', error: { code: 'execution_timeout', message: 'x' } })
        .success,
    ).toBe(false);
    expect(
      CodeExecutionOutcomeSchema.safeParse({ status: 'failed', error: { code: 'execution_timeout', message: 'x' } })
        .success,
    ).toBe(false);
    expect(
      CodeExecutionOutcomeSchema.safeParse({ status: 'failed', error: { code: 'cancelled', message: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(CodeExecutionOutcomeSchema.safeParse({ status: 'running', value: null }).success).toBe(false);
  });

  it('rejects an unknown failure code', () => {
    expect(
      CodeExecutionOutcomeSchema.safeParse({ status: 'failed', error: { code: 'oom_killed', message: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects a completed outcome with a non-JSON value', () => {
    expect(CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value: () => 1 }).success).toBe(false);
  });

  it.each<[string, unknown, readonly (string | number)[]]>([
    ['at the root', -0, ['value']],
    ['nested in an array', [-0], ['value', 0]],
  ])('rejects a completed value carrying negative zero %s', (_case, value, issuePath) => {
    const parsed = CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  // The outbound half of the same guard the request applies: a provider result
  // Zod would silently strip a `__proto__` own key from is a value the caller
  // can never be handed faithfully, so it is a contract violation rather than a
  // quiet rewrite. `JSON.parse` is how such a value arrives from a provider that
  // fetched its result over a wire.
  it.each<[string, string, readonly (string | number)[]]>([
    ['at the top level', '{"__proto__":{"polluted":true}}', ['value', '__proto__']],
    ['nested in an object', '{"outer":{"__proto__":{"polluted":true}}}', ['value', 'outer', '__proto__']],
    [
      'nested in an object inside an array',
      '{"items":[{"__proto__":{"polluted":true}}]}',
      ['value', 'items', 0, '__proto__'],
    ],
  ])('rejects a completed value carrying a __proto__ own key %s', (_case, wire, issuePath) => {
    const value: unknown = JSON.parse(wire);

    const parsed = CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  it.each<[string, unknown, readonly (string | number)[]]>([
    ['is the result itself', withPrototypeOwnKey(['kept'], { polluted: true }), ['value', '__proto__']],
    [
      'is nested under an object key',
      { items: withPrototypeOwnKey(['kept'], { polluted: true }) },
      ['value', 'items', '__proto__'],
    ],
  ])('rejects a completed value carrying a __proto__ own key on an array that %s', (_case, value, issuePath) => {
    const parsed = CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  // The outbound half of the plain-object rule: a provider handing back a value
  // the schema would rebuild into something else is a contract violation, and
  // the router turns this rejection into `invalid_provider`.
  it.each<[string, unknown, readonly (string | number)[]]>([
    ['a Date', new Date(0), ['value']],
    ['a Map nested under an object key', { cache: new Map() }, ['value', 'cache']],
  ])('rejects a completed value carrying %s', (_case, value, issuePath) => {
    const parsed = CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(issuePath);
  });

  it('accepts a deeply nested completed value that carries no __proto__ own key', () => {
    const value: unknown = JSON.parse('{"a":{"b":[1,"two",null,{"c":{"d":[]}}]},"e":false}');

    const parsed = CodeExecutionOutcomeSchema.safeParse({ status: 'completed', value });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ status: 'completed', value });
  });

  it('rejects failures that smuggle extra diagnostic payloads', () => {
    expect(
      CodeExecutionOutcomeSchema.safeParse({
        status: 'failed',
        error: { ...failure, stack: 'Error: at /tmp/makaio-abc/entry.ts:1:1' },
      }).success,
    ).toBe(false);
  });

  it('rejects an unbounded failure message', () => {
    const message = 'x'.repeat(CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH + 1);
    expect(CodeExecutionOutcomeSchema.safeParse({ status: 'failed', error: { ...failure, message } }).success).toBe(
      false,
    );
  });

  it('keeps the exported status, code, and trust constants aligned with the contract types', () => {
    expectTypeOf<(typeof CODE_EXECUTION_OUTCOME_STATUSES)[number]>().toEqualTypeOf<CodeExecutionOutcome['status']>();
    expectTypeOf<(typeof CODE_EXECUTION_TRUST_LEVELS)[number]>().toEqualTypeOf<ICodeExecutionProvider['trust']>();
    expectTypeOf<CodeExecutionFailedOutcomeCode>().toEqualTypeOf<
      Exclude<CodeExecutionFailureCode, 'execution_timeout' | 'cancelled'>
    >();
  });
});

describe('CodeExecution provider interface', () => {
  /** Compile-time fixture proving the provider surface without a runtime bus. */
  const provider: ICodeExecutionProvider = {
    id: 'test.code-execution',
    displayName: 'Test CodeExecution Provider',
    priority: 0,
    runtime: 'node',
    language: 'typescript',
    moduleFormat: 'esm',
    trust: 'trusted-code-only',
    execute: async (request: CodeExecutionRequest): Promise<CodeExecutionOutcome> => ({
      status: 'completed',
      value: { echoed: request.arguments },
    }),
  };

  it('produces schema-valid outcomes from a real execute implementation', async () => {
    const request = CodeExecutionRequestSchema.parse(REQUEST);
    const context: CodeExecutionProviderContext = {
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + request.timeoutMs,
    };
    const outcome = await provider.execute(request, context);
    expect(CodeExecutionOutcomeSchema.parse(outcome)).toEqual({
      status: 'completed',
      value: { echoed: REQUEST.arguments },
    });
  });

  it('exposes the typed registration helper surface', () => {
    expectTypeOf(registerCodeExecutionProvider).parameter(0).toEqualTypeOf<MakaioBusLike>();
    expectTypeOf(registerCodeExecutionProvider).parameter(1).toEqualTypeOf<ICodeExecutionProvider>();
    expectTypeOf(registerCodeExecutionProvider).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(unregisterCodeExecutionProvider).parameter(1).toEqualTypeOf<string>();
    expectTypeOf(unregisterCodeExecutionProvider).returns.toEqualTypeOf<Promise<void>>();
  });

  it('exposes the execution method, metadata, and context contract', () => {
    expectTypeOf(provider.execute).parameters.toEqualTypeOf<[CodeExecutionRequest, CodeExecutionProviderContext]>();
    expectTypeOf(provider.execute).returns.toEqualTypeOf<Promise<CodeExecutionOutcome>>();
    expectTypeOf<CodeExecutionProviderContext['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<CodeExecutionProviderContext['deadlineEpochMs']>().toEqualTypeOf<number>();
    expectTypeOf<ICodeExecutionProvider['priority']>().toEqualTypeOf<number>();
    expect(CodeExecutionSchemas.execute.request).toBe(CodeExecutionRequestSchema);
    expect(CodeExecutionSchemas.execute.response).toBe(CodeExecutionOutcomeSchema);
  });
});

describe('CodeExecution abort outcomes', () => {
  it.each<readonly [CodeExecutionAbortReason, CodeExecutionOutcome]>([
    ['timeout', { status: 'timed_out', error: { code: 'execution_timeout', message: expect.any(String) } }],
    ['cancellation', { status: 'cancelled', error: { code: 'cancelled', message: expect.any(String) } }],
  ])('builds the canonical outcome for the owner-recorded %s reason', (reason, expected) => {
    expect(codeExecutionAbortOutcomeForReason(reason)).toEqual(expected);
  });
});
