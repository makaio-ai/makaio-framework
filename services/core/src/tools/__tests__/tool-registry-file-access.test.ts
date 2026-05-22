import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import {
  defineTool,
  defineToolset,
  FILE_ACCESS_RULES_KEY,
  toolError,
  ToolErrorCodes,
  toolSuccess,
  type FileAccessRuleProvider,
  type FileAccessRules,
  type ToolExecutionContext,
} from '@makaio/tools-core';
import { ToolRegistry } from '../tool-registry.js';

function getInjectedRules(context: ToolExecutionContext): FileAccessRules | undefined {
  return context.constraints?.[FILE_ACCESS_RULES_KEY] as FileAccessRules | undefined;
}

const readFileLikeTool = defineTool({
  name: 'read_file',
  description: 'Test read tool that honors injected file access rules',
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  execute: async (input, context) => {
    const rules = getInjectedRules(context);
    if (rules?.isDenied(input.path)) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, `Access denied by .makaioignore rules: ${input.path}`);
    }
    return toolSuccess({ content: 'allowed' });
  },
});

const listDirectoryLikeTool = defineTool({
  name: 'list_directory',
  description: 'Test list tool that filters entries with injected file access rules',
  inputSchema: z.object({ path: z.string(), entries: z.array(z.string()) }),
  outputSchema: z.object({ entries: z.array(z.object({ name: z.string() })) }),
  execute: async (input, context) => {
    const rules = getInjectedRules(context);
    const entries = input.entries
      .filter((name) => !rules?.isDenied(path.join(input.path, name)))
      .map((name) => ({ name }));
    return toolSuccess({ entries });
  },
});

const testToolset = defineToolset({
  name: 'file-access-test',
  description: 'Test tools for ToolRegistry file access rule injection',
  version: '0.1.0',
  tools: [readFileLikeTool, listDirectoryLikeTool],
});

const testProvider: FileAccessRuleProvider = async () => ({
  isDenied: (absolutePath) =>
    absolutePath.endsWith('.env') || absolutePath.endsWith('.secret') || absolutePath.endsWith('.log'),
});

describe('ToolRegistry file access rule enforcement', () => {
  let registry: ToolRegistry;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    registry = new ToolRegistry({
      bus: MakaioBus,
      fileAccessRuleProvider: testProvider,
    });
    await registry.register(testToolset);
  });

  afterEach(() => {
    registry.dispose();
    MakaioBus.__resetHandlers?.();
  });

  it('injects file access rules so filesystem-like tools can deny restricted paths', async () => {
    const result = await registry.execute(
      'read_file',
      { path: '/tmp/project/.env' },
      { contextOverrides: { cwd: '/tmp/project' } },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toMatch(/\.makaioignore/i);
    }
  });

  it('allows paths not denied by injected file access rules', async () => {
    const result = await registry.execute(
      'read_file',
      { path: '/tmp/project/readme.txt' },
      { contextOverrides: { cwd: '/tmp/project' } },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string };
      expect(data.content).toBe('allowed');
    }
  });

  it('supports directory tools filtering entries with injected file access rules', async () => {
    const result = await registry.execute(
      'list_directory',
      { path: '/tmp/project', entries: ['.env', 'readme.txt', 'server.log'] },
      { contextOverrides: { cwd: '/tmp/project' } },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { entries: Array<{ name: string }> };
      const names = data.entries.map((entry) => entry.name);
      expect(names).not.toContain('.env');
      expect(names).not.toContain('server.log');
      expect(names).toContain('readme.txt');
    }
  });
});
