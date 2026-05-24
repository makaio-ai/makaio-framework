/**
 * Tests for adapter identity propagation in the MCP server.
 *
 * Verifies that when an adapter session is registered with identity fields
 * (adapterId, adapterName), those fields are correctly threaded through to:
 * - `ToolSubjects.list` on `tools/list` requests (for policy filtering)
 * - `ToolSubjects.execute` on `tools/call` requests (for policy enforcement)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { McpSubjects, ToolSubjects } from '@makaio/contracts';
import { McpServerBridgeService } from '../mcp-server-bridge-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an MCP client connected to a specific adapter session on the bridge.
 * @param port - Bridge HTTP port
 * @param adapterSessionId - Adapter session routed through the bridge query param
 * @returns Connected client and transport
 */
async function createMcpClient(
  port: number,
  adapterSessionId: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'identity-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp?adapterSessionId=${encodeURIComponent(adapterSessionId)}`),
  );
  await client.connect(transport);
  return { client, transport };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP server adapter identity propagation', () => {
  let bus: IMakaioBus;
  let service: McpServerBridgeService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new McpServerBridgeService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  describe('tools/list identity propagation', () => {
    it('passes adapterId and adapterName to ToolSubjects.list for a registered session', async () => {
      const capturedListPayloads: Array<{ adapterId?: string; adapterName?: string }> = [];

      const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
        capturedListPayloads.push({
          adapterId: ctx.payload.adapterId,
          adapterName: ctx.payload.adapterName,
        });
        ctx.setResult({ tools: [], toolsets: [] });
      });

      try {
        const registration = await bus.request(McpSubjects.session.register, {
          adapterSessionId: 'identity-list-session',
          agentId: 'agent-1',
          adapterId: 'my-adapter-id',
          adapterName: 'my-adapter-name',
          sessionId: 'session-1',
          contextOverrides: {},
        });

        const { client, transport } = await createMcpClient(registration.port, 'identity-list-session');
        try {
          await client.listTools();
        } finally {
          await client.close();
          await transport.close();
        }

        expect(capturedListPayloads).toHaveLength(1);
        expect(capturedListPayloads[0].adapterId).toBe('my-adapter-id');
        expect(capturedListPayloads[0].adapterName).toBe('my-adapter-name');
      } finally {
        cleanupList();
      }
    });

    it('omits identity fields when adapter session is not registered', async () => {
      const capturedListPayloads: Array<{ adapterId?: string; adapterName?: string }> = [];

      const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
        capturedListPayloads.push({
          adapterId: ctx.payload.adapterId,
          adapterName: ctx.payload.adapterName,
        });
        ctx.setResult({ tools: [], toolsets: [] });
      });

      try {
        // Register one session to start the server
        const registration = await bus.request(McpSubjects.session.register, {
          adapterSessionId: 'known-session',
          agentId: 'agent-1',
          adapterId: 'known-adapter-id',
          adapterName: 'known-adapter',
          sessionId: 'session-1',
          contextOverrides: {},
        });

        // Connect as an unknown session
        const { client, transport } = await createMcpClient(registration.port, 'unknown-session');
        try {
          await client.listTools();
        } finally {
          await client.close();
          await transport.close();
        }

        expect(capturedListPayloads).toHaveLength(1);
        expect(capturedListPayloads[0].adapterId).toBeUndefined();
        expect(capturedListPayloads[0].adapterName).toBeUndefined();
      } finally {
        cleanupList();
      }
    });
  });

  describe('tools/call identity propagation', () => {
    it('passes adapterId and adapterName at top level in ToolSubjects.execute for a registered session', async () => {
      const capturedExecutePayloads: Array<{ adapterId?: string; adapterName?: string }> = [];

      const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'echo',
              description: 'Echo tool',
              toolsetName: 'test-tools',
              inputSchema: { type: 'object' },
            },
          ],
          toolsets: [],
        });
      });
      const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
        capturedExecutePayloads.push({
          adapterId: ctx.payload.adapterId,
          adapterName: ctx.payload.adapterName,
        });
        ctx.setResult({ success: true, data: { ok: true } });
      });

      try {
        const registration = await bus.request(McpSubjects.session.register, {
          adapterSessionId: 'identity-exec-session',
          agentId: 'agent-2',
          adapterId: 'exec-adapter-id',
          adapterName: 'exec-adapter-name',
          sessionId: 'session-2',
          contextOverrides: {},
        });

        const { client, transport } = await createMcpClient(registration.port, 'identity-exec-session');
        try {
          await client.callTool({ name: 'echo', arguments: { value: 'test' } });
        } finally {
          await client.close();
          await transport.close();
        }

        expect(capturedExecutePayloads).toHaveLength(1);
        expect(capturedExecutePayloads[0].adapterId).toBe('exec-adapter-id');
        expect(capturedExecutePayloads[0].adapterName).toBe('exec-adapter-name');
      } finally {
        cleanupExecute();
        cleanupList();
      }
    });

    it('omits identity fields in ToolSubjects.execute when session is unknown', async () => {
      const capturedExecutePayloads: Array<{ adapterId?: string; adapterName?: string }> = [];

      const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'echo',
              description: 'Echo tool',
              toolsetName: 'test-tools',
              inputSchema: { type: 'object' },
            },
          ],
          toolsets: [],
        });
      });
      const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
        capturedExecutePayloads.push({
          adapterId: ctx.payload.adapterId,
          adapterName: ctx.payload.adapterName,
        });
        ctx.setResult({ success: true, data: { ok: true } });
      });

      try {
        // Register one session to start the server
        const registration = await bus.request(McpSubjects.session.register, {
          adapterSessionId: 'known-exec-session',
          agentId: 'agent-3',
          adapterId: 'known-exec-adapter',
          adapterName: 'known-exec-adapter-name',
          sessionId: 'session-3',
          contextOverrides: {},
        });

        // Connect as an unknown session
        const { client, transport } = await createMcpClient(registration.port, 'unknown-exec-session');
        try {
          await client.callTool({ name: 'echo', arguments: { value: 'test' } });
        } finally {
          await client.close();
          await transport.close();
        }

        expect(capturedExecutePayloads).toHaveLength(1);
        expect(capturedExecutePayloads[0].adapterId).toBeUndefined();
        expect(capturedExecutePayloads[0].adapterName).toBeUndefined();
      } finally {
        cleanupExecute();
        cleanupList();
      }
    });
  });
});
