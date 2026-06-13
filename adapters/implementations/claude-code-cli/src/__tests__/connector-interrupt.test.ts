import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ClaudeCliConnector } from '../connector.js';
import { ClaudeCodeCliConnectorNamespace, type ClaudeCodeCliConnectorBus } from '../namespace/index.js';

/**
 * Create a connector instance without initializing a CLI subprocess.
 * @returns Claude CLI connector under test.
 */
async function makeConnector(): Promise<ClaudeCliConnector> {
  const bus = (await ClaudeCodeCliConnectorNamespace.scopedBus()) as ClaudeCodeCliConnectorBus;
  return new ClaudeCliConnector({
    bus,
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    env: {},
  });
}

describe('ClaudeCliConnector interrupt', () => {
  it('rejects public interrupt requests as unsupported', async () => {
    const connector = await makeConnector();

    await expect(connector.interrupt()).rejects.toThrow('Claude Code CLI adapter does not support interrupt()');
  });
});
