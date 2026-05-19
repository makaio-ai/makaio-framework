import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { resolveStaticModelRegistryPath } from '../static-registry-path.js';

describe('resolveStaticModelRegistryPath', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the static model registry path when running from a source checkout', () => {
    const root = mkdtempWorkspace();
    const registryPath = path.join(root, 'static', 'model-registry.yaml');
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, '{}\n', 'utf-8');

    const packageDir = path.join(root, 'framework', 'runtimes', 'node', 'src');
    mkdirSync(packageDir, { recursive: true });

    expect(resolveStaticModelRegistryPath(packageDir)).toBe(registryPath);
  });

  it('returns undefined outside a source checkout', () => {
    const packagedDist = path.join(mkdtempWorkspace(), 'Test.app', 'Contents', 'Resources', 'app.asar', 'dist');
    mkdirSync(packagedDist, { recursive: true });

    expect(resolveStaticModelRegistryPath(packagedDist)).toBeUndefined();
  });

  function mkdtempWorkspace(): string {
    const root = path.join(os.tmpdir(), `makaio-static-registry-${crypto.randomUUID()}`);
    tempDirs.push(root);
    mkdirSync(path.join(root, 'framework'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(path.join(root, 'framework', 'package.json'), '{}\n', 'utf-8');
    return root;
  }
});
