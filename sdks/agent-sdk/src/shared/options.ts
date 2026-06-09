import { parseCanonicalModel } from '@makaio/contracts';
import type { JsonValue, ResolvableCanonicalModel } from '@makaio/contracts';
import type { TransportAuth } from '@makaio/bus-transport-websocket';
import type { CanUseToolCallback, MakaioOptions, MakaioToolDefinition, McpServerConfig } from './types.js';
import { MakaioModelError, MakaioUnsupportedFeatureError } from './errors.js';

/** Internal config produced by options normalization. */
export interface ResolvedQueryConfig {
  readonly parsedModel: ResolvableCanonicalModel;
  readonly rawModel: string;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly tools: readonly MakaioToolDefinition[];
  readonly allowedTools?: string[];
  readonly disallowedTools?: string[];
  readonly canUseTool?: CanUseToolCallback;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly maxTurns?: number;
  readonly env?: Record<string, string>;
  readonly abortController?: AbortController;
  readonly persistSession: boolean;
  readonly resume?: string;
  readonly sessionId?: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly outputFormat?: { type: 'json_schema'; schema: Record<string, JsonValue> };
  readonly websocketUrl?: string;
  readonly websocketAuth?: TransportAuth;
  readonly credentials?: Record<string, { apiKey?: string; [key: string]: string | undefined }>;
  readonly ephemeral: boolean;
}

/**
 * Normalize user-provided MakaioOptions into internal config.
 * @param options - User-provided query options.
 * @returns Resolved query config with a parsed canonical model.
 * @throws MakaioModelError on invalid or unsupported model string.
 */
export function normalizeOptions(options: MakaioOptions): ResolvedQueryConfig {
  if (options.resume !== undefined) {
    throw new MakaioUnsupportedFeatureError('resume', 'adapter-session resume requires a query startup contract');
  }
  if (options.credentials !== undefined) {
    throw new MakaioUnsupportedFeatureError(
      'credentials',
      'Makaio resolves provider credentials through provider configs and credential refs',
    );
  }
  if (Object.hasOwn(options, 'persistSession') && options.persistSession === false) {
    throw new MakaioUnsupportedFeatureError(
      'persistSession: false',
      'ephemeral Agent SDK queries need a dedicated startup path',
    );
  }

  const parsed = parseCanonicalModel(options.model);
  if (parsed.kind !== 'bare' && parsed.kind !== 'qualified') {
    throw new MakaioModelError(options.model, 'parse-error');
  }

  return {
    parsedModel: parsed,
    rawModel: options.model,
    cwd: options.cwd ?? process.cwd(),
    systemPrompt: options.systemPrompt,
    tools: options.tools ?? [],
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    canUseTool: options.canUseTool,
    mcpServers: options.mcpServers,
    maxTurns: options.maxTurns,
    env: options.env,
    abortController: options.abortController,
    persistSession: options.persistSession ?? true,
    resume: options.resume,
    sessionId: options.sessionId,
    effort: options.effort,
    outputFormat: options.outputFormat,
    websocketUrl: options.websocketUrl,
    websocketAuth: options.websocketAuth,
    ephemeral: false,
  };
}
