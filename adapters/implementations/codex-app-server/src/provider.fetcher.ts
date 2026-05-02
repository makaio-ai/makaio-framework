import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { DiscoveredAIModel, ProviderDefinitionInput } from '@makaio/contracts';
import { createStdioTransport } from './utils/createStdioTransport.js';

/**
 * Raw model entry from the Codex app-server `model/list` response.
 */
interface CodexRawModel {
  id: string;
  model: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ effort: string; description?: string }>;
  inputModalities?: string[];
}

/**
 * Map Codex reasoning effort entries to the canonical ReasoningLevelMap shape.
 * @param efforts - Codex reasoning effort entries
 * @returns Reasoning level map with string budget values
 */
function buildReasoningLevels(efforts: Array<{ effort: string }>): Record<string, string> | undefined {
  if (efforts.length === 0) return undefined;
  const map: Record<string, string> = {};
  for (const e of efforts) {
    map[e.effort] = e.effort;
  }
  return map;
}

/**
 * Normalize a Codex raw model into the canonical DiscoveredAIModel shape.
 * @param raw - Raw model from the Codex model/list response
 * @returns Normalized discovered model
 */
function normalizeModel(raw: CodexRawModel): DiscoveredAIModel {
  const result: DiscoveredAIModel = {
    name: raw.model ?? raw.id,
    friendlyName: raw.displayName,
    // Codex API does not expose context window size; lab YAML provides accurate values.
    contextWindowSize: 0,
    labId: 'openai',
  };

  if (raw.supportedReasoningEfforts) {
    const levels = buildReasoningLevels(raw.supportedReasoningEfforts);
    if (levels) result.supportedReasoningLevels = levels;
  }

  if (raw.inputModalities?.includes('image')) {
    result.metadata = { capabilities: { vision: true } };
  }

  return result;
}

/**
 * Resolve the codex binary path for fetcher use.
 *
 * Checks PATH availability without spawning a long-running process.
 * @returns The command string if codex is available, null otherwise
 */
function resolveCodexCommand(): string | null {
  try {
    execSync('codex --version', { stdio: 'ignore', timeout: 5000 });
    return 'codex';
  } catch {
    return null;
  }
}

/**
 * Fetch live model list from the Codex app-server via `model/list` JSON-RPC.
 *
 * Used only by the registry generation script — not imported at runtime.
 * Spawns a short-lived `codex app-server` subprocess, sends the `model/list`
 * request, and terminates the process after receiving the response.
 * @param _definition - Provider definition (unused — Codex auth is handled by the binary)
 * @returns Array of normalized discovered model objects, or null if codex is unavailable
 */
export async function fetchModels(_definition: ProviderDefinitionInput): Promise<DiscoveredAIModel[] | null> {
  const command = resolveCodexCommand();
  if (!command) return null;

  // createStdioTransport filters undefined env values at the spawn boundary.
  const transport = createStdioTransport(tmpdir(), { PATH: process.env.PATH, HOME: process.env.HOME });

  try {
    return await new Promise<DiscoveredAIModel[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Codex model/list timed out after 15s'));
      }, 15_000);

      let nextId = 1;
      let initialized = false;

      transport.onError((error) => {
        clearTimeout(timeout);
        reject(error);
      });

      transport.onMessage((message) => {
        const msg = message as { id?: number; result?: unknown };

        if (msg.id === 1 && !initialized) {
          initialized = true;
          transport.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          transport.send({
            jsonrpc: '2.0',
            id: ++nextId,
            method: 'model/list',
            params: { limit: 100, includeHidden: false },
          });
          return;
        }

        if (msg.id === nextId && initialized) {
          clearTimeout(timeout);
          const result = msg.result as { data?: CodexRawModel[] } | undefined;

          if (!Array.isArray(result?.data)) {
            reject(new Error('Codex model/list returned unexpected shape'));
            return;
          }

          const available = result.data.filter((m) => !m.hidden);
          resolve(available.map(normalizeModel));
        }
      });

      transport.send({
        jsonrpc: '2.0',
        id: nextId,
        method: 'initialize',
        params: {
          clientInfo: { name: 'makaio-model-fetcher', version: '1.0.0' },
          capabilities: {},
        },
      });
    });
  } finally {
    transport.close();
  }
}
