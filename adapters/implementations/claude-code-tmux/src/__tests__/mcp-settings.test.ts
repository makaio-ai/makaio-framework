import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import { addMcpServerToProject, removeMcpServerFromProject } from '../utils/mcp-settings.js';

describe('mcp-settings', () => {
  let cleanup: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = [];
  });

  afterEach(() => {
    for (const unsubscribe of cleanup) {
      unsubscribe();
    }
    MakaioBus.__resetHandlers?.();
  });

  describe('addMcpServerToProject', () => {
    it('dispatches config.mcpServers.add with projectDir, name, and server', async () => {
      const capturedPayloads: unknown[] = [];

      cleanup.push(
        MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
          capturedPayloads.push(ctx.payload);
          ctx.setResult({ added: true, replaced: false });
        }),
      );

      const handled = await addMcpServerToProject('/workspace/my-project', 'makaio-tools', {
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
        MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
          capturedPayloads.push(ctx.payload);
          ctx.setResult({ added: true, replaced: false });
        }),
      );

      const handled = await addMcpServerToProject('/project', 'stdio-server', {
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
        MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, (ctx) => {
          capturedPayloads.push(ctx.payload);
          ctx.setResult({ added: false, replaced: false });
        }),
      );

      const handled = await addMcpServerToProject('/project', 'existing-server', {
        type: 'http',
        url: 'http://already-there',
      });

      expect(handled).toBe(true);
      expect(capturedPayloads).toHaveLength(1);
    });

    it('resolves false when no config service is registered', async () => {
      await expect(
        addMcpServerToProject('/project', 'makaio', { type: 'http', url: 'http://localhost:3000' }),
      ).resolves.toBe(false);
    });
  });

  describe('removeMcpServerFromProject', () => {
    it('dispatches config.mcpServers.remove with projectDir and name', async () => {
      const capturedPayloads: unknown[] = [];

      cleanup.push(
        MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, (ctx) => {
          capturedPayloads.push(ctx.payload);
          ctx.setResult({ removed: true });
        }),
      );

      const handled = await removeMcpServerFromProject('/workspace/my-project', 'makaio-tools');

      expect(handled).toBe(true);
      expect(capturedPayloads).toHaveLength(1);
      const payload = capturedPayloads[0] as Record<string, unknown>;
      expect(payload.projectDir).toBe('/workspace/my-project');
      expect(payload.name).toBe('makaio-tools');
    });

    it('resolves even when the server does not exist (removed: false)', async () => {
      cleanup.push(
        MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.remove, (ctx) => {
          ctx.setResult({ removed: false });
        }),
      );

      await expect(removeMcpServerFromProject('/project', 'missing-server')).resolves.toBe(true);
    });

    it('resolves false when no config service is registered', async () => {
      await expect(removeMcpServerFromProject('/project', 'makaio')).resolves.toBe(false);
    });
  });

  describe('error handling', () => {
    it('propagates bus errors', async () => {
      cleanup.push(
        MakaioBus.on(ClaudeCodeClientSubjects.config.mcpServers.add, () => {
          throw new Error('service unavailable');
        }),
      );

      await expect(addMcpServerToProject('/project', 'my-server', { type: 'http', url: 'http://x' })).rejects.toThrow(
        'service unavailable',
      );
    });
  });
});
