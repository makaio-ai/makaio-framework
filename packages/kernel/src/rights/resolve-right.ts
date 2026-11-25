import { deepFreeze } from '@makaio/utils';
import type { CallContext, CallContextRecord, Party } from '@makaio/core';
import { assertMintedCallContext, matchesAnySubscription } from '@makaio/bus-core';
import type { JsonValue } from '@makaio/contracts/shared';
import { RightAnswerSchema, RightDenialReason } from '@makaio/contracts/rights';
import type {
  RightAnswer,
  RightName,
  RightQuestion,
  RightSourceQuestion,
  RightsSourceContribution,
} from '@makaio/contracts/rights';
import type { RightsCache } from './rights-cache.js';
import { rightsCacheKey } from './rights-cache.js';
import type { RightsDirectory } from './rights-directory.js';

/**
 * Time an answer source gets to answer before it counts as not answering
 * (a source that does not answer yields {@link RightDenialReason.sourceUnavailable}).
 */
export const RIGHTS_SOURCE_DEADLINE_MS = 5_000;

/** Dependencies of {@link resolveRight}. */
export interface ResolveRightDeps {
  /** Directory the right and its answer sources are looked up in. */
  readonly directory: RightsDirectory;
  /** Cache of answers to payload-independent rights. */
  readonly cache: RightsCache;
  /**
   * Called once when a right has no answer source at all and is granted by that
   * silent default (see the "no source → grant" branch below). Optional so a
   * caller that does not care to make the default visible need not supply one;
   * {@link createRightsHub} supplies one that logs it exactly once per right.
   * @param right - Right that was granted with no source to ask.
   */
  readonly onNoSourceGrant?: (right: RightName) => void;
}

/**
 * Identity of the connection a question travels on: the transport it arrived over, and,
 * when the transport supplies one, a connection/session id local to that transport.
 *
 * A connection is identified by the pair, never by a string the two fields could be
 * concatenated into (two different pairs must never collide into the same string). A
 * transport that supplies no `id` cannot tell its connections apart, so {@link resolveRight}
 * never caches a question carrying a connection without one.
 */
export interface ResolveRightConnection {
  /** Registered bus transport name the question arrived over. */
  readonly transport: string;
  /** Connection/session id local to the transport, when the transport supplies one. */
  readonly id?: string;
}

/** The concrete subject and payload sent on the wire. */
interface ExternalPayloadContext {
  readonly subject: string;
  readonly payload: JsonValue;
}

/** Options of {@link resolveRight}. */
export interface ResolveRightOptions {
  /** Candidate checks always ask sources using the proposed catalog context. */
  readonly bypassCache?: boolean;
  /** Connection the question travels on; absent means the question was asked in-process (its own key space). */
  readonly connection?: ResolveRightConnection;
  /** JSON projected by the transport, supplied only to sources that request it. */
  readonly externalPayload?: ExternalPayloadContext;
}

/**
 * Whether two parties are the same party (a principal never gets more than its caller).
 * @param left - First party.
 * @param right - Second party.
 * @returns `true` when both share the same `kind` and `id`. Claims never enter the comparison.
 */
function partyEquals(left: Party, right: Party): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * Builds the call contexts the resolution checks, in this order: the question's own call, then the caller acting for
 * itself when the principal differs, then the attester acting for itself when
 * it is present and differs from both the caller and the principal. Every entry, including the
 * question's own call, is a frozen plain `CallContextRecord`, never the minted
 * value: an answer source decides whether a party holds a right, but must never
 * be handed authority to act as that party, so its question carries the call as
 * data (see {@link RightSourceQuestion}), never as a value that satisfies
 * `isMintedCallContext` and could be sent on the bus or passed to
 * `ctx.rights.resolve` as if it were a real call.
 * @param call - Call context of the question.
 * @returns The call context records to check, each party at most once.
 */
function partiesToCheck(call: CallContext): CallContextRecord[] {
  const { caller, principal, attestedBy } = call;
  const parties: CallContextRecord[] = [
    Object.freeze({
      caller,
      principal,
      ...(attestedBy === undefined ? {} : { attestedBy }),
    }),
  ];
  if (!partyEquals(principal, caller)) {
    parties.push(Object.freeze({ caller, principal: caller }));
  }
  if (attestedBy !== undefined && !partyEquals(attestedBy, caller) && !partyEquals(attestedBy, principal)) {
    parties.push(Object.freeze({ caller: attestedBy, principal: attestedBy }));
  }
  return parties;
}

