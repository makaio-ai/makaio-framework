/**
 * Compact failure diagnostic for a native print-mode run.
 *
 * Claude Code's `--output-format json` result leads with timing, usage, and
 * cost fields, so a raw prefix of stdout cuts off the fields that explain a
 * failed oracle. This module projects the decisive fields instead.
 * @packageDocumentation
 */
import { redactStringValue } from './redaction.js';

const RESULT_TEXT_LIMIT = 300;
const RAW_FALLBACK_LIMIT = 800;
const SCALAR_FIELDS = ['subtype', 'is_error', 'num_turns', 'stop_reason', 'terminal_reason'] as const;

/**
 * Collapses whitespace and redacts sensitive patterns in diagnostic text.
 * @param value - Raw diagnostic text.
 * @returns Redacted single-line text.
 */
function compact(value: string): string {
  return redactStringValue(value).trim().replace(/\s+/g, ' ');
}

/**
 * Parses the provider's final result object: the whole stdout, or else its last `type: "result"` line.
 * @param stdout - Complete bounded CLI stdout.
 * @returns The result object, or nothing when stdout carries none.
 */
function parseResultObject(stdout: string): Record<string, unknown> | undefined {
  const candidates = [stdout, ...stdout.trim().split('\n').reverse()];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'result') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return undefined;
}

/**
 * Reads the tool names of recorded permission denials without their inputs.
 * @param value - The result's `permission_denials` field.
 * @returns Tool names in recorded order, or nothing when the field is not an array.
 */
function deniedToolNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((denial) =>
    denial && typeof denial === 'object' && typeof (denial as Record<string, unknown>).tool_name === 'string'
      ? ((denial as Record<string, unknown>).tool_name as string)
      : '?',
  );
}

/**
 * Builds a compact, redacted failure diagnostic from native stdout and stderr.
 *
 * Tool inputs of permission denials are never included; only tool names are.
 * @param stdout - Complete bounded CLI stdout.
 * @param stderr - Complete bounded CLI stderr.
 * @returns A single-line diagnostic, or an empty string when there is nothing to report.
 */
export function summarizeNativeResult(stdout: string, stderr: string): string {
  const result = parseResultObject(stdout);
  if (!result) return compact([stdout, stderr].filter(Boolean).join(' ')).slice(0, RAW_FALLBACK_LIMIT);
  const parts: string[] = [];
  for (const field of SCALAR_FIELDS) {
    if (result[field] !== undefined) parts.push(`${field}=${JSON.stringify(result[field])}`);
  }
  const denied = deniedToolNames(result.permission_denials);
  if (denied)
    parts.push(`permission_denials=${String(denied.length)}${denied.length ? ` [${denied.join(', ')}]` : ''}`);
  if (typeof result.result === 'string') {
    const text = compact(result.result);
    parts.push(
      `result=${JSON.stringify(text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text)}`,
    );
  }
  const stderrText = compact(stderr);
  if (stderrText) parts.push(`stderr=${JSON.stringify(stderrText.slice(0, RESULT_TEXT_LIMIT))}`);
  return parts.join(' ');
}
