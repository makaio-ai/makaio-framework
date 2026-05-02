import { z } from 'zod';

// =============================================================================
// Constraints (set by runtime, not LLM)
// =============================================================================

export interface ShellConstraints {
  /** Default timeout in ms (default: 30000) */
  timeout?: number;
  /** Max output buffer size in characters (default: 10M chars) */
  maxOutputSize?: number;
  /** What to keep when buffer overflows */
  truncateMode?: 'head' | 'tail' | 'middle';
  /** Commands that run without approval */
  allowedCommands?: string[];
  /** Commands that are rejected outright */
  blockedCommands?: string[];
  /** Allowed working directories */
  allowedPaths?: string[];
  /** Max concurrent shells (default: 10) */
  maxConcurrentShells?: number;
  /** TTL for output buffers after shell exits in ms (default: 1800000 = 30min) */
  bufferRetentionMs?: number;
}

export const DEFAULT_CONSTRAINTS: Required<ShellConstraints> = {
  timeout: 30_000,
  maxOutputSize: 10 * 1024 * 1024, // 10MB
  truncateMode: 'tail',
  allowedCommands: [],
  blockedCommands: [],
  allowedPaths: [],
  maxConcurrentShells: 10,
  bufferRetentionMs: 30 * 60 * 1000, // 30 minutes
};

// =============================================================================
// Shell Status
// =============================================================================

export type ShellStatus = 'running' | 'exited';

export type StreamType = 'stdout' | 'stderr';

// =============================================================================
// Output Buffer Types
// =============================================================================

export interface OutputChunk {
  stream: StreamType;
  data: string;
  timestamp: number;
}

export interface OutputLine {
  stream: StreamType;
  content: string;
  lineNumber: number;
}

export interface OutputBufferState {
  chunks: OutputChunk[];
  lines: OutputLine[];
  totalSize: number;
  truncated: boolean;
}

// =============================================================================
// Shell Instance State
// =============================================================================

export interface ShellState {
  shellId: string;
  pid: number;
  shell: string;
  status: ShellStatus;
  exitCode?: number;
  startTime: number;
  endTime?: number;
  stdoutSize: number;
  stderrSize: number;
  truncated: boolean;
}

// =============================================================================
// Zod Schemas for Tool I/O
// =============================================================================

// shell_exec
export const ShellExecInputSchema = z.object({
  command: z.string().describe('Command to execute'),
  cwd: z.string().optional().describe('Working directory (default: context.cwd)'),
  env: z.record(z.string(), z.string()).optional().describe('Additional environment variables'),
  colors: z.boolean().default(false).describe('Preserve ANSI color codes (default: strip)'),
  timeout: z.number().optional().describe('Override timeout in ms (can only be shorter than constraint)'),
});

export const ShellExecOutputSchema = z.object({
  shellId: z.string().describe('Unique shell identifier'),
  pid: z.number().describe('Process ID'),
  shell: z.string().describe('Shell used (bash, zsh, powershell, cmd)'),
});

export type ShellExecInput = z.infer<typeof ShellExecInputSchema>;
export type ShellExecOutput = z.infer<typeof ShellExecOutputSchema>;

// shell_status
export const ShellStatusInputSchema = z.object({
  shellId: z.string().describe('Shell identifier'),
});

export const ShellStatusOutputSchema = z.object({
  shellId: z.string(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().optional().describe('Exit code if exited'),
  stdoutSize: z.number().describe('Characters captured on stdout'),
  stderrSize: z.number().describe('Characters captured on stderr'),
  truncated: z.boolean().describe('True if output hit maxOutputSize'),
  runtimeMs: z.number().describe('Milliseconds since start'),
});

export type ShellStatusInput = z.infer<typeof ShellStatusInputSchema>;
export type ShellStatusOutput = z.infer<typeof ShellStatusOutputSchema>;

// shell_grep
export const ShellGrepInputSchema = z.object({
  shellId: z.string().describe('Shell identifier'),
  pattern: z.string().describe('Regex pattern to search'),
  stream: z.enum(['stdout', 'stderr', 'both']).default('both'),
  context: z.number().default(2).describe('Lines of context before/after match'),
  maxMatches: z.number().default(10).describe('Maximum matches to return'),
  offset: z.number().default(0).describe('Skip first N matches (for pagination)'),
});

export const GrepMatchSchema = z.object({
  lineNumber: z.number(),
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});

export const ShellGrepOutputSchema = z.object({
  matches: z.array(GrepMatchSchema),
  totalMatches: z.number().describe('Total matches in buffer'),
  truncated: z.boolean().describe('True if more matches exist'),
});

export type ShellGrepInput = z.infer<typeof ShellGrepInputSchema>;
export type ShellGrepOutput = z.infer<typeof ShellGrepOutputSchema>;
export type GrepMatch = z.infer<typeof GrepMatchSchema>;

// shell_output
export const ShellOutputInputSchema = z.object({
  shellId: z.string().describe('Shell identifier'),
  stream: z.enum(['stdout', 'stderr', 'both']).default('both'),
  offset: z.number().default(0).describe('Character offset to start from'),
  limit: z.number().default(10000).describe('Maximum characters to return'),
});

export const ShellOutputOutputSchema = z.object({
  content: z.string(),
  stream: z.enum(['stdout', 'stderr', 'interleaved']),
  offset: z.number(),
  totalSize: z.number().describe('Total characters available'),
  hasMore: z.boolean(),
});

export type ShellOutputInput = z.infer<typeof ShellOutputInputSchema>;
export type ShellOutputOutput = z.infer<typeof ShellOutputOutputSchema>;

// shell_send
export const ShellSendInputSchema = z.object({
  shellId: z.string().describe('Shell identifier'),
  input: z.string().describe('Text to send to stdin (include newline if needed)'),
});

export const ShellSendOutputSchema = z.object({
  sent: z.boolean(),
  bytesWritten: z.number(),
});

export type ShellSendInput = z.infer<typeof ShellSendInputSchema>;
export type ShellSendOutput = z.infer<typeof ShellSendOutputSchema>;

// shell_kill
export const ShellKillInputSchema = z.object({
  shellId: z.string().describe('Shell identifier'),
  signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGINT']).default('SIGTERM'),
});

export const ShellKillOutputSchema = z.object({
  killed: z.boolean(),
  signal: z.string(),
});

export type ShellKillInput = z.infer<typeof ShellKillInputSchema>;
export type ShellKillOutput = z.infer<typeof ShellKillOutputSchema>;
