import { describe, expect, it } from 'vitest';
import {
  McpAgentContextSchema,
  McpAutoReconnectConfigSchema,
  McpGlobalConfigSchema,
  McpProjectConfigSchema,
  McpSchemas,
  McpTransportConfigSchema,
} from '../schemas.js';

describe('McpTransportConfigSchema', () => {
  it('rejects malformed URLs for SSE and HTTP transports', () => {
    const sse = McpTransportConfigSchema.safeParse({
      type: 'sse',
      url: 'not-a-url',
    });
    const http = McpTransportConfigSchema.safeParse({
      type: 'http',
      url: 'still-not-a-url',
    });

    expect(sse.success).toBe(false);
    expect(http.success).toBe(false);
  });

  it('accepts valid URLs for SSE and HTTP transports', () => {
    const sse = McpTransportConfigSchema.safeParse({
      type: 'sse',
      url: 'https://example.com/sse',
    });
    const http = McpTransportConfigSchema.safeParse({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    });

    expect(sse.success).toBe(true);
    expect(http.success).toBe(true);
  });
});

describe('MCP pattern constraints', () => {
  it('rejects excessively long hide/expose patterns', () => {
    const tooLong = 'a'.repeat(257);
    const global = McpGlobalConfigSchema.safeParse({
      servers: {},
      hideTools: [tooLong],
    });
    const project = McpProjectConfigSchema.safeParse({
      hideTools: [tooLong],
    });

    expect(global.success).toBe(false);
    expect(project.success).toBe(false);
  });

  it('rejects patterns with too many wildcards', () => {
    const tooManyWildcards = 'a***********';
    const global = McpGlobalConfigSchema.safeParse({
      servers: {},
      exposeTools: [tooManyWildcards],
    });

    expect(global.success).toBe(false);
  });
});

describe('McpAutoReconnectConfigSchema', () => {
  it('rejects maxDelayMs smaller than baseDelayMs', () => {
    const result = McpAutoReconnectConfigSchema.safeParse({
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 5000,
      maxDelayMs: 1000,
    });

    expect(result.success).toBe(false);
  });
});

describe('McpAgentContextSchema', () => {
  it('accepts a fully-populated agent context', () => {
    const result = McpAgentContextSchema.safeParse({
      agentId: 'agent-1',
      adapterId: 'claude-code',
      adapterName: 'Claude Code',
      adapterSessionId: 'sess-abc',
      sessionId: 'session-xyz',
    });

    expect(result.success).toBe(true);
  });

  it('rejects when agentId is missing', () => {
    const result = McpAgentContextSchema.safeParse({
      adapterId: 'claude-code',
      adapterName: 'Claude Code',
      adapterSessionId: 'sess-abc',
      sessionId: 'session-xyz',
    });

    expect(result.success).toBe(false);
  });

  it('rejects when adapterSessionId is missing', () => {
    const result = McpAgentContextSchema.safeParse({
      agentId: 'agent-1',
      adapterId: 'claude-code',
      adapterName: 'Claude Code',
      sessionId: 'session-xyz',
    });

    expect(result.success).toBe(false);
  });
});

describe('McpSchemas["session.register"]', () => {
  describe('request', () => {
    it('accepts a valid register request with all fields', () => {
      const result = McpSchemas['session.register'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'claude-code',
        adapterName: 'Claude Code',
        adapterSessionId: 'sess-abc',
        sessionId: 'session-xyz',
        contextOverrides: {
          cwd: '/workspace',
          sessionId: 'session-xyz',
          agentId: 'agent-1',
        },
      });

      expect(result.success).toBe(true);
    });

    it('accepts a valid register request with an empty contextOverrides', () => {
      const result = McpSchemas['session.register'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'claude-code',
        adapterName: 'Claude Code',
        adapterSessionId: 'sess-abc',
        sessionId: 'session-xyz',
        contextOverrides: {},
      });

      expect(result.success).toBe(true);
    });

    it('rejects when adapterSessionId is missing', () => {
      const result = McpSchemas['session.register'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'claude-code',
        adapterName: 'Claude Code',
        sessionId: 'session-xyz',
        contextOverrides: {},
      });

      expect(result.success).toBe(false);
    });

    it('rejects when contextOverrides is missing', () => {
      const result = McpSchemas['session.register'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'claude-code',
        adapterName: 'Claude Code',
        adapterSessionId: 'sess-abc',
        sessionId: 'session-xyz',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('response', () => {
    it('accepts a valid response with a positive port', () => {
      const result = McpSchemas['session.register'].response.safeParse({
        port: 8080,
      });

      expect(result.success).toBe(true);
    });

    it('rejects a zero port', () => {
      const result = McpSchemas['session.register'].response.safeParse({
        port: 0,
      });

      expect(result.success).toBe(false);
    });

    it('rejects a negative port', () => {
      const result = McpSchemas['session.register'].response.safeParse({
        port: -1,
      });

      expect(result.success).toBe(false);
    });
  });
});

describe('McpSchemas["session.unregister"]', () => {
  describe('request', () => {
    it('accepts a valid unregister request', () => {
      const result = McpSchemas['session.unregister'].request.safeParse({
        adapterSessionId: 'sess-abc',
      });

      expect(result.success).toBe(true);
    });

    it('rejects when adapterSessionId is missing', () => {
      const result = McpSchemas['session.unregister'].request.safeParse({});

      expect(result.success).toBe(false);
    });
  });

  describe('response', () => {
    it('accepts an empty object', () => {
      const result = McpSchemas['session.unregister'].response.safeParse({});

      expect(result.success).toBe(true);
    });
  });
});
