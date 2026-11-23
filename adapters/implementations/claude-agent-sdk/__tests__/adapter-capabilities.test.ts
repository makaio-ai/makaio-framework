import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AIAdapterRuntimeConfig } from '@makaio/ai-adapters-core';
import { createBusInstance } from '@makaio/bus-core';
import { ClaudeCodeAdapter } from '../src/adapter.js';

const allowedRuntimeConfig: AIAdapterRuntimeConfig = {
  adapterId: 'adapter-test',
  machineId: 'test-machine',
  ownerInstanceId: 'test-owner-instance',
  globalBus: createBusInstance(),
};

// Adapter implementations, not hosts, define capabilities.
expectTypeOf<AIAdapterRuntimeConfig>().not.toHaveProperty('capabilities');

describe('ClaudeCodeAdapter capabilities', () => {
  it('declares native structured output support', () => {
    const adapter = new ClaudeCodeAdapter(allowedRuntimeConfig);

    expect(adapter.capabilities).toContain('structuredOutput');
  });
});
