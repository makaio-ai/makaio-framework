import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import { createTestBusInstance, createTestCall, makeStubExtensionBus } from '@makaio/test-utils';
import { addMcpServerToProject, removeMcpServerFromProject } from '../utils/mcp-settings.js';

describe('mcp-settings', () => {
  const carrier = { kind: 'makaio.extension', id: 'claude-code-tmux' };
  let carrierBus: IMakaioBus;
  let cleanup: Array<() => void>;

  beforeEach(() => {
    carrierBus = makeStubExtensionBus(createTestBusInstance(), carrier.id);
    cleanup = [];
  });

  afterEach(() => {
    for (const unsubscribe of cleanup) {
      unsubscribe();
    }
  });

  describe('addMcpServerToProject', () => {
    it('dispatches config.mcpServers.add with projectDir, name, and server', async () => {
      const capturedPayloads: unknown[] = [];
      const call = createTestCall({ principal: { kind: 'makaio.extension', id: 'requesting-extension' } });

      cleanup.push(
        carrierBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
          capturedPayloads.push(ctx.payload);
          expect(ctx.call).toMatchObject({ caller: carrier, principal: call.principal });
          ctx.setResult({ added: true, replaced: false });
        }),
      );

      const handled = await addMcpServerToProject(carrierBus, call, '/workspace/my-project', 'makaio-tools', {
        type: 'http',
        url: 'http://localhost:3000',
      });

      expect(handled).toBe(true);
      expect(capturedPayloads).toHaveLength(1);
      const payload = capturedPayloads[0] as Record<string, unknown>;
      expect(payload.projectDir).toBe('/workspace/my-project');
      expect(payload.name).toBe('makaio-tools');
      expect(payload.server).toEqual({ type: 'http', url: 'http://localhost:3000' });
    });

    it('forwards stdio server definitions', async () => {
      const capturedPayloads: unknown[] = [];

      cleanup.push(
        carrierBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
          capturedPayloads.push(ctx.payload);
          ctx.setResult({ added: true, replaced: false });
        }),
      );

      const handled = await addMcpServerToProject(carrierBus, createTestCall(), '/project', 'stdio-server', {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      });

      expect(handled).toBe(true);
      const payload = capturedPayloads[0] as Record<string, unknown>;
      expect(payload.server).toMatchObject({ type: 'stdio', command: 'node', args: ['server.js'] });
    });

    it('is idempotent when called with the same definition (handled by service)', async () => {
      // Test that we dispatch even when the result indicates no change.
      const capturedPayloads: unknown[] = [];

      cleanup.push(
        carrierBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
          capturedPayloads.push(ctx.payload);
          ctx.setResult({ added: false, replaced: false });
        }),
      );

      const handled = await addMcpServerToProject(carrierBus, createTestCall(), '/project', 'existing-server', {
        type: 'http',
        url: 'http://already-there',
      });

      expect(handled).toBe(true);
      expect(capturedPayloads).toHaveLength(1);
    });

    it('resolves false when no config service is registered', async () => {
      await expect(
        addMcpServerToProject(carrierBus, createTestCall(), '/project', 'makaio', {
          type: 'http',
          url: 'http://localhost:3000',
        }),
      ).resolves.toBe(false);
    });
  });

  describe('removeMcpServerFromProject', () => {
    it('dispatches config.mcpServers.remove with projectDir and name', async () => {
      const capturedPayloads: unknown[] = [];

      cleanup.push(
        carrierBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, (ctx) => {
          capturedPayloads.push(ctx.payload);
          expect(ctx.call).toMatchObject({ caller: carrier, principal: carrier });
          ctx.setResult({ removed: true });
        }),
      );

      const call = carrierBus.own('stop');
      const handled = await removeMcpServerFromProject(carrierBus, call, '/workspace/my-project', 'makaio-tools');

      expect(handled).toBe(true);
      expect(capturedPayloads).toHaveLength(1);
      const payload = capturedPayloads[0] as Record<string, unknown>;
      expect(payload.projectDir).toBe('/workspace/my-project');
      expect(payload.name).toBe('makaio-tools');
    });

    it('resolves even when the server does not exist (removed: false)', async () => {
      cleanup.push(
        carrierBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, (ctx) => {
          ctx.setResult({ removed: false });
        }),
      );

      await expect(
        removeMcpServerFromProject(carrierBus, carrierBus.own('stop'), '/project', 'missing-server'),
      ).resolves.toBe(true);
    });

    it('resolves false when no config service is registered', async () => {
      await expect(removeMcpServerFromProject(carrierBus, carrierBus.own('stop'), '/project', 'makaio')).resolves.toBe(
        false,
      );
    });
  });

  describe('error handling', () => {
    it('propagates bus errors', async () => {
      cleanup.push(
        carrierBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, () => {
          throw new Error('service unavailable');
        }),
      );

      await expect(
        addMcpServerToProject(carrierBus, createTestCall(), '/project', 'my-server', { type: 'http', url: 'http://x' }),
      ).rejects.toThrow('service unavailable');
    });
  });
});
