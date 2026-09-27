/**
 * Parsing and matching of tool list entries (`name` or `name(rule)`).
 * @packageDocumentation
 */

import { ToolNameError } from './tool-name-map.js';

/**
 * Command rule of a tool list entry. `exact` matches one command verbatim;
 * `prefix` (written `name(prefix:*)`) matches a command word sequence and its arguments.
 */
export type CommandRule = { kind: 'exact'; command: string } | { kind: 'prefix'; prefix: string };

/** A parsed tool list entry. */
export interface ToolListEntry {
  /** The original entry, verbatim. */
  readonly entry: string;
  /** Tool name part of the entry (not validated against the Makaio names). */
  readonly name: string;
  /** Command rule, present when the entry has the form `name(rule)`. */
  readonly rule?: CommandRule;
}

/** Suffix marking a prefix rule (`name(git log:*)`). */
const PREFIX_RULE_SUFFIX = ':*';

/** Shell operators that chain, substitute, or redirect; a prefix rule never matches them. */
const SHELL_OPERATORS = ['&&', '||', ';', '|', '`', '$(', '>', '<', '\n'] as const;

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
 * `name(x:*)` yields a prefix rule `x`; any other rule is exact. The rule is trimmed.
 * The name is NOT validated against the Makaio tool names; `resolveToolPolicy` does that.
 * @param entry - Tool list entry, e.g. `read_file`, `shell_exec(git status)`, `shell_exec(git log:*)`.
 * @returns The parsed entry.
 * @throws {@link ToolNameError} `malformed-entry` for unbalanced parentheses, an empty rule
 * `name()`, an empty name, or text after the closing `)`.
 */
export function parseToolListEntry(entry: string): ToolListEntry {
  const malformed = (detail: string): ToolNameError => new ToolNameError(entry, 'malformed-entry', detail);

  const open = entry.indexOf('(');
  const name = open === -1 ? entry : entry.slice(0, open);
  if (name === '') throw malformed('tool name is empty');
  if (!hasBalancedParens(entry)) throw malformed('parentheses are unbalanced');
  if (open === -1) return { entry, name };

  const close = entry.lastIndexOf(')');
  if (close !== entry.length - 1) throw malformed('unexpected text after the closing ")"');

  const ruleText = entry.slice(open + 1, close).trim();
  const isPrefix = ruleText.endsWith(PREFIX_RULE_SUFFIX);
  const ruleValue = isPrefix ? ruleText.slice(0, -PREFIX_RULE_SUFFIX.length).trim() : ruleText;
  if (ruleValue === '') throw malformed('command rule is empty');

  const rule: CommandRule = isPrefix ? { kind: 'prefix', prefix: ruleValue } : { kind: 'exact', command: ruleValue };
  return { entry, name, rule };
}

/**
 * Checks whether a shell command matches a command rule.
 *
 * - `exact`: the trimmed command equals the rule command.
 * - `prefix`: the command contains none of the shell operators `&&`, `||`, `;`, `|`,
 *   backtick, `$(`, `>`, `<` or a newline, and the trimmed command equals the prefix or
 *   starts with the prefix followed by a space.
 * @param rule - Command rule to match against.
 * @param command - Shell command of the tool call.
 * @returns True when the command matches the rule.
 */
export function matchesCommandRule(rule: CommandRule, command: string): boolean {
  const trimmed = command.trim();
  if (rule.kind === 'exact') return trimmed === rule.command;
  if (SHELL_OPERATORS.some((operator) => command.includes(operator))) return false;
  return trimmed === rule.prefix || trimmed.startsWith(`${rule.prefix} `);
}
