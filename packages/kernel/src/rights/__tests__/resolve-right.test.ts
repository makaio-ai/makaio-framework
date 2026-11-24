import { describe, expect, it, vi } from 'vitest';
import type { CallContext, Party } from '@makaio/core';
import { CallContextRecordSchema } from '@makaio/core';
import { mintCallContext } from '@makaio/bus-core/kernel-api';
import { InvalidCallContextError, isMintedCallContext } from '@makaio/bus-core';
import type { JsonSchema, JsonValue } from '@makaio/contracts/shared';
import {
  RightDenialReason,
  SUBJECT_HANDLE_RIGHT,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  type RightAnswer,
  type RightFromData,
  type RightName,
  type RightsChanged,
} from '@makaio/contracts/rights';
import { createRightsCache } from '../rights-cache.js';
import type { RightsCache } from '../rights-cache.js';
import type { RightsDirectory } from '../rights-directory.js';
import { RIGHTS_SOURCE_DEADLINE_MS, resolveRight, type ResolveRightDeps } from '../resolve-right.js';
import { createAnswerSource, createDirectoryWithCoreRights } from './fixtures.js';

/** Waits one macrotask turn, long enough for a chain of microtasks (an answer source's async call) to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PARTY_U1: Party = { kind: 'acme.user', id: 'u1' };
const PARTY_P1: Party = { kind: 'acme.user', id: 'p1' };
const PARTY_A1: Party = { kind: 'acme.idp', id: 'a1' };

const THING_RIGHT: RightName = 'acme.thing';
const THING_CONTEXT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

const CACHE_RIGHT: RightName = 'acme.cacheable';
const CACHE_CONTEXT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, payload: {} },
  required: ['ok'],
  additionalProperties: false,
};

/**
 * A fresh directory with `acme.thing` declared, next to the core's own subject rights.
 * @returns The directory.
 */
function directoryWithThingRight(): RightsDirectory {
  const directory = createDirectoryWithCoreRights();
  directory.declare('acme', [{ right: THING_RIGHT, description: 'test right', context: THING_CONTEXT_SCHEMA }]);
  return directory;
}

/**
 * A right contribution owned by `acme`, for directory tests that need one but never resolve it.
 * @param right - Name of the right.
 * @returns The contribution, with an empty (always-valid) context schema.
 */
function thingContribution(right: RightName): RightFromData {
  return { right, description: 'test right', context: {} };
}

// ---------------------------------------------------------------------------
// 1. Resolution table
// ---------------------------------------------------------------------------

