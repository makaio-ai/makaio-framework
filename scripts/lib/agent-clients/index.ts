/**
 * Agent-client probe harness helpers.
 *
 * Re-exports the public API surface of the helper modules used by
 * `test-agent-clients.ts`.
 * @packageDocumentation
 */
export type {
  CandidateHookEventShape,
  EvidenceStatus,
  HookContractManifest,
  HookContractManifestEvent,
  CredentialMode,
  ProbeOptions,
  ProbeScenario,
  ProviderId,
  RecordedHookEvent,
  ScenarioOracle,
  ScenarioFixture,
  ScenarioManifest,
} from './types.js';
export {
  CHILD_ENV_ALLOWLIST,
  PROVIDER_NATIVE_AUTH_ENV_VARS,
  PROVIDER_CREDENTIAL_VARS,
  REDACTED_PLACEHOLDER,
  REDACTION_KEY_PATTERNS,
} from './types.js';

export { prepareNativeLoginLease, resolveCredentialMode } from './credentials.js';
export type { CredentialResolution, NativeLoginLease, NativeLoginLeaseFactory } from './credentials.js';

export {
  buildChildEnvironment,
  buildClaudeCodeCommand,
  buildCodexCommand,
  buildSpawnCommand,
} from './command-construction.js';
export type { SpawnCommand } from './command-construction.js';

export { isRedactableKey, redactDeep, redactStringValue } from './redaction.js';

export {
  compareFixtures,
  fixtureFilePath,
  FIXTURES_BASE_DIR,
  hookContractManifestPath,
  publishProbeEvidence,
  readFixture,
  writeFixture,
} from './fixtures.js';

export {
  getConfigIsolationEnvVar,
  getManagedInstall,
  getManifest,
  getPinnedVersion,
  getVersionCommand,
} from './manifests.js';

export { cleanupProbeWorkspace, createProbeWorkspace } from './workspace.js';
export type { ProbeWorkspace } from './workspace.js';

export { runCommand, runScenario, writeScenarioHookConfig } from './runner.js';
export type { ScenarioRunResult } from './runner.js';

export { extractExactVersion, resolveExecutable, validateBinaryVersion } from './version-validation.js';
export type { VersionValidationResult } from './version-validation.js';

export { preparePinnedProbeBinary, resolveManagedExecutable } from './pinned-binary.js';
export type { PreparedProbeBinary } from './pinned-binary.js';
