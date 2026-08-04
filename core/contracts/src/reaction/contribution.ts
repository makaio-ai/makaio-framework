import type { ExtensionContext, NodeExtensionContext } from '../extension/extension-context.js';
import type { ReactionDefinition } from './definition.js';

/**
 * Context supplied to the `createReactions` factory of an
 * {@link ExtensionReactionsContribution}.
 *
 * This is a semantically named alias over the applicable host
 * {@link ExtensionContext} — an API-evolution seam, not a second dependency
 * container. Reaction factories receive the same per-extension runtime
 * context as other executable contribution factories; the alias exists so
 * the Reaction surface can grow reaction-specific context fields later
 * without changing every factory signature.
 * @typeParam THostContext - Concrete context shape supplied by the host
 *   runtime. Defaults to {@link NodeExtensionContext} because the current
 *   framework hosts are Node-based.
 */
export type ReactionContributionContext<THostContext extends ExtensionContext = NodeExtensionContext> = THostContext;

/**
 * Executable Reactions contribution surface declared by an extension.
 *
 * The runtime calls `createReactions(ctx)` during extension activation and
 * atomically registers the returned definitions as that extension's complete
 * Reaction batch.
 * Definitions carry live Zod parameter schemas and trusted handlers — they
 * are runtime values, never serializable descriptor data.
 * @typeParam THostContext - Concrete context shape supplied by the host
 *   runtime. Defaults to {@link NodeExtensionContext} because the current
 *   framework hosts are Node-based.
 */
export interface ExtensionReactionsContribution<THostContext extends ExtensionContext = NodeExtensionContext> {
  /**
   * Factory that produces the Reaction definitions for this extension.
   *
   * Called during extension activation. Each result is the extension's
   * complete Reaction batch and atomically replaces its prior batch. Returning
   * a `Promise` allows async resource acquisition (e.g. lazy loading).
   * @param ctx - Per-extension runtime context supplied by the host.
   * @returns Reaction definitions or a promise that resolves to them.
   */
  readonly createReactions: (
    ctx: ReactionContributionContext<THostContext>,
  ) => readonly ReactionDefinition[] | Promise<readonly ReactionDefinition[]>;
}