describe('resolveRight: resolution table', () => {
  it.each<[string, RightName, JsonValue, (directory: RightsDirectory) => void, RightAnswer]>([
    [
      'an unknown right is denied with right-unknown',
      'acme.ghost',
      {},
      () => {},
      { granted: false, reason: RightDenialReason.rightUnknown },
    ],
    [
      "a context violating the right's JSON schema is context-invalid",
      THING_RIGHT,
      {},
      () => {},
      { granted: false, reason: RightDenialReason.contextInvalid },
    ],
    ['a declared right without a source is granted', THING_RIGHT, { ok: true }, () => {}, { granted: true }],
    [
      'one source granting is granted',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource('acme', createAnswerSource('acme.src-yes', [THING_RIGHT], { kind: 'grant' })),
      { granted: true },
    ],
    [
      'one source denying, with its own by, keeps that by',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource(
          'acme',
          createAnswerSource('acme.src-no-by', [THING_RIGHT], { kind: 'deny', reason: 'nope', by: 'other.checker' }),
        ),
      { granted: false, reason: 'nope', by: 'other.checker' },
    ],
    [
      'one source denying without a by is filled with the source name',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource(
          'acme',
          createAnswerSource('acme.src-no', [THING_RIGHT], { kind: 'deny', reason: 'nope' }),
        ),
      { granted: false, reason: 'nope', by: 'acme.src-no' },
    ],
    [
      'two sources, one granting and one denying, is denied',
      THING_RIGHT,
      { ok: true },
      (directory) => {
        directory.registerSource('acme', createAnswerSource('acme.src-yes2', [THING_RIGHT], { kind: 'grant' }));
        directory.registerSource(
          'acme',
          createAnswerSource('acme.src-no2', [THING_RIGHT], { kind: 'deny', reason: 'mixed-no' }),
        );
      },
      { granted: false, reason: 'mixed-no', by: 'acme.src-no2' },
    ],
    [
      'a source that throws is source-unavailable',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource('acme', createAnswerSource('acme.src-throws', [THING_RIGHT], { kind: 'throws' })),
      { granted: false, reason: RightDenialReason.sourceUnavailable, by: 'acme.src-throws' },
    ],
    [
      'a source whose promise rejects is source-unavailable',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource('acme', createAnswerSource('acme.src-rejects', [THING_RIGHT], { kind: 'rejects' })),
      { granted: false, reason: RightDenialReason.sourceUnavailable, by: 'acme.src-rejects' },
    ],
    [
      'a source answering a malformed value is source-unavailable',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource(
          'acme',
          createAnswerSource('acme.src-malformed', [THING_RIGHT], { kind: 'malformed' }),
        ),
      { granted: false, reason: RightDenialReason.sourceUnavailable, by: 'acme.src-malformed' },
    ],
    [
      'a source answering with a throwing accessor is source-unavailable, not an escaped exception',
      THING_RIGHT,
      { ok: true },
      (directory) =>
        directory.registerSource(
          'acme',
          createAnswerSource('acme.src-throwing-accessor', [THING_RIGHT], {
            kind: 'fn',
            answer: () =>
              Object.defineProperty({}, 'granted', {
                enumerable: true,
                get(): never {
                  throw new Error('accessor exploded while safeParse read it');
                },
              }) as RightAnswer,
          }),
        ),
      { granted: false, reason: RightDenialReason.sourceUnavailable, by: 'acme.src-throwing-accessor' },
    ],
  ])('%s', async (_label, right, context, registerSources, expected) => {
    const directory = directoryWithThingRight();
    registerSources(directory);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

    const answer = await resolveRight(deps, { call, right, context });

    expect(answer).toEqual(expected);
  });

  it('denies with source-unavailable when a source never answers, past the deadline', async () => {
    vi.useFakeTimers();
    try {
      const directory = directoryWithThingRight();
      directory.registerSource('acme', createAnswerSource('acme.src-hangs', [THING_RIGHT], { kind: 'hangs' }));
      const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
      const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

      const pending = resolveRight(deps, { call, right: THING_RIGHT, context: { ok: true } });
      await vi.advanceTimersByTimeAsync(RIGHTS_SOURCE_DEADLINE_MS);

      expect(await pending).toEqual({
        granted: false,
        reason: RightDenialReason.sourceUnavailable,
        by: 'acme.src-hangs',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the deadline timer when a source answers before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const directory = directoryWithThingRight();
      directory.registerSource('acme', createAnswerSource('acme.src-fast', [THING_RIGHT], { kind: 'grant' }));
      const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
      const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

      const answer = await resolveRight(deps, { call, right: THING_RIGHT, context: { ok: true } });

      expect(answer).toEqual({ granted: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Context limitation: never more than the caller
// ---------------------------------------------------------------------------

/**
 * Reduces a call context to the party ids a test compares, so the assertion names no claims.
 * @param call - Call context whose parties are reduced.
 * @returns The ids of caller, principal and, when present, attester.
 */
function partyIds(call: { caller: Party; principal: Party; attestedBy?: Party }): {
  caller: string;
  principal: string;
  attestedBy?: string;
} {
  return {
    caller: call.caller.id,
    principal: call.principal.id,
    ...(call.attestedBy === undefined ? {} : { attestedBy: call.attestedBy.id }),
  };
}

describe('resolveRight: context limitation', () => {
  it.each<
    [
      string,
      { caller: Party; principal: Party; attestedBy?: Party },
      string | undefined,
      boolean,
      ReturnType<typeof partyIds>[],
    ]
  >([
    [
      'denies when the principal differs from the caller and the caller-for-itself question is denied',
      { caller: PARTY_U1, principal: PARTY_P1 },
      PARTY_U1.id,
      false,
      [
        { caller: PARTY_U1.id, principal: PARTY_P1.id },
        { caller: PARTY_U1.id, principal: PARTY_U1.id },
      ],
    ],
    [
      'denies when the attester differs from the caller and the attester-for-itself question is denied',
      { caller: PARTY_U1, principal: PARTY_U1, attestedBy: PARTY_A1 },
      PARTY_A1.id,
      false,
      [
        { caller: PARTY_U1.id, principal: PARTY_U1.id, attestedBy: PARTY_A1.id },
        { caller: PARTY_A1.id, principal: PARTY_A1.id },
      ],
    ],
    [
      'asks once when the principal is the caller and there is no attester',
      { caller: PARTY_U1, principal: PARTY_U1 },
      undefined,
      true,
      [{ caller: PARTY_U1.id, principal: PARTY_U1.id }],
    ],
    [
      'checks the principal once when the principal also attests the call',
      { caller: PARTY_U1, principal: PARTY_P1, attestedBy: { ...PARTY_P1 } },
      undefined,
      true,
      [
        { caller: PARTY_U1.id, principal: PARTY_P1.id, attestedBy: PARTY_P1.id },
        { caller: PARTY_U1.id, principal: PARTY_U1.id },
      ],
    ],
  ])('%s', async (_label, parties, denyPrincipalId, expectedGranted, expectedCalls) => {
    const directory = directoryWithThingRight();
    const source = createAnswerSource('acme.src', [THING_RIGHT], {
      kind: 'fn',
      answer: (question) =>
        question.call.principal.id === denyPrincipalId ? { granted: false, reason: 'denied' } : { granted: true },
    });
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext(parties);

    const answer = await resolveRight(deps, { call, right: THING_RIGHT, context: { ok: true } });

    expect(answer.granted).toBe(expectedGranted);
    expect(source.calls.map((question) => partyIds(question.call))).toEqual(expectedCalls);
  });

  it('never hands a minted context to an answer source: every party context a source receives is not minted, but is a well-formed call context record', async () => {
    const directory = directoryWithThingRight();
    const mintedChecks: boolean[] = [];
    const recordChecks: boolean[] = [];
    const source = createAnswerSource('acme.src-minted-check', [THING_RIGHT], {
      kind: 'fn',
      answer: (question) => {
        mintedChecks.push(isMintedCallContext(question.call));
        recordChecks.push(CallContextRecordSchema.safeParse(question.call).success);
        return { granted: true };
      },
    });
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_P1, attestedBy: PARTY_A1 });

    const answer = await resolveRight(deps, { call, right: THING_RIGHT, context: { ok: true } });

    expect(answer).toEqual({ granted: true });
    expect(mintedChecks).toEqual([false, false, false]);
    expect(recordChecks).toEqual([true, true, true]);
  });
});

// ---------------------------------------------------------------------------
// 3. Core rights
// ---------------------------------------------------------------------------

describe('resolveRight: core rights', () => {
  it('declares the core subject rights at creation', () => {
    const directory = createDirectoryWithCoreRights();

    expect(directory.lookup(SUBJECT_HANDLE_RIGHT)).toBeDefined();
    expect(directory.lookup(SUBJECT_SEND_RIGHT)).toBeDefined();
    expect(directory.lookup(SUBJECT_SUBSCRIBE_RIGHT)).toBeDefined();
  });

  it('is context-invalid for a subscribe context naming both subject and pattern', async () => {
    const deps: ResolveRightDeps = { directory: createDirectoryWithCoreRights(), cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

    const answer = await resolveRight(deps, {
      call,
      right: SUBJECT_SUBSCRIBE_RIGHT,
      context: { subject: 'acme.widget-created', pattern: 'acme.*' },
    });

    expect(answer).toEqual({ granted: false, reason: RightDenialReason.contextInvalid });
  });

  it('grants a subscribe question without a source', async () => {
    const deps: ResolveRightDeps = { directory: createDirectoryWithCoreRights(), cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

    const answer = await resolveRight(deps, {
      call,
      right: SUBJECT_SUBSCRIBE_RIGHT,
      context: { subject: 'acme.widget-created' },
    });

    expect(answer).toEqual({ granted: true });
  });
});

// ---------------------------------------------------------------------------
// 4. Cache
// ---------------------------------------------------------------------------

describe('resolveRight: cache', () => {
  function directoryWithCacheRight(): RightsDirectory {
    const directory = createDirectoryWithCoreRights();
    directory.declare('acme', [{ right: CACHE_RIGHT, description: 'cache test right', context: CACHE_CONTEXT_SCHEMA }]);
    return directory;
  }

  it('does not ask again for a different payload when every source lists the right as payload-independent', async () => {
    const directory = directoryWithCacheRight();
    const sourceA = createAnswerSource('acme.cache-a', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    const sourceB = createAnswerSource('acme.cache-b', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    directory.registerSource('acme', sourceA);
    directory.registerSource('acme', sourceB);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

    await resolveRight(deps, { call, right: CACHE_RIGHT, context: { ok: true, payload: { x: 1 } } });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context: { ok: true, payload: { x: 2 } } });

    expect(sourceA.calls).toHaveLength(1);
    expect(sourceB.calls).toHaveLength(1);
  });

  it('asks again when one source does not list the right as payload-independent', async () => {
    const directory = directoryWithCacheRight();
    const sourceA = createAnswerSource('acme.cache-a', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    const sourceB = createAnswerSource('acme.cache-b', [CACHE_RIGHT], { kind: 'grant' });
    directory.registerSource('acme', sourceA);
    directory.registerSource('acme', sourceB);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

    await resolveRight(deps, { call, right: CACHE_RIGHT, context: { ok: true, payload: { x: 1 } } });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context: { ok: true, payload: { x: 2 } } });

    expect(sourceA.calls).toHaveLength(2);
    expect(sourceB.calls).toHaveLength(2);
  });

  it('protects a cached denial from mutation through the resolver result', async () => {
    const directory = directoryWithCacheRight();
    const source = createAnswerSource('acme.cache-deny', [CACHE_RIGHT], { kind: 'deny', reason: 'nope' }, [
      CACHE_RIGHT,
    ]);
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const question = { call, right: CACHE_RIGHT, context: { ok: true } };

    const denial = await resolveRight(deps, question);

    expect(Reflect.set(denial, 'granted', true)).toBe(false);
    await expect(resolveRight(deps, question)).resolves.toEqual({ granted: false, reason: 'nope', by: source.source });
    expect(source.calls).toHaveLength(1);
  });

  it('forces a new ask after cache.invalidate([right])', async () => {
    const directory = directoryWithCacheRight();
    const source = createAnswerSource('acme.cache-a', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    directory.registerSource('acme', source);
    const cache = createRightsCache();
    const deps: ResolveRightDeps = { directory, cache };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const context = { ok: true };

    await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    expect(source.calls).toHaveLength(1);

    cache.invalidate([CACHE_RIGHT]);
    await resolveRight(deps, { call, right: CACHE_RIGHT, context });

    expect(source.calls).toHaveLength(2);
  });

  it('keeps a separate cache entry per connection', async () => {
    const directory = directoryWithCacheRight();
    const source = createAnswerSource('acme.cache-a', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const context = { ok: true };

    await resolveRight(deps, { call, right: CACHE_RIGHT, context }, { connection: { transport: 't', id: 'conn-a' } });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context }, { connection: { transport: 't', id: 'conn-a' } });
    expect(source.calls).toHaveLength(1);

    await resolveRight(deps, { call, right: CACHE_RIGHT, context }, { connection: { transport: 't', id: 'conn-b' } });

    expect(source.calls).toHaveLength(2);
  });

  it('never caches a question whose connection carries no id: the source is asked every time', async () => {
    const directory = directoryWithCacheRight();
    const source = createAnswerSource('acme.cache-no-id', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const context = { ok: true };

    await resolveRight(deps, { call, right: CACHE_RIGHT, context }, { connection: { transport: 't' } });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context }, { connection: { transport: 't' } });

    expect(source.calls).toHaveLength(2);
  });

  it('never caches a source-unavailable answer: the next question asks the source again instead of repeating the failure', async () => {
    const directory = directoryWithCacheRight();
    let calls = 0;
    const flakySource = createAnswerSource(
      'acme.cache-flaky',
      [CACHE_RIGHT],
      {
        kind: 'fn',
        answer: () => {
          calls += 1;
          if (calls === 1) throw new Error('source threw the first time');
          return { granted: true };
        },
      },
      [CACHE_RIGHT],
    );
    directory.registerSource('acme', flakySource);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const context = { ok: true };

    const first = await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    expect(first).toEqual({ granted: false, reason: RightDenialReason.sourceUnavailable, by: 'acme.cache-flaky' });

    const second = await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    expect(second).toEqual({ granted: true });
    expect(calls).toBe(2);
  });

  it('never caches a call whose principal carries claims: the source is asked every time', async () => {
    const directory = directoryWithCacheRight();
    const source = createAnswerSource('acme.cache-claims', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const partyGold: Party = { kind: PARTY_U1.kind, id: PARTY_U1.id, claims: { tier: 'gold' } };
    const context = { ok: true };
    const call = mintCallContext({ caller: partyGold, principal: partyGold });

    await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context });

    expect(source.calls).toHaveLength(2);
  });

  it('still caches a claim-free call: the source is asked once', async () => {
    const directory = directoryWithCacheRight();
    const source = createAnswerSource('acme.cache-claim-free', [CACHE_RIGHT], { kind: 'grant' }, [CACHE_RIGHT]);
    directory.registerSource('acme', source);
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const context = { ok: true };

    await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    await resolveRight(deps, { call, right: CACHE_RIGHT, context });

    expect(source.calls).toHaveLength(1);
  });

  it('returns a late answer to its caller, but asks again next time, when invalidate ran while pending', async () => {
    const directory = directoryWithCacheRight();
    let resolveAnswer: ((answer: RightAnswer) => void) | undefined;
    const pending = new Promise<RightAnswer>((resolve) => {
      resolveAnswer = resolve;
    });
    const source = createAnswerSource('acme.cache-pending', [CACHE_RIGHT], { kind: 'fn', answer: () => pending }, [
      CACHE_RIGHT,
    ]);
    directory.registerSource('acme', source);
    const cache = createRightsCache();
    const deps: ResolveRightDeps = { directory, cache };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const context = { ok: true };

    const started = resolveRight(deps, { call, right: CACHE_RIGHT, context });
    await flush();
    expect(source.calls).toHaveLength(1);

    cache.invalidate([CACHE_RIGHT]);
    resolveAnswer?.({ granted: true });

    await expect(started).resolves.toEqual({ granted: true });

    await resolveRight(deps, { call, right: CACHE_RIGHT, context });
    expect(source.calls).toHaveLength(2);
  });

  it('never reads the cache generation of a right nobody declares: only a known right ever reaches generationOf', async () => {
    const directory = directoryWithCacheRight();
    const generationReadsOf = new Map<RightName, number>();
    const realCache = createRightsCache();
    // A spy over the cache's own public surface, not its private state: counts how often
    // `generationOf` is asked about each right, through the exact interface `resolveRight` uses.
    const spyCache: RightsCache = {
      get: (key) => realCache.get(key),
      generationOf: (right) => {
        generationReadsOf.set(right, (generationReadsOf.get(right) ?? 0) + 1);
        return realCache.generationOf(right);
      },
      set: (key, right, answer, generation) => realCache.set(key, right, answer, generation),
      invalidate: (rights) => realCache.invalidate(rights),
      clear: () => realCache.clear(),
    };
    const deps: ResolveRightDeps = { directory, cache: spyCache };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });
    const UNKNOWN_RIGHT: RightName = 'acme.nobody-declares';

    const answer = await resolveRight(deps, { call, right: UNKNOWN_RIGHT, context: {} });

    expect(answer).toEqual({ granted: false, reason: RightDenialReason.rightUnknown });
    expect(generationReadsOf.get(UNKNOWN_RIGHT)).toBeUndefined();

    await resolveRight(deps, { call, right: CACHE_RIGHT, context: { ok: true } });
    expect(generationReadsOf.get(CACHE_RIGHT)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Unminted call context
// ---------------------------------------------------------------------------

describe('resolveRight: call context authenticity', () => {
  it('throws InvalidCallContextError for a plain object standing in for a call context', async () => {
    const directory = directoryWithThingRight();
    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = { caller: PARTY_U1, principal: PARTY_U1 } as CallContext;

    await expect(resolveRight(deps, { call, right: THING_RIGHT, context: { ok: true } })).rejects.toThrow(
      InvalidCallContextError,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Directory
// ---------------------------------------------------------------------------

describe('RightsDirectory', () => {
  it.each<[string, (directory: RightsDirectory) => void]>([
    [
      'a right not owned by the declaring extension',
      (directory) => directory.declare('acme', [thingContribution('other.thing')]),
    ],
    [
      'the same right declared by two different owners',
      (directory) => {
        directory.declare('a', [thingContribution('a.b.thing')]);
        directory.declare('a.b', [thingContribution('a.b.thing')]);
      },
    ],
    [
      'a duplicate source name',
      (directory) => {
        directory.registerSource('acme', createAnswerSource('acme.dup', [], { kind: 'grant' }));
        directory.registerSource('acme', createAnswerSource('acme.dup', [], { kind: 'grant' }));
      },
    ],
    [
      'sourceChanged reported by a non-owner',
      (directory) => {
        directory.registerSource('acme', createAnswerSource('acme.src', [], { kind: 'grant' }));
        directory.sourceChanged('other', 'acme.src');
      },
    ],
  ])('throws for %s', (_label, action) => {
    const directory = createDirectoryWithCoreRights();

    expect(() => action(directory)).toThrow();
  });

  it('declareFromData replaces the whole data set; a removed data right becomes right-unknown', () => {
    const directory = createDirectoryWithCoreRights();

    directory.declareFromData('acme', [thingContribution('acme.x'), thingContribution('acme.y')]);
    expect(directory.lookup('acme.x')).toBeDefined();
    expect(directory.lookup('acme.y')).toBeDefined();

    directory.declareFromData('acme', [thingContribution('acme.x')]);

    expect(directory.lookup('acme.x')).toBeDefined();
    expect(directory.lookup('acme.y')).toBeUndefined();
  });

  it("removeOwner removes the owner's rights and sources", () => {
    const directory = createDirectoryWithCoreRights();
    directory.declare('acme', [thingContribution('acme.a')]);
    directory.registerSource('acme', createAnswerSource('acme.src', ['acme.a'], { kind: 'grant' }));

    directory.removeOwner('acme');

    expect(directory.lookup('acme.a')).toBeUndefined();
    expect(directory.sourcesFor('acme.a')).toEqual([]);
  });

  it("removeOwner reports the other owners' rights its removed sources answered for", () => {
    const directory = createDirectoryWithCoreRights();
    directory.declare('acme', [thingContribution('acme.a'), thingContribution('acme.b')]);
    directory.registerSource('policy', createAnswerSource('policy.src', ['acme.*'], { kind: 'grant' }));
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    directory.removeOwner('policy');

    // Revision 1 was already consumed by `createDirectoryWithCoreRights`'s own `declare`, revision
    // 2 by `acme`'s `declare` above, and revision 3 by `policy`'s `registerSource`: the directory's
    // one revision counter is shared by every owner, never reset per owner.
    expect(changes).toEqual([{ owner: 'policy', revision: 4, rights: ['acme.a', 'acme.b'], reason: 'declared' }]);
    expect(directory.sourcesFor('acme.a')).toEqual([]);
  });

  it('notifies onChanged with owner, a single shared increasing revision, and the three reasons', () => {
    const directory = createDirectoryWithCoreRights();
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    directory.declare('acme', [thingContribution('acme.a')]);
    directory.registerSource('acme', createAnswerSource('acme.src', ['acme.a'], { kind: 'grant' }));
    directory.sourceChanged('acme', 'acme.src');

    expect(
      changes.map((change) => ({ owner: change.owner, revision: change.revision, reason: change.reason })),
    ).toEqual([
      // Revision 1 was already consumed by `createDirectoryWithCoreRights`'s own `declare`,
      // before this test's listener was even attached.
      { owner: 'acme', revision: 2, reason: 'declared' },
      { owner: 'acme', revision: 3, reason: 'source-registered' },
      { owner: 'acme', revision: 4, reason: 'source-changed' },
    ]);
    expect(changes[0]?.rights).toEqual(['acme.a']);
  });

  it("removing an owner and re-adding it under the same name continues the directory's one revision counter instead of restarting it", () => {
    const directory = createDirectoryWithCoreRights();
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    directory.declare('acme', [thingContribution('acme.a')]);
    const revisionBeforeRemoval = changes.at(-1)?.revision;

    directory.removeOwner('acme');
    directory.declare('acme', [thingContribution('acme.a')]);
    const revisionAfterReAdd = changes.at(-1)?.revision;

    expect(revisionBeforeRemoval).toBeDefined();
    expect(revisionAfterReAdd).toBeDefined();
    expect(revisionAfterReAdd as number).toBeGreaterThan(revisionBeforeRemoval as number);
  });

  it('matches a source to every right its pattern covers', () => {
    const directory = createDirectoryWithCoreRights();
    directory.declare('acme', [thingContribution('acme.a'), thingContribution('acme.b')]);
    const source = createAnswerSource('acme.src', ['acme.*'], { kind: 'grant' });
    directory.registerSource('acme', source);

    // The directory keeps its own copy of the source, so it is compared by name.
    expect(directory.sourcesFor('acme.a').map((entry) => entry.source)).toEqual([source.source]);
    expect(directory.sourcesFor('acme.b').map((entry) => entry.source)).toEqual([source.source]);
    expect(directory.sourcesFor('other.c')).toEqual([]);
  });

  it("list() returns a deep-frozen copy of a right's context: mutating a nested enum throws, and resolution still treats a context outside the original enum as context-invalid", async () => {
    const directory = createDirectoryWithCoreRights();
    const right: RightName = 'acme.frozen';
    const context: JsonSchema = {
      type: 'object',
      properties: { tier: { enum: ['gold'] } },
      required: ['tier'],
      additionalProperties: false,
    };
    directory.declare('acme', [{ right, description: 'd', context }]);

    const entry = directory.list().find((candidate) => candidate.right === right);
    if (entry === undefined) throw new Error(`right '${right}' not found in list()`);
    const properties = entry.context.properties as Record<string, JsonValue>;
    const tierSchema = properties.tier as Record<string, JsonValue>;
    const tierEnum = tierSchema.enum as JsonValue[];

    expect(() => tierEnum.push('silver')).toThrow();

    const deps: ResolveRightDeps = { directory, cache: createRightsCache() };
    const call = mintCallContext({ caller: PARTY_U1, principal: PARTY_U1 });

    const answer = await resolveRight(deps, { call, right, context: { tier: 'silver' } });

    expect(answer).toEqual({ granted: false, reason: RightDenialReason.contextInvalid });
  });

  it('throws for a context schema that does not compile, leaves the directory unchanged and sends no change', () => {
    const directory = createDirectoryWithCoreRights();
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    expect(() =>
      directory.declare('acme', [{ right: 'acme.nonsense', description: 'd', context: { type: 'nonsense' } }]),
    ).toThrow();

    expect(directory.lookup('acme.nonsense')).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('throws for a $async context schema, leaves the directory unchanged and sends no change', () => {
    const directory = createDirectoryWithCoreRights();
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    expect(() =>
      directory.declare('acme', [{ right: 'acme.asyncschema', description: 'd', context: { $async: true } }]),
    ).toThrow();

    expect(directory.lookup('acme.asyncschema')).toBeUndefined();
    expect(changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. activate: static rights, data rights and sources together
// ---------------------------------------------------------------------------

describe('RightsDirectory: activate', () => {
  it('commits static rights, data rights and sources as one unit, announcing declared then source-registered', () => {
    const directory = createDirectoryWithCoreRights();
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    directory.activate('acme', {
      rights: [{ right: 'acme.static', description: 'd', context: {} }],
      dataRights: [thingContribution('acme.fromdata')],
      sources: [createAnswerSource('acme.src', ['acme.*'], { kind: 'grant' })],
    });

    expect(directory.lookup('acme.static')).toBeDefined();
    expect(directory.lookup('acme.fromdata')).toBeDefined();
    expect(directory.sourcesFor('acme.static')).toHaveLength(1);
    expect(changes.map((change) => change.reason)).toEqual(['declared', 'source-registered']);
  });

  it('a violation anywhere in the contribution leaves nothing visible and announces nothing', () => {
    const directory = createDirectoryWithCoreRights();
    const changes: RightsChanged[] = [];
    directory.onChanged((batch) => changes.push(...batch));

    expect(() =>
      directory.activate('acme', {
        rights: [{ right: 'acme.static', description: 'd', context: {} }],
        dataRights: [thingContribution('acme.fromdata')],
        sources: [
          createAnswerSource('acme.src', ['acme.*'], { kind: 'grant' }),
          createAnswerSource('acme.src', ['acme.*'], { kind: 'grant' }),
        ],
      }),
    ).toThrow();

    expect(directory.lookup('acme.static')).toBeUndefined();
    expect(directory.lookup('acme.fromdata')).toBeUndefined();
    expect(directory.sourcesFor('acme.static')).toEqual([]);
    expect(changes).toEqual([]);
  });
});
