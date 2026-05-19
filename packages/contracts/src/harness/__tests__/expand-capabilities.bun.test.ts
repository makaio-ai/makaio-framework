import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ToolCapability } from '../../tool-capability/index.js';
import { expandCapabilities, expandProfileToolCapabilities, getToolCapabilities } from '../expand-capabilities.js';
import { HarnessSubjects } from '../namespace.js';

/**
 * Shared capability map used across expandCapabilities test scenarios.
 * Each tool declares exactly the capabilities it exercises.
 */
const testMap: Record<string, readonly ToolCapability[]> = {
  bash: [
    ToolCapability.SHELL_EXECUTE,
    ToolCapability.FILE_READ,
    ToolCapability.FILE_WRITE,
    ToolCapability.FILE_DELETE,
    ToolCapability.NETWORK_REQUEST,
    ToolCapability.PROCESS_MANAGE,
  ],
  patch: [ToolCapability.FILE_WRITE],
  read: [ToolCapability.FILE_READ],
  grep: [ToolCapability.SEARCH_CONTENT],
  glob: [ToolCapability.SEARCH_FILES],
  fetch: [ToolCapability.NETWORK_REQUEST],
};

const registeredTools = ['bash', 'patch', 'read', 'grep', 'glob', 'fetch', 'unmapped'];

describe('getToolCapabilities', () => {
  it('returns declared capabilities for a known tool', () => {
    const caps = getToolCapabilities('bash', testMap);
    expect(caps).toEqual([
      ToolCapability.SHELL_EXECUTE,
      ToolCapability.FILE_READ,
      ToolCapability.FILE_WRITE,
      ToolCapability.FILE_DELETE,
      ToolCapability.NETWORK_REQUEST,
      ToolCapability.PROCESS_MANAGE,
    ]);
  });

  it('returns empty array for an unknown tool', () => {
    const caps = getToolCapabilities('nonexistent', testMap);
    expect(caps).toEqual([]);
  });

  it('returns empty array when the capability map is empty', () => {
    const caps = getToolCapabilities('bash', {});
    expect(caps).toEqual([]);
  });
});

describe('expandCapabilities', () => {
  describe('allowedTools - ALL-match rule', () => {
    it('returns empty allowedTools when allowedCapabilities is empty (no filtering)', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).toEqual([]);
    });

    it('allows only tools whose entire capability set is covered by file.read', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [ToolCapability.FILE_READ],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).toEqual(['read']);
    });

    it('allows tools fully covered by file.read + search.content', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [ToolCapability.FILE_READ, ToolCapability.SEARCH_CONTENT],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).toContain('read');
      expect(allowedTools).toContain('grep');
      expect(allowedTools).not.toContain('bash');
      expect(allowedTools).not.toContain('patch');
      expect(allowedTools).not.toContain('glob');
      expect(allowedTools).not.toContain('fetch');
    });

    it('allows every tool when all capabilities are in the allowed set', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [
          ToolCapability.SHELL_EXECUTE,
          ToolCapability.FILE_READ,
          ToolCapability.FILE_WRITE,
          ToolCapability.FILE_DELETE,
          ToolCapability.NETWORK_REQUEST,
          ToolCapability.PROCESS_MANAGE,
          ToolCapability.SEARCH_CONTENT,
          ToolCapability.SEARCH_FILES,
          ToolCapability.SEARCH_WEB,
        ],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).toContain('bash');
      expect(allowedTools).toContain('patch');
      expect(allowedTools).toContain('read');
      expect(allowedTools).toContain('grep');
      expect(allowedTools).toContain('glob');
      expect(allowedTools).toContain('fetch');
    });

    it('excludes bash when allowed set is file.read + file.write (conservative ALL-match)', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [ToolCapability.FILE_READ, ToolCapability.FILE_WRITE],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).not.toContain('bash');
      expect(allowedTools).toContain('patch');
      expect(allowedTools).toContain('read');
    });

    it('allows only patch when allowed set is file.write only', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [ToolCapability.FILE_WRITE],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).toEqual(['patch']);
    });

    it('filters to registered tools even when capability map contains more', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools: ['read', 'grep'],
        allowedCapabilities: [ToolCapability.FILE_READ, ToolCapability.SEARCH_CONTENT],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).toEqual(['read', 'grep']);
    });

    it('excludes tools with no capability mapping', () => {
      const { allowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [ToolCapability.FILE_READ, ToolCapability.SEARCH_CONTENT],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(allowedTools).not.toContain('unmapped');
    });
  });

  describe('disallowedTools - ANY-match rule', () => {
    it('disallows only bash when disallowing shell.execute', () => {
      const { disallowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [],
        disallowedCapabilities: [ToolCapability.SHELL_EXECUTE],
        capabilityMap: testMap,
      });
      expect(disallowedTools).toEqual(['bash']);
    });

    it('disallows bash and patch when disallowing file.write', () => {
      const { disallowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [],
        disallowedCapabilities: [ToolCapability.FILE_WRITE],
        capabilityMap: testMap,
      });
      expect(disallowedTools).toContain('bash');
      expect(disallowedTools).toContain('patch');
      expect(disallowedTools).not.toContain('read');
      expect(disallowedTools).not.toContain('grep');
      expect(disallowedTools).not.toContain('glob');
      expect(disallowedTools).not.toContain('fetch');
    });

    it('returns empty disallowedTools when disallowedCapabilities is empty', () => {
      const { disallowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [],
        disallowedCapabilities: [],
        capabilityMap: testMap,
      });
      expect(disallowedTools).toEqual([]);
    });
  });

  describe('combined allowed + disallowed', () => {
    it('returns correct allowed and disallowed sets when both filters are active', () => {
      const { allowedTools, disallowedTools } = expandCapabilities({
        registeredTools,
        allowedCapabilities: [ToolCapability.FILE_READ, ToolCapability.SEARCH_CONTENT],
        disallowedCapabilities: [ToolCapability.SEARCH_CONTENT],
        capabilityMap: testMap,
      });

      expect(allowedTools).toContain('read');
      expect(allowedTools).toContain('grep');
      expect(disallowedTools).toContain('grep');
      expect(disallowedTools).not.toContain('read');
    });
  });
});

