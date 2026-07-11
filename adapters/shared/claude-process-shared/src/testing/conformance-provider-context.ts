import type { ProviderContext, ProviderDefinitionInput } from '@makaio/contracts';
import { AuthCredentialRefSchema } from '@makaio/contracts/auth';
import { createTestProviderContext, normalizeEnvValue } from '@makaio/ai-adapters-core';
import { clientDefinition } from '@makaio/client-claude-code';

/**
 * Build the refs-only provider context used by Claude conformance connectors.
 *
 * Provider-owned methods use the generic test builder. The Claude-owned
 * `anthropic-oauth` surface explicitly selects the declared OAuth env ref when
 * it is present; otherwise it selects the declared native method. Merely
 * inheriting ambient vendor auth is never a third implicit option.
 * @param provider - Provider selected by the conformance preset
 * @param readEnv - Environment presence reader, injectable for deterministic tests
 * @returns Resolved refs-only provider context
 */
export function createClaudeConformanceProviderContext(
  provider: ProviderDefinitionInput,
  readEnv: (name: string) => string | undefined = (name) => process.env[name],
): ProviderContext {
  const defaultAuth = clientDefinition.defaultAuth;
  if (defaultAuth === undefined || provider.id !== defaultAuth.providerDefinitionId) {
    return createTestProviderContext(provider);
  }

  const nativeMethod = clientDefinition.authMethods.find(({ id }) => id === 'native');
  const oauthMethod = clientDefinition.authMethods.find(({ id }) => id === 'oauth-token');
  if (nativeMethod?.mode !== 'inferred' || oauthMethod?.mode !== 'explicit') {
    throw new Error('Claude Code client auth declarations are missing native or OAuth conformance methods.');
  }

  const oauthField = oauthMethod.fields.find(({ id }) => id === 'oauthToken');
  const oauthSource = oauthField?.sourceHints.find(({ kind }) => kind === 'environment');
  if (oauthField === undefined || oauthSource === undefined) {
    throw new Error('Claude Code OAuth conformance auth has no declared environment source.');
  }

  const base = {
    state: 'resolved' as const,
    providerConfigId: 'claude-conformance-provider-config',
    definitionId: provider.id,
    ...(provider.endpoints ? { endpointOverrides: { ...provider.endpoints } } : {}),
    ...(provider.capabilities ? { capabilities: structuredClone(provider.capabilities) } : {}),
  };
  if (normalizeEnvValue(readEnv(oauthSource.variable)) !== undefined) {
    return {
      ...base,
      auth: {
        mode: 'explicit',
        method: { owner: 'client', clientId: clientDefinition.id, methodId: oauthMethod.id },
        definition: structuredClone(oauthMethod),
        credentialRefs: {
          [oauthField.id]: AuthCredentialRefSchema.parse(`env:${oauthSource.variable}`),
        },
      },
    };
  }

  return {
    ...base,
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: clientDefinition.id, methodId: nativeMethod.id },
      definition: structuredClone(nativeMethod),
    },
  };
}
