import assert from 'node:assert/strict';
import { expect, it, vi } from 'vitest';
import type { BusEventMessage, BusReceiveHandler } from '@makaio/bus-core';
import { MAKAIO_E2E_PEER_PARTY_KIND } from '@makaio/core';
import { createE2ERelayCodec } from '../e2e-relay-client-transport.js';
import { createRelayControlRegistry } from '../relay-control-registry.js';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createRelayAuthPairRaw, MockWebSocket } from './test-helpers.js';

it('omits attestation from encrypted peer receive contexts even when the client has an attesting role', async () => {
  const machineId = 'test-machine';
  const { initiator, responder, sendToResponder } = await createRelayAuthPairRaw({ machineId });
  const socket = new MockWebSocket();
  vi.spyOn(socket, 'send').mockImplementation((data) => {
    if (typeof data === 'string') sendToResponder(JSON.parse(data));
  });

  const registry = createRelayControlRegistry();
  registry.freeze();
  const transport = new WebSocketClientTransport({
    url: 'ws://unused',
    createWebSocket: () => socket,
    auth: initiator,
    codec: createE2ERelayCodec(initiator, registry).codec,
    attestingRole: 'core-uplink',
    autoReconnect: false,
    heartbeat: false,
  });
  const received = vi.fn<BusReceiveHandler>();
  transport.onReceive(received);

  try {
    await responder.authenticateClient((frame) => socket.receiveMessage(JSON.stringify(frame)));
    await transport.connect();

    const event: BusEventMessage = {
      type: 'event',
      namespace: 'test',
      subject: 'received',
      messageId: 'encrypted-event',
      payload: {},
    };
    const { codec: peerCodec } = createE2ERelayCodec(responder, registry);
    const frame = await peerCodec.encode(event);
    assert(typeof frame === 'string');
    socket.receiveMessage(frame);

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received).toHaveBeenCalledWith(event, {
      transportName: transport.name,
      authenticated: true,
      encrypted: true,
      caller: { kind: MAKAIO_E2E_PEER_PARTY_KIND, id: machineId },
    });
  } finally {
    responder.cleanup();
    await transport.disconnect();
  }
});
