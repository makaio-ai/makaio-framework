import { z } from 'zod';
import {
  ShellExecInputSchema,
  ShellExecOutputSchema,
  ShellStatusInputSchema,
  ShellStatusOutputSchema,
  ShellOutputInputSchema,
  ShellOutputOutputSchema,
  ShellGrepInputSchema,
  ShellGrepOutputSchema,
  ShellSendInputSchema,
  ShellSendOutputSchema,
  ShellKillInputSchema,
  ShellKillOutputSchema,
} from '../types.js';

export const ShellServiceSchemas = {
  exec: {
    request: z.object({
      input: ShellExecInputSchema,
      context: z.object({
        cwd: z.string(),
        platform: z.enum(['posix', 'windows']),
        constraints: z.unknown().optional(),
      }),
    }),
    response: ShellExecOutputSchema,
  },
  status: { request: ShellStatusInputSchema, response: ShellStatusOutputSchema },
  output: { request: ShellOutputInputSchema, response: ShellOutputOutputSchema },
  grep: { request: ShellGrepInputSchema, response: ShellGrepOutputSchema },
  send: { request: ShellSendInputSchema, response: ShellSendOutputSchema },
  kill: { request: ShellKillInputSchema, response: ShellKillOutputSchema },
};
