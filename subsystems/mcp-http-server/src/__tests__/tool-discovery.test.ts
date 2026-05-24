import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { ToolRegistry } from '@makaio/services-core/tools';
import { defineToolset, defineTool, toolSuccess } from '@makaio/tools-core';
import type { ToolInfo } from '@makaio/tools-core';
import { resolveMcpTools, toolInfoToMcpTool } from '../tool-discovery.js';

/**
 * Builds a minimal tool definition for testing purposes.
 * @param name - Tool name
 * @returns Tool definition
 */
function makeTestTool(name: string) {
  return defineTool({
    name,
    description: `${name} tool`,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    execute: async (input) => toolSuccess({ result: input.value }),
  });
}

/**
 * Creates an isolated bus + registry pair for a single test.
 * Returns `dispose` to clean up after the test.
 * @returns Object with bus, registry, and dispose function
 */
function createTestHarness() {
  const bus = createBusInstance();
  const registry = new ToolRegistry({ bus });
  return {
    bus,
    registry,
    dispose: () => registry.dispose(),
  };
}

describe('resolveMcpTools', () => {
  /** Cleanup reference for tests that create their own harness. */
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  describe('prefixing', () => {
    it('plugin-owned toolset gets {pluginName}.{toolName} prefix', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'my-toolset',
          description: 'A toolset',
          version: '1.0.0',
          tools: [makeTestTool('doThing')],
        }),
      );

      const result = await resolveMcpTools(bus, {
        pluginToolsets: { 'my-toolset': 'my-plugin' },
      });

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('my-plugin.doThing');
      expect(result.byMcpName.get('my-plugin.doThing')?.sourceToolName).toBe('doThing');
    });
  });

  describe('no-prefix', () => {
    it('non-plugin toolset tool gets bare {toolName}', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'core-toolset',
          description: 'Core tools',
          version: '1.0.0',
          tools: [makeTestTool('readFile')],
        }),
      );

      const result = await resolveMcpTools(bus);

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('readFile');
      expect(result.byMcpName.get('readFile')?.sourceToolName).toBe('readFile');
    });
  });

  describe('collision-fallback', () => {
    it('two toolsets with same tool name produce {toolset}.{tool} for the collision', async () => {
      // ToolRegistry prevents duplicate source tool names, so we drive this test via
      // `getExposedTools` which injects a custom ToolInfo list bypassing the registry,
      // simulating a scenario where two different sources contribute the same bare name.
      const { bus, dispose } = createTestHarness();
      cleanup = dispose;

      const colliding: ToolInfo[] = [
        { name: 'run', description: 'Run from A', toolsetName: 'toolset-a' },
        { name: 'run', description: 'Run from B', toolsetName: 'toolset-b' },
      ];

      const result = await resolveMcpTools(bus, {
        getExposedTools: () => colliding,
      });

      // Both bare "run" names collide → qualified to "toolset-a.run" and "toolset-b.run"
      expect(result.tools).toHaveLength(2);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('toolset-a.run');
      expect(names).toContain('toolset-b.run');
    });

    it('throws when final MCP names are still duplicated after fallback', async () => {
      const { bus, dispose } = createTestHarness();
      cleanup = dispose;

      const duplicates: ToolInfo[] = [
        { name: 'run', description: 'Run A', toolsetName: 'toolset-a' },
        { name: 'run', description: 'Run B', toolsetName: 'toolset-a' },
      ];

      await expect(
        resolveMcpTools(bus, {
          getExposedTools: () => duplicates,
        }),
      ).rejects.toThrow(/Duplicate resolved MCP tool name: toolset-a.run/);
    });
  });

  describe('list-after-register', () => {
    it('registering a toolset and calling resolveMcpTools returns it', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'fs-tools',
          description: 'Filesystem tools',
          version: '1.0.0',
          tools: [makeTestTool('readFile'), makeTestTool('writeFile')],
        }),
      );

      const result = await resolveMcpTools(bus);

      expect(result.tools).toHaveLength(2);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('readFile');
      expect(names).toContain('writeFile');
    });
  });

  describe('list-after-deregister', () => {
    it('deregistering and calling resolveMcpTools does not return deregistered tools', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'temp-toolset',
          description: 'Temporary toolset',
          version: '1.0.0',
          tools: [makeTestTool('tempAction')],
        }),
      );

      const before = await resolveMcpTools(bus);
      expect(before.tools).toHaveLength(1);

      await registry.deregister('temp-toolset');

      const after = await resolveMcpTools(bus);
      expect(after.tools).toHaveLength(0);
    });
  });

  describe('execution-mapping', () => {
    it('byMcpName.get(mcpName)?.sourceToolName equals the original runtime tool name', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'exec-toolset',
          description: 'Execution test toolset',
          version: '1.0.0',
          tools: [makeTestTool('processData')],
        }),
      );

      const result = await resolveMcpTools(bus, {
        pluginToolsets: { 'exec-toolset': 'exec-plugin' },
      });

      expect(result.byMcpName.get('exec-plugin.processData')?.sourceToolName).toBe('processData');
    });
  });

  describe('static-fallback', () => {
    it('when ToolSubjects.list is not handled, falls back to static list', async () => {
      // No ToolRegistry registered on this bus → no handler for ToolSubjects.list
      const bus = createBusInstance();

      const result = await resolveMcpTools(bus, {
        staticFallback: [{ name: 'fallbackTool', description: 'Fallback tool', toolsetName: 'fallback-toolset' }],
      });

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('fallbackTool');
      expect(result.byMcpName.get('fallbackTool')?.sourceToolName).toBe('fallbackTool');
    });

    it('returns empty when no handler and no static fallback provided', async () => {
      const bus = createBusInstance();

      const result = await resolveMcpTools(bus);

      expect(result.tools).toHaveLength(0);
      expect(result.byMcpName.size).toBe(0);
    });
  });

  describe('filter-hook-empty', () => {
    it('getExposedTools returning [] causes no tools exposed', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'hidden-toolset',
          description: 'Should be hidden',
          version: '1.0.0',
          tools: [makeTestTool('secretTool')],
        }),
      );

      const result = await resolveMcpTools(bus, {
        getExposedTools: () => [],
      });

      expect(result.tools).toHaveLength(0);
      expect(result.byMcpName.size).toBe(0);
    });
  });

  describe('inputSchema normalization', () => {
    it('flattens oneOf discriminated union into single object schema', async () => {
      const { bus, dispose } = createTestHarness();
      cleanup = dispose;

      const unionTool: ToolInfo[] = [
        {
          name: 'multi_op',
          description: 'Tool with discriminated union schema',
          toolsetName: 'test-toolset',
          inputSchema: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  op: { type: 'string', const: 'create', description: 'Operation' },
                  name: { type: 'string', description: 'Name to create' },
                },
                required: ['op', 'name'],
              },
              {
                type: 'object',
                properties: {
                  op: { type: 'string', const: 'delete', description: 'Operation' },
                  id: { type: 'string', description: 'ID to delete' },
                },
                required: ['op', 'id'],
              },
            ],
          },
        },
      ];

      const result = await resolveMcpTools(bus, { getExposedTools: () => unionTool });
      const schema = result.tools[0].inputSchema as Record<string, unknown>;

      expect(result.tools).toHaveLength(1);
      expect(schema.type).toBe('object');
      expect(schema).not.toHaveProperty('oneOf');
      expect(schema).not.toHaveProperty('anyOf');

      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.op).toEqual({ type: 'string', enum: ['create', 'delete'], description: 'Operation' });
      expect(props.name).toEqual({ type: 'string', description: 'Name to create' });
      expect(props.id).toEqual({ type: 'string', description: 'ID to delete' });

      expect(schema.required).toEqual(['op']);
    });

    it('preserves existing type "object" schema unchanged', async () => {
      const { bus, dispose } = createTestHarness();
      cleanup = dispose;

      const objectTool: ToolInfo[] = [
        {
          name: 'simple',
          description: 'Simple object tool',
          toolsetName: 'test-toolset',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ];

      const result = await resolveMcpTools(bus, { getExposedTools: () => objectTool });

      expect(result.tools[0].inputSchema).toEqual({
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      });
    });

    it('produces { type: "object" } when inputSchema is undefined', () => {
      const tool: ToolInfo = { name: 'no_schema', description: 'No schema', toolsetName: 'test' };
      const result = toolInfoToMcpTool(tool, 'no_schema');

      expect(result.inputSchema).toEqual({ type: 'object' });
    });

    it('flattens anyOf schema the same as oneOf', () => {
      const tool: ToolInfo = {
        name: 'any_of',
        description: 'anyOf tool',
        toolsetName: 'test',
        inputSchema: {
          anyOf: [
            { type: 'object', properties: { mode: { type: 'string', const: 'a' }, x: { type: 'string' } } },
            { type: 'object', properties: { mode: { type: 'string', const: 'b' }, y: { type: 'number' } } },
          ],
        },
      };
      const result = toolInfoToMcpTool(tool, 'any_of');
      const schema = result.inputSchema as Record<string, unknown>;

      expect(schema.type).toBe('object');
      expect(schema).not.toHaveProperty('anyOf');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.mode.enum).toEqual(['a', 'b']);
      expect(props.x).toEqual({ type: 'string' });
      expect(props.y).toEqual({ type: 'number' });
    });

    it('preserves non-object oneOf variants while enforcing the MCP object root', () => {
      const tool: ToolInfo = {
        name: 'mixed',
        description: 'Mixed union',
        toolsetName: 'test',
        inputSchema: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      };
      const result = toolInfoToMcpTool(tool, 'mixed');
      const schema = result.inputSchema as Record<string, unknown>;

      expect(schema.type).toBe('object');
      expect(schema).toHaveProperty('oneOf');
    });
  });

  describe('filter-hook-partial', () => {
    it('getExposedTools returning subset exposes only that subset', async () => {
      const { bus, registry, dispose } = createTestHarness();
      cleanup = dispose;

      await registry.register(
        defineToolset({
          name: 'mixed-toolset',
          description: 'Mixed toolset',
          version: '1.0.0',
          tools: [makeTestTool('allowedTool'), makeTestTool('blockedTool')],
        }),
      );

      const result = await resolveMcpTools(bus, {
        getExposedTools: (tools) => tools.filter((t) => t.name === 'allowedTool'),
      });

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('allowedTool');
      expect(result.byMcpName.has('blockedTool')).toBe(false);
    });
  });
});
