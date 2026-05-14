import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import os from 'node:os';
import { UserConsoleLog } from 'vitest';
import { LogItem, SchemaViolation } from './types.js';

const conformanceLogDirEnv = 'MAKAIO_CONFORMANCE_LOG_DIR';

/**
 * Creates a log file path for parsed conformance output.
 * @returns Path to a unique temp file
 */
async function getLogFile() {
  const configuredLogDir = process.env[conformanceLogDirEnv]?.trim();
  const logDir = configuredLogDir || os.tmpdir();
  await mkdir(logDir, { recursive: true });
  return path.join(logDir, `${crypto.randomUUID()}.json`);
}

export interface RawLog {
  content: string;
  time: number;
  type: string;
  size: number;
}

const rBusViolation = /^\[BUS:VIOLATION] subject="([^"]+)" issues="([^"]+)"$/;
const rLowLevel = /\[LOW-LEVEL]\[.+?]\[Agent (.+?)] ({.*)/;
const busViolationPrefix = '[BUS:VIOLATION] ';
const sensitiveLogKeyPattern =
  /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token|(?:^|[_-])key(?:$|[_-])|(?:^|[_-])pat(?:$|[_-]))/i;

/**
 * Redact credential-like fields from structured log payloads.
 * @param key - Current object key, if available
 * @param value - Structured log value
 * @returns Redacted value with original shape preserved
 */
function redactLogValue(key: string | undefined, value: unknown): unknown {
  if (key && key !== 'apiKeySource' && sensitiveLogKeyPattern.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactLogValue(undefined, item));
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactLogValue(childKey, childValue);
    }
    return redacted;
  }
  return value;
}

/**
 * Redact credential-like fields from JSON log content.
 * @param value - Parsed log JSON
 * @returns Redacted log content
 */
