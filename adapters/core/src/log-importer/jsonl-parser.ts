import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/**
 * Error encountered while parsing a JSONL line.
 * @remarks
 * Errors include the line number (1-indexed), the error message, and the
 * raw content of the line for debugging purposes. Content is truncated
 * at 200 characters to prevent large payloads from bloating error logs.
 * @see {@link JsonlParseResult} - Contains array of parse errors
 */
export interface JsonlParseError {
  /** 1-indexed line number relative to the file start (not the offset) */
  line: number;

  /** Error message describing why parsing failed */
  error: string;

  /** Raw content of the malformed line (truncated at 200 chars) */
  content: string;
}

/**
 * Result of parsing a JSONL file.
 * @typeParam T - The expected type of each parsed record
 * @remarks
 * Contains successfully parsed records, the new byte offset for cursor updates,
 * and any errors encountered. Errors don't prevent successful records from being
 * returned - the parser continues after malformed lines.
 * @see {@link parseJsonlFile} - Function that produces this result
 */
export interface JsonlParseResult<T> {
  /**
   * Successfully parsed records.
   * @remarks
   * Records are returned in file order. Each record is the result of
   * `JSON.parse()` on a complete line. Type safety is the caller's
   * responsibility via validation or type guards.
   */
  records: T[];

  /**
   * Byte offset for cursor update.
   * @remarks
   * This is the position immediately after the last complete line
   * (the last `\n` character processed). Use this value to update
   * the cursor for resuming later reads.
   *
   * If the file ends without a trailing newline, `bytesRead` points
   * to the end of the last complete line, leaving incomplete content
   * for the next read when it becomes complete.
   */
  bytesRead: number;

  /**
   * Parse errors encountered.
   * @remarks
   * One entry per malformed line. Lines that fail `JSON.parse()` are
   * logged here but don't stop processing. The caller should log these
   * for debugging while continuing to process valid records.
   */
  errors: JsonlParseError[];
}

/**
 * Options for parsing a JSONL file.
 * @see {@link parseJsonlFile} - Function that accepts these options
 */
export interface JsonlParserOptions {
  /**
   * Absolute path to the JSONL file to parse.
   */
  filePath: string;

  /**
   * Byte offset to start reading from.
   * @defaultValue 0 (start of file)
   * @remarks
   * Use this to resume reading from a previously stored cursor position.
   * The parser will seek to this position before reading.
   */
  startOffset?: number;
}

/** Maximum content length to store in error objects */
const MAX_ERROR_CONTENT_LENGTH = 200;

/** Default buffer size for reading chunks (64KB) */
const READ_BUFFER_SIZE = 65536;

/**
 * Parse a JSONL file starting from a byte offset.
 * @typeParam T - The expected type of each parsed JSON record
 * @param options - Parser configuration including file path and start offset
 * @returns Parse result with records, new byte offset, and any errors
 * @throws Error if the file cannot be opened or read
 * @remarks
 * ## Partial Line Handling
 *
 * JSONL files may be actively written to, leaving incomplete lines at the end.
 * This parser only processes complete lines (lines ending with `\n`). Incomplete
 * trailing content is left for the next read cycle.
 *
 * ## Error Handling
 *
 * Malformed JSON lines don't stop parsing. The parser logs the error and
 * continues to the next line. Callers should check the `errors` array and
 * log/alert as appropriate.
 *
 * ## Type Safety
 *
 * The generic type `T` is not validated at runtime. Callers should either:
 * 1. Use Zod or similar to validate each record
 * 2. Use type guards before accessing properties
 * 3. Trust the source format (e.g., known tool log format)
 * @example
 * ```typescript
 * interface LogRecord {
 *   type: string;
 *   timestamp: string;
 *   data: unknown;
 * }
 *
 * // First read (from beginning)
 * const result = await parseJsonlFile<LogRecord>({
 *   filePath: '/path/to/logs.jsonl',
 * });
 *
 * // Process records
 * for (const record of result.records) {
 *   console.log(record.type);
 * }
 *
 * // Store cursor for next read
 * await saveCursor(result.bytesRead);
 *
 * // Later: resume from cursor
 * const cursor = await loadCursor();
 * const nextResult = await parseJsonlFile<LogRecord>({
 *   filePath: '/path/to/logs.jsonl',
 *   startOffset: cursor,
 * });
 * ```
 */
