import { describe, expect, it } from 'vitest';
import { AgentSchemas } from '../../agent/schemas.js';
import { CredentialNamespace } from '../namespace.js';

const PROVIDER_CONTEXT = {
  state: 'resolved' as const,
  providerConfigId: 'cfg-native',
  definitionId: 'anthropic',
  auth: {
    mode: 'inferred' as const,
    method: { owner: 'client' as const, clientId: 'claude-code', methodId: 'native' },
    definition: { id: 'native', mode: 'inferred' as const, label: 'Native Claude Code' },
    account: { managerId: 'account-manager', accountId: 'account-1' },
  },
};

describe('normalized credential lifecycle payloads', () => {
  it('accepts complete refs-only contexts for activation and change fan-out', () => {
    expect(CredentialNamespace.schemas.activate.request.safeParse({ providerContext: PROVIDER_CONTEXT }).success).toBe(
      true,
    );
    expect(
      CredentialNamespace.schemas.changed.request.safeParse({
        sessionId: 'session-1',
        changeSequence: 1,
        providerContext: PROVIDER_CONTEXT,
      }).success,
    ).toBe(true);
    expect(
      AgentSchemas['credential.change'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'claude-code-cli',
        changeSequence: 1,
        providerContext: PROVIDER_CONTEXT,
      }).success,
    ).toBe(true);
  });

  it('rejects retired top-level credential identity fields', () => {
    const legacy = {
      providerConfigId: 'cfg-native',
      definitionId: 'anthropic',
      credentialRefs: {},
    };
    expect(CredentialNamespace.schemas.activate.request.safeParse(legacy).success).toBe(false);
    expect(
      CredentialNamespace.schemas.changed.request.safeParse({
        sessionId: 'session-1',
        changeSequence: 1,
        ...legacy,
      }).success,
    ).toBe(false);
    expect(
      AgentSchemas['credential.change'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'claude-code-cli',
        changeSequence: 1,
        ...legacy,
      }).success,
    ).toBe(false);
    expect(
      AgentSchemas['credential.change'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'claude-code-cli',
        providerConfigId: 'legacy-duplicate-coordinate',
        changeSequence: 1,
        providerContext: PROVIDER_CONTEXT,
      }).success,
    ).toBe(false);
  });

  it('limits activation failures to credential-free stable codes', () => {
    expect(
      CredentialNamespace.schemas.activate.response.safeParse({
        success: false,
        code: 'account-not-found',
      }).success,
    ).toBe(true);
    expect(
      CredentialNamespace.schemas.activate.response.safeParse({
        success: false,
        code: 'secret-value',
      }).success,
    ).toBe(false);
  });

  it('limits agent rotation failures to strict credential-free stable codes', () => {
    expect(
      AgentSchemas['credential.change'].response.safeParse({
        success: false,
        reason: 'credential_activation_failed:account-not-found',
      }).success,
    ).toBe(true);
    expect(
      AgentSchemas['credential.change'].response.safeParse({
        success: false,
        reason: 'credential_swap_failed: secret-value',
      }).success,
    ).toBe(false);
    expect(
      AgentSchemas['credential.change'].response.safeParse({
        success: false,
        reason: 'credential_swap_failed',
        credentialRef: 'stored:providerConfig:cfg-native:apiKey',
      }).success,
    ).toBe(false);
  });
});
