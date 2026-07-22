import { dep } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { ClientsCoreToken } from '@makaio/subsystem-client';
import { ClaudeCodeClientService } from './claude-code-client-service.js';
export { CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES } from '../definition.js';
export { ClaudeCodeClientSubjects } from './namespace.js';
export { ClaudeCodeClientService } from './claude-code-client-service.js';
export {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
  CLAUDE_CODE_HOOK_NOTIFICATION,
  CLAUDE_CODE_HOOK_MCP_SERVER_START,
  CLAUDE_CODE_HOOK_MCP_SERVER_STOP,
} from './schemas.js';
export { normalizeClaudeCodeHook } from './hook-normalizer.js';
export type { ClaudeCodeNormalizedEvent, ClaudeCodeNormalizedSubject } from './hook-normalizer.js';
export { normalizeClaudeCodeSessionUsage, normalizeClaudeCodeStatusline } from './statusline-normalizer.js';
export type { StatuslineIdentityContext } from './statusline-normalizer.js';
export { resolveClaudeCodeSettingsPaths } from './settings-paths.js';
export type { ClaudeCodeSettingsPath, ResolveClaudeCodeSettingsPathsOptions } from './settings-paths.js';
export { handleClaudeCodeSessionConfigSetup } from './session-config-handler.js';
export {
  claudeCodeToolResponseContract,
  createApproveEffect,
  createDenyEffect,
  CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
  CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_VERSION,
} from './hook-response-contracts.js';
export type {
  ClaudeCodePreToolUseEffects,
  ClaudeCodeToolDecision,
} from './hook-response-contracts.js';
export { composeHookResponse } from './hook-response-composer.js';
export {
  executeCredentialSourceLock as executeClaudeCodeNativeCredentialSourceLock,
  withCredentialSourceLock as withClaudeCodeNativeCredentialSourceLock,
} from './native-credential-source-lock.js';
export type { CredentialSourceLockExecution as ClaudeCodeNativeCredentialSourceLockExecution } from './native-credential-source-lock.js';
export {
  buildClaudeCodeCredentialsKeychainService,
  clearClaudeCodeNativeCredentialsForSession,
  cloneClaudeCodeNativeCredentialsForSession,
  inheritClaudeCodeNativeCredentialsForSession,
  removeClaudeCodeNativeCredentialsForSession,
} from './native-credentials.js';
export type {
  ClaudeCodeNativeCredentialClearRequest,
  ClaudeCodeNativeCredentialInheritanceRequest,
  ClaudeCodeNativeCredentialPreparationResult,
} from './native-credentials.js';

/**
 * Runtime package that registers Claude Code client-native namespaces and
 * creates the {@link ClaudeCodeClientService} that bridges raw hook events
 * into normalized `client.session.*` observations.
 */
export const claudeCodeClientRuntimePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'claude-code.runtime',
  displayName: 'Claude Code Client Runtime',
  version: '0.1.0',
  dependencies: [dep('makaio.clients-core')],
  /**
   * Create the Claude Code client service bound to the runtime bus.
   *
   * Retrieves the required {@link ClientsCoreService} via `ctx.getService`
   * and passes its provider contract and hook response registries to the
   * service. Missing clients-core fails activation immediately.
   * @param ctx - Runtime package context
   * @returns Uninitialized Claude Code client service
   */
  create: (ctx) => {
    const clientsCore = ctx.getService(ClientsCoreToken);
    if (!clientsCore) throw new Error('claude-code.runtime requires makaio.clients-core');
    return new ClaudeCodeClientService(
      ctx.bus,
      ctx.machineId,
      clientsCore.providerContractRegistry,
      clientsCore.hookResponseRegistry,
    );
  },
};