/**
 * Whether any party a question's call context carries holds `claims`.
 *
 * Claims may be shared object graphs (see `party.test.ts`), so a cache key built from
 * one is unbounded; the source must decide on the full call every time instead, never
 * through the cache. `partiesToCheck` only ever derives its extra entries from `call`'s
 * own caller/principal/attester, so checking those three is equivalent to checking every
 * context {@link partiesToCheck} would build.
 * @param call - Call context of the question.
 * @returns `true` when the caller, principal, or attesting party carries `claims`.
 */
function carriesClaims(call: CallContext): boolean {
  return [call.caller, call.principal, call.attestedBy].some((party) => party?.claims !== undefined);
}

/** Sentinel for an answer source that did not answer within {@link RIGHTS_SOURCE_DEADLINE_MS}. */
const SOURCE_TIMED_OUT = Symbol('rights-source-timed-out');
/** Sentinel for an answer source whose call threw, or whose promise rejected. */
const SOURCE_FAILED = Symbol('rights-source-failed');

/**
 * Asks one answer source, normalizing every way it can fail into
 * `{ granted: false, reason: RightDenialReason.sourceUnavailable }`: a synchronous throw, a
 * rejected promise, a timeout, and an answer failing {@link RightAnswerSchema}. A denial of this
 * shape is never cached (see {@link resolveForParty}): the source failed to answer this time, so
 * the next question asks it again instead of repeating a transient failure. A denied answer
 * without its own `by` gets the source's name; a granted answer is returned unchanged.
 * @param question - The question handed to the source.
 * @param source - The answer source to ask.
 * @returns The source's normalized answer; never throws and never leaves its deadline timer running.
 */
async function askSource(question: RightSourceQuestion, source: RightsSourceContribution): Promise<RightAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await new Promise<RightAnswer | typeof SOURCE_TIMED_OUT | typeof SOURCE_FAILED>((resolve) => {
      timer = setTimeout(() => resolve(SOURCE_TIMED_OUT), RIGHTS_SOURCE_DEADLINE_MS);
      Promise.resolve()
        .then(() => source.answer(question))
        .then(resolve, () => resolve(SOURCE_FAILED));
    });
    if (outcome === SOURCE_TIMED_OUT || outcome === SOURCE_FAILED) {
      return { granted: false, reason: RightDenialReason.sourceUnavailable, by: source.source };
    }
    // `safeParse` itself reads `outcome`'s properties while it validates them; a throwing
    // accessor or proxy on the source's own answer object (not merely a value that fails the
    // schema) must normalize into the same `source-unavailable` denial as every other way this
    // source can fail, never escape as an exception out of this one source's own resolution.
    let parsed: ReturnType<typeof RightAnswerSchema.safeParse>;
    try {
      parsed = RightAnswerSchema.safeParse(outcome);
    } catch {
      return { granted: false, reason: RightDenialReason.sourceUnavailable, by: source.source };
    }
    if (!parsed.success) {
      return { granted: false, reason: RightDenialReason.sourceUnavailable, by: source.source };
    }
    if (parsed.data.granted) return parsed.data;
    return parsed.data.by === undefined ? { ...parsed.data, by: source.source } : parsed.data;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Asks every source of a right for one party, in parallel, and combines the
 * answers: granted only when every source grants it, otherwise the first
 * denying source (in {@link RightsDirectory.sourcesFor} order) decides.
 * @param partyCall - Call context record of the party asked for.
 * @param right - Right asked about.
 * @param context - Context of the question.
 * @param sources - Answer sources covering the right.
 * @param externalPayload - External wire JSON available to sources that requested it.
 * @returns The combined answer of this party's question.
 */
async function answerForParty(
  partyCall: CallContextRecord,
  right: RightName,
  context: JsonValue,
  sources: readonly RightsSourceContribution[],
  externalPayload?: ExternalPayloadContext,
): Promise<RightAnswer> {
  const answers = await Promise.all(
    sources.map((source) => {
      const sourceContext =
        externalPayload !== undefined && matchesAnySubscription(right, source.requiresPayload ?? [])
          ? { subject: externalPayload.subject, payload: externalPayload.payload }
          : context;
      return askSource({ call: partyCall, right, context: deepFreeze(structuredClone(sourceContext)) }, source);
    }),
  );
  return answers.find((answer) => !answer.granted) ?? { granted: true };
}

/**
 * Resolves one party's question, using the cache when the right is
 * payload-independent for every covering source, and never touching the cache otherwise.
 * @param deps - Directory and cache the resolution runs on.
 * @param partyCall - Call context record of the party asked for.
 * @param right - Right asked about.
 * @param context - Context of the question.
 * @param sources - Answer sources covering the right.
 * @param cacheable - Whether every source lists the right in `payloadIndependent`, the
 * connection (when any) carries an id, and no checked party carries `claims`.
 * @param connection - Connection of the original question, folded into the cache key.
 * @param externalPayload - Wire JSON available to interested sources.
 * @param generation - Cache generation of the right, read before the directory was consulted.
 * @returns The party's answer, cached when `cacheable` is `true` and the answer is not a
 * transient `source-unavailable` failure (see {@link askSource}): such an answer is returned, a
 * visible denial, but never stored, so the next question asks the source again instead of
 * repeating a failure that may no longer hold.
 */
