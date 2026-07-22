/** Source-backed Codex 0.144.1 response contract tests. */
import { describe, expect, it } from 'vitest';
import { ClientHookProviderContractRegistry, ClientHookResponseRegistry } from '@makaio/subsystem-client';
import type { ContributorDefinition } from '@makaio/contracts/client';
import { createAppendEffect } from '@makaio/contracts/client';
import { composeCodexHookResponse } from '../hook-response-composer.js';
import {
  CODEX_INTERACTION_BLOCKABILITY,
  codexProviderContractCatalog,
  createCodexSessionStartBlockEffect,
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
  });
});
