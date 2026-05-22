import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, type ToolsetPolicyProvider } from '../tool-registry.js';
import { defineToolset, defineTool, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { MakaioBus } from '@makaio/bus-core';

describe('ToolRegistry.listToolsWithToolsets policy filtering', () => {
  const tool1 = defineTool({
    name: 'allowed-tool',
    description: 'Tool in allowed toolset',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: async () => toolSuccess({}),
  });

  const tool2 = defineTool({
    name: 'restricted-tool',
    description: 'Tool in restricted toolset',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: async () => toolSuccess({}),
  });

  const tool3 = defineTool({
    name: 'disabled-tool',
    description: 'Tool that will be disabled',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: async () => toolSuccess({}),
  });

  it('should filter toolsets based on allowedAdapters policy', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'allowed-toolset') {
        return { allowedAdapters: ['my-adapter', 'other-adapter'] };
      }
      if (toolsetName === 'restricted-toolset') {
        return { allowedAdapters: ['different-adapter'] };
      }
      return null;
    };

    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(
      defineToolset({
        name: 'allowed-toolset',
        description: 'Allowed toolset',
        version: '1.0.0',
        tools: [tool1],
      }),
    );
    await registry.register(
      defineToolset({
        name: 'restricted-toolset',
        description: 'Restricted toolset',
        version: '1.0.0',
        tools: [tool2],
      }),
    );

    const result = await registry.listToolsWithToolsets({ adapterName: 'my-adapter' });

    // Only allowed-toolset should be visible
    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0].name).toBe('allowed-toolset');

    // Only tools from allowed-toolset should be visible
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('allowed-tool');

    registry.dispose();
  });

  it('should filter tools based on disabledTools policy', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'mixed-toolset') {
        return { disabledTools: ['disabled-tool'] };
      }
      return null;
    };

    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(
      defineToolset({
        name: 'mixed-toolset',
        description: 'Toolset with disabled tool',
        version: '1.0.0',
        tools: [tool1, tool3],
      }),
    );

    const result = await registry.listToolsWithToolsets({ adapterName: 'any-adapter' });

    // Toolset should still be visible
    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0].name).toBe('mixed-toolset');

    // Only non-disabled tool should be visible
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('allowed-tool');

    registry.dispose();
  });

  it('should not apply policy filtering when no adapterName is provided', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'restricted-toolset') {
        return { allowedAdapters: ['specific-adapter'] };
      }
      return null;
    };

    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(
      defineToolset({
        name: 'restricted-toolset',
        description: 'Restricted toolset',
        version: '1.0.0',
        tools: [tool2],
      }),
    );

    // Without adapterName, no policy filtering should be applied
    const result = await registry.listToolsWithToolsets();

    expect(result.toolsets).toHaveLength(1);
    expect(result.tools).toHaveLength(1);

    registry.dispose();
  });

  it('should allow all toolsets when allowedAdapters is empty', async () => {
    const policyProvider: ToolsetPolicyProvider = async () => {
      return { allowedAdapters: [] }; // Empty = allow all
    };

    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(
      defineToolset({
        name: 'any-toolset',
        description: 'Any toolset',
        version: '1.0.0',
        tools: [tool1],
      }),
    );

    const result = await registry.listToolsWithToolsets({ adapterName: 'any-adapter' });

    expect(result.toolsets).toHaveLength(1);
    expect(result.tools).toHaveLength(1);

    registry.dispose();
  });
});

describe('ToolRegistry policy enforcement on execute', () => {
  const echoTool = defineTool({
    name: 'echo',
    description: 'Echoes input',
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ echo: z.string() }),
    execute: async (input) => toolSuccess({ echo: input.message }),
  });

  const restrictedToolset = defineToolset({
    name: 'restricted',
    description: 'Restricted toolset',
    version: '1.0.0',
    tools: [echoTool],
  });

  it('should allow execution when no policy provider is configured', async () => {
    const registry = new ToolRegistry({ bus: MakaioBus });
    await registry.register(restrictedToolset);

    const result = await registry.execute('echo', { message: 'hello' });

    expect(result.success).toBe(true);
    registry.dispose();
  });

  it('should allow execution when policy provider returns null', async () => {
    const policyProvider: ToolsetPolicyProvider = async () => null;
    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(restrictedToolset);

    const result = await registry.execute('echo', { message: 'hello' });

    expect(result.success).toBe(true);
    registry.dispose();
  });

  it('should deny execution when tool is disabled', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'restricted') {
        return { disabledTools: ['echo'] };
      }
      return null;
    };
    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(restrictedToolset);

    const result = await registry.execute('echo', { message: 'hello' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ToolErrorCodes.PERMISSION_DENIED);
      expect(result.error.message).toContain('disabled');
    }
    registry.dispose();
  });

  it('should deny execution when adapter is not in allowedAdapters', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'restricted') {
        return { allowedAdapters: ['claude-code'] };
      }
      return null;
    };
    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(restrictedToolset);

    // No adapter specified
    const result1 = await registry.execute('echo', { message: 'hello' });
    expect(result1.success).toBe(false);
    if (!result1.success) {
      expect(result1.error.code).toBe(ToolErrorCodes.PERMISSION_DENIED);
    }

    // Wrong adapter
    const result2 = await registry.execute('echo', { message: 'hello' }, { adapterId: 'other-adapter' });
    expect(result2.success).toBe(false);

    registry.dispose();
  });

  it('should allow execution when adapter is in allowedAdapters', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'restricted') {
        return { allowedAdapters: ['claude-code', 'openai'] };
      }
      return null;
    };
    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(restrictedToolset);

    const result = await registry.execute('echo', { message: 'hello' }, { adapterId: 'claude-code' });

    expect(result.success).toBe(true);
    registry.dispose();
  });

  it('should allow execution when adapter name matches allowedAdapters', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'restricted') {
        return { allowedAdapters: ['claude-code'] };
      }
      return null;
    };
    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(restrictedToolset);

    const result = await registry.execute('echo', { message: 'hello' }, { adapterName: 'claude-code' });

    expect(result.success).toBe(true);
    registry.dispose();
  });

  it('should prioritize adapterName over adapterId for allowedAdapters check', async () => {
    const policyProvider: ToolsetPolicyProvider = async (toolsetName) => {
      if (toolsetName === 'restricted') {
        return { allowedAdapters: ['allowed-name'] };
      }
      return null;
    };
    const registry = new ToolRegistry({ bus: MakaioBus, policyProvider });
    await registry.register(restrictedToolset);

    // Should succeed when adapterName matches, even if adapterId doesn't
    const result1 = await registry.execute(
      'echo',
      { message: 'hello' },
      {
        adapterId: 'not-allowed-id',
        adapterName: 'allowed-name',
      },
    );
    expect(result1.success).toBe(true);

    // Should fail when adapterName doesn't match, even if adapterId does
    const result2 = await registry.execute(
      'echo',
      { message: 'hello' },
      {
        adapterId: 'allowed-name', // note: this matches but it's adapterId
        adapterName: 'not-allowed-name',
      },
    );
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error.code).toBe(ToolErrorCodes.PERMISSION_DENIED);
    }

    registry.dispose();
  });
});