export async function parseJsonlFile<T>(options: JsonlParserOptions): Promise<JsonlParseResult<T>> {
  const { filePath, startOffset = 0 } = options;

  const records: T[] = [];
  const errors: JsonlParseError[] = [];
  let bytesRead = startOffset;

  let fileHandle: FileHandle | undefined;

  try {
    fileHandle = await fs.open(filePath, 'r');
    const stat = await fileHandle.stat();

    // Nothing to read if we're at or past the end
    if (startOffset >= stat.size) {
      return { records, bytesRead: startOffset, errors };
    }

    // Read file content from offset to end
    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let accumulatedContent = '';
    let currentPosition = startOffset;
    let absoluteLineNumber = 0; // Will be calculated based on offset

    // Calculate line number offset by counting newlines before startOffset
    if (startOffset > 0) {
      absoluteLineNumber = await countNewlinesBeforeOffset(fileHandle, startOffset);
    }

    // Read chunks and process lines
    while (currentPosition < stat.size) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(buffer, 0, READ_BUFFER_SIZE, currentPosition);

      if (chunkBytesRead === 0) {
        break;
      }

      accumulatedContent += buffer.toString('utf8', 0, chunkBytesRead);
      currentPosition += chunkBytesRead;

      // Process complete lines (those ending with \n)
      const lines = accumulatedContent.split('\n');

      // Keep the last element if it doesn't end with newline (incomplete line)
      // If accumulatedContent ends with \n, last element is empty string
      const lastElement = lines.pop();

      for (const line of lines) {
        absoluteLineNumber++;

        // Skip empty lines (result of consecutive newlines)
        if (line.trim() === '') {
          // Update bytesRead to include this empty line plus its newline
          bytesRead += Buffer.byteLength(line, 'utf8') + 1;
          continue;
        }

        const parseResult = parseSingleLine<T>(line, absoluteLineNumber);

        if (parseResult.success) {
          records.push(parseResult.record);
        } else {
          errors.push(parseResult.error);
        }

        // Update bytesRead to include this line plus its newline
        bytesRead += Buffer.byteLength(line, 'utf8') + 1;
      }

      // Accumulate incomplete line for next chunk (or leave for next read cycle)
      accumulatedContent = lastElement ?? '';
    }

    // Note: accumulatedContent may contain an incomplete line here.
    // We intentionally don't process it - bytesRead points to the end of
    // the last complete line, so the incomplete content will be read
    // again when the file is next polled and the line is complete.

    return { records, bytesRead, errors };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

/**
 * Read the first N JSON records from a JSONL file.
 *
 * Optimized for discovery: reads only enough bytes to find `maxRecords`
 * complete JSON lines, then stops. Uses a small buffer to avoid reading
 * entire large files.
 * @param filePath - Absolute path to the JSONL file
 * @param maxRecords - Maximum number of records to return
 * @returns Array of parsed JSON records (skips malformed lines)
 */
export async function readFirstJsonlRecords<T>(filePath: string, maxRecords: number): Promise<T[]> {
  const records: T[] = [];
  let fileHandle: FileHandle | undefined;

  try {
    fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let accumulatedContent = '';
    let currentPosition = 0;

    while (records.length < maxRecords) {
      const { bytesRead } = await fileHandle.read(buffer, 0, READ_BUFFER_SIZE, currentPosition);
      if (bytesRead === 0) break;

      accumulatedContent += buffer.toString('utf8', 0, bytesRead);
      currentPosition += bytesRead;

      const lines = accumulatedContent.split('\n');
      // Keep last element (may be incomplete)
      accumulatedContent = lines.pop() ?? '';

      for (const line of lines) {
        if (records.length >= maxRecords) break;
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          records.push(JSON.parse(trimmed) as T);
        } catch {
          // Skip malformed lines silently during discovery
        }
      }
    }

    return records;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

/**
 * Determine whether any parsed JSONL record matches a predicate.
 *
 * Stops reading as soon as a matching record is found, which keeps discovery
 * checks bounded even for very large log files.
 * @typeParam T - The expected type of each parsed record
 * @param filePath - Absolute path to the JSONL file
 * @param predicate - Record matcher evaluated in file order
 * @returns True on the first matching record, otherwise false
 */
export async function someJsonlRecord<T>(filePath: string, predicate: (record: T) => boolean): Promise<boolean> {
  let fileHandle: FileHandle | undefined;

  try {
    fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let accumulatedContent = '';
    let currentPosition = 0;

    while (true) {
      const { bytesRead } = await fileHandle.read(buffer, 0, READ_BUFFER_SIZE, currentPosition);
      if (bytesRead === 0) break;

      accumulatedContent += buffer.toString('utf8', 0, bytesRead);
      currentPosition += bytesRead;

      const lines = accumulatedContent.split('\n');
      accumulatedContent = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const record = JSON.parse(trimmed) as T;
          if (predicate(record)) {
            return true;
          }
        } catch {
          // Skip malformed lines silently during lightweight discovery scans.
        }
      }
    }

    return false;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

/**
 * Parse result union type for internal use.
 */
type SingleLineParseResult<T> = { success: true; record: T } | { success: false; error: JsonlParseError };

/**
 * Parse a single JSON line.
 * @param line - Raw line content (without newline)
 * @param lineNumber - 1-indexed line number for error reporting
 * @returns Success with record, or failure with error details
 */
function parseSingleLine<T>(line: string, lineNumber: number): SingleLineParseResult<T> {
  try {
    const record = JSON.parse(line) as T;
    return { success: true, record };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        line: lineNumber,
        error: errorMessage,
        content: truncateContent(line),
      },
    };
  }
}

/**
 * Truncate content for error logging.
 * @param content - Raw content
 * @returns Truncated content with ellipsis if needed
 */
function truncateContent(content: string): string {
  if (content.length <= MAX_ERROR_CONTENT_LENGTH) {
    return content;
  }
  return content.slice(0, MAX_ERROR_CONTENT_LENGTH) + '...';
}

/**
 * Count newlines in file before a given offset.
 * @remarks
 * Used to calculate correct line numbers when resuming from an offset.
 * @param fileHandle - Open file handle
 * @param offset - Byte offset to count newlines before
 * @returns Number of newline characters before the offset
 */
async function countNewlinesBeforeOffset(fileHandle: FileHandle, offset: number): Promise<number> {
  let count = 0;
  const buffer = Buffer.alloc(READ_BUFFER_SIZE);
  let position = 0;

  while (position < offset) {
    const bytesToRead = Math.min(READ_BUFFER_SIZE, offset - position);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, position);

    if (bytesRead === 0) {
      break;
    }

    // Count newlines in this chunk
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0x0a) {
        // \n
        count++;
      }
    }

    position += bytesRead;
  }

  return count;
}
