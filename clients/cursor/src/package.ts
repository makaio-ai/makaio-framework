import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Cursor client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the Cursor client.
 *
 * Declares the Cursor AI code editor as a client with hook support (`preToolUse`,
 * `afterFileEdit`). All tool invocations default to `always-ask` approval policy.
 */
export const cursorClientPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'client-cursor',
  displayName: 'Cursor Client',
  version: '0.1.0',
  clients: [clientDefinition],
};
