/**
 * Strategy-to-feed-fetcher bridge for the binary version resolver.
 *
 * {@link StrategyFeedFetcher} adapts the strategy-specific
 * `resolveLatestVersion()` call into the {@link FeedFetcher} interface
 * expected by {@link ClientBinaryVersionResolver}.
 *
 * The resolver is strategy-agnostic; this bridge creates a transient strategy
 * instance per `fetchLatestVersion` call so the resolver does not need to know
 * which strategy a client uses.
 * @packageDocumentation
 */

import type { ManagedInstallDescriptor } from '@makaio/contracts/client';
import type { FeedFetcher } from './client-binary-version-resolver.js';
import { createStrategy } from './binary-strategies/index.js';
import type { StrategyDependencies } from './binary-strategies/index.js';

/**
 * Adapts a strategy's `resolveLatestVersion()` call into the
 * {@link FeedFetcher} interface expected by {@link ClientBinaryVersionResolver}.
 */
export class StrategyFeedFetcher implements FeedFetcher {
  /**
   * @param strategyDeps - I/O dependencies forwarded to each transient strategy
   */
  public constructor(private readonly strategyDeps: StrategyDependencies) {}

  /**
   * Resolve the latest version for the given managed install descriptor.
   * @param descriptor - Managed install descriptor for the client
   * @returns Latest version string from the upstream feed
   */
  public async fetchLatestVersion(descriptor: ManagedInstallDescriptor): Promise<string> {
    const strategy = createStrategy(descriptor, this.strategyDeps);
    if (strategy === undefined) {
      throw new Error(`Unsupported managed install descriptor type: ${descriptor.type}`);
    }
    return strategy.resolveLatestVersion();
  }
}
