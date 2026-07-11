import { describe, expect, it } from 'vitest';
import type { ProviderContext } from '@makaio/contracts';
import { AuthCredentialRefSchema, type AuthCredentialRef } from '@makaio/contracts/auth';
import { providerContextsEqual } from '../provider-context-equality.js';

function explicitContext(
  ref: AuthCredentialRef = AuthCredentialRefSchema.parse('env:ANTHROPIC_API_KEY'),
): ProviderContext {
  return {
    state: 'resolved',
    providerConfigId: 'anthropic-work',
    definitionId: 'anthropic',
    endpointOverrides: { anthropic: 'https://api.example.test' },
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
      definition: {
        id: 'api-key',
        mode: 'explicit',
        label: 'API key',
        fields: [
          {
            id: 'apiKey',
            label: 'API key',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
          },
        ],
      },
      credentialRefs: { apiKey: ref },
    },
    capabilities: { structuredOutput: { strict: true } },
  };
}

describe('providerContextsEqual', () => {
  it('treats two closed unresolved contexts as equal', () => {
    expect(providerContextsEqual({ state: 'unresolved' }, { state: 'unresolved' })).toBe(true);
  });

  it('distinguishes resolved and unresolved state', () => {
    expect(providerContextsEqual(explicitContext(), { state: 'unresolved' })).toBe(false);
  });

  it('compares normalized auth refs as identities', () => {
    expect(providerContextsEqual(explicitContext(), explicitContext())).toBe(true);
    expect(
      providerContextsEqual(
        explicitContext(),
        explicitContext(AuthCredentialRefSchema.parse('stored:providerConfig:work:apiKey')),
      ),
    ).toBe(false);
  });

  it('compares record values independently of key insertion order', () => {
    const left = explicitContext();
    const right = explicitContext();
    if (left.state === 'resolved' && right.state === 'resolved') {
      left.capabilities = { first: true, second: false };
      right.capabilities = { second: false, first: true };
    }

    expect(providerContextsEqual(left, right)).toBe(true);
  });

  it('detects definition, endpoint, and capability changes', () => {
    const baseline = explicitContext();
    const changedDefinition = explicitContext();
    const changedEndpoint = explicitContext();
    const changedCapability = explicitContext();
    if (
      changedDefinition.state === 'resolved' &&
      changedDefinition.auth.mode === 'explicit' &&
      changedEndpoint.state === 'resolved' &&
      changedCapability.state === 'resolved'
    ) {
      changedDefinition.auth.definition.fields[0].sourceHints = [{ kind: 'environment', variable: 'OTHER_API_KEY' }];
      changedEndpoint.endpointOverrides = { anthropic: 'https://other.example.test' };
      changedCapability.capabilities = { structuredOutput: { strict: false } };
    }

    expect(providerContextsEqual(baseline, changedDefinition)).toBe(false);
    expect(providerContextsEqual(baseline, changedEndpoint)).toBe(false);
    expect(providerContextsEqual(baseline, changedCapability)).toBe(false);
  });
});
