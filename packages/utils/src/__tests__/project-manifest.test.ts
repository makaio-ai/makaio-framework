import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_MANIFEST_FILE,
  ProjectManifestSchema,
  compareProjectManifestExtensions,
  findProjectManifestPath,
  formatExactExtensionSpec,
  parseExactExtensionSpec,
  readProjectManifest,
  writeProjectManifest,
} from '../project-manifest.js';

function makeTempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'makaio-project-manifest-'));
}

describe('project manifest utilities', () => {
  it('finds .makaio/manifest.json by walking upward and stops at git root', async () => {
    const repo = makeTempRepo();
    const nested = path.join(repo, 'a', 'b');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await mkdir(path.join(repo, '.makaio'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repo, PROJECT_MANIFEST_FILE), '{"extensions":[]}', 'utf-8');

    await expect(findProjectManifestPath(nested)).resolves.toBe(path.join(repo, PROJECT_MANIFEST_FILE));
  });

  it('returns null when the git root does not contain a project manifest', async () => {
    const repo = makeTempRepo();
    const nested = path.join(repo, 'a', 'b');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });

    await expect(findProjectManifestPath(nested)).resolves.toBeNull();
  });

  it('accepts exact npm extension specs and rejects ranges', () => {
    expect(parseExactExtensionSpec('@makaio/extension-workflow@0.1.4')).toEqual({
      packageName: '@makaio/extension-workflow',
      version: '0.1.4',
      spec: '@makaio/extension-workflow@0.1.4',
    });
    expect(parseExactExtensionSpec('weather-tools@1.2.3-beta.1')).toEqual({
      packageName: 'weather-tools',
      version: '1.2.3-beta.1',
      spec: 'weather-tools@1.2.3-beta.1',
    });
    expect(() => parseExactExtensionSpec('@makaio/extension-workflow@^0.1.4')).toThrow(
      'Project manifest extension specs must use exact semantic versions',
    );
    expect(() => parseExactExtensionSpec('weather-tools@01.2.3')).toThrow(
      'Project manifest extension specs must use exact semantic versions',
    );
    expect(() => parseExactExtensionSpec('weather-tools@1.2.3-alpha..beta')).toThrow(
      'Project manifest extension specs must use exact semantic versions',
    );
    expect(() => parseExactExtensionSpec('../local-ext@1.2.3')).toThrow(
      'Project manifest extension specs must use npm package names',
    );
    expect(() => parseExactExtensionSpec('git+https://example.test/repo@1.2.3')).toThrow(
      'Project manifest extension specs must use npm package names',
    );
    expect(() => parseExactExtensionSpec('@makaio/extension-workflow/subpath@1.2.3')).toThrow(
      'Project manifest extension specs must use npm package names',
    );
  });

  it('formats exact extension specs from package name and version', () => {
    expect(formatExactExtensionSpec('@makaio/extension-workflow', '0.1.4')).toBe('@makaio/extension-workflow@0.1.4');
    expect(() => formatExactExtensionSpec('../local-ext', '0.1.4')).toThrow(
      'Project manifest extension specs must use npm package names',
    );
    expect(() => formatExactExtensionSpec('@makaio/extension-workflow', '^0.1.4')).toThrow(
      'Project manifest extension specs must use exact semantic versions',
    );
  });

  it('compares manifest pins with installed singleton state', () => {
    expect(
      compareProjectManifestExtensions(
        ['@makaio/extension-workflow@0.1.4', '@makaio/extension-prompt@1.0.0', '@makaio/extension-old@2.0.0'],
        [
          { name: '@makaio/extension-workflow', version: '0.1.4' },
          { name: '@makaio/extension-old', version: '2.1.0' },
        ],
      ),
    ).toEqual({
      satisfied: [
        {
          manifest: {
            packageName: '@makaio/extension-workflow',
            version: '0.1.4',
            spec: '@makaio/extension-workflow@0.1.4',
          },
          installedVersion: '0.1.4',
        },
      ],
      missing: [
        {
          packageName: '@makaio/extension-prompt',
          version: '1.0.0',
          spec: '@makaio/extension-prompt@1.0.0',
        },
      ],
      mismatched: [
        {
          manifest: {
            packageName: '@makaio/extension-old',
            version: '2.0.0',
            spec: '@makaio/extension-old@2.0.0',
          },
          installedVersion: '2.1.0',
        },
      ],
    });
  });

  it('validates core fields while preserving host-owned namespaces', async () => {
    const repo = makeTempRepo();
    const manifestPath = path.join(repo, PROJECT_MANIFEST_FILE);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        $schema: 'makaio/project-manifest/v1',
        extensions: ['@makaio/extension-workflow@0.1.4'],
        hosts: { 'example-host': { bootstrap: { import: { enabled: true } } } },
      }),
      'utf-8',
    );

    const manifest = await readProjectManifest(manifestPath);

    expect(manifest.extensions).toEqual(['@makaio/extension-workflow@0.1.4']);
    expect(manifest.hosts).toEqual({ 'example-host': { bootstrap: { import: { enabled: true } } } });
  });

  it('writes pretty JSON and preserves host-owned namespaces supplied by caller', async () => {
    const repo = makeTempRepo();
    const manifestPath = path.join(repo, PROJECT_MANIFEST_FILE);
    await writeProjectManifest(manifestPath, {
      $schema: 'makaio/project-manifest/v1',
      extensions: ['@makaio/extension-workflow@0.1.4'],
      hosts: { 'example-host': { bootstrap: { import: { enabled: true } } } },
    });

    const raw = await readFile(manifestPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({
      $schema: 'makaio/project-manifest/v1',
      extensions: ['@makaio/extension-workflow@0.1.4'],
      hosts: { 'example-host': { bootstrap: { import: { enabled: true } } } },
    });
  });

  it('exposes the schema for callers that need direct parsing', () => {
    expect(() =>
      ProjectManifestSchema.parse({
        extensions: ['@makaio/extension-workflow@0.1.4'],
        hosts: { custom: true },
      }),
    ).not.toThrow();
  });
});
