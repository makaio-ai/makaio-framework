import { describe, it, expect } from 'bun:test';
import { ToolSchemas } from '../schemas.js';

describe('ToolSchemas', () => {
  describe('execute.request', () => {
    it('should accept toolName and input as required fields', () => {
      const payload = {
        toolName: 'myTool',
        input: { key: 'value' },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should accept contextOverrides with cwd', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        contextOverrides: {
          cwd: '/custom/path',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contextOverrides?.cwd).toBe('/custom/path');
      }
    });

    it('should accept contextOverrides with env', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        contextOverrides: {
          env: { NODE_ENV: 'test', DEBUG: 'true' },
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contextOverrides?.env).toEqual({
          NODE_ENV: 'test',
          DEBUG: 'true',
        });
      }
    });

    it('should accept contextOverrides with sessionId', () => {
      const payload = {
        toolName: 'myTool',
        input: { action: 'create' },
        contextOverrides: {
          sessionId: 'session-abc-123',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contextOverrides?.sessionId).toBe('session-abc-123');
      }
    });

    it('should reject override-only adapter identity', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        contextOverrides: {
          adapterId: 'adapter-runtime-1',
          adapterName: 'claude-code',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          {
            code: 'custom',
            message:
              'adapter identity must be provided at the top level; contextOverrides cannot supply adapter identity',
            path: ['contextOverrides', 'adapterId'],
          },
          {
            code: 'custom',
            message:
              'adapter identity must be provided at the top level; contextOverrides cannot supply adapter identity',
            path: ['contextOverrides', 'adapterName'],
          },
        ]);
      }
    });

    it('should accept matching top-level and contextOverrides adapter identity', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        adapterId: 'adapter-runtime-1',
        adapterName: 'claude-code',
        contextOverrides: {
          adapterId: 'adapter-runtime-1',
          adapterName: 'claude-code',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should accept partial top-level adapter identity without overrides', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        adapterName: 'claude-code',
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.adapterId).toBeUndefined();
        expect(result.data.adapterName).toBe('claude-code');
      }
    });

    it('should reject conflicting adapter identity between top-level fields and contextOverrides', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        adapterId: 'adapter-runtime-1',
        adapterName: 'claude-code',
        contextOverrides: {
          adapterId: 'different-adapter',
          adapterName: 'openai-node',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should reject partial cross-source adapter identity mixing', () => {
      const payloads = [
        {
          toolName: 'myTool',
          input: {},
          adapterName: 'claude-code',
          contextOverrides: {
            adapterId: 'adapter-runtime-1',
            adapterName: 'claude-code',
          },
        },
        {
          toolName: 'myTool',
          input: {},
          adapterId: 'adapter-runtime-1',
          contextOverrides: {
            adapterId: 'adapter-runtime-1',
            adapterName: 'claude-code',
          },
        },
      ];

      const expectedMessages = [
        'contextOverrides.adapterId cannot supply adapter identity when top-level adapter identity is present',
        'contextOverrides.adapterName cannot supply adapter identity when top-level adapter identity is present',
      ];

      for (const [index, payload] of payloads.entries()) {
        const result = ToolSchemas.execute.request.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toEqual([
            {
              code: 'custom',
              message: expectedMessages[index],
              path: ['contextOverrides', index === 0 ? 'adapterId' : 'adapterName'],
            },
          ]);
        }
      }
    });

    it('should reject override-only partial adapter identity', () => {
      const payloads = [
        {
          toolName: 'myTool',
          input: {},
          contextOverrides: {
            adapterId: 'adapter-runtime-1',
          },
        },
        {
          toolName: 'myTool',
          input: {},
          contextOverrides: {
            adapterName: 'claude-code',
          },
        },
      ];

      for (const payload of payloads) {
        const result = ToolSchemas.execute.request.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it('should accept contextOverrides with turnContext', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        contextOverrides: {
          turnContext: {
            terminalSessionKey: 'proj::default::term-1',
          },
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contextOverrides?.turnContext).toEqual({
          terminalSessionKey: 'proj::default::term-1',
        });
      }
    });

    it('should accept contextOverrides with toolCallId', () => {
      const payload = {
        toolName: 'myTool',
        input: {},
        contextOverrides: {
          toolCallId: 'call_abc123',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contextOverrides?.toolCallId).toBe('call_abc123');
      }
    });

    it('should accept all fields together when adapter identity is top-level', () => {
      const payload = {
        toolName: 'taskTool',
        input: { title: 'New Task' },
        adapterId: 'adapter-runtime-2',
        adapterName: 'openai-node',
        contextOverrides: {
          cwd: '/workspace/project',
          env: { NODE_ENV: 'production' },
          sessionId: 'sess-xyz-789',
          adapterId: 'adapter-runtime-2',
          adapterName: 'openai-node',
          toolCallId: 'call-123',
          reasoning: 'Need project context before running the tool.',
        },
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.adapterId).toBe('adapter-runtime-2');
        expect(result.data.adapterName).toBe('openai-node');
        expect(result.data.contextOverrides).toEqual({
          cwd: '/workspace/project',
          env: { NODE_ENV: 'production' },
          sessionId: 'sess-xyz-789',
          adapterId: 'adapter-runtime-2',
          adapterName: 'openai-node',
          toolCallId: 'call-123',
          reasoning: 'Need project context before running the tool.',
        });
      }
    });

    it('should allow contextOverrides to be undefined', () => {
      const payload = {
        toolName: 'simpleTool',
        input: null,
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contextOverrides).toBeUndefined();
      }
    });

    it('should allow empty contextOverrides object', () => {
      const payload = {
        toolName: 'tool',
        input: 42,
        contextOverrides: {},
      };

      const result = ToolSchemas.execute.request.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe('execute.response', () => {
    it('should accept success response with data', () => {
      const response = {
        success: true,
        data: { result: 'completed' },
      };

      const result = ToolSchemas.execute.response.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('should accept failure response with error', () => {
      const response = {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid input provided',
        },
      };

      const result = ToolSchemas.execute.response.safeParse(response);
      expect(result.success).toBe(true);
    });
  });
});