/**
 * Minimal harness fixture without a toolCapabilityMap, used by no-op harness tests.
 */
const minimalHarness = {
  id: 'harness-test-001',
  name: 'Test Harness',
  adapterName: 'codex-app-server',
  approvalPolicy: 'always-ask' as const,
  nativeTools: { enabled: ['bash', 'read', 'grep'], disabled: [] },
  registryTools: { enabled: [], disabled: [] },
  isDefault: false,
  enabled: true,
  createdAt: 1000,
  updatedAt: 1000,
};

/**
 * Harness fixture with a toolCapabilityMap, used by expansion tests.
 */
const harnessWithCapabilityMap = {
  ...minimalHarness,
  id: 'harness-test-002',
  toolCapabilityMap: {
    bash: [ToolCapability.SHELL_EXECUTE, ToolCapability.FILE_READ, ToolCapability.FILE_WRITE],
    read: [ToolCapability.FILE_READ],
    grep: [ToolCapability.SEARCH_CONTENT],
  },
};

/**
 * Register HarnessSubjects.get handler for tests that need a specific harness payload.
 * @param harness - Harness object to return from HarnessSubjects.get
 * @returns Cleanup function for the registered handler
 */
function registerHarnessGetHandler(harness: typeof minimalHarness | typeof harnessWithCapabilityMap): () => void {
  return MakaioBus.on(HarnessSubjects.get, (context) => {
    if (context.isRequest) {
      context.setResult(harness);
    }
  });
}

describe('expandProfileToolCapabilities', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('returns explicit tool lists unchanged when no capabilities are set', async () => {
    const result = await expandProfileToolCapabilities(MakaioBus, {
      allowedTools: ['explicit-tool'],
      disallowedTools: ['blocked-tool'],
    });

    expect(result.allowedTools).toEqual(['explicit-tool']);
    expect(result.disallowedTools).toEqual(['blocked-tool']);
  });

  it('returns explicit tool lists unchanged when no harnessId is provided', async () => {
    const result = await expandProfileToolCapabilities(MakaioBus, {
      allowedCapabilities: [ToolCapability.FILE_READ],
      allowedTools: ['explicit-tool'],
      disallowedTools: ['blocked-tool'],
    });

    expect(result.allowedTools).toEqual(['explicit-tool']);
    expect(result.disallowedTools).toEqual(['blocked-tool']);
  });

  it('returns explicit tool lists unchanged when harness has no toolCapabilityMap', async () => {
    const cleanup = registerHarnessGetHandler(minimalHarness);

    const result = await expandProfileToolCapabilities(MakaioBus, {
      harnessId: minimalHarness.id,
      allowedCapabilities: [ToolCapability.FILE_READ],
      allowedTools: ['explicit-tool'],
      disallowedTools: ['blocked-tool'],
    });
    cleanup();

    expect(result.allowedTools).toEqual(['explicit-tool']);
    expect(result.disallowedTools).toEqual(['blocked-tool']);
  });

  it('expands allowedCapabilities and unions results with explicit allowedTools', async () => {
    const cleanup = registerHarnessGetHandler(harnessWithCapabilityMap);

    const result = await expandProfileToolCapabilities(MakaioBus, {
      harnessId: harnessWithCapabilityMap.id,
      allowedCapabilities: [ToolCapability.FILE_READ],
      allowedTools: ['explicit-allowed'],
    });
    cleanup();

    expect(result.allowedTools).toContain('read');
    expect(result.allowedTools).toContain('explicit-allowed');
    expect(result.allowedTools).not.toContain('bash');
    expect(result.allowedTools).not.toContain('grep');
  });

  it('expands disallowedCapabilities and unions results with explicit disallowedTools', async () => {
    const cleanup = registerHarnessGetHandler(harnessWithCapabilityMap);

    const result = await expandProfileToolCapabilities(MakaioBus, {
      harnessId: harnessWithCapabilityMap.id,
      disallowedCapabilities: [ToolCapability.FILE_WRITE],
      disallowedTools: ['explicit-blocked'],
    });
    cleanup();

    expect(result.disallowedTools).toContain('bash');
    expect(result.disallowedTools).toContain('explicit-blocked');
    expect(result.disallowedTools).not.toContain('read');
    expect(result.disallowedTools).not.toContain('grep');
  });
});
