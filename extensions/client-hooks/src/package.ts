/**
 * Package manifest for the client-hooks extension.
 *
 * Registers the generic hook CLI bridge:
 * - `makaio hook received <client> <event-name>` forwards raw client hook events
 *   to the Makaio bus without a response path.
 * - `makaio hook handle <client> <event-name>` forwards the same raw observation,
 *   then translates a bus handler response into process stdout/stderr/exit code.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { clientHooksCli } from './cli/index.js';

/**
 * Client hooks package manifest.
 *
 * This is a CLI-only package: it has no background service and no storage
 * requirements. It exposes the `hook` command that any native client tool can
 * invoke to forward hook events into the bus or request a response.
 */
export const clientHooksPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'client-hooks',
  displayName: 'Client Hook Bridge',
  version: '0.1.0',
  cli: clientHooksCli,
};
