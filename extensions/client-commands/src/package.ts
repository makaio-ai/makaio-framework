/**
 * Package manifest for the client-commands extension.
 *
 * Registers the `makaio client wire/unwire/wiring` CLI commands
 * that let users install and inspect Makaio hooks in supported client native
 * configs. This is a CLI-only package: it has no background service and no
 * storage requirements.
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts';
import { clientCommandsCli } from './cli/contribution.js';

/**
 * Client commands package manifest.
 *
 * Exposes `makaio client wire`, `makaio client unwire`, and
 * `makaio client wiring` — CLI commands that dispatch wiring
 * requests to the Makaio runtime bus.
 */
export const clientCommandsPackage: MakaioExtension = {
  name: 'client-commands',
  displayName: 'Client Commands',
  version: '0.1.0',
  cli: clientCommandsCli,
};
