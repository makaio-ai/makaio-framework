import { z } from 'zod';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { handleClaudeStatusline, type ClaudeStatuslineArgs } from './handler.js';

export const claudeStatuslineSchema = z.object({
  upstreamCommand: z.string().optional().meta({
    description: 'Optional executable to run after ingesting stdin',
    short: '-u',
    placeholder: '<command>',
  }),
  upstreamArgsJson: z.string().optional().meta({
    description: 'Optional JSON array of upstream command arguments',
    placeholder: '<json>',
  }),
}) satisfies z.ZodType<ClaudeStatuslineArgs>;

export const claudeCodeStatuslineCli: CliContribution = {
  name: 'claude',
  description: 'Claude Code command helpers',
  subcommands: [
    defineCliSubcommand(
      'statusline',
      'Ingest raw Claude statusline JSON and optionally proxy an upstream renderer',
      claudeStatuslineSchema,
      handleClaudeStatusline,
    ),
  ],
};
