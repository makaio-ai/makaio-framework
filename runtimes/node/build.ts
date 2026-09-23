import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createLocalBinPathEnv } from '@makaio/build-tooling/process-env';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';
import { copyNodePtyBridgeAsset } from './build-native-session-bridge.js';

const start = performance.now();
const buildEnv = createLocalBinPathEnv({ startDir: import.meta.dirname });

console.info('[build] Bundling JS via tsdown...');
execSync('tsdown', {
  stdio: 'inherit',
  cwd: import.meta.dirname,
  env: buildEnv,
});

emitDeclarations({ packageDir: import.meta.dirname });
copyNodePtyBridgeAsset(
  join(import.meta.dirname, '../../subsystems/native-session-supervisor/src/pty/bridge/pty-bridge.cjs'),
  join(import.meta.dirname, 'dist'),
);

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
console.info(`[build] Done in ${elapsed}s`);
