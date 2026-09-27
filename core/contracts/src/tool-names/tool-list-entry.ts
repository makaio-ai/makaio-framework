/**
 * Parsing and matching of tool list entries (`name` or `name(rule)`).
 * Format and matching semantics: `ToolLists` in `tool-policy.ts`.
 * @packageDocumentation
 */

import { isMcpToolName, MCP_TOOL_NAME_PREFIX, ToolNameError } from './tool-name-map.js';

/**
 * Command rule of a tool list entry. `exact` matches one command verbatim;
 * `prefix` (written `name(prefix:*)`) matches a command word sequence and its arguments.
 * Rule text is trimmed and blank runs (spaces, tabs) are collapsed to one space.
 */
export type CommandRule = { kind: 'exact'; command: string } | { kind: 'prefix'; prefix: string };

/** A parsed tool list entry. */
export interface ToolListEntry {
  /** Tool name part of the entry (not validated against the Makaio names). */
  readonly name: string;
  /** Command rule, present when the entry has the form `name(rule)`. */
  readonly rule?: CommandRule;
}

/** Suffix marking a prefix rule (`name(git log:*)`). */
const PREFIX_RULE_SUFFIX = ':*';

/**
 * Shell metacharacters that chain, background, pipe, substitute, group, or redirect
 * commands: `&`, `;`, `|`, `<`, `>`, backtick, `$`, `(`, `)`, `{`, `}`, newline, and
 * carriage return. A command containing any of them never matches an allowlist prefix
 * rule; denylist rules match each segment between them.
 */
const SHELL_METACHARACTERS = /[&;|<>`$(){}\n\r]/;

/** Backslash-newline line continuations, which the shell removes before parsing. */
const LINE_CONTINUATIONS = /\\\r?\n/g;

/** Runs of shell blanks (spaces, tabs); newlines are command separators, not blanks. */
const BLANK_RUNS = /[ \t]+/g;

/**
 * Trims a command and collapses runs of spaces and tabs to one space.
 * @param command - Command or rule text.
 * @returns The normalized text.
 */
function normalizeCommand(command: string): string {
  return command.trim().replace(BLANK_RUNS, ' ');
}

/**
 * Checks that parentheses in `text` are balanced and never close before they open.
 * @param text - Text to check.
 * @returns True when every `(` has a matching later `)`.
 */
function hasBalancedParens(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Parses a tool list entry of the form `name` or `name(rule)`.
 *
 * `name(x:*)` yields a prefix rule `x`; any other rule is exact. The rule is normalized
 * (trimmed, blank runs collapsed). The name is NOT validated against the Makaio tool
 * names; `resolveToolPolicy` does that.
 * @param entry - Tool list entry, e.g. `read_file`, `shell_exec(git status)`, `shell_exec(git log:*)`.
 * @returns The parsed entry.
 * @throws {@link ToolNameError} `malformed-entry` for unbalanced parentheses, an empty rule
 * `name()`, an empty name, text after the closing `)`, an `mcp__` name without non-empty
 * server and tool parts, or a `*` anywhere except the trailing `:*` of a prefix rule.
 */
export function parseToolListEntry(entry: string): ToolListEntry {
  const malformed = (detail: string): ToolNameError => new ToolNameError(entry, 'malformed-entry', detail);

  const open = entry.indexOf('(');
  const name = open === -1 ? entry : entry.slice(0, open);
  if (name === '') throw malformed('tool name is empty');
  if (name.startsWith(MCP_TOOL_NAME_PREFIX) && !isMcpToolName(name)) {
    throw malformed('MCP tool names need a non-empty server and tool part: mcp__<server>__<tool>');
  }
  if (name.includes('*')) throw malformed('"*" is not allowed in a tool name');
  if (!hasBalancedParens(entry)) throw malformed('parentheses are unbalanced');
  if (open === -1) return { name };

  const close = entry.lastIndexOf(')');
  if (close !== entry.length - 1) throw malformed('unexpected text after the closing ")"');

  const ruleText = entry.slice(open + 1, close).trim();
  const isPrefix = ruleText.endsWith(PREFIX_RULE_SUFFIX);
  const ruleValue = normalizeCommand(isPrefix ? ruleText.slice(0, -PREFIX_RULE_SUFFIX.length) : ruleText);
  if (ruleValue === '') throw malformed('command rule is empty');
  if (ruleValue.includes('*')) {
    throw malformed('"*" is only allowed as the trailing ":*" of a prefix rule; write e.g. "npm run:*"');
  }

  const rule: CommandRule = isPrefix ? { kind: 'prefix', prefix: ruleValue } : { kind: 'exact', command: ruleValue };
  return { name, rule };
}

/**
 * Checks whether one normalized command text matches a rule.
 * @param rule - Command rule to match against.
 * @param normalized - Normalized command text.
 * @returns True for an exact match, or the prefix alone or followed by a space.
 */
function matchesNormalized(rule: CommandRule, normalized: string): boolean {
  if (rule.kind === 'exact') return normalized === rule.command;
  return normalized === rule.prefix || normalized.startsWith(`${rule.prefix} `);
}

/**
 * Checks whether a shell command matches an allowlist command rule. Fails closed.
 *
 * The command is normalized (trimmed, blank runs collapsed) before comparison.
 * - `exact`: the normalized command equals the rule command.
 * - `prefix`: the command contains no shell metacharacter (`&`, `;`, `|`, `<`, `>`,
 *   backtick, `$`, `(`, `)`, `{`, `}`, newline, carriage return), and the normalized
 *   command equals the prefix or starts with the prefix followed by a space.
 * @param rule - Command rule to match against.
 * @param command - Shell command of the tool call.
 * @returns True when the command matches the rule.
 */
export function matchesCommandRule(rule: CommandRule, command: string): boolean {
  if (rule.kind === 'prefix' && SHELL_METACHARACTERS.test(command)) return false;
  return matchesNormalized(rule, normalizeCommand(command));
}

/**
 * Checks whether a shell command matches a denylist command rule. Best effort.
 *
 * Backslash-newline line continuations are removed, then the command is split on the
 * shell metacharacters listed at {@link matchesCommandRule} into segments, and each
 * segment is normalized (trimmed, blank runs collapsed). The rule matches when ANY
 * segment matches it exactly (`exact`) or equals the prefix or starts with the prefix
 * followed by a space (`prefix`). Quoting (`"git" push`), escapes (`\git push`),
 * wrappers (`env`, `bash -c`, `xargs`), and absolute paths (`/usr/bin/git`) are not
 * recognised.
 * @param rule - Command rule to match against.
 * @param command - Shell command of the tool call.
 * @returns True when a command segment matches the rule.
 */
export function matchesDenyCommandRule(rule: CommandRule, command: string): boolean {
  return command
    .replace(LINE_CONTINUATIONS, '')
    .split(SHELL_METACHARACTERS)
    .some((segment) => matchesNormalized(rule, normalizeCommand(segment)));
}
