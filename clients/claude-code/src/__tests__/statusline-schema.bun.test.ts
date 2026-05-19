import { describe, expect, it } from 'bun:test';
import { ClaudeStatuslinePayloadSchema } from '../index.js';

function createBaseStatuslinePayload() {
  return {
    cwd: '/repo',
    session_id: 'session-1',
    transcript_path: '/repo/.claude/transcript.jsonl',
    model: {
      id: 'claude-sonnet-4',
      display_name: 'Sonnet',
    },
    workspace: {
      current_dir: '/repo',
      project_dir: '/repo',
      added_dirs: [],
    },
    version: '2.1.90',
    output_style: {
      name: 'default',
    },
    cost: {
      total_cost_usd: 0,
      total_duration_ms: 0,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    context_window: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      context_window_size: 200_000,
      used_percentage: 0,
      remaining_percentage: 100,
      current_usage: null,
    },
    exceeds_200k_tokens: false,
  };
}

describe('ClaudeStatuslinePayloadSchema', () => {
  it('parses the documented raw statusline payload and preserves passthrough fields', () => {
    const payload = {
      cwd: '/current/working/directory',
      session_id: 'abc123',
      session_name: 'my-session',
      transcript_path: '/path/to/transcript.jsonl',
      model: {
        id: 'claude-opus-4-7',
        display_name: 'Opus',
        family: 'claude',
      },
      workspace: {
        current_dir: '/current/working/directory',
        project_dir: '/original/project/directory',
        added_dirs: ['/tmp/shared'],
        git_worktree: 'feature-xyz',
        extra_workspace_field: true,
      },
      version: '2.1.90',
      output_style: {
        name: 'default',
        variant: 'compact',
      },
      cost: {
        total_cost_usd: 0.01234,
        total_duration_ms: 45_000,
        total_api_duration_ms: 2_300,
        total_lines_added: 156,
        total_lines_removed: 23,
        total_edits: 8,
      },
      context_window: {
        total_input_tokens: 15_234,
        total_output_tokens: 4_521,
        context_window_size: 200_000,
        used_percentage: 8,
        remaining_percentage: 92,
        current_usage: {
          input_tokens: 8_500,
          output_tokens: 1_200,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 2_000,
          extra_usage_field: 'preserved',
        },
        extra_context_field: { source: 'docs' },
      },
      exceeds_200k_tokens: false,
      rate_limits: {
        five_hour: {
          used_percentage: 23.5,
          resets_at: 1_738_425_600,
          warning_threshold: 80,
        },
        seven_day: {
          used_percentage: 41.2,
          resets_at: 1_738_857_600,
        },
        thirty_day: {
          used_percentage: 12,
          resets_at: 1_739_000_000,
        },
      },
      vim: {
        mode: 'NORMAL',
      },
      agent: {
        name: 'security-reviewer',
        kind: 'custom',
      },
      worktree: {
        name: 'my-feature',
        path: '/path/to/.claude/worktrees/my-feature',
        branch: 'worktree-my-feature',
        original_cwd: '/path/to/project',
        original_branch: 'main',
        provider: 'git',
      },
      custom_status_field: {
        enabled: true,
      },
    };

    const result = ClaudeStatuslinePayloadSchema.parse(payload);

    expect(result.custom_status_field).toEqual({ enabled: true });
    expect(result.model?.family).toBe('claude');
    expect(result.workspace?.extra_workspace_field).toBe(true);
    expect(result.context_window?.extra_context_field).toEqual({ source: 'docs' });
    expect(result.context_window?.current_usage?.extra_usage_field).toBe('preserved');
    expect(result.rate_limits?.five_hour?.warning_threshold).toBe(80);
    expect(result.rate_limits?.thirty_day).toEqual({
      used_percentage: 12,
      resets_at: 1_739_000_000,
    });
  });

  it('accepts early-session nulls and independently optional rate limit windows', () => {
    const result = ClaudeStatuslinePayloadSchema.parse({
      ...createBaseStatuslinePayload(),
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 200_000,
        used_percentage: null,
        remaining_percentage: null,
        current_usage: null,
      },
      exceeds_200k_tokens: false,
      rate_limits: {
        seven_day: {
          used_percentage: 41.2,
          resets_at: 1_738_857_600,
        },
      },
    });

    expect(result.context_window?.current_usage).toBeNull();
    expect(result.context_window?.used_percentage).toBeNull();
    expect(result.rate_limits?.five_hour).toBeUndefined();
    expect(result.rate_limits?.seven_day?.used_percentage).toBe(41.2);
  });

  it('accepts partial raw observation payloads without dropping documented fields', () => {
    const result = ClaudeStatuslinePayloadSchema.parse({
      session_id: 'session-1',
      rate_limits: {
        five_hour: {
          used_percentage: 23.5,
        },
      },
      context_window: {
        current_usage: {
          output_tokens: 1200,
        },
      },
    });

    expect(result.session_id).toBe('session-1');
    expect(result.rate_limits?.five_hour?.used_percentage).toBe(23.5);
    expect(result.context_window?.current_usage?.output_tokens).toBe(1200);
  });

  it('accepts sparse early statusline payloads without nested sections', () => {
    const result = ClaudeStatuslinePayloadSchema.parse({
      session_id: 'session-early',
      context_window: null,
    });

    expect(result.session_id).toBe('session-early');
    expect(result.model).toBeUndefined();
    expect(result.workspace).toBeUndefined();
    expect(result.output_style).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(result.context_window).toBeNull();
  });

  it('rejects malformed documented rate limit windows', () => {
    const result = ClaudeStatuslinePayloadSchema.safeParse({
      ...createBaseStatuslinePayload(),
      rate_limits: {
        five_hour: {
          used_percentage: '23.5',
          resets_at: 1_738_425_600,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
