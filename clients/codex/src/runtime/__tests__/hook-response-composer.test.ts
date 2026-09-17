/** Source-backed Codex 0.144.1 response contract tests. */
import { describe, expect, it } from 'vitest';
import { ClientHookProviderContractRegistry, ClientHookResponseRegistry } from '@makaio/subsystem-client';
import type { ContributorDefinition } from '@makaio/contracts/client';
import { createAppendEffect, createSessionTokenEffect } from '@makaio/contracts/client';
import { composeCodexHookResponse } from '../hook-response-composer.js';
import {
  CODEX_INTERACTION_BLOCKABILITY,
  codexProviderContractCatalog,
  createCodexSessionStartBlockEffect,
  createCodexSessionStartContextEffect,
  createCodexPostToolUseBlockEffect,
  createCodexPreToolUseBlockEffect,
  createCodexPreToolUseContextEffect,
  createCodexPreToolUseDenyEffect,
  createCodexPreToolUseUpdateEffect,
  createCodexStopBlockEffect,
} from '../hook-response-contracts.js';
import { CODEX_HOOK_RESPONSE_CAPABILITIES } from '../../definition.js';

function registry(): ClientHookResponseRegistry {
  const contracts = new ClientHookProviderContractRegistry();
  contracts.registerProviderContract('codex.runtime', codexProviderContractCatalog);
  return new ClientHookResponseRegistry(contracts);
}
function payload(eventName: string) {
  return { eventName, receivedAt: Date.now(), payload: {} };
}
function install(target: ClientHookResponseRegistry, definition: ContributorDefinition): void {
  expect(target.installContributors('test', [definition]).errors).toEqual([]);
}
function provider(id: string, eventName: string, respond: ContributorDefinition['respond']): ContributorDefinition {
  return {
    lane: 'provider',
    clientId: 'codex',
    contractId: 'openai.codex-hook-response',
    id,
    priority: 1,
    timeoutMs: 1000,
    selectors: [{ kind: 'event-name', name: eventName }],
    respond,
  };
}

