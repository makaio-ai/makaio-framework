import { z } from 'zod';

/**
 * Platform identifier for tool execution context.
 * Used to determine platform-specific behavior in tools.
 */
export type Platform = 'posix' | 'windows';

/**
 * Execution context passed to tool implementations.
 *
 * Provides tools with essential runtime information about the execution environment,
 * including working directory, environment variables, platform, and cancellation support.
 * @example
 * ```typescript
 * const result = await tool.execute(input, {
 *   cwd: '/path/to/project',
 *   env: { NODE_ENV: 'development' },
 *   platform: 'posix',
 *   signal: abortController.signal,
 * });
 * ```
 */
export interface MakaioContext {
  /** Working directory for tool execution */
  cwd: string;

  /** Read-only environment variables available to the tool */
  env: Readonly<Record<string, string>>;

  /** Platform identifier for cross-platform compatibility */
  platform: Platform;

  /** Optional abort signal for cancellation support */
  signal?: AbortSignal;

  /** Optional constraints that tools can check for specific behaviors */
  constraints?: Record<string, unknown>;

  /** Session ID for the current execution context */
  sessionId?: string;

  /** Subagent ID if running as a subagent */
  subagentId?: string;

  /** Current nesting depth in subagent hierarchy (0 = root) */
  subagentDepth?: number;
}

/**
 * Zod schema for MakaioContext validation.
 * Used for runtime validation of context objects.
 */
export const MakaioContextSchema = z.object({
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  platform: z.enum(['posix', 'windows']),
  signal: z.custom<AbortSignal>().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
  subagentId: z.string().optional(),
  subagentDepth: z.number().optional(),
});

/**
 * Detects the current platform from process information.
 * @returns Platform identifier ('posix' or 'windows')
 */
function detectPlatform(): Platform {
  if (typeof process === 'undefined') {
    // Default to posix in non-Node environments (e.g., browser)
    return 'posix';
  }
  return process.platform === 'win32' ? 'windows' : 'posix';
}

/**
 * Patterns that indicate sensitive environment variables.
 * Variables matching these patterns (case-insensitive) are filtered out.
 */
const SENSITIVE_PATTERNS = [
  'API_KEY',
  'APIKEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'PRIVATEKEY',
  'AUTH',
  'BEARER',
  'ACCESS_KEY',
  'ACCESSKEY',
] as const;

/**
 * Checks if an environment variable key matches any sensitive pattern.
 * @param key - Environment variable name to check
 * @returns True if the key appears to contain sensitive data
 */
function isSensitiveKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return SENSITIVE_PATTERNS.some((pattern) => upperKey.includes(pattern));
}

/**
 * Sanitizes environment variables by filtering out undefined values
 * and sensitive variables (API keys, secrets, tokens, etc.).
 * @param env - Raw environment object from process.env
 * @returns Sanitized environment record with only safe string values
 */
function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isSensitiveKey(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Creates a MakaioContext with sensible defaults and optional overrides.
 *
 * Default behavior:
 * - `cwd`: Uses process.cwd() or '/' in non-Node environments
 * - `env`: Sanitized process.env (filters undefined values)
 * - `platform`: Auto-detected from process.platform
 * @param overrides - Optional partial context to merge with defaults
 * @returns Complete MakaioContext ready for tool execution
 * @example
 * ```typescript
 * // Create context with all defaults
 * const ctx = createMakaioContext();
 *
 * // Override specific values
 * const ctx = createMakaioContext({
 *   cwd: '/custom/path',
 *   signal: abortController.signal,
 * });
 * ```
 */
export function createMakaioContext(overrides?: Partial<MakaioContext>): MakaioContext {
  const defaultCwd = typeof process !== 'undefined' ? process.cwd() : '/';
  const defaultEnv = typeof process !== 'undefined' ? sanitizeEnv(process.env) : {};

  return {
    cwd: overrides?.cwd ?? defaultCwd,
    env: overrides?.env ?? defaultEnv,
    platform: overrides?.platform ?? detectPlatform(),
    signal: overrides?.signal,
    constraints: overrides?.constraints,
    sessionId: overrides?.sessionId,
    subagentId: overrides?.subagentId,
    subagentDepth: overrides?.subagentDepth,
  };
}
