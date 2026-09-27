/**
 * Resolution of Makaio-named tool allow/deny lists into a native tool policy.
 *
 * Adapters feed the native projections (`nativeAvailableTools`, `nativeAllowedEntries`,
 * `nativeDisallowedTools`) to their SDK and run `checkToolCall` as the per-call gate.
 * @packageDocumentation
 */

import { matchesCommandRule, parseToolListEntry } from './tool-list-entry.js';
import type { CommandRule } from './tool-list-entry.js';
import { isMcpToolName, resolveNativeToolName, toMakaioToolName, ToolNameError } from './tool-name-map.js';
import type { ToolVocabulary } from './tool-name-map.js';

/** Outcome of the tool gate for one tool call. */
export type ToolGateDecision = { allowed: true } | { allowed: false; reason: string };

/** Tool allow/deny lists written with Makaio (or MCP) tool names. */
export interface ToolLists {
  /** Allowlist entries (`name` or `name(rule)`). Absent = no allowlist; `[]` allows nothing. */
  readonly allowedTools?: readonly string[];
  /** Denylist entries (`name` or `name(rule)`). */
  readonly disallowedTools?: readonly string[];
}

/** Tool lists validated and translated to one native vocabulary. */
export interface ResolvedToolPolicy {
  /** Native built-in base names granted by the allowlist (deduped, MCP excluded). undefined = no allowlist. */
  readonly nativeAvailableTools?: readonly string[];
  /** Allowlist translated to native entries, rules kept: e.g. 'Bash(git status)', 'Read', 'mcp__s__t'. undefined = no allowlist. */
  readonly nativeAllowedEntries?: readonly string[];
  /** Denylist translated to native entries, rules kept: e.g. 'Bash(rm -rf:*)'. undefined = no denylist. */
  readonly nativeDisallowedTools?: readonly string[];
  /**
   * Gate for one tool call, native name + tool input.
   * @param nativeName - Native tool name of the call.
   * @param input - Tool call input; `input.command` is matched against command rules.
   * @returns Whether the lists allow the call.
   */
  checkToolCall(nativeName: string, input: Record<string, unknown>): ToolGateDecision;
}

/** One validated list entry. */
interface ResolvedEntry {
  /** Original entry, verbatim. */
  readonly entry: string;
  /** Makaio (or MCP) tool name the entry targets. */
  readonly name: string;
  /** Native tool name of `name`. */
  readonly nativeName: string;
  /** Command rule, when the entry has one. */
  readonly rule?: CommandRule;
  /** Entry rendered in the native vocabulary, rule kept. */
  readonly nativeEntry: string;
}

/** Makaio tool that accepts command rules. */
const RULE_TOOL_NAME = 'shell_exec';

/**
 * Renders a command rule in native entry form.
 * @param nativeName - Native tool name.
 * @param rule - Command rule.
 * @returns `${nativeName}(${command})` or `${nativeName}(${prefix}:*)`.
 */
function toNativeEntry(nativeName: string, rule: CommandRule): string {
  return rule.kind === 'exact' ? `${nativeName}(${rule.command})` : `${nativeName}(${rule.prefix}:*)`;
}

/**
 * Parses, validates, and translates one list entry.
 * @param vocabulary - Target native vocabulary.
 * @param entry - Tool list entry.
 * @returns The resolved entry.
 * @throws {@link ToolNameError} for malformed entries, unknown or unsupported tools, and
 * rules on tools other than `shell_exec`.
 */
function resolveEntry(vocabulary: ToolVocabulary, entry: string): ResolvedEntry {
  const { name, rule } = parseToolListEntry(entry);
  const nativeName = resolveNativeToolName(vocabulary, name, entry);
  if (rule === undefined) return { entry, name, nativeName, nativeEntry: nativeName };
  if (name !== RULE_TOOL_NAME) {
    throw new ToolNameError(entry, 'rule-not-supported', `command rules are only supported on ${RULE_TOOL_NAME}`);
  }
  return { entry, name, nativeName, rule, nativeEntry: toNativeEntry(nativeName, rule) };
}

/**
 * Checks whether a resolved entry covers a tool call.
 * @param entry - Resolved list entry.
 * @param name - Makaio (or MCP) tool name of the call.
 * @param command - Shell command of the call, when the input carries a string command.
 * @returns True for a plain entry naming the tool, or a rule entry for the tool whose rule matches.
 */
function coversCall(entry: ResolvedEntry, name: string, command: string | undefined): boolean {
  if (entry.name !== name) return false;
  if (entry.rule === undefined) return true;
  return command !== undefined && matchesCommandRule(entry.rule, command);
}

/**
 * Parses and validates both tool lists eagerly and translates them to a native vocabulary.
 *
 * Command rules are accepted only on `shell_exec`. Native rule form is
 * `${native}(${exact})` or `${native}(${prefix}:*)`.
 *
 * `checkToolCall` maps the native name back to Makaio (a native name without one is on
 * no list), applies the denylist first, allows everything when there is no allowlist,
 * and otherwise allows only calls covered by an allowlist entry. `[]` denies every tool,
 * MCP included. The gate only restricts; central approval still runs afterwards.
 * @param vocabulary - Target native vocabulary.
 * @param lists - Tool lists written with Makaio (or MCP) names.
 * @returns The resolved policy.
 * @throws {@link ToolNameError} on the first invalid entry of either list.
 */
export function resolveToolPolicy(vocabulary: ToolVocabulary, lists: ToolLists): ResolvedToolPolicy {
  const allowed = lists.allowedTools?.map((entry) => resolveEntry(vocabulary, entry));
  const disallowed = lists.disallowedTools?.map((entry) => resolveEntry(vocabulary, entry));

  return {
    ...(allowed !== undefined && {
      nativeAvailableTools: [
        ...new Set(allowed.filter((entry) => !isMcpToolName(entry.name)).map((entry) => entry.nativeName)),
      ],
      nativeAllowedEntries: allowed.map((entry) => entry.nativeEntry),
    }),
    ...(disallowed !== undefined && {
      nativeDisallowedTools: disallowed.map((entry) => entry.nativeEntry),
    }),
    checkToolCall(nativeName: string, input: Record<string, unknown>): ToolGateDecision {
      const name = toMakaioToolName(vocabulary, nativeName);
      const command = typeof input.command === 'string' ? input.command : undefined;

      const denyEntry = name === undefined ? undefined : disallowed?.find((entry) => coversCall(entry, name, command));
      if (denyEntry !== undefined) {
        return {
          allowed: false,
          reason: `Tool ${nativeName} is denied by the step's denylist entry ${denyEntry.entry}`,
        };
      }

      if (allowed === undefined) return { allowed: true };
      if (name !== undefined && allowed.some((entry) => coversCall(entry, name, command))) return { allowed: true };
      return { allowed: false, reason: `Tool ${nativeName} is not on the step's allowlist` };
    },
  };
}
