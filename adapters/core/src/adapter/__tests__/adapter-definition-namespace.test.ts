import { createBusInstance } from '@makaio/bus-core';
import { describe, expect, it, vi } from 'vitest';
import { adapterDefinition as anthropic } from '../../../../implementations/anthropic-sdk/src/definition.js';
import { adapterDefinition as claudeSdk } from '../../../../implementations/claude-agent-sdk/src/definition.js';
import { adapterDefinition as claudeCli } from '../../../../implementations/claude-code-cli/src/definition.js';
import { adapterDefinition as claudeTmux } from '../../../../implementations/claude-code-tmux/src/definition.js';
import { adapterDefinition as codex } from '../../../../implementations/codex-app-server/src/definition.js';
import { adapterDefinition as cursor } from '../../../../implementations/cursor-sdk/src/definition.js';
import { adapterDefinition as openai } from '../../../../implementations/openai-node/src/definition.js';
import { adapterDefinition as pi } from '../../../../implementations/pi-sdk/src/definition.js';
import { adapterDefinition as qwen } from '../../../../implementations/qwen-acp/src/definition.js';

describe('adapter definitions', () => {
  it.each([
    anthropic,
    claudeSdk,
    claudeCli,
    claudeTmux,
    codex,
    cursor,
    openai,
    pi,
    qwen,
  ])('$name declares the namespace scoped by its factory', async (definition) => {
    const globalBus = createBusInstance();
    const scoped = vi.spyOn(globalBus, 'scoped');
    globalBus.registerNamespaces([definition.busNamespace]);
    const adapter = await definition.createAdapter({
      adapterId: 'namespace-test-adapter',
      ownerInstanceId: 'namespace-test-owner',
      machineId: 'namespace-test-machine',
      globalBus,
    });
    try {
      expect(scoped.mock.calls.map(([input]) => input.name)).toEqual([definition.busNamespace.name]);
    } finally {
      await adapter.closeAsync();
    }
  });
});