describe('Codex hook response contract', () => {
  it('renders SessionStart canonical context synchronously', async () => {
    const target = registry();
    install(target, {
      lane: 'canonical',
      clientIds: ['codex'],
      id: 'context',
      priority: 1,
      timeoutMs: 1000,
      selectors: [{ kind: 'event-name', name: 'SessionStart' }],
      respond: () => ({ canonicalEffects: [createAppendEffect('session context')] }),
    });
    expect(JSON.parse((await composeCodexHookResponse(target, payload('SessionStart'))).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'session context' },
    });
  });
  it('renders SessionStart blocks through the native continue contract', async () => {
    const target = registry();
    install(
      target,
      provider('session-block', 'SessionStart', () => ({
        providerEnvelope: createCodexSessionStartBlockEffect('startup rejected'),
      })),
    );

    expect(JSON.parse((await composeCodexHookResponse(target, payload('SessionStart'))).stdout)).toEqual({
      continue: false,
      stopReason: 'startup rejected',
    });
  });
  it('renders UserPromptSubmit blocks', async () => {
    const target = registry();
    install(
      target,
      provider('block', 'UserPromptSubmit', () => ({
        providerEnvelope: createCodexPostToolUseBlockEffect('stop prompt'),
      })),
    );
    expect(JSON.parse((await composeCodexHookResponse(target, payload('UserPromptSubmit'))).stdout)).toEqual({
      decision: 'block',
      reason: 'stop prompt',
    });
  });
  it('renders PreToolUse permission deny and input update', async () => {
    const target = registry();
    install(
      target,
      provider('deny', 'PreToolUse', () => ({ providerEnvelope: createCodexPreToolUseDenyEffect('deny') })),
    );
    expect(JSON.parse((await composeCodexHookResponse(target, payload('PreToolUse'))).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'deny' },
    });
    const update = registry();
    install(
      update,
      provider('update', 'PreToolUse', () => ({
        providerEnvelope: createCodexPreToolUseUpdateEffect({ command: 'echo safe' }),
      })),
    );
    expect(
      JSON.parse((await composeCodexHookResponse(update, payload('PreToolUse'))).stdout).hookSpecificOutput
        .updatedInput,
    ).toEqual({ command: 'echo safe' });
  });
  it('rejects top-level null updates while preserving nested JSON null values', async () => {
    // @ts-expect-error Codex's native `Option<Value>` parser rejects top-level null as an absent update.
    createCodexPreToolUseUpdateEffect(null);

    expect(
      codexProviderContractCatalog.validate(
        {
          providerEnvelope: {
            clientId: 'codex',
            contractId: 'openai.codex-hook-response',
            effects: { permissionDecision: 'allow', updatedInput: null },
          },
        },
        { eventName: 'PreToolUse' },
      ),
    ).toContain("Unsupported Codex response effects for 'PreToolUse'");

    const target = registry();
    install(
      target,
      provider('nested-null', 'PreToolUse', () => ({
        providerEnvelope: createCodexPreToolUseUpdateEffect({ command: null }),
      })),
    );
    expect(
      JSON.parse((await composeCodexHookResponse(target, payload('PreToolUse'))).stdout).hookSpecificOutput
        .updatedInput,
    ).toEqual({ command: null });
  });
  it('renders PostToolUse and Stop blocks', async () => {
    const post = registry();
    install(
      post,
      provider('post', 'PostToolUse', () => ({ providerEnvelope: createCodexPostToolUseBlockEffect('post block') })),
    );
    expect(JSON.parse((await composeCodexHookResponse(post, payload('PostToolUse'))).stdout)).toEqual({
      decision: 'block',
      reason: 'post block',
    });
    const stop = registry();
    install(
      stop,
      provider('stop', 'Stop', () => ({ providerEnvelope: createCodexStopBlockEffect('continue') })),
    );
    expect(JSON.parse((await composeCodexHookResponse(stop, payload('Stop'))).stdout)).toEqual({
      decision: 'block',
      reason: 'continue',
    });
  });
  it('rejects an effect for the wrong event', async () => {
    const target = registry();
    install(
      target,
      provider('wrong', 'Stop', () => ({ providerEnvelope: createCodexPreToolUseDenyEffect('no') })),
    );
    expect(await composeCodexHookResponse(target, payload('Stop'))).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('uses restrictive block precedence over deny and input updates', async () => {
    const target = registry();
    install(
      target,
      provider('update', 'PreToolUse', () => ({
        providerEnvelope: createCodexPreToolUseUpdateEffect({ command: 'echo rewritten' }),
      })),
    );
    install(
      target,
      provider('deny', 'PreToolUse', () => ({ providerEnvelope: createCodexPreToolUseDenyEffect('deny') })),
    );
    install(
      target,
      provider('block', 'PreToolUse', () => ({ providerEnvelope: createCodexPreToolUseBlockEffect('block') })),
    );

    expect(JSON.parse((await composeCodexHookResponse(target, payload('PreToolUse'))).stdout)).toEqual({
      decision: 'block',
      reason: 'block',
    });
  });

  it('uses the pinned event-specific block-reason aggregation rules', async () => {
    const preTool = registry();
    install(
      preTool,
      provider('first', 'PreToolUse', () => ({ providerEnvelope: createCodexPreToolUseBlockEffect('first') })),
    );
    install(
      preTool,
      provider('second', 'PreToolUse', () => ({ providerEnvelope: createCodexPreToolUseBlockEffect('second') })),
    );
    expect(JSON.parse((await composeCodexHookResponse(preTool, payload('PreToolUse'))).stdout).reason).toBe('first');

    const postTool = registry();
    install(
      postTool,
      provider('first', 'PostToolUse', () => ({ providerEnvelope: createCodexPostToolUseBlockEffect('first') })),
    );
    install(
      postTool,
      provider('second', 'PostToolUse', () => ({ providerEnvelope: createCodexPostToolUseBlockEffect('second') })),
    );
    expect(JSON.parse((await composeCodexHookResponse(postTool, payload('PostToolUse'))).stdout).reason).toBe(
      'first\n\nsecond',
    );
  });

  it('rejects incompatible input rewrites instead of selecting one silently', async () => {
    const target = registry();
    install(
      target,
      provider('first', 'PreToolUse', () => ({
        providerEnvelope: createCodexPreToolUseUpdateEffect({ command: 'echo first' }),
      })),
    );
    install(
      target,
      provider('second', 'PreToolUse', () => ({
        providerEnvelope: createCodexPreToolUseUpdateEffect({ command: 'echo second' }),
      })),
    );

    await expect(composeCodexHookResponse(target, payload('PreToolUse'))).rejects.toThrow(
      'Conflicting Codex PreToolUse input.update effects',
    );
  });

  it('renders PreToolUse native context and ignores canonical context where unsupported', async () => {
    const preTool = registry();
    install(
      preTool,
      provider('context', 'PreToolUse', () => ({ providerEnvelope: createCodexPreToolUseContextEffect('remember') })),
    );
    expect(JSON.parse((await composeCodexHookResponse(preTool, payload('PreToolUse'))).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'remember' },
    });

    const stop = registry();
    install(stop, {
      lane: 'canonical',
      clientIds: ['codex'],
      id: 'unsupported-context',
      priority: 1,
      timeoutMs: 1000,
      selectors: [{ kind: 'event-name', name: 'Stop' }],
      respond: () => ({ canonicalEffects: [createAppendEffect('must not render')] }),
    });
    expect(await composeCodexHookResponse(stop, payload('Stop'))).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('validates exact envelopes and event-specific effect schemas', () => {
    const context = { eventName: 'PreToolUse' };
    expect(
      codexProviderContractCatalog.validate(
        { providerEnvelope: createCodexPreToolUseUpdateEffect({ command: 'echo safe' }) },
        context,
      ),
    ).toBe(true);
    expect(
      codexProviderContractCatalog.validate(
        {
          providerEnvelope: {
            ...createCodexPreToolUseBlockEffect('stop'),
            unexpected: true,
          },
        },
        context,
      ),
    ).toContain("Unsupported Codex providerEnvelope field 'unexpected'");
    expect(
      codexProviderContractCatalog.validate(
        { providerEnvelope: createCodexPreToolUseContextEffect('not supported on Stop') },
        { eventName: 'Stop' },
      ),
    ).toContain("Unsupported Codex response effects for 'Stop'");
  });

  it('SubagentStart accepts context effects and rejects block or deny effects', () => {
    expect(
      codexProviderContractCatalog.validate(
        { providerEnvelope: createCodexSessionStartContextEffect('boot hint') },
        { eventName: 'SubagentStart' },
      ),
    ).toBe(true);
    expect(
      codexProviderContractCatalog.validate(
        { providerEnvelope: createCodexSessionStartBlockEffect('rejected') },
        { eventName: 'SubagentStart' },
      ),
    ).toContain("Unsupported Codex response effects for 'SubagentStart'");
    expect(
      codexProviderContractCatalog.validate(
        { providerEnvelope: createCodexPreToolUseDenyEffect('denied') },
        { eventName: 'SubagentStart' },
      ),
    ).toContain("Unsupported Codex response effects for 'SubagentStart'");
  });

  it.each([
    CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny,
    CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate,
  ])('fails closed when a throwing %s capability contributor is selected', async (capability) => {
    const target = registry();
    install(target, {
      lane: 'provider',
      clientId: 'codex',
      contractId: 'openai.codex-hook-response',
      id: `${capability}-closed`,
      priority: 1,
      timeoutMs: 1000,
      failurePolicy: 'closed',
      selectors: [{ kind: 'capability', capability }],
      respond: () => {
        throw new Error(`failed ${capability}`);
      },
    });

    expect(JSON.parse((await composeCodexHookResponse(target, payload('PreToolUse'))).stdout)).toEqual({
      decision: 'block',
      reason: expect.stringContaining(`failed ${capability}`),
    });
  });

  it('marks only PreToolUse native capabilities as independently blockable', () => {
    const blockability = new Map(
      CODEX_INTERACTION_BLOCKABILITY.map(({ interaction, blockable }) => [interaction, blockable]),
    );

    expect(blockability.get(CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny)).toBe(true);
    expect(blockability.get(CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate)).toBe(true);
    expect(blockability.get('context.append')).toBe(false);
    expect(blockability.get('session.token')).toBe(false);
  });

  describe('session.token canonical effect', () => {
    // Codex does not declare `session.token` on any of its hook events (neither
    // SessionStart nor SubagentStart): it passes no session id to MCP subprocesses,
    // so no consumer can key `client.session.token.get`. The composer infrastructure
    // (resolveSessionTokenScope, the sink callback, CANONICAL_HOOK_RESPONSE_CAPABILITIES
    // import) remains in place — adding `session.token` to `responseCapabilities` is
    // the only change needed once such a lookup key exists on Codex.
    //
    // All tests below verify that the sink is NOT called for any Codex event.

    it('drops the token on SessionStart — session.token not declared for Codex', async () => {
      const target = registry();
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-session-start',
        priority: 1,
        timeoutMs: 1000,
        selectors: [{ kind: 'event-name', name: 'SessionStart' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-abc')] }),
      });

      const sinkCalls: string[] = [];
      const rawPayload = { eventName: 'SessionStart', receivedAt: Date.now(), payload: { session_id: 'sid-1' } };
      const response = await composeCodexHookResponse(target, rawPayload, {
        onSessionToken: (token) => {
          sinkCalls.push(token);
        },
      });

      // session.token not declared on SessionStart — sink must not be called.
      expect(sinkCalls).toEqual([]);

      // Token value must not leak to stdout either.
      expect(response.stdout).not.toContain('tok-abc');
    });

    it('drops the token when the event does not declare the session.token capability', async () => {
      const target = registry();
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-post-tool-use',
        priority: 1,
        timeoutMs: 1000,
        // PostToolUse does not declare session.token — the effect must be dropped.
        selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-dropped')] }),
      });

      const sinkCalls: string[] = [];
      const rawPayload = { eventName: 'PostToolUse', receivedAt: Date.now(), payload: { session_id: 'sid-2' } };
      await composeCodexHookResponse(target, rawPayload, {
        onSessionToken: (token) => {
          sinkCalls.push(token);
        },
      });

      expect(sinkCalls).toEqual([]);
    });

    it('drops the token on SubagentStart — session.token not declared for Codex', async () => {
      const target = registry();
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-subagent-start',
        priority: 1,
        timeoutMs: 1000,
        selectors: [{ kind: 'event-name', name: 'SubagentStart' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-sub')] }),
      });

      const sinkCalls: string[] = [];
      const rawPayload = {
        eventName: 'SubagentStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sid-3', agent_id: 'agent-xyz' },
      };
      await composeCodexHookResponse(target, rawPayload, {
        onSessionToken: (token) => {
          sinkCalls.push(token);
        },
      });

      expect(sinkCalls).toEqual([]);
    });

    it('does not call the sink even when multiple contributors return tokens', async () => {
      const target = registry();
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-low-priority',
        priority: 1,
        timeoutMs: 1000,
        selectors: [{ kind: 'event-name', name: 'SessionStart' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-low')] }),
      });
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-high-priority',
        priority: 10,
        timeoutMs: 1000,
        selectors: [{ kind: 'event-name', name: 'SessionStart' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-high')] }),
      });

      const sinkCalls: string[] = [];
      const rawPayload = { eventName: 'SessionStart', receivedAt: Date.now(), payload: { session_id: 'sid-4' } };
      await composeCodexHookResponse(target, rawPayload, {
        onSessionToken: (token) => {
          sinkCalls.push(token);
        },
      });

      // Capability not declared — sink must not be called regardless of priority.
      expect(sinkCalls).toEqual([]);
    });

    it('does not call the sink on SubagentStart without agent_id', async () => {
      const target = registry();
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-subagent-no-id',
        priority: 1,
        timeoutMs: 1000,
        selectors: [{ kind: 'event-name', name: 'SubagentStart' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-orphan')] }),
      });

      const sinkCalls: string[] = [];
      const rawPayload = {
        eventName: 'SubagentStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sid-parent' },
      };
      await composeCodexHookResponse(target, rawPayload, {
        onSessionToken: (token) => {
          sinkCalls.push(token);
        },
      });

      expect(sinkCalls).toEqual([]);
    });

    it('does not call the sink on SessionStart with a stray agent_id', async () => {
      const target = registry();
      install(target, {
        lane: 'canonical',
        clientIds: ['codex'],
        id: 'token-session-stray-agent',
        priority: 1,
        timeoutMs: 1000,
        selectors: [{ kind: 'event-name', name: 'SessionStart' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-stray')] }),
      });

      const sinkCalls: string[] = [];
      const rawPayload = {
        eventName: 'SessionStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sid-5', agent_id: 'stray-id' },
      };
      await composeCodexHookResponse(target, rawPayload, {
        onSessionToken: (token) => {
          sinkCalls.push(token);
        },
      });

      // session.token not declared on SessionStart — sink must not be called.
      expect(sinkCalls).toEqual([]);
    });
  });
});