async function resolveForParty(
  deps: ResolveRightDeps,
  partyCall: CallContextRecord,
  right: RightName,
  context: JsonValue,
  sources: readonly RightsSourceContribution[],
  cacheable: boolean,
  connection: ResolveRightConnection | undefined,
  generation: number,
  externalPayload?: ExternalPayloadContext,
): Promise<RightAnswer> {
  if (!cacheable) return answerForParty(partyCall, right, context, sources, externalPayload);
  const key = rightsCacheKey({ connection, call: partyCall, right, context });
  const cached = deps.cache.get(key);
  if (cached !== undefined) return cached;
  const answer = await answerForParty(partyCall, right, context, sources);
  if (answer.granted || answer.reason !== RightDenialReason.sourceUnavailable) {
    deps.cache.set(key, right, answer, generation);
  }
  return answer;
}

/**
 * The one place that resolves a right for a call context: looks the right up, checks its context against the right's JSON
 * schema, asks its answer sources for every party that must be checked, and
 * combines the answers. Sends nothing on the bus itself.
 *
 * Without an answer source, access is granted. Subject registration is then the only gate.
 * Ohne Antwortquelle wird gewaehrt; das einzige Tor ist dann, dass das Subject registriert ist.
 *
 * **Trust boundary.** Extensions in the host process are trusted code, like the core. Rights
 * protect against parties that come over the bus or across a boundary (workers, agents,
 * people, external systems). The mechanism is not hardened against deliberately hostile code
 * in the same process; there it protects against mistakes (frozen copies, a data shape instead
 * of a minted context for answer sources). Code the host does not trust runs as a step in a
 * process of its own, never as an extension in the host.
 * @param deps - Directory the right is looked up in, and the answer cache.
 * @param question - The right and the context it is asked about, with the call context of the asking party.
 * @param options - `connection` folds the connection the question travels on into the cache
 * key; absent means in-process (its own key space). A connection without an `id` (the
 * transport cannot tell its connections apart) is never cacheable, and neither is a call
 * carrying `claims` on any checked party (see {@link carriesClaims}): the source is asked
 * directly in both cases, every time, never through the cache.
 * @returns `{ granted: true }` when every checked party is granted the right;
 * otherwise the first denial, with its reason.
 * @throws InvalidCallContextError When `question.call` was not minted by the core.
 */
export async function resolveRight(
  deps: ResolveRightDeps,
  question: RightQuestion,
  options?: ResolveRightOptions,
): Promise<RightAnswer> {
  assertMintedCallContext(question.call);

  // Every declared right carries the context check compiled at declaration. Checked before the
  // cache's generation is ever read: a right no active extension declares never reaches
  // `generationOf`, so asking about an unknown name never creates a generation entry for it.
  const contextCheck = deps.directory.contextCheckFor(question.right);
  if (contextCheck === undefined) {
    return { granted: false, reason: RightDenialReason.rightUnknown };
  }

  // Read only once the right is known to exist, and before the directory is consulted any
  // further: any change committed after this point invalidates the right, so an answer built on
  // the older state is never cached.
  const generation = deps.cache.generationOf(question.right);

  const checked = contextCheck(question.context);
  if (!checked.valid) {
    return { granted: false, reason: RightDenialReason.contextInvalid };
  }

  const sources = deps.directory.sourcesFor(question.right);
  if (sources.length === 0) {
    // An external subject's registration is checked at the boundary before resolution.
    deps.onNoSourceGrant?.(question.right);
    return { granted: true };
  }

  const cacheable =
    !options?.bypassCache &&
    sources.every(
      (source) =>
        matchesAnySubscription(question.right, source.payloadIndependent ?? []) &&
        !matchesAnySubscription(question.right, source.requiresPayload ?? []),
    ) &&
    (options?.connection === undefined || options.connection.id !== undefined) &&
    !carriesClaims(question.call);

  for (const partyCall of partiesToCheck(question.call)) {
    const answer = await resolveForParty(
      deps,
      partyCall,
      question.right,
      question.context,
      sources,
      cacheable,
      options?.connection,
      generation,
      options?.externalPayload,
    );
    if (!answer.granted) return answer;
  }
  return { granted: true };
}
