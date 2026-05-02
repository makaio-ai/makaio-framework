/**
 * Base class for log importers with default processLogFile() implementation.
 *
 * Provides the common pattern of extractSessionContext + processRecords
 * composition. Adapters with special needs (e.g., fork detection) can override.
 * @packageDocumentation
 */

import type { JsonObject } from 'type-fest';
import type {
  LogImporter,
  LogImportSessionContext,
  NormalizedEvent,
  ProcessLogFileResult,
  DiscoveryMetadata,
} from './types.js';

/**
 * Abstract base class for log importers.
 *
 * Provides default processLogFile() implementation that composes
 * extractSessionContext() + processRecords(). Adapters implement
 * the abstract methods for their specific log format.
 * @typeParam TRecord - The tool's native log record type
 * @typeParam TState - The resumable state type
 */
export abstract class BaseLogImporter<TRecord, TState = unknown> implements LogImporter<TRecord, TState> {
  // Abstract methods that implementers must provide
  public abstract canHandle(sample: string | JsonObject): boolean | { confidence: number };
  public abstract getLogDirectory(): string;
  /**
   * Parse a single log record from raw input.
   * @param line - Raw log line or parsed JSON object to parse
   * @param sourceFilePath - Optional source file path for format-specific context
   * @returns Parsed record or null when the input does not match the adapter format
   */
  public abstract parseRecord(line: string | JsonObject, sourceFilePath?: string): TRecord | null;
  public abstract isMakaioManaged(sessionId: string): Promise<boolean>;
  /**
   * Extract discovery metadata from a log file without importing full message history.
   * @param filePath - Absolute path to the source log file
   * @returns Discovery metadata when parsing succeeds; rejects on unrecoverable read/parse errors
   */
  public abstract extractDiscoveryMetadata(filePath: string): Promise<DiscoveryMetadata>;
  public abstract extractSessionContext(records: TRecord[]): LogImportSessionContext<TState>;
  public abstract processRecords(records: TRecord[], context: LogImportSessionContext<TState>): NormalizedEvent[];
  public abstract serializeState(state: TState): JsonObject;
  public abstract deserializeState(raw: JsonObject): TState;

  /**
   * Process a complete log file in a single call.
   *
   * Composes extractSessionContext + processRecords + message extraction.
   * Adapters that need special handling (fork detection, field normalization)
   * should override this method.
   * @param records - All parsed records from the log file
   * @returns Combined session metadata, events, and message payloads
   */
  public processLogFile(records: TRecord | TRecord[]): ProcessLogFileResult {
    const input = Array.isArray(records) ? records : [records];
    const context = this.extractSessionContext(input);
    const messageEvents = this.processRecords(input, context);

    return {
      adapterSessionId: context.adapterSessionId,
      sessionEvent: context.sessionEvent,
      messageEvents: [context.startedEvent, ...messageEvents],
      messagePayloads: [],
      lineage: { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null },
    };
  }
}
