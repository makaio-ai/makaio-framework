import {
  NATIVE_TOOL_NAMES,
  parseCanonicalModel,
  parseToolListEntry,
  toMakaioToolName,
  ToolNameError,
} from '@makaio/contracts';
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
 * Translates one Claude-vocabulary tool list entry to the Makaio vocabulary.
 *
 * This is the input contract of the Claude-Agent-SDK-compatible surface: callers
 * name tools as the Claude Agent SDK does (`Read`, `Bash(git status)`), Makaio
 * adapters expect Makaio names (`read_file`, `shell_exec(git status)`). The base
 * name is translated; a rule suffix (`(git status)`, `(git log:*)`) is kept
 * verbatim; `mcp__<server>__<tool>` entries pass through unchanged.
 * @param entry - Tool list entry in the Claude vocabulary.
 * @returns The equivalent entry in the Makaio vocabulary.
 * @throws {@link ToolNameError} `malformed-entry` for an unparseable entry,
 * `unknown-tool` when the Claude name has no Makaio equivalent (e.g. `WebFetch`).
 */
export function toMakaioToolListEntry(entry: string): string {
  const { name } = parseToolListEntry(entry);
  const makaioName = toMakaioToolName('claude', name);
  if (makaioName === undefined) {
    const supported = Object.values(NATIVE_TOOL_NAMES.claude).join(', ');
    throw new ToolNameError(
      entry,
      'unknown-tool',
      `"${name}" has no Makaio equivalent; supported tool names are ${supported} or mcp__<server>__<tool>`,
    );
  }
  return `${makaioName}${entry.slice(name.length)}`;
}

/**
 * Normalize user-provided MakaioOptions into internal config.
 * @param options - User-provided query options.
 * @returns Resolved query config with a parsed canonical model.
 * @throws MakaioModelError on invalid or unsupported model string.
 * @throws {@link ToolNameError} when an `allowedTools`/`disallowedTools` entry has no Makaio equivalent.
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
    allowedTools: options.allowedTools?.map(toMakaioToolListEntry),
    disallowedTools: options.disallowedTools?.map(toMakaioToolListEntry),
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
