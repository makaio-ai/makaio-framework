// Service
export { AccountManager, type AccountManagerOptions } from './account-manager.js';

// Interfaces
export type {
  ICredentialSource,
  RawCredential,
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
  StoredAccount,
  StoredAccountCredential,
  IUsageProvider,
  ILabelProvider,
  UsageEntry,
} from './interfaces/index.js';

// Backends
export type { ICredentialBackend } from './backends/credential-backend.js';
export { SecurityCliBackend } from './backends/security-cli-backend.js';
export { KeyringBackend } from './backends/keyring-backend.js';
export { FileBackend } from './backends/file-backend.js';

// Utilities (needed by credential sources and tests)
export { computeFingerprint } from './utils/fingerprint.js';
export { toPublicAccount } from './utils/to-public-account.js';

// Sources
export { ClaudeCodeSource } from './sources/claude-code-source.js';
export { CodexSource } from './sources/codex-source.js';

// Stores
export { DarwinAccountStore } from './stores/darwin-account-store.js';
export { PlaintextAccountStore } from './stores/plaintext-account-store.js';
export {
  BusAccountMetadataStore,
  BusAccountUsageSnapshotStore,
  registerDrizzleAccountManagerStorage,
} from './storage/index.js';

// CLI
export { accountManagerCli } from './cli/index.js';

// Package manifest
export { accountManagerPackage } from './package.js';
