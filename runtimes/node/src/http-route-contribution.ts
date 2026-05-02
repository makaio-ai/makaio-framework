import type { Hono } from 'hono';

/** The ordered phase in which an HTTP route contribution is mounted. */
export type HttpContributionPhase = 'extension' | 'static-fallback';

/**
 * A single contribution to the HTTP route graph.
 *
 * Contributions declare their routing phase so the builder can mount them in
 * the correct order regardless of registration order.
 */
export interface HttpRouteContribution {
  /** Stable identifier for the contributing owner; used to remove by owner. */
  readonly owner: string;
  /** Phase determines mount order: `extension` before `static-fallback`. */
  readonly phase: HttpContributionPhase;
  /**
   * Mount routes onto the provided Hono app.
   * @param app - Fresh Hono app being assembled by the builder.
   */
  readonly mount: (app: Hono) => void;
}
