import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NoopFrameworkModuleResolver, resolveFrameworkSpecifier } from './framework-module-resolver.js';

describe('framework module resolver', () => {
  it('maps framework subpath specifiers into the configured dist path', () => {
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/bus')).toBe(
      '/app/dist/framework/bus/index.mjs',
    );
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/contracts')).toBe(
      '/app/dist/framework/contracts/index.mjs',
    );
    expect(resolveFrameworkSpecifier('/app/dist/framework', '@makaio/framework/adapters/stream-session')).toBe(
      '/app/dist/framework/adapters/stream-session/index.mjs',
    );
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
    const busDir = join(tempDir, 'bus');
    const smokeScriptPath = join(tempDir, 'resolver-smoke.mjs');
    mkdirSync(busDir, { recursive: true });
    writeFileSync(join(busDir, 'index.mjs'), 'export const resolverSmokeValue = "mapped";\n');
    writeFileSync(
      smokeScriptPath,
      `
import { NodeFrameworkModuleResolver } from ${JSON.stringify(
        pathToFileURL(join(import.meta.dirname, 'framework-module-resolver.ts')).href,
      )};

const resolver = new NodeFrameworkModuleResolver(${JSON.stringify(tempDir)});
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
      'utf8',
    );

    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', smokeScriptPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('mapped');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
