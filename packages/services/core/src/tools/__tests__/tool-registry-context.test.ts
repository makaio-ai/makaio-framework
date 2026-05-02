import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import {
  defineTool,
  defineToolset,
  FILE_ACCESS_RULES_KEY,
  toolSuccess,
  type FileAccessRuleProvider,
  type ToolExecutionContext,
} from '@makaio/tools-core';
import { ToolSubjects } from '@makaio/contracts';
import { ToolRegistry } from '../tool-registry.js';

describe('ToolRegistry context injection', () => {
  let registry: ToolRegistry;

  // Track context received by tool
  let capturedContext: ToolExecutionContext | null = null;

  const contextCaptureTool = defineTool({
    name: 'captureContext',
    description: 'Captures execution context for testing',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ received: z.boolean() }),
    execute: async (_input, context) => {
      capturedContext = context;
      return toolSuccess({ received: true });
    },
  });

  const testToolset = defineToolset({
    name: 'test-toolset',
    description: 'Test toolset',
    version: '1.0.0',
    tools: [contextCaptureTool],
  });

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    capturedContext = null;
    registry = new ToolRegistry({ bus: MakaioBus });
    await registry.register(testToolset);
  });

  afterEach(() => {
    registry.dispose();
    MakaioBus.__resetHandlers?.();
  });

  describe('sessionId injection', () => {
    it('should inject sessionId from contextOverrides into tool context', async () => {
      const result = await registry.execute(
        'captureContext',
        { value: 'test' },
        {
          contextOverrides: { sessionId: 'session-123' },
        },
      );

      expect(result.success).toBe(true);
      expect(capturedContext).not.toBeNull();
      expect(capturedContext?.sessionId).toBe('session-123');
    });

    it('should not have sessionId when not provided in contextOverrides', async () => {
      const result = await registry.execute('captureContext', { value: 'test' });

      expect(result.success).toBe(true);
      expect(capturedContext).not.toBeNull();
      expect(capturedContext?.sessionId).toBeUndefined();
    });

    it('should pass sessionId along with other context properties', async () => {
      const result = await registry.execute(
        'captureContext',
        { value: 'test' },
        {
          contextOverrides: {
            cwd: '/custom/path',
            sessionId: 'sess-456',
          },
        },
      );

      expect(result.success).toBe(true);
      expect(capturedContext?.cwd).toBe('/custom/path');
      expect(capturedContext?.sessionId).toBe('sess-456');
    });
  });

  describe('bus injection', () => {
    it('should inject bus into tool context', async () => {
      const result = await registry.execute('captureContext', { value: 'test' });

      expect(result.success).toBe(true);
      expect(capturedContext).not.toBeNull();
      expect(capturedContext?.bus).toBeDefined();
      // Verify it has the expected bus methods
      expect(typeof capturedContext?.bus?.emit).toBe('function');
      expect(typeof capturedContext?.bus?.request).toBe('function');
      expect(typeof capturedContext?.bus?.on).toBe('function');
    });

    it('should inject same bus instance used by registry', async () => {
      // Verify the injected bus can actually emit events
      let eventReceived = false;
      const unsubscribe = MakaioBus.on(ToolSubjects.started, () => {
        eventReceived = true;
      });

      await registry.execute('captureContext', { value: 'test' });

      expect(eventReceived).toBe(true);
      unsubscribe();
    });
  });

  describe('bus handler integration', () => {
    it('should inject top-level adapter identity into tool context', async () => {
      const result = await MakaioBus.request(ToolSubjects.execute, {
        toolName: 'captureContext',
        input: { value: 'adapter-identity' },
        adapterId: 'adapter-runtime-1',
        adapterName: 'claude-code',
      });

      expect(result.success).toBe(true);
      expect(capturedContext?.adapterId).toBe('adapter-runtime-1');
      expect(capturedContext?.adapterName).toBe('claude-code');
    });

    it('should allow partial top-level adapter identity for direct execution', async () => {
      const result = await registry.execute(
        'captureContext',
        { value: 'partial-top-level' },
        {
          adapterName: 'claude-code',
        },
      );

      expect(result.success).toBe(true);
      expect(capturedContext?.adapterId).toBeUndefined();
      expect(capturedContext?.adapterName).toBe('claude-code');
    });

    it('should reject conflicting adapter identity between top-level fields and contextOverrides', async () => {
      const result = await registry.execute(
        'captureContext',
        { value: 'conflict' },
        {
          adapterId: 'adapter-runtime-1',
          adapterName: 'claude-code',
          contextOverrides: {
            adapterId: 'different-adapter',
            adapterName: 'openai-node',
          },
        },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain('contextOverrides.adapterId must match top-level adapterId');
      }
      expect(capturedContext).toBeNull();
    });

    it('should reject partial cross-source adapter identity mixing', async () => {
      const scenarios = [
        {
          options: {
            adapterName: 'claude-code',
            contextOverrides: {
              adapterId: 'adapter-runtime-1',
              adapterName: 'claude-code',
            },
          },
          expectedMessage: 'contextOverrides.adapterId cannot supply adapter identity',
        },
        {
          options: {
            adapterId: 'adapter-runtime-1',
            contextOverrides: {
              adapterId: 'adapter-runtime-1',
              adapterName: 'claude-code',
            },
          },
          expectedMessage: 'contextOverrides.adapterName cannot supply adapter identity',
        },
      ] as const;

      for (const scenario of scenarios) {
        const result = await registry.execute('captureContext', { value: 'partial-conflict' }, scenario.options);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
          expect(result.error.message).toContain(scenario.expectedMessage);
        }
        expect(capturedContext).toBeNull();
      }
    });

    it('should reject override-only adapter identity for direct execution', async () => {
      const result = await registry.execute(
        'captureContext',
        { value: 'override-only-full' },
        {
          contextOverrides: {
            adapterId: 'adapter-runtime-1',
            adapterName: 'claude-code',
          },
        },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain('adapter identity must be provided at the top level');
      }
      expect(capturedContext).toBeNull();
    });

    it('should reject override-only partial adapter identity for direct execution', async () => {
      const scenarios = [
        {
          contextOverrides: {
            adapterId: 'adapter-runtime-1',
          },
        },
        {
          contextOverrides: {
            adapterName: 'claude-code',
          },
        },
      ] as const;

      for (const options of scenarios) {
        const result = await registry.execute('captureContext', { value: 'override-only-partial' }, options);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('VALIDATION_FAILED');
          expect(result.error.message).toContain('adapter identity must be provided at the top level');
        }
        expect(capturedContext).toBeNull();
      }
    });

    it('should extract sessionId from contextOverrides in bus handler', async () => {
      // Execute via bus request (simulating external caller)
      const result = await MakaioBus.request(ToolSubjects.execute, {
        toolName: 'captureContext',
        input: { value: 'via-bus' },
        contextOverrides: {
          sessionId: 'bus-session-789',
        },
      });

      expect(result.success).toBe(true);
      expect(capturedContext?.sessionId).toBe('bus-session-789');
    });

    it('should handle bus request without sessionId', async () => {
      const result = await MakaioBus.request(ToolSubjects.execute, {
        toolName: 'captureContext',
        input: { value: 'no-session' },
      });

      expect(result.success).toBe(true);
      expect(capturedContext?.sessionId).toBeUndefined();
    });

    it('should combine cwd, env, and sessionId from bus request', async () => {
      const result = await MakaioBus.request(ToolSubjects.execute, {
        toolName: 'captureContext',
        input: { value: 'combined' },
        contextOverrides: {
          cwd: '/bus/path',
          env: { BUS_VAR: 'value' },
          sessionId: 'combined-session',
          turnContext: { terminalSessionKey: 'proj::default::term-1' },
        },
      });

      expect(result.success).toBe(true);
      expect(capturedContext?.cwd).toBe('/bus/path');
      expect(capturedContext?.env.BUS_VAR).toBe('value');
      expect(capturedContext?.sessionId).toBe('combined-session');
      expect(capturedContext?.turnContext).toEqual({ terminalSessionKey: 'proj::default::term-1' });
    });
  });

  describe('allowedDirectories sanitization', () => {
    it('passes only string allowedDirectories entries to the file access rule provider', async () => {
      registry.dispose();

      let capturedAllowedDirectories: readonly string[] | undefined;
      const provider: FileAccessRuleProvider = async (_cwd, allowedDirectories) => {
        capturedAllowedDirectories = allowedDirectories;
        return { isDenied: () => false };
      };

      registry = new ToolRegistry({ bus: MakaioBus, fileAccessRuleProvider: provider });
      await registry.register(testToolset);

      const result = await registry.execute(
        'captureContext',
        { value: 'test' },
        {
          contextOverrides: {
            constraints: { allowedDirectories: ['/safe', 42, null, '/safe-2'] },
          },
        },
      );

      expect(result.success).toBe(true);
      expect(capturedAllowedDirectories).toEqual(['/safe', '/safe-2']);
      expect(capturedContext?.constraints?.[FILE_ACCESS_RULES_KEY]).toBeDefined();
    });

    it('passes undefined when allowedDirectories is malformed', async () => {
      registry.dispose();

      let capturedAllowedDirectories: readonly string[] | undefined;
      const provider: FileAccessRuleProvider = async (_cwd, allowedDirectories) => {
        capturedAllowedDirectories = allowedDirectories;
        return { isDenied: () => false };
      };

      registry = new ToolRegistry({ bus: MakaioBus, fileAccessRuleProvider: provider });
      await registry.register(testToolset);

      const result = await registry.execute(
        'captureContext',
        { value: 'test' },
        {
          contextOverrides: {
            constraints: { allowedDirectories: 'not-an-array' },
          },
        },
      );

      expect(result.success).toBe(true);
      expect(capturedAllowedDirectories).toBeUndefined();
    });
  });
});
