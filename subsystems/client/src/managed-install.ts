/**
 * Focused public API for hosts that execute canonical managed-client installs.
 * @packageDocumentation
 */

export { createStrategy } from './binary-strategies/index.js';
export type { InstallArtifact, InstallStrategy, StrategyDependencies } from './binary-strategies/index.js';
export { verifyInstalledVersion } from './client-binary-version-verifier.js';
