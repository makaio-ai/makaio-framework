import { describe, expect, it } from 'vitest';
import {
  CODE_EXECUTION_IDENTIFIER_MAX_LENGTH,
  type CodeExecutionOutcome,
  type CodeExecutionRequirements,
  type ICapabilityProvider,
  type ICodeExecutionProvider,
} from '@makaio/contracts';
import { selectCodeExecutionProvider, type CodeExecutionProviderSelection } from '../provider-selection.js';

/**
 * Live registration carrying arbitrary extra fields.
 *
 * The capability registry stores whatever object an extension handed it and
 * validates nothing, so shape rejection has to be tested against registrations
 * that no compiler ever checked. This is the honest type for those.
 */
type LooseRegistration = ICapabilityProvider & Record<string, unknown>;

/**
 * Build a contract-conforming provider with overridable selection fields.
 * @param overrides - Fields that differentiate this provider from the default.
 * @returns A well-formed code-execution provider.
 */
function makeProvider(overrides: Partial<ICodeExecutionProvider> & { id: string }): ICodeExecutionProvider {
  return {
    displayName: `Provider ${overrides.id}`,
    priority: 0,
    runtime: 'node',
    language: 'typescript',
    moduleFormat: 'esm',
    trust: 'trusted-code-only',
    execute: () => Promise.resolve({ status: 'completed', value: null }),
    ...overrides,
  };
}

/** Fields a well-formed provider declares, as unvalidated registration data. */
const WELL_FORMED_FIELDS: Readonly<Record<string, unknown>> = {
  priority: 0,
  runtime: 'node',
  language: 'typescript',
  moduleFormat: 'esm',
  trust: 'trusted-code-only',
  execute: () => Promise.resolve({ status: 'completed', value: null }),
};

/**
 * Build a registration that is well formed except for the given fields.
 * @param broken - Fields to override with contract-violating values.
 * @returns A registration the selector must refuse to invoke.
 */
function makeMalformed(broken: Readonly<Record<string, unknown>>): LooseRegistration {
  return { id: 'malformed', displayName: 'Malformed', ...WELL_FORMED_FIELDS, ...broken };
}

/**
 * Build a registration whose declared field is exposed by a throwing accessor.
 *
 * A registration is an arbitrary object an extension handed the registry, so
 * "the field is of the wrong type" and "the field cannot be read at all" are
 * the same class of contract violation. The accessor is real, not stubbed.
 * @param field - Declared field to expose through a throwing getter.
 * @returns A registration whose shape check cannot complete normally.
 */
function makeThrowingRegistration(field: string): LooseRegistration {
  const registration = makeMalformed({});
  Object.defineProperty(registration, field, {
    enumerable: true,
    configurable: true,
    get: () => {
      throw new Error(`hostile accessor on '${field}'`);
    },
  });
  return registration;
}

/**
 * Build a registration whose declared field survives its first read and throws
 * on every later one.
 *
 * This is the shape a selector that re-reads live registrations cannot catch:
 * the initial snapshot succeeds, and the throw only lands once requirement
 * filtering or the priority comparator reads the field again.
 * @param field - Declared field whose second read throws.
 * @param firstValue - Value the first read answers with, so validation passes.
 * @returns A registration that is well formed exactly once.
 */
function makeSecondReadThrowingRegistration(field: string, firstValue: unknown): LooseRegistration {
  const registration = makeMalformed({ id: 'second-read' });
  let reads = 0;
  Object.defineProperty(registration, field, {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      if (reads > 1) throw new Error(`hostile second read of '${field}'`);
      return firstValue;
    },
  });
  return registration;
}

/**
 * Assert that a selection admitted exactly one given live registration.
 *
 * Compares the registration by identity: the hostile registrations below expose
 * accessors that throw once exhausted, so a structural comparison risks reading
 * them again and failing for a reason the case is not about. The identifier is
 * asserted against a literal for the same reason — it is the snapshot selection
 * took, and reading it back off the live object to compare would defeat the
 * point of carrying it out.
 * @param selection - Result of one selection pass.
 * @param expected - Registration the pass must have admitted.
 * @param expectedId - Identifier the pass must have snapshotted for it.
 */
