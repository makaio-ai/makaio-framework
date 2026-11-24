import type { CallContext, ContributionName } from '@makaio/core';
import type { HandlerContext } from './handler-context.js';
import type { RightAnswer, RightContribution, RightsSourceContribution } from './right.js';
import type { RightsResolveRequest } from './schemas.js';

/**
 * A right declared from data of the host: a right contribution without
 * `suggestedFor`.
 */
export type RightFromData = Omit<RightContribution, 'suggestedFor'> & { readonly suggestedFor?: never };

/**
 * Capability of rights inside the host process, reached through the extension
 * context and never over the bus.
 */
export interface RightsCapability {
  /**
   * Resolves a right for the given call context. This is the one place that
   * resolves a right; the core builds the question from the arguments. A right
   * that no active extension declares is denied. A declared right without an
   * answer source is granted.
   *
   * Asks only: unlike {@link HandlerContext.hasRight}, a "no" here
   * is neither denied nor announced on `makaio:access.denied` — this method only answers the
   * question, it never decides what the caller does with a "no" or makes it visible. A handler
   * serving a message that needs its caller's "no" announced uses `handlerContext(call)`
   * instead (see {@link handlerContext}).
   * @param call - Context of the call the right is resolved for.
   * @param ask - The right and the context of the question about it.
   * @returns The combined answer.
   */
  resolve(call: CallContext, ask: Readonly<RightsResolveRequest>): Promise<RightAnswer>;

  /**
   * Builds the handler context of a message this extension serves: `call` is
   * the `context.call` the handler received. `hasRight` on the result resolves
   * through this same `resolve`, never a second path.
   * @param call - Context of the call the handler received.
   * @returns The handler context, bound to `call`.
   */
  handlerContext(call: CallContext): HandlerContext;

  /**
   * Reports that an answer source of this extension changed its content. The
   * core invalidates the affected cached answers and announces the change.
   * Takes no call context.
   * @param source - Name of the answer source whose content changed.
   */
  sourceChanged(source: ContributionName): void;

  /**
   * Reports the complete set of rights this extension declares from data of its
   * host. Every report replaces the previous one of the same extension. The
   * names lie in the extension's namespace; a right from data carries no
   * `suggestedFor`.
   * @param rights - The complete set of rights declared from data.
   */
  declareRightsFromData(rights: readonly RightFromData[]): void;

  /**
   * Registers an answer source after start. From then on it counts for its
   * rights like one declared in the extension manifest.
   * @param source - The answer source to register.
   * @throws When a source of the same name is already registered; the first registration stays.
   */
  registerRightsSource(source: RightsSourceContribution): void;
}
