import { z } from 'zod';

/**
 * Raw rate limit window exposed to Claude Code status line commands.
 *
 * Windows are modeled explicitly where documented (`five_hour`, `seven_day`),
 * while each window preserves additional upstream fields so newer CLI versions
 * do not force client package updates before consumers can observe the payload.
 */
export const ClaudeStatuslineRateLimitWindowSchema = z
  .object({
    used_percentage: z.number().optional(),
    resets_at: z.number().optional(),
  })
  .passthrough();

export type ClaudeStatuslineRateLimitWindow = z.infer<typeof ClaudeStatuslineRateLimitWindowSchema>;

/**
 * Raw status line rate limit payload.
 *
 * Claude Code currently documents `five_hour` and `seven_day`, but the object
 * stays open so additional windows can flow through unchanged.
 */
export const ClaudeStatuslineRateLimitsSchema = z
  .object({
    five_hour: ClaudeStatuslineRateLimitWindowSchema.optional(),
    seven_day: ClaudeStatuslineRateLimitWindowSchema.optional(),
  })
  .passthrough();

export type ClaudeStatuslineRateLimits = z.infer<typeof ClaudeStatuslineRateLimitsSchema>;

/**
 * Token counts from the most recent API call in the status line payload.
 */
export const ClaudeStatuslineCurrentUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

export type ClaudeStatuslineCurrentUsage = z.infer<typeof ClaudeStatuslineCurrentUsageSchema>;

/**
 * Raw Claude Code status line payload sent to custom status line commands.
 *
 * Mirrors the currently documented payload while remaining intentionally
 * permissive: documented fields are typed when present, early-session
 * nullable/absent values are accepted, and all objects preserve unknown
 * upstream fields.
 *
 * Source:
 * https://code.claude.com/docs/en/statusline
 */
export const ClaudeStatuslinePayloadSchema = z
  .object({
    cwd: z.string().optional(),
    session_id: z.string().optional(),
    session_name: z.string().optional(),
    transcript_path: z.string().optional(),
    model: z
      .object({
        id: z.string().optional(),
        display_name: z.string().optional(),
        family: z.string().optional(),
      })
      .passthrough()
      .optional(),
    workspace: z
      .object({
        current_dir: z.string().optional(),
        project_dir: z.string().optional(),
        added_dirs: z.array(z.string()).optional(),
        git_worktree: z.string().optional(),
      })
      .passthrough()
      .optional(),
    version: z.string().optional(),
    output_style: z
      .object({
        name: z.string().optional(),
        variant: z.string().optional(),
      })
      .passthrough()
      .optional(),
    cost: z
      .object({
        total_cost_usd: z.number().optional(),
        total_duration_ms: z.number().optional(),
        total_api_duration_ms: z.number().optional(),
        total_lines_added: z.number().optional(),
        total_lines_removed: z.number().optional(),
        total_edits: z.number().optional(),
      })
      .passthrough()
      .optional(),
    context_window: z
      .object({
        total_input_tokens: z.number().optional(),
        total_output_tokens: z.number().optional(),
        context_window_size: z.number().optional(),
        used_percentage: z.number().nullable().optional(),
        remaining_percentage: z.number().nullable().optional(),
        current_usage: ClaudeStatuslineCurrentUsageSchema.nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    exceeds_200k_tokens: z.boolean().optional(),
    rate_limits: ClaudeStatuslineRateLimitsSchema.optional(),
    vim: z
      .object({
        mode: z.string().optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        name: z.string().optional(),
        kind: z.string().optional(),
      })
      .passthrough()
      .optional(),
    worktree: z
      .object({
        name: z.string().optional(),
        path: z.string().optional(),
        branch: z.string().optional(),
        original_cwd: z.string().optional(),
        original_branch: z.string().optional(),
        provider: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ClaudeStatuslinePayload = z.infer<typeof ClaudeStatuslinePayloadSchema>;

/**
 * Raw Claude Code statusline payload schema used by the Claude-specific
 * `client:claude-code.*` namespace.
 */
export const ClaudeCodeStatuslineRawPayloadSchema = ClaudeStatuslinePayloadSchema;

export type ClaudeCodeStatuslineRawPayload = ClaudeStatuslinePayload;
