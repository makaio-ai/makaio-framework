import type { ContributionName } from '@makaio/core';
import type { RightAnswer, RightSourceQuestion, RightsSourceContribution } from '@makaio/contracts/rights';
import {
  CORE_RIGHTS_OWNER,
  coreRightContributions,
  createRightsDirectory,
  type RightsDirectory,
} from '../rights-directory.js';

/**
 * Behaviours a test answer source can be built with, shared by every rights test (hub-level and
 * `resolveRight`-level): grant everything, deny with a reason, decide per question (synchronously
 * or by returning a promise a test controls), or fail the way `resolveRight` must normalize every
 * answer source's failure (a synchronous throw, a rejected promise, never answering, or an
 * answer that does not match the `RightAnswer` shape).
 */
export type SourceBehavior =
  | { readonly kind: 'grant' }
  | { readonly kind: 'deny'; readonly reason: string; readonly by?: ContributionName }
  | { readonly kind: 'throws' }
  | { readonly kind: 'rejects' }
  | { readonly kind: 'hangs' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'fn'; readonly answer: (question: RightSourceQuestion) => RightAnswer | Promise<RightAnswer> };

/**
 * Builds a plain {@link RightsSourceContribution} for rights tests, with no mechanics of its own:
 * it only records the questions it was asked (in asking order) and answers according to
 * `behavior`.
 * @param name - Name of the source, owned by the extension that registers it.
 * @param rights - Patterns of rights the source answers for.
 * @param behavior - How the source answers.
 * @param payloadIndependent - Patterns whose answer does not depend on the payload.
 * @returns The source, plus the questions it recorded.
 */
export function createAnswerSource(
  name: ContributionName,
  rights: readonly string[],
  behavior: SourceBehavior,
  payloadIndependent?: readonly string[],
): RightsSourceContribution & { readonly calls: RightSourceQuestion[] } {
  const calls: RightSourceQuestion[] = [];
  const answer = async (question: RightSourceQuestion): Promise<RightAnswer> => {
    calls.push(question);
    if (behavior.kind === 'grant') return { granted: true };
    if (behavior.kind === 'deny') {
      return { granted: false, reason: behavior.reason, ...(behavior.by === undefined ? {} : { by: behavior.by }) };
    }
    if (behavior.kind === 'throws') throw new Error('source threw');
    if (behavior.kind === 'rejects') return Promise.reject(new Error('source rejected'));
    if (behavior.kind === 'hangs') return new Promise<RightAnswer>(() => {});
    // Round-trips through JSON so the malformed value reaches the caller as plain, untyped data,
    // the way a real answer source's content would, instead of asserting past the type system.
    if (behavior.kind === 'malformed') return JSON.parse(JSON.stringify({ nope: true }));
    return behavior.answer(question);
  };
  return {
    source: name,
    description: `test source ${name}`,
    rights,
    ...(payloadIndependent === undefined ? {} : { payloadIndependent }),
    calls,
    answer,
  };
}

/**
 * Builds a rights directory with the core's own subject rights declared under {@link CORE_RIGHTS_OWNER},
 * the state the rights hub's directory has right after the hub was created.
 * @returns The directory, with the core subject rights declared.
 */
export function createDirectoryWithCoreRights(): RightsDirectory {
  const directory = createRightsDirectory();
  directory.declare(CORE_RIGHTS_OWNER, coreRightContributions());
  return directory;
}

/**
 * Builds a bus handler that appends each received payload to `into`, for tests that only need to
 * record every emission of a subject in order. A bare `(ctx) => into.push(ctx.payload)` would
 * return `Array.push`'s number, which a bus handler (`void | Promise<void>`) must not do.
 * @param into - Array the handler appends each payload to.
 * @returns A `(ctx) => void` bus handler.
 */
export function collectInto<Payload>(into: Payload[]): (ctx: { payload: Payload }) => void {
  return (ctx) => {
    into.push(ctx.payload);
  };
}
