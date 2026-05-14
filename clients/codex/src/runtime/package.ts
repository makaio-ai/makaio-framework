/**
 * Codex client runtime package.
 *
 * Exports the {@link MakaioExtension} manifest for the Codex client runtime and
 * re-exports the namespace subjects for client-native integrations.
 * @packageDocumentation
 */

import { dep } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { CodexClientSessionService } from './codex-client-session-service.js';

export { CodexClientSubjects, CODEX_CLIENT_NAMESPACE } from './namespace.js';
export { CodexClientSessionService } from './codex-client-session-service.js';
export { normalizeCodexHook } from './hook-normalizer.js';
export type { CodexNormalizedEvent, CodexNormalizedSubject } from './hook-normalizer.js';

/**
 * MakaioExtension manifest for the Codex client session normalization service.
 *
 * Creates a {@link CodexClientSessionService} that bridges raw
 * `client:codex.hook.received` events into normalized `client.session.*`
 * observations when the Codex descriptor server entry activates.
 */
export const codexClientRuntimePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'codex.runtime',
  displayName: 'Codex Client Runtime',
  version: '0.1.0',
  dependencies: [dep('makaio.clients-core')],
  /**
   * Create the Codex client session service bound to the runtime bus.
   * @param ctx - Runtime package context
   * @returns Uninitialized Codex client session service
   */
  create: (ctx) => new CodexClientSessionService(ctx.bus),
};
