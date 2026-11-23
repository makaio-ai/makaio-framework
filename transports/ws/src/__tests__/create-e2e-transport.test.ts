import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace, MAKAIO_E2E_PEER_PARTY_KIND, type CallContext } from '@makaio/core';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { E2EAuth } from '../auth/e2e-auth.js';
import { createE2ETransport } from '../create-e2e-transport.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import { encryptMessage } from '../e2e-message-crypto.js';
import type { WebSocketClientTransport } from '../ws-client-transport.js';
import { MockWebSocket } from './test-helpers.js';

it('ignores a client attestation role on an authenticated E2E connection', async () => {
  const websocket = new MockWebSocket();
  const [clientKeys, peerKeys] = await Promise.all([generateSigningKeyPair(), generateSigningKeyPair()]);
  const caller = { kind: MAKAIO_E2E_PEER_PARTY_KIND, id: 'peer' };
  const e2eAuth = new E2EAuth({
    identityId: 'client',
    peerId: caller.id,
    signingKeyPair: clientKeys,
    getPeerSigningKey: async () => peerKeys.publicKey,
  });
  const peerAuth = new E2EAuth({
    identityId: caller.id,
    signingKeyPair: peerKeys,
    getPeerSigningKey: async () => clientKeys.publicKey,
  });
  vi.spyOn(websocket, 'send').mockImplementation((data) => {
    if (typeof data === 'string') {
      peerAuth.handleAuthMessage(JSON.parse(data), websocket);
    }
  });

  const clientOptions: ConstructorParameters<typeof WebSocketClientTransport>[0] = {
    url: 'ws://unused',
    attestingRole: 'core-uplink',
  };
  const transport = createE2ETransport({ ...clientOptions, websocket, e2eAuth });
  const bus = createBusInstance({ transports: [transport] });
  const { subjects } = bus.registerNamespace(createBusNamespace('e2eTest', { received: z.object({}) }));
  const received = Promise.withResolvers<CallContext>();
  bus.on(subjects.received, (ctx) => received.resolve(ctx.call));

  try {
    await Promise.all([
      peerAuth.authenticateServer(websocket, (frame) => websocket.receiveMessage(JSON.stringify(frame))),
      bus.connect(),
    ]);
    const sessionKey = peerAuth.getSessionKey(websocket);
    if (!sessionKey) throw new Error('Peer did not establish an E2E session');

    const frame = await encryptMessage(
      {
        type: 'event',
        namespace: 'e2eTest',
        subject: 'received',
        messageId: 'e2e-event',
        payload: {},
        metadata: { principal: { kind: 'makaio.host', id: 'other-host' } },
      },
      sessionKey,
    );
    websocket.receiveMessage(JSON.stringify(frame));

    const call = await received.promise;
    expect(call.caller).toEqual(caller);
    expect(call.principal).toEqual(call.caller);
    expect(call.attestedBy).toBeUndefined();
  } finally {
    peerAuth.cleanupSocket(websocket);
    await bus.disconnect();
  }
});
