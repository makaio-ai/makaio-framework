import { Hono } from 'hono';
import type { HonoRouteGraph } from './hono-route-graph.js';
import type { HttpContributionPhase, HttpRouteContribution } from './http-route-contribution.js';

/** Phase mount order: earlier index → mounted first. */
const PHASE_ORDER: readonly HttpContributionPhase[] = ['extension', 'static-fallback'];

/**
 * Manages a mutable set of {@link HttpRouteContribution}s and keeps the owning
 * {@link HonoRouteGraph} up to date whenever contributions change.
 */
export interface HttpRouteGraphBuilder {
  /**
   * Add a contribution and trigger a rebuild of the route graph.
   * @param contribution - The contribution to register.
   */
  add(contribution: HttpRouteContribution): void;
  /**
   * Remove all contributions registered under the given owner and trigger a
   * rebuild.  A no-op when the owner is not registered.
   * @param owner - The owner identifier to remove.
   */
  remove(owner: string): void;
  /**
   * Assemble and return a fresh Hono app from the current contributions sorted
   * by phase.
   * @returns Newly constructed Hono app.
   */
  build(): Hono;
  /** Snapshot of the current contributions in registration order. */
  readonly contributions: ReadonlyArray<HttpRouteContribution>;
}

/**
 * Create an {@link HttpRouteGraphBuilder} backed by an optional route graph.
 *
 * When `routeGraph` is provided, every {@link HttpRouteGraphBuilder.add} and
 * {@link HttpRouteGraphBuilder.remove} call triggers
 * {@link HonoRouteGraph.replaceApp} with a freshly assembled Hono app.
 *
 * When `routeGraph` is `undefined` (e.g. the Vite dev-server mode where the
 * route graph lives in the Vite plugin), contributions accumulate without
 * triggering a rebuild.
 * @param routeGraph - Route graph to update on change, or `undefined` to
 *   accumulate contributions without rebuilding.
 * @returns Builder instance managing contributions and rebuilds.
 */
export function createHttpRouteGraphBuilder(routeGraph: HonoRouteGraph | undefined): HttpRouteGraphBuilder {
  let items: HttpRouteContribution[] = [];

  /**
   * Assemble a fresh Hono app from the current contributions sorted by phase.
   * @param contributions - Contribution set to assemble.
   * @returns Newly constructed Hono app with all contributions mounted.
   */
  function buildFrom(contributions: ReadonlyArray<HttpRouteContribution>): Hono {
    const app = new Hono();
    const sorted = [...contributions].sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
    for (const c of sorted) {
      c.mount(app);
    }
    return app;
  }

  /**
   * Assemble a fresh Hono app from the current contributions sorted by phase.
   * @returns Newly constructed Hono app with all contributions mounted.
   */
  function build(): Hono {
    return buildFrom(items);
  }

  /**
   * Commit a contribution set after successfully rebuilding the route graph.
   * @param nextItems - Next contribution set.
   */
  function commit(nextItems: HttpRouteContribution[]): void {
    if (routeGraph) {
      routeGraph.replaceApp(buildFrom(nextItems));
    }
    items = nextItems;
  }

  return {
    add(contribution) {
      commit([...items, contribution]);
    },
    remove(owner) {
      const nextItems = items.filter((c) => c.owner !== owner);
      if (nextItems.length !== items.length) {
        commit(nextItems);
      }
    },
    build,
    get contributions() {
      return [...items];
    },
  };
}
