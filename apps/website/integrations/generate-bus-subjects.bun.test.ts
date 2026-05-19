import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { copyMarkdownTree, generateBusSubjects } from './generate-bus-subjects';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-bus-subjects-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('generateBusSubjects', () => {
  it('returns an Astro integration with the expected name', () => {
    const integration = generateBusSubjects();
    expect(integration.name).toBe('generate-bus-subjects');
    expect(integration.hooks).toHaveProperty('astro:config:setup');
  });

  it('copies markdown files when the setup hook runs', () => {
    const src = path.join(tempDir, 'source');
    const dest = path.join(tempDir, 'dest');

    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'index.md'), '# Index\n');

    const integration = generateBusSubjects({ sourceDir: src, outputDir: dest });
    const setupHook = integration.hooks['astro:config:setup'];
    expect(setupHook).toBeDefined();
    setupHook?.({} as Parameters<NonNullable<typeof setupHook>>[0]);

    expect(fs.readFileSync(path.join(dest, 'index.md'), 'utf8')).toBe('# Index\n');
  });
});

describe('copyMarkdownTree', () => {
  it('copies Markdown files and skips the data directory', () => {
    const src = path.join(tempDir, 'source');
    const dest = path.join(tempDir, 'dest');

    fs.mkdirSync(path.join(src, 'adapters'), { recursive: true });
    fs.mkdirSync(path.join(src, 'data'), { recursive: true });
    fs.writeFileSync(path.join(src, 'index.md'), '# Index\n');
    fs.writeFileSync(path.join(src, 'agent.md'), '# agent\n');
    fs.writeFileSync(path.join(src, 'adapters/index.md'), '# adapters\n');
    fs.writeFileSync(path.join(src, 'data/namespaces.json'), '{}');
    fs.writeFileSync(path.join(src, 'ignored.txt'), 'not markdown');

    copyMarkdownTree(src, dest);

    expect(fs.readFileSync(path.join(dest, 'index.md'), 'utf8')).toBe('# Index\n');
    expect(fs.readFileSync(path.join(dest, 'agent.md'), 'utf8')).toBe('# agent\n');
    expect(fs.readFileSync(path.join(dest, 'adapters/index.md'), 'utf8')).toBe('# adapters\n');
    expect(fs.existsSync(path.join(dest, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'ignored.txt'))).toBe(false);
  });
});
