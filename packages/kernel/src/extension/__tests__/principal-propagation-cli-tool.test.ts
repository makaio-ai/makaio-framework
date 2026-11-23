import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects, type Party } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { ToolRegistry } from '@makaio/services-core/tools';
import { createTestCall } from '@makaio/test-utils';
import { defineTool, defineToolset, toolSuccess } from '@makaio/tools-core';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { CliRpcSubjects } from '../../bus/cli/namespace.js';
import { defineCliSubcommand, requireBus } from '../../cli/types.js';
import { ExtensionCoordinator } from '../extension-coordinator.js';

const ProbeNamespace = createBusNamespace('test:cli-tool-principal', {
  reached: z.object({ hop: z.enum(['cli-gate', 'tool-body']) }),
});
const empty = z.object({});
const toolRequest = { toolName: 'principal-probe', input: {} };

it('preserves each request principal from CLI and tool execution to downstream sends', async () => {
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus);
  const registry = new ToolRegistry({ bus });
  onTestFinished(() => coordinator.shutdown());
  onTestFinished(() => registry.dispose());

  const { reached } = bus.registerNamespace(ProbeNamespace).subjects;
  const observed: Array<[hop: string, principal: Party]> = [];
  bus.on(reached, (ctx) => {
    observed.push([ctx.payload.hop, ctx.call.principal]);
  });
  bus.on(ToolSubjects.started, (ctx) => {
    observed.push(['tool-started', ctx.call.principal]);
  });
  bus.on(ToolSubjects.completed, (ctx) => {
    observed.push(['tool-completed', ctx.call.principal]);
  });

  await registry.register(
    defineToolset({
      name: 'principal-probe-tools',
      description: 'Principal propagation test tools',
      version: '1.0.0',
      tools: [
        defineTool({
          name: toolRequest.toolName,
          description: 'Report the principal seen by the tool',
          inputSchema: empty,
          outputSchema: empty,
          execute: async (_input, ctx) => {
            if (!ctx.bus) throw new Error('ToolRegistry did not provide a bus to the tool');
            await ctx.bus.emit(ctx.call, reached, { hop: 'tool-body' });
            return toolSuccess({});
          },
        }),
      ],
    }),
  );
  coordinator.load([
    {
      name: 'principal-probe-cli',
      displayName: 'Principal probe CLI',
      version: '1.0.0',
      cli: {
        name: 'principal-probe',
        description: 'Exercise tool execution from a CLI command',
        beforeRun: async (ctx) => {
          await requireBus(ctx).emit(ctx.call, reached, { hop: 'cli-gate' });
          return { proceed: true };
        },
        subcommands: [
          defineCliSubcommand('run', 'Execute the principal probe', empty, async (ctx) => {
            const result = await requireBus(ctx).request(ctx.call, ToolSubjects.execute, toolRequest);
            ctx.output.write(result.success ? 'ok' : result.error.message);
          }),
        ],
      },
    },
  ]);

  const cliCall = createTestCall({ principal: { kind: 'test.user', id: 'cli-user' } });
  const toolCall = createTestCall({ principal: { kind: 'test.user', id: 'tool-user' } });
  const cliResult = await bus.request(cliCall, CliRpcSubjects.execute, {
    command: 'principal-probe',
    subcommand: 'run',
  });
  const toolResult = await bus.request(toolCall, ToolSubjects.execute, toolRequest);

  expect(cliResult).toEqual({ exitCode: 0, stdout: ['ok'], stderr: [] });
  expect(toolResult).toEqual(toolSuccess({}));
  expect(observed).toEqual([
    ['cli-gate', cliCall.principal],
    ['tool-started', cliCall.principal],
    ['tool-body', cliCall.principal],
    ['tool-completed', cliCall.principal],
    ['tool-started', toolCall.principal],
    ['tool-body', toolCall.principal],
    ['tool-completed', toolCall.principal],
  ]);
});
