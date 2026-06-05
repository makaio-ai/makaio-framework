import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WorkerContributionManifest } from '@makaio/contracts';
import { loadWorkerContributions } from '../worker-contributions.js';

// ---------------------------------------------------------------------------
// Inline test modules exposed via data: URLs
//
// data: URLs are valid ESM import specifiers in Node.js (>=14). We encode
// test module source as base64 to avoid filesystem fixtures.
// ---------------------------------------------------------------------------

/**
 * Encode a JavaScript source string as an importable `data:` URL.
 * @param source - ESM source code.
 * @returns A `data:` URL suitable for dynamic import.
 */
function toDataUrl(source: string): string {
  const encoded = Buffer.from(source).toString('base64');
  return `data:text/javascript;base64,${encoded}`;
}

/** Module exporting a default extension with tools only. */
const TOOLS_ONLY_MODULE = toDataUrl(`
  const toolset = {
    metadata: { name: 'test-tools', description: 'test', version: '1.0.0' },
    tools: {
      'test-tools.ping': {
        metadata: { name: 'test-tools.ping', description: 'ping' },
        inputSchema: { parse: (v) => v },
        outputSchema: { parse: (v) => v },
        execute: async (input) => ({ success: true, data: input }),
      },
    },
  };

  export default {
    name: 'tools-only-pkg',
    displayName: 'Tools Only',
    version: '0.1.0',
    tools: {
      createToolsets: () => [toolset],
    },
  };
`);

/** Module exporting a default extension with adapters only. */
const ADAPTERS_ONLY_MODULE = toDataUrl(`
  export default {
    name: 'adapters-only-pkg',
    displayName: 'Adapters Only',
    version: '0.1.0',
    adapters: [
      {
        manifest: { name: 'test-adapter', displayName: 'Test', protocols: ['openai'] },
        definition: { name: 'test-adapter', displayName: 'Test', description: 'Test adapter', createAdapter: async () => ({}) },
      },
    ],
  };
`);

/** Module exporting both tools and adapters. */
const COMBINED_MODULE = toDataUrl(`
  const toolset = {
    metadata: { name: 'combined-tools', description: 'combined', version: '1.0.0' },
    tools: {},
  };

  export default {
    name: 'combined-pkg',
    displayName: 'Combined',
    version: '0.1.0',
    tools: {
      createToolsets: () => [toolset],
    },
    adapters: [
      {
        manifest: { name: 'combined-adapter', displayName: 'Combined Adapter', protocols: ['anthropic'] },
        definition: { name: 'combined-adapter', displayName: 'Combined Adapter', description: 'desc', createAdapter: async () => ({}) },
      },
    ],
  };
`);

/** Module with a named export (no default). */
const NAMED_EXPORT_MODULE = toDataUrl(`
  export const namedPkg = {
    name: 'named-pkg',
    displayName: 'Named Export',
    version: '0.1.0',
    tools: {
      createToolsets: () => [{
        metadata: { name: 'named-tools', description: 'named', version: '1.0.0' },
        tools: {},
      }],
    },
  };
`);

/** Module with no recognizable extension shape. */
const UNRECOGNIZABLE_MODULE = toDataUrl(`
  export default { notAnExtension: true };
`);

/** Module that throws on import. */
const BROKEN_MODULE = toDataUrl(`
  throw new Error('module load failure');
`);

/** Module whose createToolsets throws. */
const FAILING_TOOLSETS_MODULE = toDataUrl(`
  export default {
    name: 'failing-toolsets-pkg',
    displayName: 'Failing Toolsets',
    version: '0.1.0',
    tools: {
      createToolsets: () => { throw new Error('toolset creation failed'); },
    },
  };
`);

