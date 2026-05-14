import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NoopFrameworkModuleResolver, resolveFrameworkSpecifier } from './framework-module-resolver.js';

function runNodeResolverScript(tempDir: string, source: string) {
  const nodeBinary = process.env['NODE_BINARY'] ?? 'node';
  const smokeScriptPath = join(tempDir, 'resolver-smoke.mjs');
  writeFileSync(smokeScriptPath, source, 'utf8');
  return spawnSync(nodeBinary, ['--import', 'tsx', smokeScriptPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('framework module resolver', () => {
  it('maps framework subpath specifiers into the configured dist path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        exports: {
          './bus': { default: './dist/bus/index.mjs' },
          './contracts': { default: './dist/contracts/index.mjs' },
          './adapters/stream-session': { default: './dist/adapters/stream-session/index.mjs' },
        },
      }),
      'utf8',
    );
    const distDir = join(tempDir, 'dist');

    try {
      expect(resolveFrameworkSpecifier(distDir, '@makaio/framework/bus')).toBe(join(distDir, 'bus', 'index.mjs'));
      expect(resolveFrameworkSpecifier(distDir, '@makaio/framework/contracts')).toBe(
        join(distDir, 'contracts', 'index.mjs'),
      );
      expect(resolveFrameworkSpecifier(distDir, '@makaio/framework/adapters/stream-session')).toBe(
        join(distDir, 'adapters', 'stream-session', 'index.mjs'),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps file-based framework exports through package.json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        exports: {
          './utils/workspace-root': { default: './dist/utils/workspace-root.mjs' },
          './storage/drizzle/client': { default: './dist/storage/drizzle/client.mjs' },
        },
      }),
      'utf8',
    );
    const distDir = join(tempDir, 'dist');

    try {
      expect(resolveFrameworkSpecifier(distDir, '@makaio/framework/utils/workspace-root')).toBe(
        join(distDir, 'utils', 'workspace-root.mjs'),
      );
      expect(resolveFrameworkSpecifier(distDir, '@makaio/framework/storage/drizzle/client')).toBe(
        join(distDir, 'storage', 'drizzle', 'client.mjs'),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the subpath is not exported by the framework package', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ exports: {} }), 'utf8');
    try {
      expect(resolveFrameworkSpecifier(join(tempDir, 'dist'), '@makaio/framework/bus')).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not map package exports outside the framework package root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ exports: { './bus': { default: '../outside.mjs' } } }),
      'utf8',
    );

    try {
      expect(resolveFrameworkSpecifier(join(tempDir, 'dist'), '@makaio/framework/bus')).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps framework subpath specifiers through an explicit exports map', () => {
    const exportsMap = {
      './bus': { default: './dist/bus/index.mjs' },
      './contracts': { default: './dist/contracts/index.mjs' },
      './adapters/stream-session': { default: './dist/adapters/stream-session/index.mjs' },
    };

    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/bus', exportsMap)).toBe(
      '/app/dist/framework/bus/index.mjs',
    );
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/contracts', exportsMap)).toBe(
      '/app/dist/framework/contracts/index.mjs',
    );
    expect(
      resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/adapters/stream-session', exportsMap),
    ).toBe('/app/dist/framework/adapters/stream-session/index.mjs');
  });

  it('does not map unrelated package specifiers', () => {
    expect(resolveFrameworkSpecifier('/app/dist/framework', 'openai')).toBeUndefined();
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/adapter-openai-node')).toBeUndefined();
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework')).toBeUndefined();
  });

  it('rejects malformed framework subpaths', () => {
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/')).toBeUndefined();
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/bus/../contracts')).toBeUndefined();
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/bus//contracts')).toBeUndefined();
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/bus\\contracts')).toBeUndefined();
  });

  it('noop resolver has empty dist path and is idempotent', () => {
    const resolver = new NoopFrameworkModuleResolver();
    expect(resolver.frameworkDistPath).toBe('');
    resolver.install();
    resolver.uninstall();
    resolver.uninstall();
  });

  it('node resolver maps framework imports while installed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    const distDir = join(tempDir, 'dist');
    const busDir = join(distDir, 'bus');
    mkdirSync(busDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ exports: { './bus': { default: './dist/bus/index.mjs' } } }),
      'utf8',
    );
    writeFileSync(join(busDir, 'index.mjs'), 'export const resolverSmokeValue = "mapped";\n');

    try {
      const result = runNodeResolverScript(
        tempDir,
        `
import { NodeFrameworkModuleResolver } from ${JSON.stringify(
          pathToFileURL(join(import.meta.dirname, 'framework-module-resolver.ts')).href,
        )};

const resolver = new NodeFrameworkModuleResolver(${JSON.stringify(distDir)});
try {
  await resolver.install();
  const imported = await import('@makaio/framework/bus');
  if (imported.resolverSmokeValue !== 'mapped') {
    throw new Error(\`Unexpected resolver smoke value: \${String(imported.resolverSmokeValue)}\`);
  }
  console.log(imported.resolverSmokeValue);
} finally {
  resolver.uninstall();
}
`,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('mapped');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('node resolver does not leave stale hooks after concurrent installs are uninstalled', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    const distDir = join(tempDir, 'dist');
    mkdirSync(join(distDir, 'bus'), { recursive: true });
    mkdirSync(join(distDir, 'contracts'), { recursive: true });
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        exports: {
          './bus': { default: './dist/bus/index.mjs' },
          './contracts': { default: './dist/contracts/index.mjs' },
        },
      }),
      'utf8',
    );
    writeFileSync(join(distDir, 'bus', 'index.mjs'), 'export const resolverSmokeValue = "mapped";\n');
    writeFileSync(join(distDir, 'contracts', 'index.mjs'), 'export const staleHookValue = "stale";\n');

    try {
      const result = runNodeResolverScript(
        tempDir,
        `
import { NodeFrameworkModuleResolver } from ${JSON.stringify(
          pathToFileURL(join(import.meta.dirname, 'framework-module-resolver.ts')).href,
        )};

const resolver = new NodeFrameworkModuleResolver(${JSON.stringify(distDir)});
await Promise.all([resolver.install(), resolver.install()]);
const imported = await import('@makaio/framework/bus');
if (imported.resolverSmokeValue !== 'mapped') {
  throw new Error(\`Unexpected resolver smoke value: \${String(imported.resolverSmokeValue)}\`);
}

resolver.uninstall();
try {
  await import('@makaio/framework/contracts');
  throw new Error('Resolver remained installed after concurrent install uninstall');
} catch (error) {
  if (error instanceof Error && error.message === 'Resolver remained installed after concurrent install uninstall') {
    throw error;
  }
}
console.log('uninstalled');
`,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('uninstalled');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('node resolver cancels stale in-flight installs before later installs attach hooks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'makaio-framework-resolver-'));
    const distDir = join(tempDir, 'dist');
    mkdirSync(join(distDir, 'bus'), { recursive: true });
    mkdirSync(join(distDir, 'contracts'), { recursive: true });
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        exports: {
          './bus': { default: './dist/bus/index.mjs' },
          './contracts': { default: './dist/contracts/index.mjs' },
        },
      }),
      'utf8',
    );
    writeFileSync(join(distDir, 'bus', 'index.mjs'), 'export const resolverSmokeValue = "mapped";\n');
    writeFileSync(join(distDir, 'contracts', 'index.mjs'), 'export const staleHookValue = "stale";\n');

    try {
      const result = runNodeResolverScript(
        tempDir,
        `
import { NodeFrameworkModuleResolver } from ${JSON.stringify(
          pathToFileURL(join(import.meta.dirname, 'framework-module-resolver.ts')).href,
        )};

const resolver = new NodeFrameworkModuleResolver(${JSON.stringify(distDir)});
const staleInstall = resolver.install();
resolver.uninstall();
const currentInstall = resolver.install();
await Promise.all([staleInstall, currentInstall]);

const imported = await import('@makaio/framework/bus');
if (imported.resolverSmokeValue !== 'mapped') {
  throw new Error(\`Unexpected resolver smoke value: \${String(imported.resolverSmokeValue)}\`);
}

resolver.uninstall();
try {
  await import('@makaio/framework/contracts');
  throw new Error('Resolver remained installed after canceled install');
} catch (error) {
  if (error instanceof Error && error.message === 'Resolver remained installed after canceled install') {
    throw error;
  }
}
console.log('reinstalled');
`,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('reinstalled');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
