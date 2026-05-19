export type {
  SetupStepId,
  SetupMode,
  SetupConfig,
  SetupRestartAndReconnect,
  ConsentState,
  SetupClientEntry,
  DetectedClient,
  ManagedRecommendation,
  ManagedBinaryState,
  InstallProgress,
  SetupResult,
  SetupState,
  SetupActions,
  SetupController,
  SetupClientBinaryInventory,
  InstalledVersionSummary,
} from './types.js';
export { recommendManagedAction, buildManagedBinaryStates } from './detect/managed-binary.js';
export type { ManagedBinaryBuildInput } from './detect/managed-binary.js';
export { CLIENT_CATALOG } from './detect/client-catalog.js';
export { detectClients, resolveSelectedExtensionPackages } from './detect/detect-clients.js';
export { computeConsentHash, loadConsentDocument } from './consent/consent-document.js';
export { readConsentRecord, writeConsentRecord } from './consent/consent-store.js';
export { installExtensionPackages } from './bus/package-manager-ops.js';
export { loadClientInventory, activateManagedPins } from './bus/client-ops.js';
export type { ClientInventoryResult } from './bus/client-ops.js';
export { requestKernelRestart } from './bus/kernel-ops.js';
export { createSetupController } from './setup-controller.js';
