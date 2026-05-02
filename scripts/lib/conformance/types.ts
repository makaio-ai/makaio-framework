import { resolve, join } from 'path';
import { TaskMeta, TestError, type UserConsoleLog } from 'vitest';
import { TestProject, TestCollection } from 'vitest/node';

// ─────────────────────────────────────────────────────────────────────────────
// Vitest Internal Task Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vitest internal task structure not exposed in the public reporter API.
 *
 * Vitest's public `TestSuite` / `TestCase` nodes delegate to an internal
 * `task` object for low-level state such as `result`, `logs`, and `file`.
 * This interface captures only the subset accessed by the adapter reporter.
 */
export interface InternalVitestTask {
  /** Low-level task result carrying state and errors. */
  result?: {
    state?: string;
    errors?: TestError[];
  };
  /** Console logs emitted during the task run. */
  logs?: UserConsoleLog[];
  /** File metadata attached to the task. */
  file?: { name?: string };
  /** TaskMeta attached during collection or execution. */
  meta?: TaskMeta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

export const ROOT = resolve(import.meta.dirname, '../../..');
export const ADAPTERS_PATH = join(ROOT, 'adapters/implementations');
export const CONFORMANCE_PATH = join(ADAPTERS_PATH, '__tests__');
export const PROVIDERS_PATH = join(ROOT, 'providers');

// ─────────────────────────────────────────────────────────────────────────────
// ANSI Colors
// ─────────────────────────────────────────────────────────────────────────────

export const colors = process.env.AI_AGENT?.length
  ? {
      reset: '',
      bold: '',
      dim: '',
      green: '',
      red: '',
      yellow: '',
      cyan: '',
    }
  : ({
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      green: '\x1b[32m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
    } as const);

// ─────────────────────────────────────────────────────────────────────────────
// Runner Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ErrorInfo {
  test: string;
  message: string;
  file?: string;
  line?: number;
}

export interface AdapterResult {
  adapter: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  errors: ErrorInfo[];
  unhandledErrors: Array<{ name?: string; message: string; file?: string; line?: number }>;
  schemaViolations: SchemaViolation[];
}

/** High-level status for one adapter invocation in a conformance phase. */
export type ConformanceRunStatus = 'passed' | 'failed' | 'skipped';

/** Machine-readable artifact emitted by the conformance runner for CI reports. */
export interface ConformanceRunArtifact {
  /** Artifact schema version. */
  schemaVersion: 1;
  /** Optional phase label supplied by the caller. */
  phase?: string;
  /** ISO timestamp for artifact generation. */
  generatedAt: string;
  /** Per-adapter results included in this invocation. */
  runs: ConformanceRunEntry[];
}

/** Adapter result enriched with report metadata. */
export interface ConformanceRunEntry extends AdapterResult {
  /** High-level status derived from failures and unhandled errors. */
  status: ConformanceRunStatus;
  /** Conformance-relative test file paths included in this invocation. */
  testFiles: string[];
}

export interface RunOptions {
  adapters: string[];
  filePatterns: string[];
  excludePatterns: string[];
  testNamePattern?: string;
  concurrencyOverride?: number;
  adapterParallelism: number;
  verbose: boolean;
  workers?: number;
  dryRun: boolean;
  allAdapters?: boolean;
  all: boolean;
  phase?: string;
  resultOutputPath?: string;
  schemaViolationsOutputPath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporter Types (module augmentation in scripts/lib/vitest-meta.d.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type TaskChild = {
  name: string;
  meta: () => TaskMeta;
  /** Internal vitest task — not part of the public reporter API. */
  task?: InternalVitestTask;
  children?: TaskChild[] | TestCollection;
  parent?: unknown;
  state: () => string;
  project: TestProject;
};

export type TaskContext = {
  adapterId?: string[];
  agentId?: string[];
  adapterSessionId?: string[];
  sessionId?: string[];
  timestamp?: number;
};

export type LogItem = {
  timestamp: number;
  source: string;
  content?: string | Record<string, unknown>;
  message?: string;
  adapterId?: string | string[];
  agentId?: string | string[];
  sessionId?: string | string[];
  adapterSessionId?: string | string[];
};

/**
 * Schema violation captured from [BUS:VIOLATION] log lines.
 * Deduplicated by subject + issue text.
 */
export interface SchemaViolation {
  /** Fully-qualified subject key */
  subject: string;
  /** Compact issue descriptions */
  issues: string[];
  /** Redacted payload captured with the violation */
  sample?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats milliseconds as human-readable duration.
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export type StackLocation = { file?: string; line?: number };

/**
 * Extracts file and line from an error's stack trace.
 * @param error - Error to parse stack from
 * @returns Object with file and line, or empty if not found
 */
export function parseStackLocation(error: Error | TestError): StackLocation {
  const testError = error as TestError;
  const firstStack = testError.stacks?.[0];

  if (firstStack) {
    return { file: firstStack.file, line: firstStack.line };
  }

  if (error.stack) {
    const match = error.stack.match(/at .+? \((.+?):(\d+):\d+\)/);
    if (match) {
      return { file: match[1], line: parseInt(match[2], 10) };
    }
  }

  return {};
}
