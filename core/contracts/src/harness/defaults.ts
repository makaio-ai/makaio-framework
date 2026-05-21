import type { DefaultHarnessDefinition } from './schemas.js';
import { codexCapabilityMap } from './codex-capability-map.js';

interface RegistryHarnessParams {
  id: string;
  name: string;
  description: string;
  /** Set for API-only adapters that have no associated client application. */
  adapterName?: DefaultHarnessDefinition['adapterName'];
  /** Set for client-backed adapters scoped to a specific client application. */
  clientId?: DefaultHarnessDefinition['clientId'];
}

/**
 * Builds a default "registry tools only" harness definition.
 *
 * Centralizes shared defaults so adapter-specific registry harnesses stay
 * structurally consistent as new adapters are added.
 * @param params - Adapter-specific identity and display metadata
 * @returns Default harness definition for registry-only adapters
 */
function createRegistryHarness(params: RegistryHarnessParams): DefaultHarnessDefinition {
  return {
    id: params.id,
    name: params.name,
    description: params.description,
    adapterName: params.adapterName,
    clientId: params.clientId,
    approvalPolicy: 'always-ask',
    nativeTools: {
      enabled: [],
      disabled: [],
    },
    registryTools: {
      enabled: [],
      disabled: [],
    },
    isDefault: true,
    enabled: true,
  };
}

/** Default harness for codex-app-server native tools. */
export const CODEX_APP_SERVER_NATIVE_HARNESS: DefaultHarnessDefinition = {
  id: 'harness-codex-app-server-native',
  name: 'Codex Native',
  description: 'Codex app server with built-in native tools',
  adapterName: 'codex-app-server',
  clientId: 'codex',
  approvalPolicy: 'always-ask',
  nativeTools: {
    enabled: ['bash', 'patch'],
    disabled: [],
  },
  registryTools: {
    enabled: [],
    disabled: [],
  },
  /**
   * Shared capability map used by both contracts defaults and the
   * codex-app-server adapter runtime export.
   */
  toolCapabilityMap: codexCapabilityMap,
  isDefault: true,
  enabled: true,
};

/** Default harness for openai-node adapter using registry tools only. */
export const OPENAI_NODE_REGISTRY_HARNESS: DefaultHarnessDefinition = createRegistryHarness({
  id: 'harness-openai-node-registry',
  name: 'OpenAI Registry',
  description: 'OpenAI adapter with registry-managed tools',
  adapterName: 'openai-node',
});

/** Default harness for claude-code adapter using registry tools only. */
export const CLAUDE_CODE_REGISTRY_HARNESS: DefaultHarnessDefinition = createRegistryHarness({
  id: 'harness-claude-code-registry',
  name: 'Claude Code Registry',
  description: 'Claude Code adapter with registry-managed tools',
  adapterName: 'claude-code',
  clientId: 'claude-code',
});

/** Default harness for gemini-sdk adapter using registry tools only. */
export const GEMINI_SDK_REGISTRY_HARNESS: DefaultHarnessDefinition = createRegistryHarness({
  id: 'harness-gemini-sdk-registry',
  name: 'Gemini SDK Registry',
  description: 'Gemini SDK adapter with registry-managed tools',
  adapterName: 'gemini-sdk',
  clientId: 'gemini',
});

/** Shipped default harnesses registered during service initialization. */
export const DEFAULT_HARNESSES: DefaultHarnessDefinition[] = [
  CODEX_APP_SERVER_NATIVE_HARNESS,
  OPENAI_NODE_REGISTRY_HARNESS,
  CLAUDE_CODE_REGISTRY_HARNESS,
  GEMINI_SDK_REGISTRY_HARNESS,
];
