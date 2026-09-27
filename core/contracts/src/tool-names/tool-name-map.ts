/**
 * Makaio framework tool names and their adapter-native equivalents.
 *
 * Adapters translate tool list names (format: `ToolLists` in `tool-policy.ts`) to
 * their native vocabulary through this table.
 * @packageDocumentation
 */

/** Makaio framework tool names accepted in tool allow/deny lists. */
export const MAKAIO_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'glob_files',
  'grep_files',
  'shell_exec',
  'shell_kill',
  'spawn_subagent',
  'send_to_subagent',
] as const;

/** A Makaio framework tool name, see {@link MAKAIO_TOOL_NAMES}. */
export type MakaioToolName = (typeof MAKAIO_TOOL_NAMES)[number];

/** Native tool vocabularies. FACT-75..81 add one entry per adapter family. */
export type ToolVocabulary = 'claude';

/**
 * Makaio tool name to native tool name, per vocabulary. A missing entry means the
 * adapter family has no native equivalent for that Makaio tool.
 */
export const NATIVE_TOOL_NAMES: Readonly<Record<ToolVocabulary, Readonly<Partial<Record<MakaioToolName, string>>>>> = {
  // Verified against live Claude Code transcripts (2026-05-19). This is the
  // source table; sdks/agent-sdk/src/shared/messages.ts derives its output
  // normalisation from it.
  claude: {
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    glob_files: 'Glob',
    grep_files: 'Grep',
    shell_exec: 'Bash',
    shell_kill: 'TaskStop',
    spawn_subagent: 'Agent',
    send_to_subagent: 'SendMessage',
  },
};

/** Name prefix of MCP-provided tools (`mcp__<server>__<tool>`). Package-internal. */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';

/** Separator between the server and tool part of an MCP tool name. */
const MCP_TOOL_NAME_SEPARATOR = '__';

/** Why a tool name or tool list entry was rejected. */
export type ToolNameErrorReason = 'malformed-entry' | 'unknown-tool' | 'unsupported-by-adapter' | 'rule-not-supported';

/** Thrown when a tool name or tool list entry cannot be parsed, resolved, or translated. */
export class ToolNameError extends Error {
  /** The rejected tool name or tool list entry, verbatim. */
  public readonly entry: string;
  /** Why the entry was rejected. */
  public readonly reason: ToolNameErrorReason;

  /**
   * @param entry - The rejected tool name or tool list entry.
   * @param reason - Why the entry was rejected.
   * @param detail - Human-readable explanation appended to the message.
   */
  public constructor(entry: string, reason: ToolNameErrorReason, detail: string) {
    super(`Invalid tool list entry "${entry}": ${detail}`);
    this.name = 'ToolNameError';
    this.entry = entry;
    this.reason = reason;
  }
}

/**
 * Checks whether a name is a Makaio framework tool name.
 * @param name - Tool name to check.
 * @returns True when `name` is listed in {@link MAKAIO_TOOL_NAMES}.
 */
export function isMakaioToolName(name: string): name is MakaioToolName {
  return (MAKAIO_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Checks whether a name is an MCP tool name (`mcp__<server>__<tool>`).
 * @param name - Tool name to check.
 * @returns True when `name` carries the MCP prefix followed by a non-empty server part,
 * `__`, and a non-empty tool part (`mcp__`, `mcp____tool`, `mcp__github` are not).
 */
export function isMcpToolName(name: string): boolean {
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return false;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
  const separator = rest.indexOf(MCP_TOOL_NAME_SEPARATOR);
  return separator > 0 && separator + MCP_TOOL_NAME_SEPARATOR.length < rest.length;
}

/**
 * Translates a Makaio (or MCP) tool name to the native name of a vocabulary.
 * MCP names pass through unchanged.
 * @param vocabulary - Target native vocabulary.
 * @param name - Makaio or MCP tool name.
 * @param entry - Entry reported on a {@link ToolNameError}; list resolution passes the
 * full list entry. Defaults to `name`.
 * @returns The native tool name.
 * @throws {@link ToolNameError} `unknown-tool` when `name` is not a Makaio name,
 * `unsupported-by-adapter` when the vocabulary has no entry for it.
 */
export function toNativeToolName(vocabulary: ToolVocabulary, name: string, entry: string = name): string {
  if (isMcpToolName(name)) return name;
  if (!isMakaioToolName(name)) {
    throw new ToolNameError(
      entry,
      'unknown-tool',
      `"${name}" is not a Makaio tool name; valid names are ${MAKAIO_TOOL_NAMES.join(', ')} or mcp__<server>__<tool>`,
    );
  }
  const nativeName = NATIVE_TOOL_NAMES[vocabulary][name];
  if (nativeName === undefined) {
    throw new ToolNameError(
      entry,
      'unsupported-by-adapter',
      `tool "${name}" has no native equivalent in the "${vocabulary}" vocabulary`,
    );
  }
  return nativeName;
}

/**
 * Translates a native tool name back to its Makaio tool name.
 * MCP names pass through unchanged.
 * @param vocabulary - Source native vocabulary.
 * @param nativeName - Native tool name (e.g., 'Bash').
 * @returns The Makaio (or MCP) tool name, or undefined when the native name has no Makaio name.
 */
export function toMakaioToolName(vocabulary: ToolVocabulary, nativeName: string): string | undefined {
  if (isMcpToolName(nativeName)) return nativeName;
  const table = NATIVE_TOOL_NAMES[vocabulary];
  return MAKAIO_TOOL_NAMES.find((name) => table[name] === nativeName);
}
