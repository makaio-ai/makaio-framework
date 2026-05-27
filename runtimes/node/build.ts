import { execSync } from 'node:child_process';
import { createLocalBinPathEnv } from '@makaio/build-tooling/process-env';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

const start = performance.now();
const buildEnv = createLocalBinPathEnv({ startDir: import.meta.dirname });

console.info('[build] Bundling JS via tsdown...');
execSync('tsdown', {
  stdio: 'inherit',
  cwd: import.meta.dirname,
  env: buildEnv,
});

emitDeclarations({ packageDir: import.meta.dirname });

const elapsed = ((performance.now() - start) / 1000).toFixed(1);
console.info(`[build] Done in ${elapsed}s`);
