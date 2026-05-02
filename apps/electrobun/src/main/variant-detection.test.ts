import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectVariant } from './variant-detection.js';

function createBundleLayout(): { execPath: string; resourcesDir: string; tempDir: string; variantPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-variant-'));
  const macOsDir = path.join(tempDir, 'Makaio.app', 'Contents', 'MacOS');
  const resourcesDir = path.join(tempDir, 'Makaio.app', 'Contents', 'Resources');
  fs.mkdirSync(macOsDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  return {
    execPath: path.join(macOsDir, 'Makaio'),
    resourcesDir,
    tempDir,
    variantPath: path.join(resourcesDir, 'variant.json'),
  };
}

describe('detectVariant', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows env fallback in development when no bundled descriptor exists', () => {
    const layout = createBundleLayout();
    tempDirs.push(layout.tempDir);

    expect(detectVariant({ env: { MAKAIO_VARIANT: 'cef' }, execPath: layout.execPath, isDev: true })).toMatchObject({
      variant: 'cef',
    });
  });

  it('reads the bundled descriptor in production', () => {
    const layout = createBundleLayout();
    tempDirs.push(layout.tempDir);
    fs.writeFileSync(layout.variantPath, '{"variant":"cef"}\n');

    expect(detectVariant({ env: {}, execPath: layout.execPath, isDev: false })).toMatchObject({
      variant: 'cef',
    });
  });

  it('throws in production when the bundled descriptor is missing', () => {
    const layout = createBundleLayout();
    tempDirs.push(layout.tempDir);

    expect(() => detectVariant({ env: {}, execPath: layout.execPath, isDev: false })).toThrow(
      `Missing bundled variant descriptor at ${layout.variantPath}`,
    );
  });

  it('throws in production when the bundled descriptor cannot be parsed', () => {
    const layout = createBundleLayout();
    tempDirs.push(layout.tempDir);
    fs.writeFileSync(layout.variantPath, '{');

    expect(() => detectVariant({ env: {}, execPath: layout.execPath, isDev: false })).toThrow(
      `Failed to parse bundled variant descriptor at ${layout.variantPath}`,
    );
  });
});
