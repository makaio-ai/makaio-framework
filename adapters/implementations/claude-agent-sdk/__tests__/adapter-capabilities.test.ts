import { describe, expect, it } from 'vitest';
import type { AIAdapterRuntimeConfig } from '@makaio/ai-adapters-core';
import { ClaudeCodeAdapter } from '../src/adapter.js';

const allowedRuntimeConfig: AIAdapterRuntimeConfig = {
  adapterId: 'adapter-test',
  machineId: 'test-machine',
  ownerInstanceId: 'test-owner-instance',
};

const forbiddenRuntimeConfig: AIAdapterRuntimeConfig = {
  machineId: 'test-machine',
  ownerInstanceId: 'test-owner-instance',
  // @ts-expect-error Adapter implementations, not hosts, define capabilities.
  capabilities: ['forged-capability'],
};

void allowedRuntimeConfig;
void forbiddenRuntimeConfig;

describe('ClaudeCodeAdapter capabilities', () => {
  it('declares native structured output support', () => {
    const adapter = new ClaudeCodeAdapter({
      adapterId: 'adapter-test',
      machineId: 'test-machine',
      ownerInstanceId: 'test-owner-instance',
    });

    expect(adapter.capabilities).toContain('structuredOutput');
  });
});
