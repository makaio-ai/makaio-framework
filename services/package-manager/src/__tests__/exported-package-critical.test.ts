import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveExportedPackageCritical,
  resolveExportedPackages,
  resolveCriticalFlag,
  toLocalPackageInfo,
} from '../exported-package-critical.js';

describe('resolveExportedPackageCritical', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exported-package-critical-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads critical from a single-object default export matching the descriptor name', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default { name: 'solo-ext', displayName: 'Solo', version: '1.0.0', critical: true };\n`,
    );

    const critical = await resolveExportedPackageCritical(modulePath, 'solo-ext', '[test] solo-ext');

    expect(critical).toBe(true);
  });

  it('reads critical from the descriptor-named member of an array default export', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default [\n` +
        `  { name: 'parent-ext', displayName: 'Parent', version: '1.0.0', critical: false },\n` +
        `  { name: 'parent-ext.child', displayName: 'Child', version: '1.0.0', critical: true },\n` +
        `];\n`,
    );

    const critical = await resolveExportedPackageCritical(modulePath, 'parent-ext', '[test] parent-ext');

    expect(critical).toBe(false);
  });

  it('resolves undefined when the exported package declares no critical flag', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default { name: 'optional-ext', displayName: 'Optional', version: '1.0.0' };\n`,
    );

    const critical = await resolveExportedPackageCritical(modulePath, 'optional-ext', '[test] optional-ext');

    expect(critical).toBeUndefined();
  });

  it('warns and resolves undefined, never false, when the import fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(
        path.join(tempDir, 'does-not-exist.mjs'),
        'missing-ext',
        '[test] missing-ext',
      );

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[test] missing-ext: failed to import server entry'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and resolves undefined when no exported package matches the descriptor name', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(modulePath, `export default { name: 'other-name', displayName: 'Other', version: '1.0.0' };\n`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(modulePath, 'expected-name', '[test] expected-name');

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("does not include a package named 'expected-name'"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and resolves undefined when the descriptor-named export is missing displayName/version', async () => {
    // Pairs with load-extensions.test.ts's "skips extension when imported package
    // name does not match descriptor name" family: `normalizeExtensionManifestExport`
    // (@makaio/contracts) rejects this shape structurally before name is ever
    // considered relevant, and the worker text mirroring it must reject it the
    // same way rather than matching on `name` alone.
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(modulePath, `export default { name: 'shape-ext', critical: true };\n`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(modulePath, 'shape-ext', '[test] shape-ext');

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('default export is not a valid MakaioExtension or MakaioExtension[]'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and resolves undefined when an array export contains a duplicate package name', async () => {
    // Pairs with load-extensions.test.ts's "skips a package array with duplicate
    // package names" — the whole export is invalid, not just resolvable via the
    // first match, so this must not silently return the first duplicate's flag.
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default [\n` +
        `  { name: 'dup-ext', displayName: 'Dup', version: '1.0.0', critical: true },\n` +
        `  { name: 'dup-ext', displayName: 'Dup', version: '2.0.0', critical: false },\n` +
        `];\n`,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(modulePath, 'dup-ext', '[test] dup-ext');

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("duplicate package name 'dup-ext'"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and resolves undefined when an array export contains a package outside the descriptor namespace', async () => {
    // Pairs with load-extensions.test.ts's "skips an extension package array when
    // a child package is outside the descriptor namespace".
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default [\n` +
        `  { name: 'ns-ext', displayName: 'Ns', version: '1.0.0', critical: true },\n` +
        `  { name: 'unrelated-package', displayName: 'Unrelated', version: '1.0.0' },\n` +
        `];\n`,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(modulePath, 'ns-ext', '[test] ns-ext');

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("outside descriptor namespace 'ns-ext'"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and resolves undefined, never the raw value, when the exported critical field is not a boolean', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default { name: 'stringly-critical-ext', displayName: 'Stringly', version: '1.0.0', critical: 'yes' };\n`,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(
        modulePath,
        'stringly-critical-ext',
        '[test] stringly-critical-ext',
      );

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("'critical' field for 'stringly-critical-ext' is not a boolean (got string)"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('re-imports a reinstalled server entry instead of returning a module-cached stale critical value', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default { name: 'reinstalled-ext', displayName: 'Reinstalled', version: '1.0.0', critical: true };\n`,
    );

    const firstCritical = await resolveExportedPackageCritical(modulePath, 'reinstalled-ext', '[test] reinstalled-ext');
    expect(firstCritical).toBe(true);

    // Simulate an in-place reinstall: same path, new content.
    await fs.writeFile(
      modulePath,
      `export default { name: 'reinstalled-ext', displayName: 'Reinstalled', version: '1.0.0', critical: false };\n`,
    );

    const secondCritical = await resolveExportedPackageCritical(
      modulePath,
      'reinstalled-ext',
      '[test] reinstalled-ext',
    );
    expect(secondCritical).toBe(false);
  });

  it('re-imports the full module graph, not just the entrypoint, when the entrypoint re-exports its package object from another file', async () => {
    // Regression for a cache-busting scheme that only defeated Node's ESM
    // module cache for the entrypoint's own URL: a dependency the entrypoint
    // imports/re-exports from would still resolve under its own unbusted
    // file URL and keep returning the process-cached, pre-reinstall module.
    // A fresh worker thread per call has its own module registry, so this
    // must observe the update on both files, not just the entrypoint.
    const packagePath = path.join(tempDir, 'package.mjs');
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      packagePath,
      `export const ownPackage = { name: 're-exported-ext', displayName: 'Re-exported', version: '1.0.0', critical: true };\n`,
    );
    await fs.writeFile(modulePath, `export { ownPackage as default } from './package.mjs';\n`);

    const firstCritical = await resolveExportedPackageCritical(modulePath, 're-exported-ext', '[test] re-exported-ext');
    expect(firstCritical).toBe(true);

    // In-place reinstall updates both the entrypoint's dependency and the
    // entrypoint itself, exactly as a real extension reinstall would.
    await fs.writeFile(
      packagePath,
      `export const ownPackage = { name: 're-exported-ext', displayName: 'Re-exported', version: '2.0.0', critical: false };\n`,
    );
    await fs.writeFile(modulePath, `export { ownPackage as default } from './package.mjs';\n`);

    const secondCritical = await resolveExportedPackageCritical(
      modulePath,
      're-exported-ext',
      '[test] re-exported-ext',
    );
    expect(secondCritical).toBe(false);
  });

  it('warns and resolves undefined, never false, when the server entry throws during import', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(modulePath, `throw new Error('boom during top-level evaluation');\n`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const critical = await resolveExportedPackageCritical(modulePath, 'broken-ext', '[test] broken-ext');

      expect(critical).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[test] broken-ext: failed to import server entry'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves the exported package only when frameworkDistPath is supplied, mirroring NodeFrameworkModuleResolver', async () => {
    // Simulates a packaged Electron host: the server entry imports a
    // `@makaio/framework/*` subpath that only resolves through the
    // main-thread `NodeFrameworkModuleResolver` hook — the worker must
    // install the equivalent hook itself, or the import rejects even though
    // the main thread (which installed its own copy of the hook at boot)
    // would have loaded the same file fine.
    const frameworkRoot = path.join(tempDir, 'framework-dist');
    const distDir = path.join(frameworkRoot, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(frameworkRoot, 'package.json'),
      JSON.stringify({ name: '@makaio/framework', exports: { './marker': './dist/marker.mjs' } }),
    );
    await fs.writeFile(path.join(distDir, 'marker.mjs'), `export const MARKER = true;\n`);

    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `import { MARKER } from '@makaio/framework/marker';\n` +
        `export default { name: 'framework-dependent-ext', displayName: 'Framework Dependent', version: '1.0.0', critical: MARKER };\n`,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const withoutHook = await resolveExportedPackageCritical(
        modulePath,
        'framework-dependent-ext',
        '[test] framework-dependent-ext',
      );
      expect(withoutHook).toBeUndefined();

      const withHook = await resolveExportedPackageCritical(
        modulePath,
        'framework-dependent-ext',
        '[test] framework-dependent-ext',
        distDir,
      );
      expect(withHook).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('resolveExportedPackages', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-exported-packages-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reports every package an array export declares, not just the descriptor-named one', async () => {
    // The enablement store is keyed by executable package name, and one
    // descriptor can export several — a listing that only saw the descriptor's
    // own package could not address its children at all.
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default [\n` +
        `  { name: 'parent-ext', displayName: 'Parent', version: '1.0.0', critical: false },\n` +
        `  { name: 'parent-ext.child', displayName: 'Child', version: '2.0.0', critical: true },\n` +
        `];\n`,
    );

    const listing = await resolveExportedPackages(modulePath, 'parent-ext', '[test] parent-ext');

    expect(listing?.packages).toEqual([
      { name: 'parent-ext', version: '1.0.0', critical: false },
      { name: 'parent-ext.child', version: '2.0.0', critical: true },
    ]);
    expect(listing?.invalidCriticalNames.size).toBe(0);
  });

  it('omits a declared-but-unusable critical flag and names the package it belongs to', async () => {
    // Reporting `critical: undefined` alone would be indistinguishable from a
    // package that legitimately declares nothing, which is the difference
    // between refusing a disable and allowing it.
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default [\n` +
        `  { name: 'parent-ext', displayName: 'Parent', version: '1.0.0' },\n` +
        `  { name: 'parent-ext.child', displayName: 'Child', version: '1.0.0', critical: 'yes' },\n` +
        `];\n`,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const listing = await resolveExportedPackages(modulePath, 'parent-ext', '[test] parent-ext');

      expect(listing?.packages).toEqual([
        { name: 'parent-ext', version: '1.0.0' },
        { name: 'parent-ext.child', version: '1.0.0' },
      ]);
      expect([...(listing?.invalidCriticalNames ?? [])]).toEqual(['parent-ext.child']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("'critical' field for 'parent-ext.child' is not a boolean (got string)"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves undefined, never a partial listing, when the export violates the identity contract', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default [\n` +
        `  { name: 'parent-ext', displayName: 'Parent', version: '1.0.0' },\n` +
        `  { name: 'unrelated-ext', displayName: 'Unrelated', version: '1.0.0' },\n` +
        `];\n`,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const listing = await resolveExportedPackages(modulePath, 'parent-ext', '[test] parent-ext');

      expect(listing).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('outside descriptor namespace'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves undefined when the entrypoint does not exist', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const listing = await resolveExportedPackages(
        path.join(tempDir, 'missing.mjs'),
        'missing-ext',
        '[test] missing-ext',
      );

      expect(listing).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to import server entry while reading its exported packages'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('resolveCriticalFlag', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-critical-flag-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('uses the descriptor-declared value when there is no server entrypoint', async () => {
    const critical = await resolveCriticalFlag(true, undefined, 'detached-ext', '[test] detached-ext');
    expect(critical).toBe(true);
  });

  it('reads the exported package instead of the descriptor when a server entrypoint is present', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default { name: 'server-ext', displayName: 'Server Ext', version: '1.0.0', critical: true };\n`,
    );

    // A descriptor with a server entrypoint cannot itself declare `critical`
    // — the schema rejects that combination — so callers always pass
    // `undefined` here; this asserts the exported value wins regardless.
    const critical = await resolveCriticalFlag(undefined, modulePath, 'server-ext', '[test] server-ext');

    expect(critical).toBe(true);
  });
});

describe('toLocalPackageInfo', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'to-local-package-info-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('carries a descriptor-declared critical flag through when there is no server entrypoint', async () => {
    const info = await toLocalPackageInfo({ name: 'detached-ext', version: '1.0.0', critical: true });

    expect(info).toEqual({
      name: 'detached-ext',
      version: '1.0.0',
      hasDescriptor: true,
      descriptorName: 'detached-ext',
      critical: true,
    });
  });

  it('resolves critical from the exported package when a server entrypoint is present', async () => {
    const modulePath = path.join(tempDir, 'server.mjs');
    await fs.writeFile(
      modulePath,
      `export default { name: 'server-ext', displayName: 'Server Ext', version: '1.0.0', critical: true };\n`,
    );

    const info = await toLocalPackageInfo({ name: 'server-ext', version: '1.0.0', serverImportPath: modulePath });

    expect(info).toEqual({
      name: 'server-ext',
      version: '1.0.0',
      hasDescriptor: true,
      descriptorName: 'server-ext',
      serverImportPath: modulePath,
      critical: true,
    });
  });
});
