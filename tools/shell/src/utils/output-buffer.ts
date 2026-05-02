/**
 * OutputBuffer - Manages buffered output from shell processes.
 *
 * Features:
 * - Captures stdout/stderr with timestamps
 * - Handles partial line buffering
 * - Enforces max size with truncation
 * - Supports chronological interleaving
 */

import type { StreamType, OutputLine } from '../types.js';

// =============================================================================
// Types
// =============================================================================

export interface OutputBufferOptions {
  /** Maximum buffer size in characters (UTF-16 code units) */
  maxSize: number;
  /** Truncation mode when buffer overflows (default: 'tail') */
  truncateMode?: 'head' | 'tail' | 'middle';
}

export interface OutputBufferStats {
  stdoutSize: number;
  stderrSize: number;
  totalSize: number;
  truncated: boolean;
}

export interface OutputBufferContent {
  content: string;
  stream: 'stdout' | 'stderr' | 'interleaved';
  offset: number;
  totalSize: number;
  hasMore: boolean;
}

// =============================================================================
// Internal Types
// =============================================================================

interface InternalChunk {
  stream: StreamType;
  data: string;
  timestamp: number;
}

// =============================================================================
// OutputBuffer Class
// =============================================================================

export class OutputBuffer {
  private readonly maxSize: number;
  private readonly truncateMode: 'head' | 'tail' | 'middle';

  private chunks: InternalChunk[] = [];
  private stdoutSize = 0;
  private stderrSize = 0;
  private truncated = false;

  // Partial line buffers for each stream
  private partialStdout = '';
  private partialStderr = '';
  private partialStdoutTimestamp = 0;
  private partialStderrTimestamp = 0;

  public constructor(options: OutputBufferOptions) {
    this.maxSize = options.maxSize;
    this.truncateMode = options.truncateMode ?? 'tail';
  }

  /**
   * Append data to the buffer.
   * @param stream - Target stream ('stdout' or 'stderr')
   * @param data - Data chunk to append
   */
  public append(stream: StreamType, data: string): void {
    if (data.length === 0) {
      return;
    }

    const timestamp = Date.now();

    // Handle line buffering - split by newlines while preserving partial lines
    const partial = stream === 'stdout' ? this.partialStdout : this.partialStderr;
    const combined = partial + data;

    // Normalize line endings: \r\n -> \n
    const normalized = combined.replace(/\r\n/g, '\n');

    // Find complete lines (everything up to and including last newline)
    const lastNewline = normalized.lastIndexOf('\n');

    if (lastNewline === -1) {
      // No complete lines - update partial buffer
      if (stream === 'stdout') {
        this.partialStdout = normalized;
        this.partialStdoutTimestamp = this.partialStdoutTimestamp || timestamp;
      } else {
        this.partialStderr = normalized;
        this.partialStderrTimestamp = this.partialStderrTimestamp || timestamp;
      }
      // Update size for partial
      this.updateSize(stream, data.length);

      // If total size exceeds max, force-flush partial to chunks so it can be truncated
      const totalSize = this.stdoutSize + this.stderrSize;
      if (totalSize > this.maxSize) {
        this.flushPartial(stream);
        this.enforceMaxSize();
      }
      return;
    }

    // We have complete lines
    const completeData = normalized.slice(0, lastNewline + 1);
    const remaining = normalized.slice(lastNewline + 1);

    // Add complete lines as chunks
    const chunkTimestamp =
      stream === 'stdout' ? this.partialStdoutTimestamp || timestamp : this.partialStderrTimestamp || timestamp;

    this.chunks.push({
      stream,
      data: completeData,
      timestamp: chunkTimestamp,
    });

    // Update partial buffer
    if (stream === 'stdout') {
      this.partialStdout = remaining;
      this.partialStdoutTimestamp = remaining ? timestamp : 0;
    } else {
      this.partialStderr = remaining;
      this.partialStderrTimestamp = remaining ? timestamp : 0;
    }

    // Update sizes
    this.updateSize(stream, data.length);

    // Enforce max size
    this.enforceMaxSize();
  }

  /**
   * Flush any pending partial lines as complete lines.
   */
  public flush(): void {
    if (this.partialStdout) {
      this.chunks.push({
        stream: 'stdout',
        data: this.partialStdout,
        timestamp: this.partialStdoutTimestamp || Date.now(),
      });
      this.partialStdout = '';
      this.partialStdoutTimestamp = 0;
    }

    if (this.partialStderr) {
      this.chunks.push({
        stream: 'stderr',
        data: this.partialStderr,
        timestamp: this.partialStderrTimestamp || Date.now(),
      });
      this.partialStderr = '';
      this.partialStderrTimestamp = 0;
    }
  }

