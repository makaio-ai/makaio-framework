/**
 * The Claude conformance auth selection, asserted against the real client
 * declarations rather than a stand-in for them.
 *
 * Both arms matter and neither is observable from a connector alone: the default
 * arm is what a live conformance run selects, and the `declared-credentials` arm
 * is what lets a default-suite case construct these connectors on a machine where
 * nobody has logged the vendor client in.
 *
 * The provider is supplied as the bare identity the selection branches on — the
 * client owns every auth method involved, so pulling in a provider contribution
 * package would add a dependency without adding a declaration under test.
 */
import type { ProviderDefinitionInput } from '@makaio/contracts';
import { describe, expect, it } from 'vitest';
import { clientDefinition } from '@makaio/client-claude-code';
import { createClaudeConformanceProviderContext } from './conformance-provider-context.js';

const oauthMethod = clientDefinition.authMethods.find((method) => method.id === 'oauth-token');
const oauthVariable =
  oauthMethod?.mode === 'explicit'
    ? oauthMethod.fields
        .find((field) => field.id === 'oauthToken')
        ?.sourceHints.find((hint) => hint.kind === 'environment')?.variable
    : undefined;

/**
 * Name the client-owned provider the selection branches on.
 * @returns Provider input carrying the client's declared default provider ID.
 */
function claudeClientProvider(): ProviderDefinitionInput {
  const providerDefinitionId = clientDefinition.defaultAuth?.providerDefinitionId;
  if (providerDefinitionId === undefined) {
    throw new Error('The Claude Code client declares no default provider, so it delegates no auth to select from.');
  }
  // No provider-owned auth methods: this provider delegates its entire auth
  // surface to the client, which is exactly the branch under test.
  return { id: providerDefinitionId, name: providerDefinitionId, authMethods: [] };
}

describe('createClaudeConformanceProviderContext', () => {
  it('selects the declared native method when nothing else is declared present', () => {
    const context = createClaudeConformanceProviderContext(claudeClientProvider(), { readEnv: () => undefined });

    // Narrowed by failing rather than by returning: a bare early return would let
    // an unresolved context pass this arm without asserting anything.
    if (context.state !== 'resolved') {
      expect.fail(`Expected a resolved context, received ${JSON.stringify(context)}`);
    }
    expect(context.auth.mode).toBe('inferred');
    expect(context.auth.method).toMatchObject({ owner: 'client', clientId: clientDefinition.id, methodId: 'native' });
  });

  it('selects the credential-backed method when its declared environment source is present', () => {
    expect(oauthVariable).toBeTruthy();
    const context = createClaudeConformanceProviderContext(claudeClientProvider(), {
      readEnv: (name) => (name === oauthVariable ? 'declared-token' : undefined),
    });

    if (context.state !== 'resolved' || context.auth.mode !== 'explicit') {
      expect.fail(`Expected an explicit selection, received ${JSON.stringify(context)}`);
    }
    expect(context.auth.method).toMatchObject({
      owner: 'client',
      clientId: clientDefinition.id,
      methodId: 'oauth-token',
    });
    expect(Object.values(context.auth.credentialRefs)).toContain(`env:${oauthVariable}`);
  });

  it('selects the credential-backed method for declared-credentials even with an empty environment', () => {
    // The property the default-suite teardown case depends on: the selection may
    // not fall back to inheriting ambient native login, because a case that only
    // passes on a logged-in machine is not a gate. The ref is emitted for the
    // harness to materialize.
    const context = createClaudeConformanceProviderContext(claudeClientProvider(), {
      readEnv: () => undefined,
      authSelection: 'declared-credentials',
    });

    if (context.state !== 'resolved' || context.auth.mode !== 'explicit') {
      expect.fail(`Expected an explicit selection, received ${JSON.stringify(context)}`);
    }
    expect(context.auth.method).toMatchObject({
      owner: 'client',
      clientId: clientDefinition.id,
      methodId: 'oauth-token',
    });
    expect(Object.values(context.auth.credentialRefs)).toContain(`env:${oauthVariable}`);
  });
});