function expectAdmitted(
  selection: CodeExecutionProviderSelection,
  expected: ICapabilityProvider,
  expectedId: string,
): void {
  expect(selection.admitted).toBe(true);
  if (!selection.admitted) return;
  expect(selection.provider).toBe(expected);
  expect(selection.id).toBe(expectedId);
}

describe('selectCodeExecutionProvider', () => {
  it('reports provider_unavailable for an empty bucket', () => {
    expect(selectCodeExecutionProvider([], undefined)).toEqual({
      admitted: false,
      code: 'provider_unavailable',
    });
  });

  it('admits the only well-formed provider when the request declares no requirements', () => {
    const provider = makeProvider({ id: 'only' });
    expectAdmitted(selectCodeExecutionProvider([provider], undefined), provider, 'only');
  });

  it('reports invalid_provider when the sole candidate is malformed', () => {
    expect(selectCodeExecutionProvider([makeMalformed({ execute: undefined })], undefined)).toEqual({
      admitted: false,
      code: 'invalid_provider',
    });
  });

  it.each([
    'id',
    'runtime',
    'language',
    'moduleFormat',
  ] as const)('rejects a provider whose %s cannot be represented by request requirements', (field) => {
    expect(
      selectCodeExecutionProvider(
        [makeMalformed({ [field]: 'x'.repeat(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH + 1) })],
        undefined,
      ),
    ).toEqual({ admitted: false, code: 'invalid_provider' });
  });

  it.each([
    'id',
    'runtime',
    'language',
    'moduleFormat',
  ] as const)('admits a provider whose %s is exactly at the request identifier limit', (field) => {
    const value = 'x'.repeat(CODE_EXECUTION_IDENTIFIER_MAX_LENGTH);
    const provider = makeMalformed({ [field]: value });
    expectAdmitted(selectCodeExecutionProvider([provider], undefined), provider, field === 'id' ? value : 'malformed');
  });

  it('admits a well-formed provider registered alongside a malformed one', () => {
    const provider = makeProvider({ id: 'good' });
    const selection = selectCodeExecutionProvider([makeMalformed({ trust: 'sandboxed' }), provider], undefined);
    expectAdmitted(selection, provider, 'good');
  });

  it('prefers invalid_provider over provider_unavailable when a malformed registration was present', () => {
    // A contract-violating registration is an actionable composition fault;
    // reporting "unavailable" would hide the only signal that it exists.
    const selection = selectCodeExecutionProvider(
      [makeMalformed({ execute: undefined }), makeProvider({ id: 'good', runtime: 'node' })],
      { runtime: 'deno' },
    );
    expect(selection).toEqual({ admitted: false, code: 'invalid_provider' });
  });

  it('rejects duplicate provider IDs before filtering or priority selection', () => {
    // The capability registry stores live objects. These providers were
    // initially distinct registrations, but a later mutation leaves their
    // selection snapshots with the same contractually unique identity.
    const first = makeProvider({ id: 'first', priority: 7 });
    const second = makeProvider({ id: 'second', priority: 7 });
    const unrelated = makeProvider({ id: 'other', priority: 99, runtime: 'deno' });
    expect(Reflect.set(first, 'id', 'duplicate')).toBe(true);
    expect(Reflect.set(second, 'id', 'duplicate')).toBe(true);

    for (const bucket of [
      [first, second, unrelated],
      [unrelated, second, first],
    ]) {
      expect(selectCodeExecutionProvider(bucket, { providerId: 'other' })).toEqual({
        admitted: false,
        code: 'invalid_provider',
      });
    }
  });

  it('classifies a registration whose accessor throws as invalid_provider', () => {
    // The selector stays total over whatever the registry accepted: a
    // registration that cannot be read must be classified, not thrown at the
    // router, which would turn one bad registration into a rejected subject.
    const bucket = [makeThrowingRegistration('trust')];

    expect(() => selectCodeExecutionProvider(bucket, undefined)).not.toThrow();
    expect(selectCodeExecutionProvider(bucket, undefined)).toEqual({
      admitted: false,
      code: 'invalid_provider',
    });
  });

  it('admits a well-formed provider registered alongside one whose accessor throws', () => {
    const provider = makeProvider({ id: 'good' });
    const selection = selectCodeExecutionProvider([makeThrowingRegistration('execute'), provider], undefined);
    expectAdmitted(selection, provider, 'good');
  });

  // Shape validation is contained, but requirement filtering and the priority
  // comparator are not: a registration that answers its first read and throws
  // on the next one would escape as a thrown bus handler unless selection reads
  // each declared field exactly once. These cases pin that single read from both
  // sides. The first selection sees nothing but first reads, so it must admit
  // the registration on the values it answered with — a selector that read any
  // field twice would already fail here. A later selection finds the same field
  // unreadable and has to classify it rather than throw.
  it.each<[string, unknown]>([
    ['id', 'second-read'],
    ['priority', 5],
    ['runtime', 'node'],
    ['language', 'typescript'],
    ['moduleFormat', 'esm'],
    ['trust', 'trusted-code-only'],
  ])('reads %s once per selection, then classifies the exhausted registration', (field, firstValue) => {
    const registration = makeSecondReadThrowingRegistration(field, firstValue);
    const bucket = [registration];

    expectAdmitted(selectCodeExecutionProvider(bucket, undefined), registration, 'second-read');

    expect(() => selectCodeExecutionProvider(bucket, undefined)).not.toThrow();
    expect(selectCodeExecutionProvider(bucket, undefined)).toEqual({
      admitted: false,
      code: 'invalid_provider',
    });
  });

  it('decides requirement filtering on the snapshot, then classifies the exhausted registration', () => {
    // Requirements name the very field whose second read throws, so a selector
    // reading the live object during filtering would throw on the first pass
    // instead of matching the value the snapshot already holds.
    const registration = makeSecondReadThrowingRegistration('runtime', 'node');
    const bucket = [registration];

    expectAdmitted(selectCodeExecutionProvider(bucket, { runtime: 'node' }), registration, 'second-read');

    expect(() => selectCodeExecutionProvider(bucket, { runtime: 'node' })).not.toThrow();
    expect(selectCodeExecutionProvider(bucket, { runtime: 'node' })).toEqual({
      admitted: false,
      code: 'invalid_provider',
    });
  });

  it('orders on the snapshot, then admits the survivor once the hostile registration is exhausted', () => {
    // Two eligible providers force the comparator to run, which is the other
    // place a live re-read would happen. The hostile registration declares the
    // higher priority, so the first pass has to admit it; a selector re-reading
    // `priority` while sorting would throw instead.
    const provider = makeProvider({ id: 'good', priority: 1 });
    const registration = makeSecondReadThrowingRegistration('priority', 9);
    const bucket = [registration, provider];

    expectAdmitted(selectCodeExecutionProvider(bucket, undefined), registration, 'second-read');

    expect(() => selectCodeExecutionProvider(bucket, undefined)).not.toThrow();
    expectAdmitted(selectCodeExecutionProvider(bucket, undefined), provider, 'good');
  });

  it('returns the live registration, not a metadata copy, so execute keeps its binding', async () => {
    class BoundProvider {
      public readonly id = 'bound';
      public readonly displayName = 'Bound';
      public readonly priority = 0;
      public readonly runtime = 'node';
      public readonly language = 'typescript';
      public readonly moduleFormat = 'esm';
      public readonly trust = 'trusted-code-only' as const;
      private readonly marker = 'from-instance';

      /**
       * Resolve a completed outcome that can only be produced through `this`.
       * @returns Completed outcome carrying the instance-private marker.
       */
      public execute(): Promise<CodeExecutionOutcome> {
        return Promise.resolve({ status: 'completed', value: this.marker });
      }
    }
    const provider = new BoundProvider();

    const selection = selectCodeExecutionProvider([provider], undefined);

    expect(selection.admitted).toBe(true);
    if (!selection.admitted) return;
    expect(selection.provider).toBe(provider);
    await expect(
      selection.provider.execute(
        {
          invocationId: 'inv-1',
          program: { files: {}, entryFile: 'e.ts', exportName: 'run' },
          arguments: null,
          timeoutMs: 1,
        },
        { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 1 },
      ),
    ).resolves.toEqual({ status: 'completed', value: 'from-instance' });
  });

  it('reports provider_unavailable when every candidate is well formed but none matches', () => {
    const selection = selectCodeExecutionProvider([makeProvider({ id: 'node-only', runtime: 'node' })], {
      runtime: 'deno',
    });
    expect(selection).toEqual({ admitted: false, code: 'provider_unavailable' });
  });

  describe('requirement filtering', () => {
    const provider = makeProvider({
      id: 'pinned',
      runtime: 'node',
      language: 'typescript',
      moduleFormat: 'esm',
      trust: 'isolated',
    });

    it.each<[string, CodeExecutionRequirements]>([
      ['every field matching', { providerId: 'pinned', runtime: 'node', language: 'typescript', trust: 'isolated' }],
      ['only the runtime', { runtime: 'node' }],
      ['only the module format', { moduleFormat: 'esm' }],
      ['no field at all', {}],
    ])('admits the provider for requirements naming %s', (_case, requirements) => {
      expectAdmitted(selectCodeExecutionProvider([provider], requirements), provider, 'pinned');
    });

    it.each<[string, CodeExecutionRequirements]>([
      ['a different provider id', { providerId: 'other' }],
      ['a different runtime', { runtime: 'deno' }],
      ['a different language', { language: 'python' }],
      ['a different module format', { moduleFormat: 'cjs' }],
      ['a different trust level', { trust: 'trusted-code-only' }],
    ])('refuses the provider for requirements naming %s', (_case, requirements) => {
      expect(selectCodeExecutionProvider([provider], requirements)).toEqual({
        admitted: false,
        code: 'provider_unavailable',
      });
    });
  });

  it('pins an exact provider id even when a higher-priority provider is eligible', () => {
    const pinned = makeProvider({ id: 'pinned', priority: 1 });
    const stronger = makeProvider({ id: 'stronger', priority: 99 });
    const selection = selectCodeExecutionProvider([stronger, pinned], { providerId: 'pinned' });
    expectAdmitted(selection, pinned, 'pinned');
  });

  it('refuses a pinned provider that fails another requirement', () => {
    const pinned = makeProvider({ id: 'pinned', runtime: 'node' });
    const selection = selectCodeExecutionProvider([pinned], { providerId: 'pinned', runtime: 'deno' });
    expect(selection).toEqual({ admitted: false, code: 'provider_unavailable' });
  });

  it('admits the highest priority among eligible providers', () => {
    const low = makeProvider({ id: 'low', priority: 1 });
    const high = makeProvider({ id: 'high', priority: 10 });
    const middle = makeProvider({ id: 'middle', priority: 5 });
    const selection = selectCodeExecutionProvider([low, high, middle], undefined);
    expectAdmitted(selection, high, 'high');
  });

  it('breaks priority ties by ascending id, independent of registration order', () => {
    const alpha = makeProvider({ id: 'alpha', priority: 7 });
    const beta = makeProvider({ id: 'beta', priority: 7 });
    const gamma = makeProvider({ id: 'gamma', priority: 7 });

    for (const bucket of [
      [alpha, beta, gamma],
      [gamma, beta, alpha],
      [beta, gamma, alpha],
    ]) {
      expectAdmitted(selectCodeExecutionProvider(bucket, undefined), alpha, 'alpha');
    }
  });

  it('never reorders the live registry array it was handed', () => {
    const bucket: ICapabilityProvider[] = [
      makeProvider({ id: 'zulu', priority: 1 }),
      makeProvider({ id: 'alpha', priority: 9 }),
    ];
    const snapshot = [...bucket];

    selectCodeExecutionProvider(bucket, undefined);

    expect(bucket).toEqual(snapshot);
    expect(bucket.map((provider) => provider.id)).toEqual(['zulu', 'alpha']);
  });
});
