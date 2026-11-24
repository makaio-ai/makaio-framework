import type { IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import type { MakaioExtension } from '@makaio/contracts';
import { CLIDetectionNamespace } from '@makaio/services-core/cli-detection/namespace';
import { CliDetectionService } from './cli-detection-service.js';

/** Framework package name for required Node-hosted CLI detection. */
export const CLI_DETECTION_PACKAGE_NAME = 'makaio.cli-detection';

/**
 * CLI detection package shared by full and isolated Node runtimes.
 *
 * Every runtime that loads ClientsCore composes this package so the required
 * `cliDetection.scan` request never depends on product presence.
 */
export const cliDetectionPackage = {
  name: CLI_DETECTION_PACKAGE_NAME,
  displayName: 'CLI Detection',
  version: '0.1.0',
  critical: true,
  surface: 'any',
  namespaces: [CLIDetectionNamespace],
  /**
   * Create the Node-hosted CLI detection service.
   * @param ctx - Runtime extension context.
   * @returns Uninitialized CLI detection service.
   */
  create: (ctx) => new CliDetectionService(ctx.bus),
} satisfies MakaioExtension<IsolatedNodeExtensionContext<IMakaioBus>>;
