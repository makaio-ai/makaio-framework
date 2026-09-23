import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyNodePtyBridgeAsset, nodePtyBridgeRelativePath } from './build-native-session-bridge.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'makaio-runtime-node-build-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('copyNodePtyBridgeAsset', () => {
  it('places the CommonJS bridge at the bundled backend runtime path', () => {
    const fixtureDir = makeTempDir();
    const bridgeSource = join(fixtureDir, 'pty-bridge.cjs');
    const distDir = join(fixtureDir, 'dist');
    const bridgeContents = "require('node-pty');\n";
    writeFileSync(bridgeSource, bridgeContents);

    copyNodePtyBridgeAsset(bridgeSource, distDir);

    const stagedBridge = join(distDir, nodePtyBridgeRelativePath);
    expect(existsSync(stagedBridge)).toBe(true);
    expect(readFileSync(stagedBridge, 'utf8')).toBe(bridgeContents);
  });
});