/** Module that records whether worker-local context surfaces are present. */
const CONTEXT_MODULE = toDataUrl(`
  export default {
    name: 'context-pkg',
    displayName: 'Context Package',
    version: '0.1.0',
    tools: {
      createToolsets: (ctx) => [{
        metadata: {
          name: ctx.bus && ctx.signal ? 'context-has-runtime' : 'context-missing-runtime',
          description: 'context',
          version: '1.0.0',
        },
        tools: {},
      }],
    },
  };
`);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadWorkerContributions', () => {
  it('extracts toolsets from a package with tools', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'tools-only-pkg', importPath: TOOLS_ONLY_MODULE }],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0]!.metadata.name).toBe('test-tools');
    expect(result.adapters).toHaveLength(0);
  });

  it('extracts adapters from a package with adapter contributions', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'adapters-only-pkg', importPath: ADAPTERS_ONLY_MODULE }],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(0);
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]!.manifest.name).toBe('test-adapter');
  });

  it('extracts both tools and adapters from a combined package', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'combined-pkg', importPath: COMBINED_MODULE }],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0]!.metadata.name).toBe('combined-tools');
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]!.manifest.name).toBe('combined-adapter');
  });

  it('loads contributions from multiple packages', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [
        { name: 'tools-only-pkg', importPath: TOOLS_ONLY_MODULE },
        { name: 'adapters-only-pkg', importPath: ADAPTERS_ONLY_MODULE },
      ],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(1);
    expect(result.adapters).toHaveLength(1);
  });

  it('finds a named export when no default is present', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'named-pkg', importPath: NAMED_EXPORT_MODULE }],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0]!.metadata.name).toBe('named-tools');
  });

  it('skips packages that fail to import', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [
        { name: 'broken-pkg', importPath: BROKEN_MODULE },
        { name: 'tools-only-pkg', importPath: TOOLS_ONLY_MODULE },
      ],
    };

    const result = await loadWorkerContributions(manifest);

    // The broken package is skipped, the valid one still loads
    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0]!.metadata.name).toBe('test-tools');
  });

  it('skips packages with unrecognizable exports', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'unrecognizable-pkg', importPath: UNRECOGNIZABLE_MODULE }],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(0);
    expect(result.adapters).toHaveLength(0);
  });

  it('skips toolset extraction when createToolsets throws', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'failing-toolsets-pkg', importPath: FAILING_TOOLSETS_MODULE }],
    };

    const result = await loadWorkerContributions(manifest);

    // The toolset creation failure is caught, so no toolsets are returned
    expect(result.toolsets).toHaveLength(0);
    expect(result.adapters).toHaveLength(0);
  });

  it('returns empty contributions for an empty manifest', async () => {
    const manifest: WorkerContributionManifest = { packages: [] };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(0);
    expect(result.adapters).toHaveLength(0);
  });

  it('passes worker-local bus and signal into toolset factories', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'context-pkg', importPath: CONTEXT_MODULE }],
    };
    const bus = createBusInstance();
    const signal = new AbortController().signal;

    const result = await loadWorkerContributions(manifest, { bus, signal });

    expect(result.toolsets[0]?.metadata.name).toBe('context-has-runtime');
  });

  it('handles a nonexistent import path gracefully', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'ghost-pkg', importPath: '@makaio/nonexistent-package-xyz' }],
    };

    const result = await loadWorkerContributions(manifest);

    expect(result.toolsets).toHaveLength(0);
    expect(result.adapters).toHaveLength(0);
  });

  it('resolves a relative importPath against makaioHome when provided', async () => {
    // Simulate the cross-machine portability case: an npm-installed package's
    // importPath is stored relative to makaioHome in the manifest.  Here the
    // resolved path does not exist, so the loader must handle it gracefully.
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'ghost-pkg', importPath: './node_modules/@acme/ghost/dist/server.mjs' }],
    };

    const result = await loadWorkerContributions(manifest, {
      makaioHome: '/nonexistent-makaio-home-xyz',
    });

    // The resolved absolute path does not exist — loader skips with a warning.
    expect(result.toolsets).toHaveLength(0);
    expect(result.adapters).toHaveLength(0);
  });

  it('preserves URL import specifiers when makaioHome is provided', async () => {
    const manifest: WorkerContributionManifest = {
      packages: [{ name: 'tools-only-pkg', importPath: TOOLS_ONLY_MODULE }],
    };

    const result = await loadWorkerContributions(manifest, {
      makaioHome: '/nonexistent-makaio-home-xyz',
    });

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0]!.metadata.name).toBe('test-tools');
  });

  it('preserves package import specifiers when makaioHome is provided', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const manifest: WorkerContributionManifest = {
        packages: [{ name: 'ghost-pkg', importPath: '@makaio/nonexistent-package-xyz' }],
      };

      const result = await loadWorkerContributions(manifest, {
        makaioHome: '/nonexistent-makaio-home-xyz',
      });

      expect(result.toolsets).toHaveLength(0);
      expect(result.adapters).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('from "@makaio/nonexistent-package-xyz"'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('/nonexistent-makaio-home-xyz'));
    } finally {
      warn.mockRestore();
    }
  });

  it('skips relative importPaths that escape makaioHome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const manifest: WorkerContributionManifest = {
        packages: [{ name: 'escape-pkg', importPath: '../escape.mjs' }],
      };

      const result = await loadWorkerContributions(manifest, {
        makaioHome: '/tmp/makaio-home',
      });

      expect(result.toolsets).toHaveLength(0);
      expect(result.adapters).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('importPath escapes makaioHome: ../escape.mjs'));
    } finally {
      warn.mockRestore();
    }
  });
});
