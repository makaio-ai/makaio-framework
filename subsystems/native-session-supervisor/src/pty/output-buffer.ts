/**
 * Output Buffer
 *
 * Circular buffer for PTY process output. Stores the last N lines for
 * reconnection replay without altering stream chunks.
 * @packageDocumentation
 */

/**
 * Result of reading buffered output.
 */
export interface BufferReadResult {
  /** Concatenated output data. */
  content: string;
  /** Whether older output was lost due to buffer overflow. */
  wasTruncated: boolean;
}

/**
 * Circular buffer for process output.
 *
 * Stores the last N lines of output for reconnection replay without altering
 * stream chunk boundaries (which could corrupt terminal control sequences).
 */
export class OutputBuffer {
  private chunks: Array<{ seq: number; data: string; newlines: number }> = [];
  private newlineCount = 0;
  private truncated = false;

  /**
   * Create a new output buffer.
   * @param maxLines - Maximum number of lines to store (default: 5000).
   * @param maxChunks - Maximum chunks to prevent unbounded growth from
   *   newline-free output (default: 10000).
   */
  public constructor(
    private readonly maxLines: number = 5000,
    private readonly maxChunks: number = 10_000,
  ) {}

  /**
   * Add output data to the buffer.
   *
   * Preserves chunk boundaries to avoid corrupting terminal control sequences.
   * @param seq - Monotonic sequence number for this chunk.
   * @param data - Output data to add.
   */
  public push(seq: number, data: string): void {
    if (!data) {
      return;
    }

    let newlines = 0;
    for (let i = 0; i < data.length; i++) {
      if (data.charCodeAt(i) === 10) newlines++;
    }
    this.chunks.push({ seq, data, newlines });
    this.newlineCount += newlines;

    while ((this.newlineCount > this.maxLines || this.chunks.length > this.maxChunks) && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (dropped) {
        this.newlineCount -= dropped.newlines;
      }
      this.truncated = true;
    }
  }

  /**
   * Get buffered output as a single string.
   * @returns All buffered output joined without separators.
   */
  public getContent(): string {
    return this.chunks.map((chunk) => chunk.data).join('');
  }

  /**
   * Get content limited to the last N lines.
   * @param lineCount - Number of lines from the end. Null returns the full buffer.
   * @returns Buffered output and truncation flag.
   */
  public getLastNLines(lineCount: number | null): BufferReadResult {
    if (lineCount === null) {
      return { content: this.getContent(), wasTruncated: this.truncated };
    }

    if (lineCount <= 0 || this.chunks.length === 0) {
      return { content: '', wasTruncated: this.truncated };
    }

    let linesNeeded = lineCount;
    const collected: Array<{ seq: number; data: string }> = [];

    for (let index = this.chunks.length - 1; index >= 0; index -= 1) {
      const chunk = this.chunks[index];
      collected.push({ seq: chunk.seq, data: chunk.data });
      linesNeeded -= chunk.newlines;
      if (linesNeeded <= 0) {
        break;
      }
    }

    if (collected.length === 0) {
      return { content: '', wasTruncated: this.truncated };
    }

    collected.sort((a, b) => a.seq - b.seq);
    let content = collected.map((chunk) => chunk.data).join('');

    // Trim from start so only requested last N logical lines remain.
    // Use line splitting (not newline count) to avoid off-by-one behavior.
    const hasTrailingNewline = content.endsWith('\n');
    const lines = content.split('\n');
    if (hasTrailingNewline) {
      lines.pop();
    }

    if (lines.length > lineCount) {
      const tail = lines.slice(-lineCount);
      content = tail.join('\n');
      if (hasTrailingNewline) {
        content += '\n';
      }
    }

    return { content, wasTruncated: this.truncated };
  }

  /**
   * Get buffered output since a sequence number.
   * @param sinceSeq - Last seen sequence number (exclusive). Null returns the full buffer.
   * @returns Buffered output and truncation flag.
   */
  public getSince(sinceSeq: number | null): BufferReadResult {
    if (sinceSeq === null) {
      return { content: this.getContent(), wasTruncated: this.truncated };
    }

    const oldestSeq = this.chunks[0]?.seq ?? null;
    const wasTruncated = oldestSeq !== null && sinceSeq < oldestSeq;
    const content = this.chunks
      .filter((chunk) => chunk.seq > sinceSeq)
      .map((chunk) => chunk.data)
      .join('');
    return { content, wasTruncated };
  }

  /**
   * Get buffered output and clear the buffer.
   * @returns Buffered output and truncation flag.
   */
  public drain(): BufferReadResult {
    const content = this.getContent();
    const wasTruncated = this.truncated;
    this.clear();
    return { content, wasTruncated };
  }

  /**
   * Check if output was truncated due to buffer overflow.
   * @returns True if buffer overflow occurred.
   */
  public wasTruncated(): boolean {
    return this.truncated;
  }

  /**
   * Clear the buffer and reset the truncation flag.
   */
  public clear(): void {
    this.chunks = [];
    this.newlineCount = 0;
    this.truncated = false;
  }
}