function redactLogContent(value: unknown): Record<string, unknown> {
  const redacted = redactLogValue(undefined, value);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

/**
 * Build a stable deduplication key for schema violations.
 *
 * Includes the sample payload so multiple SDK drift payloads that happen to
 * fail the same union branches are all preserved in the final artifact.
 * @param violation - Parsed schema violation
 * @returns Stable key for one violation instance
 */
export function schemaViolationDedupKey(violation: SchemaViolation): string {
  return `${violation.subject}::${violation.issues.join('\n')}::${JSON.stringify(violation.sample ?? null)}`;
}

/**
 * Parse a structured or legacy bus schema violation log line.
 * @param line - Raw console line
 * @returns Parsed schema violation, or undefined when the line is unrelated/malformed
 */
function parseBusViolationLine(line: string): SchemaViolation | undefined {
  if (!line.startsWith(busViolationPrefix)) return undefined;

  const content = line.slice(busViolationPrefix.length);
  try {
    if (content.startsWith('{')) {
      const parsed = JSON.parse(content) as {
        subject?: unknown;
        issues?: unknown;
        sample?: unknown;
      };
      if (typeof parsed.subject !== 'string') return undefined;
      const sample =
        parsed.sample && typeof parsed.sample === 'object' && !Array.isArray(parsed.sample)
          ? redactLogContent(parsed.sample)
          : undefined;
      return {
        subject: parsed.subject,
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.filter((issue): issue is string => typeof issue === 'string')
          : [],
        sample,
      };
    }
  } catch {
    return undefined;
  }

  const match = line.match(rBusViolation);
  if (!match) return undefined;
  return { subject: match[1], issues: [match[2]] };
}

/**
 * Split multiline Vitest console logs into one line per entry.
 * @param rawLogs - Raw log entries from Vitest
 * @returns Single-line log entries retaining Vitest metadata
 */
function splitRawLogs(rawLogs: RawLog[]): UserConsoleLog[] {
  const splitLogs: UserConsoleLog[] = [];
  for (const rawLog of rawLogs) {
    const { content, time, type, size } = rawLog;
    for (const line of content.split('\n')) {
      if (line.trim().length) splitLogs.push({ content: line, time, type: type as 'stdout' | 'stderr', size });
    }
  }
  return splitLogs;
}

/**
 * Convert an unknown value to a supported structured log content shape.
 * @param value - Parsed log content value
 * @returns String or object content, or undefined when unsupported
 */
function asLogContent(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Parse a low-level SDK log entry.
 * @param log - Single-line Vitest console log
 * @returns Structured SDK log item, or undefined when the line is not a match
 */
function parseLowLevelLog(log: UserConsoleLog): LogItem | undefined {
  const lowLevelMatch = log.content.match(rLowLevel);
  if (!lowLevelMatch) return undefined;

  const [, agentId, jsonString] = lowLevelMatch;
  const jsonContent = redactLogContent(JSON.parse(jsonString.trim()));
  const adapterSessionIdValue = jsonContent['session_id'] ?? jsonContent['sessionId'];
  const adapterSessionId = typeof adapterSessionIdValue === 'string' ? adapterSessionIdValue : undefined;
  const logMessage: LogItem = { source: 'sdk', timestamp: log.time, content: jsonContent };
  if (agentId) logMessage.agentId = agentId;
  if (adapterSessionId) logMessage.adapterSessionId = adapterSessionId;
  return logMessage;
}

/**
 * Parse a structured bus log entry.
 * @param log - Single-line Vitest console log
 * @returns Structured bus log item, or undefined when the line is not a match
 */
function parseBusLog(log: UserConsoleLog): LogItem | undefined {
  if (!log.content.startsWith('[BUS] ')) return undefined;

  const contentString = log.content.substring(6);
  const jsonContent = redactLogContent(JSON.parse(contentString));
  const { adapterId, agentId, adapterSessionId, sessionId, timestamp } = jsonContent;
  const logMessage: LogItem = {
    source: 'bus',
    timestamp: typeof timestamp === 'number' ? timestamp : log.time,
    content: asLogContent(jsonContent.content),
  };
  if (typeof adapterId === 'string') logMessage.adapterId = adapterId;
  if (typeof agentId === 'string') logMessage.agentId = agentId;
  if (typeof adapterSessionId === 'string') logMessage.adapterSessionId = adapterSessionId;
  if (typeof sessionId === 'string') logMessage.sessionId = sessionId;
  return logMessage;
}

/**
 * Parse a schema-violation log entry.
 * @param log - Single-line Vitest console log
 * @returns Structured violation log item, or undefined when the line is not a match
 */
function parseViolationLog(log: UserConsoleLog): LogItem | undefined {
  const violation = parseBusViolationLine(log.content);
  if (!violation) return undefined;
  return {
    source: 'bus:violation',
    message: `${violation.subject}: ${violation.issues.join(' | ')}`,
    timestamp: log.time,
    content: violation.sample ? redactLogContent(violation.sample) : undefined,
  };
}

/**
 * Parse one structured log line if it uses a known conformance log prefix.
 * @param log - Single-line Vitest console log
 * @returns Structured log item, or undefined when the line should remain raw
 */
function parseStructuredLog(log: UserConsoleLog): LogItem | undefined {
  try {
    return parseLowLevelLog(log) ?? parseBusLog(log) ?? parseViolationLog(log);
  } catch {
    return undefined;
  }
}

/**
 * Redact common credential assignments from unstructured log lines.
 * @param message - Raw log line content
 * @returns Redacted log line
 */
function redactRawMessage(message: string): string {
  return message.replace(
    /((?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token|pat)\s*[:=]\s*)(["']?)[^"'\s,}]+/gi,
    '$1$2[redacted]',
  );
}

/**
 * Parses raw test logs and writes them to a temp file.
 * @param rawLogs - Raw log entries from vitest
 * @returns Path to the temp log file, or undefined if no logs
 */
export async function parseAndWriteLogs(rawLogs: RawLog[]): Promise<string | undefined> {
  if (!rawLogs.length) return undefined;

  const logFile = await getLogFile();
  const logs: LogItem[] = [];
  const splitLogs = splitRawLogs(rawLogs);

  for (const log of splitLogs) {
    logs.push(
      parseStructuredLog(log) ?? { source: log.type, message: redactRawMessage(log.content), timestamp: log.time },
    );
  }

  logs.sort((a, b) => a.timestamp - b.timestamp);
  const filteredLogs = logs.filter(
    (it) => !(JSON.stringify(it)?.includes('_delta"') || JSON.stringify(it)?.includes('.delta"')),
  );
  await writeFile(logFile, JSON.stringify(filteredLogs, null, 2));
  return logFile;
}

/**
 * Extracts deduplicated schema violations from raw log entries.
 *
 * Designed to be called from the runner after vitest completes,
 * parsing the same raw console logs that the reporter already captures.
 * @param rawLogs - Raw vitest console log entries
 * @returns Deduplicated array of schema violations
 */
export function parseViolationsFromLogs(rawLogs: RawLog[]): SchemaViolation[] {
  const seen = new Set<string>();
  const violations: SchemaViolation[] = [];

  for (const { content: line } of splitRawLogs(rawLogs)) {
    const violation = parseBusViolationLine(line);
    if (violation) {
      const key = schemaViolationDedupKey(violation);
      if (!seen.has(key)) {
        seen.add(key);
        violations.push(violation);
      }
    }
  }

  return violations;
}
