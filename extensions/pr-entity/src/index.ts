/**
 * \@makaio/extension-pr-entity
 *
 * Stateless aggregation extension that assembles `PullRequestState` on demand
 * by combining raw VCS data (PR metadata, check runs, commit statuses) with
 * review findings (when the review service is available).
 *
 * No database table — all state is computed per-request with an in-memory
 * LRU cache to avoid N+1 fetches during list operations (AD-2).
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts/extension';
import { prEntityToolset } from './toolset.js';
import { VCSPRAggregationService } from './aggregation-service.js';

/**
 * PR entity extension package.
 *
 * Registers the VCS:PR aggregation service and exposes the `pr_status` tool.
 * The service handles `vcs:pr.get`, `vcs:pr.list`, and `vcs:pr.refresh` subjects.
 */
export const prEntityPackage: MakaioExtension = {
  name: 'pr-entity',
  displayName: 'PR Entity',
  version: '0.1.0',

  tools: {
    /**
     * Create the `pr-entity` toolset.
     * @param _ctx - Extension context (unused — toolset is bus-agnostic at definition time)
     * @returns Array containing the PR entity toolset
     */
    createToolsets: (_ctx) => [prEntityToolset],
  },

  /**
   * Create the aggregation service.
   *
   * Returns the `VCSPRAggregationService` directly — it satisfies
   * `ExtensionService` because it extends `BaseService`.
   * @param ctx - Extension context providing the bus instance
   * @returns Aggregation service (not yet initialized; host calls `init`)
   */
  create: (ctx) => new VCSPRAggregationService(ctx.bus),
};

export default prEntityPackage;
