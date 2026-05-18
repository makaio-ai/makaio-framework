import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '../workspace-root.js';

describe('resolveWorkspaceRoot', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the root in the prefixed source layout (3 levels deep)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(root);

    // Prefixed-layout marker: root/framework/package.json
    const frameworkDir = path.join(root, 'framework');
    mkdirSync(frameworkDir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(path.join(frameworkDir, 'package.json'), '{}\n', 'utf-8');

    // packageDir is 3 levels deep: root/framework/apps/electron
    const packageDir = path.join(root, 'framework', 'apps', 'electron');
    mkdirSync(packageDir, { recursive: true });

    expect(resolveWorkspaceRoot(packageDir)).toBe(root);
  });

  it('resolves the root in the prefixed source layout (4 levels deep)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(root);

    // Prefixed-layout marker: root/framework/package.json
    // framework/ itself also has package.json, which must NOT be matched.
    const frameworkDir = path.join(root, 'framework');
    mkdirSync(frameworkDir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(path.join(frameworkDir, 'package.json'), '{}\n', 'utf-8');

    // packageDir is 4 levels deep: root/framework/runtimes/node/src
    const packageDir = path.join(root, 'framework', 'runtimes', 'node', 'src');
    mkdirSync(packageDir, { recursive: true });

    expect(resolveWorkspaceRoot(packageDir)).toBe(root);
  });

  it('resolves the root in the package-root layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(root);

    const packageDir = path.join(root, 'apps', 'electron');
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    mkdirSync(packageDir, { recursive: true });

    expect(resolveWorkspaceRoot(packageDir)).toBe(root);
  });

  it('does not overshoot a package-root checkout named framework', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(parent);

    const root = path.join(parent, 'framework');
    const packageDir = path.join(root, 'apps', 'electron');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');

    expect(resolveWorkspaceRoot(packageDir)).toBe(root);
  });

  it('does not overshoot an embedded package-root checkout', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(parent);

    const embeddedRoot = path.join(parent, 'checkout');
    writeFileSync(path.join(parent, 'package.json'), '{}\n', 'utf-8');
    mkdirSync(path.join(parent, 'framework'), { recursive: true });
    writeFileSync(path.join(parent, 'framework', 'package.json'), '{}\n', 'utf-8');
    mkdirSync(embeddedRoot, { recursive: true });
    writeFileSync(path.join(embeddedRoot, 'package.json'), '{}\n', 'utf-8');

    const packageDir = path.join(embeddedRoot, 'apps', 'electron');
    mkdirSync(packageDir, { recursive: true });

    expect(resolveWorkspaceRoot(packageDir)).toBe(embeddedRoot);
  });

  it('does not overshoot to a parent directory that also has package.json', () => {
    // Simulate: /parent/root where parent/ has package.json but root/ is the
    // actual workspace root with framework/package.json.
    const parent = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(parent);

    const root = path.join(parent, 'root');
    mkdirSync(path.join(root, 'framework'), { recursive: true });
    writeFileSync(path.join(parent, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(path.join(root, 'framework', 'package.json'), '{}\n', 'utf-8');

    // packageDir is 3 levels deep under root: root/framework/apps/electron
    const packageDir = path.join(root, 'framework', 'apps', 'electron');
    mkdirSync(packageDir, { recursive: true });

    // Must resolve to root, not parent (even though parent has package.json
    // and is reachable at 4 levels up).
    expect(resolveWorkspaceRoot(packageDir)).toBe(root);
  });

  it('throws when packageDir is relative', () => {
    expect(() => resolveWorkspaceRoot('relative/path')).toThrow(/must be absolute/);
  });

  it('throws when neither supported source layout is detected', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-workspace-root-'));
    tempDirs.push(root);

    // Create a packageDir with no package.json at any candidate depth.
    const packageDir = path.join(root, 'a', 'b', 'c');
    mkdirSync(packageDir, { recursive: true });

    expect(() => resolveWorkspaceRoot(packageDir)).toThrow(/Could not resolve workspace root/);
  });
});
