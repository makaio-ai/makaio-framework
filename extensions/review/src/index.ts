import type { MakaioExtension, ExtensionContext, ExtensionServiceLifecycle } from '@makaio/contracts/extension';
import { resolvePackageRoot } from '@makaio/utils/package-root';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { CapabilityToken } from '@makaio/services-core';
import { registerReviewStorageHandlers } from './storage/handlers.js';
import { reviewToolset } from './toolset.js';
import { ReviewFindingsService } from './service.js';

const PACKAGE_ROOT = resolvePackageRoot(import.meta);

/**
 * Review findings extension.
 *
 * Provides:
 * - Drizzle-backed persistent storage for review findings
 * - `ReviewFindingsService` managing the full fetch/reconcile/persist lifecycle
 * - `review_findings` tool for agent interaction with findings
 * - `review.*` bus namespace handlers (fetch, list, start, update_status, submit, sources)
 */
export const reviewPackage: MakaioExtension = {
  name: 'review',
  displayName: 'Review Findings',

  storage: {
    migrations: 'drizzle',
    packageRoot: PACKAGE_ROOT,
    migrationSourceId: 'framework/extensions/review/drizzle',
    registerHandlers: registerDrizzleHandlers(registerReviewStorageHandlers),
  },

  tools: {
    /**
     * Create toolsets for the review package.
     * @param _ctx - Runtime extension context (reserved for config-driven toolset composition).
     * @returns Toolsets contributed by this package.
     */
    createToolsets: (_ctx: ExtensionContext) => [reviewToolset],
  },

  /**
   * Creates the review findings service.
   *
   * Resolves `CapabilityService` via the extension token, constructs
   * `ReviewFindingsService`, and returns a lifecycle object whose
   * `destroy` method cleans up all resources.
   * @param ctx - Runtime extension context with bus, getService, and config.
   * @returns Package service lifecycle.
   */
  create(ctx: ExtensionContext): ExtensionServiceLifecycle {
    let service: ReviewFindingsService | undefined;

    const init = async (): Promise<void> => {
      const capabilityService = ctx.getService(CapabilityToken);
      if (capabilityService === undefined) {
        throw new Error('[review] CapabilityService is required but not available');
      }
      service = new ReviewFindingsService(ctx.bus, capabilityService);
      await service.init();
    };

    const destroy = async (): Promise<void> => {
      await service?.destroy();
      service = undefined;
    };

    return { init, destroy };
  },
};

export default reviewPackage;

export { ReviewStorageNamespace, ReviewStorageSubjects } from './storage/namespace.js';
