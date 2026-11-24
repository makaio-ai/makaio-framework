import { canonicalStringify } from '@makaio/utils';
import type { CallContextRecord } from '@makaio/core';
import type { JsonValue } from '@makaio/contracts/shared';
import type { RightAnswer, RightName } from '@makaio/contracts/rights';
import type { ResolveRightConnection } from './resolve-right.js';

/**
 * In-process cache of answers to payload-independent rights.
 *
 * Holds one answer per cache key and indexes keys by right, so invalidating a
 * right drops exactly the answers it could have produced, without touching
 * answers of any other right.
 *
 * Each right also carries a generation counter. A resolution reads the
 * generation of the right it is about to ask sources for, and only {@link set}
 * succeeds when that generation is still current once the sources answered:
 * an invalidation that happens while sources are being asked bumps the
 * generation, so the in-flight resolution's answer is discarded instead of
 * repopulating the cache with a now-outdated grant or denial.
 */
export interface RightsCache {
  /**
   * Reads a cached answer.
   * @param key - Key built by {@link rightsCacheKey}.
   * @returns The cached answer, or `undefined` when nothing is cached for it.
   */
  get(key: string): RightAnswer | undefined;

  /**
   * Reads the current generation of a right.
   *
   * A resolution must call this before asking sources, and pass the returned
   * value to {@link set}: if the right is invalidated while sources are being
   * asked, the generation returned here no longer matches, and the answer is
   * not cached.
   * @param right - Right whose generation is read.
   * @returns The right's current generation; starts at `0` for a right never invalidated.
   */
  generationOf(right: RightName): number;

  /**
   * Freezes and stores an answer under a key, indexed by the right it answers, but only
   * when `generation` still matches the right's current generation.
   * @param key - Key built by {@link rightsCacheKey}.
   * @param right - Right the answer is for; used to invalidate it later.
   * @param answer - The answer to cache.
   * @param generation - The right's generation as read by {@link generationOf} before sources were asked.
   */
  set(key: string, right: RightName, answer: RightAnswer, generation: number): void;

  /**
   * Drops every cached answer of the given rights and bumps each right's generation.
   * @param rights - Right names whose cached answers are no longer valid.
   */
  invalidate(rights: readonly RightName[]): void;

  /** Drops every cached answer and bumps the generation of every right ever read or cached. */
  clear(): void;
}

/**
 * Maximum number of answers one cache holds at once.
 *
 * Per-connection eviction (dropping only the entries of one connection that drops, rather
 * than the oldest entries overall) is out of scope for this bound; this is a simple size
 * bound, oldest entry first, not a connection-aware policy. A cache question is always
 * payload-independent and connection-scoped (see {@link resolveRight}'s own doc comment on
 * `cacheable`), so unbounded growth would otherwise come from an unbounded number of distinct
 * connections or parties asking payload-independent questions, not from one connection alone.
 */
export const RIGHTS_CACHE_MAX_ENTRIES = 10_000;

/**
 * Creates an empty rights cache.
 * @returns The cache.
 */
