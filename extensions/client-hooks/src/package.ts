/**
 * Package manifest for the client-hooks extension.
 *
 * Registers the generic hook CLI bridge
 * (`makaio hook received <client> <event-name>`) that forwards raw client hook
 * events to the Makaio bus without a background service.
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts';
import { clientHooksCli } from './cli/index.js';

/**
 * Client hooks package manifest.
 *
 * This is a CLI-only package: it has no background service and no storage
 * requirements. It exposes the `hook` command that any native client tool can
 * invoke to forward hook events into the bus.
 */
export const clientHooksPackage: MakaioExtension = {
  name: 'client-hooks',
  displayName: 'Client Hook Bridge',
  cli: clientHooksCli,
};
