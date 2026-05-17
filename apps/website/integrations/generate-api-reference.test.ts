import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFrameworkSourceLinkOptions,
  createPublicApiEntryPoints,
  normalizeFrameworkSourceLinks,
  normalizeTypeDocPageTitle,
} from './generate-api-reference';
import { loadOrCreateApiSymbolManifest, writeApiSymbolManifest } from './api-symbol-manifest';
import { toApiSlug } from './api-route-utils';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-api-entrypoints-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createPublicApiEntryPoints', () => {
  it('creates stable docs entrypoints from package exports', () => {
    const frameworkRoot = path.join(tempDir, 'source-root');
    const packageRoot = path.join(frameworkRoot, 'packages/contracts');
    fs.mkdirSync(path.join(packageRoot, 'src/skill'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'src/cli'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@makaio/contracts',
        exports: {
          '.': './src/index.ts',
          './skill': './src/skill/index.ts',
          './cli/register': './src/cli/register.ts',
          './package.json': './package.json',
        },
      }),
    );

    const entrypointRoot = path.join(tempDir, 'entrypoints');
    const entryPoints = createPublicApiEntryPoints({
      frameworkRoot,
      packageRoots: [packageRoot],
      entrypointRoot,
    });

    expect(entryPoints).toEqual([
      path.join(entrypointRoot, 'contracts/index.ts'),
      path.join(entrypointRoot, 'contracts/skill/index.ts'),
    ]);
    expect(fs.readFileSync(path.join(entrypointRoot, 'contracts/skill/index.ts'), 'utf8')).toBe(
      "export * from '../../../source-root/packages/contracts/src/skill/index.js';\n",
    );
    expect(fs.existsSync(path.join(entrypointRoot, 'contracts/cli/register/index.ts'))).toBe(false);
  });

  it('uses supported conditional export targets', () => {
    const frameworkRoot = path.join(tempDir, 'source-root');
    const packageRoot = path.join(frameworkRoot, 'packages/contracts');
    fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@makaio/contracts',
        exports: {
          '.': { types: './src/index.ts', import: './dist/index.js' },
        },
      }),
    );

    const entrypointRoot = path.join(tempDir, 'entrypoints');
    const entryPoints = createPublicApiEntryPoints({
      frameworkRoot,
      packageRoots: [packageRoot],
      entrypointRoot,
    });

    expect(entryPoints).toEqual([path.join(entrypointRoot, 'contracts/index.ts')]);
  });

  it('rejects export targets outside the package root', () => {
    const frameworkRoot = path.join(tempDir, 'source-root');
    const packageRoot = path.join(frameworkRoot, 'packages/contracts');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@makaio/contracts',
        exports: {
          '.': '../shared/src/index.ts',
        },
      }),
    );

    expect(() =>
      createPublicApiEntryPoints({
        frameworkRoot,
        packageRoots: [packageRoot],
        entrypointRoot: path.join(tempDir, 'entrypoints'),
      }),
    ).toThrow('Export . in @makaio/contracts points outside');
  });
});

describe('applyFrameworkSourceLinkOptions', () => {
  it('points generated source links at the public framework repository root', () => {
    const config: Record<string, unknown> = {};

    applyFrameworkSourceLinkOptions(config);

    expect(config).toMatchObject({
      gitRevision: 'main',
      sourceLinkTemplate: 'https://github.com/makaio-ai/makaio-framework/blob/main/{path}#L{line}',
    });
    expect(config).not.toHaveProperty('displayBasePath');
  });
});

describe('normalizeTypeDocPageTitle', () => {
  it('removes TypeDoc Markdown escapes before writing Starlight frontmatter', () => {
    expect(normalizeTypeDocPageTitle('Interface: MakaioExtension\\<THostContext\\>')).toBe(
      'Interface: MakaioExtension<THostContext>',
    );
  });

  it('keeps Markdown emphasis markers out of page titles', () => {
    expect(normalizeTypeDocPageTitle('Function: **defineTool**()')).toBe('Function: defineTool()');
  });
});

describe('normalizeFrameworkSourceLinks', () => {
  it('rewrites nested source links to the public framework repository', () => {
    expect(
      normalizeFrameworkSourceLinks(
        'Defined in: [../../../adapters/core/src/agent/types.ts:60](https://github.com/example/source-workspace/blob/e71fd558adf8116269f7c2ce8e56f0c998c356a5/framework/adapters/core/src/agent/types.ts#L60)',
      ),
    ).toBe(
      'Defined in: [adapters/core/src/agent/types.ts:60](https://github.com/makaio-ai/makaio-framework/blob/main/adapters/core/src/agent/types.ts#L60)',
    );
  });
});

describe('writeApiSymbolManifest', () => {
  it('writes linkable API symbols from generated TypeDoc Markdown', () => {
    const outputDir = path.join(tempDir, 'reference/api');
    const manifestPath = path.join(tempDir, '.api-symbol-manifest.json');
    fs.mkdirSync(path.join(outputDir, 'ai-adapters-core/classes'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'ai-adapters-core/type-aliases'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'ai-adapters-core/enumerations'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'ai-adapters-core/classes/AIAdapter.md'), '# AIAdapter');
    fs.writeFileSync(path.join(outputDir, 'ai-adapters-core/type-aliases/AgentContext.md'), '# AgentContext');
    fs.writeFileSync(path.join(outputDir, 'ai-adapters-core/enumerations/HiddenEnum.md'), '# HiddenEnum');

    const manifest = writeApiSymbolManifest(outputDir, manifestPath);

    expect(manifest).toEqual({
      AIAdapter: '/reference/api/ai-adapters-core/classes/aiadapter/',
      AgentContext: '/reference/api/ai-adapters-core/type-aliases/agentcontext/',
    });
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });

  it('resolves duplicate API symbols deterministically by sorted package/category/file order', () => {
    const outputDir = path.join(tempDir, 'reference/api-duplicates');
    const manifestPath = path.join(tempDir, '.api-symbol-manifest-duplicates.json');
    fs.mkdirSync(path.join(outputDir, 'z-package/classes'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'a-package/interfaces'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'z-package/classes/Duplicate.md'), '# Duplicate');
    fs.writeFileSync(path.join(outputDir, 'a-package/interfaces/Duplicate.md'), '# Duplicate');

    const manifest = writeApiSymbolManifest(outputDir, manifestPath);

    expect(manifest.Duplicate).toBe('/reference/api/a-package/interfaces/duplicate/');
  });
});

describe('toApiSlug', () => {
  it('normalizes punctuation without collapsing tokens together', () => {
    expect(toApiSlug('Foo.Bar<Baz>')).toBe('foo-bar-baz');
  });

  it('rejects names that cannot produce a route segment', () => {
    expect(() => toApiSlug('***')).toThrow(/Cannot derive API slug/);
  });
});

describe('loadOrCreateApiSymbolManifest', () => {
  it('recreates a missing manifest from existing generated API Markdown', () => {
    const outputDir = path.join(tempDir, 'reference/api');
    const manifestPath = path.join(tempDir, '.api-symbol-manifest.json');
    fs.mkdirSync(path.join(outputDir, 'bus-core/interfaces'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'bus-core/interfaces/IMakaioBus.md'), '# IMakaioBus');

    const manifest = loadOrCreateApiSymbolManifest({ outputDir, manifestPath });

    expect(manifest).toEqual({
      IMakaioBus: '/reference/api/bus-core/interfaces/imakaiobus/',
    });
    expect(fs.existsSync(manifestPath)).toBe(true);
  });
});