export function createRightsCache(): RightsCache {
  // Insertion-ordered, like every `Map`: the oldest entry is always the first one `.keys()`
  // yields, so evicting it needs no separate bookkeeping. Re-`set`ing an existing key would
  // move it to the end (this cache never does: `set` only ever inserts a key once — see
  // `resolveForParty`'s own guard on `cached !== undefined`), so this stays accurate as a
  // straightforward insertion-order (oldest-first) eviction, not an access-order (LRU) one.
  const answers = new Map<string, RightAnswer>();
  const keysByRight = new Map<RightName, Set<string>>();
  const rightByKey = new Map<string, RightName>();
  const generations = new Map<RightName, number>();

  /**
   * Evicts the single oldest cached answer once the cache is over {@link RIGHTS_CACHE_MAX_ENTRIES},
   * dropping it from every index it is held in.
   */
  function evictOldestIfOverLimit(): void {
    if (answers.size <= RIGHTS_CACHE_MAX_ENTRIES) return;
    const oldestKey = answers.keys().next().value;
    if (oldestKey === undefined) return;
    answers.delete(oldestKey);
    const right = rightByKey.get(oldestKey);
    rightByKey.delete(oldestKey);
    if (right !== undefined) keysByRight.get(right)?.delete(oldestKey);
  }

  /**
   * Reads a right's generation, initializing it to `0` on first access so a
   * later bump has an entry to increment.
   * @param right - Right whose generation is read.
   * @returns The right's current generation.
   */
  function generationOf(right: RightName): number {
    let generation = generations.get(right);
    if (generation === undefined) {
      generation = 0;
      generations.set(right, generation);
    }
    return generation;
  }

  return {
    get(key) {
      return answers.get(key);
    },
    generationOf,
    set(key, right, answer, generation) {
      if (generation !== generationOf(right)) return;
      answers.set(key, Object.freeze(answer));
      rightByKey.set(key, right);
      let keys = keysByRight.get(right);
      if (keys === undefined) {
        keys = new Set();
        keysByRight.set(right, keys);
      }
      keys.add(key);
      evictOldestIfOverLimit();
    },
    invalidate(rights) {
      for (const right of rights) {
        generations.set(right, generationOf(right) + 1);
        const keys = keysByRight.get(right);
        if (keys === undefined) continue;
        for (const key of keys) {
          answers.delete(key);
          rightByKey.delete(key);
        }
        keysByRight.delete(right);
      }
    },
    clear() {
      answers.clear();
      keysByRight.clear();
      rightByKey.clear();
      for (const right of generations.keys()) generations.set(right, generationOf(right) + 1);
    },
  };
}

/** Input of {@link rightsCacheKey}. */
export interface RightsCacheKeyInput {
  /**
   * Connection the question travels on, identified by the (transport, id) pair; absent means
   * the question was asked in-process (its own key space). Only ever present here with its
   * `id` set: {@link resolveRight} treats a connection without one as not cacheable, so this
   * key is never built for it.
   */
  readonly connection?: ResolveRightConnection;
  /** Call context record the question is asked for: caller, principal and attesting party. */
  readonly call: CallContextRecord;
  /** Right the question is about. */
  readonly right: RightName;
  /** Context of the question, with its top-level `payload` left out. */
  readonly context: JsonValue;
}

/**
 * Removes the top-level `payload` property of a question context, when the
 * context is a JSON object: the key never depends on the payload.
 * @param context - Context of the question.
 * @returns The context without its top-level `payload` property; the same value, unchanged, when
 * it carries no top-level `payload` to begin with.
 */
function omitTopLevelPayload(context: JsonValue): JsonValue {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return context;
  if (!('payload' in context)) return context;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (key !== 'payload') rest[key] = value;
  }
  return rest;
}

/**
 * Builds the deterministic cache key of a question: the connection as a structured
 * (transport, id) pair, never a string the two fields could be concatenated into, the
 * full caller, principal and attesting party, right, and the question context without
 * its top-level `payload`.
 *
 * The full party is kept in the key as today (including `claims`, were one ever present),
 * but `resolveRight` never builds this key for a call carrying `claims` on any checked
 * party: claims may be shared object graphs whose serialization is unbounded, so the
 * source decides on those calls directly, every time, never through the cache.
 * @param input - The parts the key is built from.
 * @returns A string key stable across equal input regardless of object key order.
 */
export function rightsCacheKey(input: RightsCacheKeyInput): string {
  const { connection, call, right, context } = input;
  const keyShape = {
    connection: connection ?? null,
    caller: call.caller,
    principal: call.principal,
    attestedBy: call.attestedBy ?? null,
    right,
    context: omitTopLevelPayload(context),
  };
  return canonicalStringify(keyShape);
}
