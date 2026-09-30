/**
 * Relay codec debug-log sink routing tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createE2ERelayCodec } from '../e2e-relay-client-transport.js';
import { buildRelayControlTestRegistry, createRelayControlTestHelpers } from './relay-control-test-registry.js';
import { createPreSessionRelayAuth } from './test-helpers.js';

const testRegistry = buildRelayControlTestRegistry();
const { createRelayControlEnvelope } = createRelayControlTestHelpers(testRegistry);

const DEBUG_LINE = '[E2ERelayTransport] Decoded relay control envelope: event relay error';

/**
 * Decode one relay control envelope, which makes the codec emit a debug line.
 * @param codec - Codec under test
 */
async function decodeControlEnvelope(codec: ReturnType<typeof createE2ERelayCodec>['codec']): Promise<void> {
  await codec.decode(
    createRelayControlEnvelope({
      type: 'event',
      subject: 'error',
      namespace: 'relay',
      payload: { code: 'connection_error', message: 'oops', timestamp: Date.now() },
      messageId: 'relay-ctrl-debug',
    }),
  );
}

describe('createE2ERelayCodec — debug log sink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes the debug line to the provided sink instead of console.info', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const sink = vi.fn();
    const e2eAuth = await createPreSessionRelayAuth('codec-debug-sink');
    const { codec } = createE2ERelayCodec(e2eAuth, testRegistry, true, sink);

    await decodeControlEnvelope(codec);

    expect(sink).toHaveBeenCalledWith(DEBUG_LINE);
    expect(infoSpy).not.toHaveBeenCalledWith(DEBUG_LINE);
  });

  it('falls back to console.info when debug is enabled without a sink', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const e2eAuth = await createPreSessionRelayAuth('codec-debug-default');
    const { codec } = createE2ERelayCodec(e2eAuth, testRegistry, true);

    await decodeControlEnvelope(codec);

    expect(infoSpy).toHaveBeenCalledWith(DEBUG_LINE);
  });

  it('never calls the sink when debug is disabled', async () => {
    const sink = vi.fn();
    const e2eAuth = await createPreSessionRelayAuth('codec-debug-off');
    const { codec } = createE2ERelayCodec(e2eAuth, testRegistry, false, sink);

    await decodeControlEnvelope(codec);

    expect(sink).not.toHaveBeenCalled();
  });
});
