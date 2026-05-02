/**
 * Fixture CLI contribution for community-extension-e2e tests.
 *
 * Exports a minimal {@link CliContribution} with a single `greet` subcommand
 * that writes a greeting via the output writer. No bus interaction — safe to invoke
 * without a running server.
 */
import { z } from 'zod';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';

const greetSchema = z.object({
  name: z.string().meta({ description: 'Who to greet', positional: true }),
});

const contribution: CliContribution = {
  name: 'test-ext',
  description: 'A test extension',
  subcommands: [
    defineCliSubcommand('greet', 'Say hello', greetSchema, async (ctx) => {
      ctx.output.write(`Hello, ${ctx.args.name}!\n`);
    }),
  ],
};

export default contribution;
