/**
 * Codex client runtime package.
 *
 * Exports the {@link MakaioExtension} manifest for the Codex client runtime and
 * re-exports the namespace subjects for client-native integrations.
 *
 * The `create()` factory resolves the `clients-core` service via
 * {@link ClientsCoreToken} and passes its
 * {@link ClientHookProviderContractRegistry} to the
 * {@link CodexClientSessionService} so the Codex provider contract is
 * registered and unregistered alongside the service lifecycle.
 * @packageDocumentation
 */

import { dep } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { ClientsCoreToken } from '@makaio/subsystem-client';
import { CodexClientSessionService } from './codex-client-session-service.js';

export { CodexClientSubjects, CODEX_CLIENT_NAMESPACE } from './namespace.js';
export { CodexClientSessionService } from './codex-client-session-service.js';
export { normalizeCodexHook } from './hook-normalizer.js';
export type { CodexNormalizedEvent, CodexNormalizedSubject } from './hook-normalizer.js';
export {
  buildCodexNativeAuthSourceLockPath,
  executeCodexNativeAuthSourceLock,
  withCodexNativeAuthSourceLock,
} from './native-auth-source-lock.js';
export type { CodexNativeAuthSourceLockExecution } from './native-auth-source-lock.js';
export { CODEX_HOOK_RESPONSE_CAPABILITIES } from '../definition.js';
export {
  codexProviderContractCatalog,
  CODEX_CLIENT_ID,
  CODEX_CONTRACT_ID,
  CODEX_CONTRACT_VERSION,
  CODEX_SUPPORTED_INTERACTIONS,
  CODEX_RESPONSE_CAPABILITIES,
  CODEX_INTERACTION_BLOCKABILITY,
  createCodexSessionStartContextEffect,
  createCodexSessionStartBlockEffect,
  createCodexUserPromptSubmitContextEffect,
  createCodexUserPromptSubmitBlockEffect,
  createCodexPreToolUseBlockEffect,
  createCodexPreToolUseContextEffect,
  createCodexPreToolUseDenyEffect,
  createCodexPreToolUseUpdateEffect,
  createCodexPostToolUseContextEffect,
  createCodexPostToolUseBlockEffect,
  createCodexStopBlockEffect,
} from './hook-response-contracts.js';
export type { CodexEffects, CodexJsonValue } from './hook-response-contracts.js';
export { composeCodexHookResponse } from './hook-response-composer.js';

/**
 * MakaioExtension manifest for the Codex client session normalization service.
 *
 * Creates a {@link CodexClientSessionService} that bridges raw
 * `client:codex.hook.received` events into normalized `client.session.*`
 * observations when the Codex descriptor server entry activates.
 *
 * The `create()` factory requires the `clients-core` service so provider
 * contract registration and terminal hook composition cannot silently start
 * in a non-functional state.
 */
export const codexClientRuntimePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'codex.runtime',
  displayName: 'Codex Client Runtime',
  version: '0.1.0',
  dependencies: [dep('makaio.clients-core')],
  /**
   * Create the Codex client session service bound to the runtime bus.
   *
   * Resolves the clients-core service via {@link ClientsCoreToken} to
   * obtain the {@link ClientHookProviderContractRegistry} for provider
   * contract registration during the service lifecycle.
   * @param ctx - Runtime package context
   * @returns Uninitialized Codex client session service
   */
  create: (ctx) => {
    const clientsCore = ctx.getService(ClientsCoreToken);
    if (!clientsCore) throw new Error('codex.runtime requires makaio.clients-core');
    return new CodexClientSessionService(
      ctx.bus,
      undefined,
      ctx.machineId,
      undefined,
      clientsCore.providerContractRegistry,
      clientsCore.hookResponseRegistry,
    );
  },
};
