/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { ClaudeCodeStatuslineRawPayloadSchema } from '../index.js';
import { ClaudeCodeClientSubjects } from '../runtime/namespace.js';

describe('ClaudeCodeClientSubjects', () => {
  it('registers the raw Claude statusline event schema', () => {
    expect(ClaudeCodeClientSubjects.statusline.received.subject).toBe('statusline.received');
    expect(ClaudeCodeClientSubjects.statusline.received.$meta.namespace).toBe('client:claude-code');

    const schema = MakaioBus.getSchema(ClaudeCodeClientSubjects.statusline.received) as z.ZodType;

    expect(schema).toBe(ClaudeCodeStatuslineRawPayloadSchema);
    expect(
      schema.safeParse({
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
        },
        exceeds_200k_tokens: false,
      }).success,
    ).toBe(true);
    expect(schema.safeParse('not-an-object').success).toBe(false);
  });
});