  /**
   * Get current buffer statistics.
   * @returns Buffer statistics including sizes and truncation status
   */
  public getState(): OutputBufferStats {
    return {
      stdoutSize: this.stdoutSize,
      stderrSize: this.stderrSize,
      totalSize: this.stdoutSize + this.stderrSize,
      truncated: this.truncated,
    };
  }

  /**
   * Get lines from the buffer.
   * @param stream - Which stream(s) to retrieve lines from
   * @returns Array of output lines with stream type and line numbers
   */
  public getLines(stream: 'stdout' | 'stderr' | 'both'): OutputLine[] {
    // Get relevant chunks based on stream filter
    const filteredChunks =
      stream === 'both'
        ? [...this.chunks].sort((a, b) => a.timestamp - b.timestamp)
        : this.chunks.filter((c) => c.stream === stream);

    const lines: OutputLine[] = [];
    let lineNumber = 1;

    for (const chunk of filteredChunks) {
      // Split chunk data into lines
      const chunkLines = chunk.data.split('\n');

      // Last element is empty string after trailing newline (or partial line)
      for (let i = 0; i < chunkLines.length; i++) {
        const content = chunkLines[i];
        // Skip the empty string after trailing newline
        if (i === chunkLines.length - 1 && content === '') {
          continue;
        }

        lines.push({
          stream: chunk.stream,
          content,
          lineNumber: lineNumber++,
        });
      }
    }

    return lines;
  }

  /**
   * Get raw content with pagination support.
   * @param stream - Which stream(s) to retrieve content from
   * @param offset - Character offset to start from
   * @param limit - Maximum characters to return
   * @returns Content with pagination metadata
   */
  public getContent(stream: 'stdout' | 'stderr' | 'both', offset: number, limit: number): OutputBufferContent {
    // Build content string
    let content: string;

    if (stream === 'both') {
      // Interleave chronologically
      const sortedChunks = [...this.chunks].sort((a, b) => a.timestamp - b.timestamp);
      content = sortedChunks.map((c) => c.data).join('');
    } else {
      content = this.chunks
        .filter((c) => c.stream === stream)
        .map((c) => c.data)
        .join('');
    }

    const totalSize = content.length;

    // Handle pagination
    if (offset >= totalSize) {
      return {
        content: '',
        stream: stream === 'both' ? 'interleaved' : stream,
        offset,
        totalSize,
        hasMore: false,
      };
    }

    const sliced = content.slice(offset, offset + limit);
    const hasMore = offset + sliced.length < totalSize;

    return {
      content: sliced,
      stream: stream === 'both' ? 'interleaved' : stream,
      offset,
      totalSize,
      hasMore,
    };
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  private updateSize(stream: StreamType, delta: number): void {
    if (stream === 'stdout') {
      this.stdoutSize += delta;
    } else {
      this.stderrSize += delta;
    }
  }

  private enforceMaxSize(): void {
    const totalSize = this.stdoutSize + this.stderrSize;

    if (totalSize <= this.maxSize) {
      return;
    }

    // Tail mode: keep recent content, remove old
    if (this.truncateMode === 'tail') {
      this.truncateTail(totalSize - this.maxSize);
    }
    // Note: 'head' and 'middle' modes can be added later as needed

    this.truncated = true;
  }

  private truncateTail(bytesToRemove: number): void {
    let removed = 0;

    while (removed < bytesToRemove && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      const chunkSize = oldest.data.length;

      if (removed + chunkSize <= bytesToRemove) {
        // Remove entire chunk
        this.chunks.shift();
        removed += chunkSize;

        // Update sizes
        if (oldest.stream === 'stdout') {
          this.stdoutSize -= chunkSize;
        } else {
          this.stderrSize -= chunkSize;
        }
      } else {
        // Partial removal of first chunk
        const toRemove = bytesToRemove - removed;
        oldest.data = oldest.data.slice(toRemove);

        if (oldest.stream === 'stdout') {
          this.stdoutSize -= toRemove;
        } else {
          this.stderrSize -= toRemove;
        }

        removed = bytesToRemove;
      }
    }
  }

  /**
   * Flush a single stream's partial buffer to chunks.
   * Used when partial data exceeds size limits and needs to be truncated.
   * @param stream - Which stream's partial buffer to flush
   */
  private flushPartial(stream: StreamType): void {
    if (stream === 'stdout' && this.partialStdout) {
      this.chunks.push({
        stream: 'stdout',
        data: this.partialStdout,
        timestamp: this.partialStdoutTimestamp || Date.now(),
      });
      this.partialStdout = '';
      this.partialStdoutTimestamp = 0;
    } else if (stream === 'stderr' && this.partialStderr) {
      this.chunks.push({
        stream: 'stderr',
        data: this.partialStderr,
        timestamp: this.partialStderrTimestamp || Date.now(),
      });
      this.partialStderr = '';
      this.partialStderrTimestamp = 0;
    }
  }
}
