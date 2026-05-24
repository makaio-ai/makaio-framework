import type { MakaioNodeExtension } from '@makaio/contracts';
import { GitService } from './git-service.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { GitNamespace } from '@makaio/services-core/git';

/**
 * MakaioNodeExtension<IMakaioBus> manifest for {@link GitService}.
 *
 * Git operations run in headless mode — repository monitoring and change
 * detection do not require a UI shell.
 *
 * Note: GitService has a soft dependency on FileWatcherService for efficient
 * watch-based invalidation.
 */
export const gitPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'git',
  displayName: 'Git',
  version: '0.1.0',
  critical: true,
  surface: 'headless',
  namespaces: [GitNamespace],
  /**
   * Creates a new {@link GitService} bound to the package bus.
   * @param ctx - Runtime context providing the bus instance.
   * @returns Uninitialized service instance; host calls `init()`.
   */
  create: (ctx) => new GitService(ctx.bus),
};
