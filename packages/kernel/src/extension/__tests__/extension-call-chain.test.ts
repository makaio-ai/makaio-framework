import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace, type CallContext } from '@makaio/core';
import { createTestCall } from '@makaio/test-utils';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { CliRpcSubjects } from '../../bus/cli/namespace.js';
import { ExtensionCoordinator } from '../extension-coordinator.js';

const extensionA = { kind: 'makaio.extension', id: 'chain-a' } as const;
const extensionB = { kind: 'makaio.extension', id: 'chain-b' } as const;
const inspect = { command: extensionB.id, subcommand: 'inspect' };
const relayNamespace = createBusNamespace('test:extension-call-chain', {
  relay: {
    request: z.object({}),
    response: z.object({ exitCode: z.number(), stdout: z.array(z.string()), stderr: z.array(z.string()) }),
  },
});

/** Start a pair of extensions and record calls observed by B's actual CLI callback. */
async function startChain() {
  const host = createBusInstance();
  const { subjects } = host.registerNamespace(relayNamespace);
  const coordinator = new ExtensionCoordinator(host, {
    extensionContextBase: {
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'call-chain-test',
      tryImport: async () => null,
    },
  });
  onTestFinished(() => coordinator.shutdown());
  const received: CallContext[] = [];
  let sender: IMakaioBus | undefined;
  coordinator.load([
    {
      name: extensionA.id,
      displayName: 'Chain A',
      version: '0.1.0',
      create: ({ bus }) => {
        sender = bus;
        const unsubscribe = bus.on(subjects.relay, async (ctx) => {
          await Promise.resolve();
          ctx.setResult(await bus.request(ctx.call, CliRpcSubjects.execute, inspect));
        });
        return { init: () => Promise.resolve(), destroy: unsubscribe };
      },
    },
    {
      name: extensionB.id,
      displayName: 'Chain B',
      version: '0.1.0',
      cli: {
        name: extensionB.id,
        description: 'Inspect the received call',
        subcommands: [
          {
            name: inspect.subcommand,
            description: 'Record the caller and principal',
            schema: z.object({}),
            handler: async ({ call }) => {
              received.push(call);
            },
          },
        ],
      },
    },
  ]);
  await coordinator.startAll();
  if (!sender) throw new Error('Extension A did not start');
  return { host, sender, relay: subjects.relay, received };
}

describe('extension call chain', () => {
  it('delivers an A-to-B call through the coordinator with A as the caller', async () => {
    const { sender, received } = await startChain();
    const call = createTestCall({ caller: extensionA, principal: { kind: 'makaio.host', id: 'direct-principal' } });

    const result = await sender.request(call, CliRpcSubjects.execute, inspect);

    expect(result).toEqual({ exitCode: 0, stdout: [], stderr: [] });
    expect(received).toEqual([{ caller: extensionA, principal: call.principal }]);
  });

  it('forwards the principal of the message handled by A after an await', async () => {
    const { host, relay, received } = await startChain();
    const call = createTestCall({
      caller: { kind: 'makaio.host', id: 'relay-caller' },
      principal: { kind: 'makaio.host', id: 'relay-principal' },
    });

    const result = await host.request(call, relay, {});

    expect(result).toEqual({ exitCode: 0, stdout: [], stderr: [] });
    expect(received).toEqual([{ caller: extensionA, principal: call.principal }]);
  });

  it.each(['schedule', 'start'] as const)('delivers own(%s) as a host carrier origin, not as A', async (purpose) => {
    const { host, received } = await startChain();
    const origin = host.own(purpose);

    const result = await host.request(origin, CliRpcSubjects.execute, inspect);

    expect(result).toEqual({ exitCode: 0, stdout: [], stderr: [] });
    expect(origin.caller).not.toEqual(extensionA);
    expect(received).toEqual([{ caller: origin.caller, principal: origin.caller }]);
  });
});
