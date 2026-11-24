import { NO_BOUNDARY_ACCESS_CHECK, type BoundaryAccessCheck, type IMakaioBus } from '@makaio/bus-core';
import type { BusServerConfig, StartBusServerOptions } from '@makaio/bus-server';
import type { ServerTransport } from '@makaio/bus-transport-websocket';
import { expect, expectTypeOf, it } from 'vitest';
import type { ServerTransportProvider } from '../boot-types.js';

/**
 * Compile-only checks for the required boundary access decision.
 * @param provider - Provider using the previous positional connection signature.
 */
function requireBoundaryPolicy(provider: {
  connect(bus: IMakaioBus, machineId: string): Promise<void>;
  disconnect(): Promise<void>;
}): void {
  // @ts-expect-error the old server provider cannot accept the host's boundary access policy
  const serverProvider: ServerTransportProvider = provider;
  // @ts-expect-error bus server creation requires a boundary access decision
  const serverConfig: Pick<BusServerConfig, 'checkBoundaryAccess'> = {};
  // @ts-expect-error bus server startup requires a boundary access decision
  const startupConfig: Pick<StartBusServerOptions, 'checkBoundaryAccess'> = {};
  // @ts-expect-error WebSocket server transports require a boundary access decision
  const transportConfig: Pick<ConstructorParameters<typeof ServerTransport>[0], 'checkBoundaryAccess'> = {};
  void [serverProvider, serverConfig, startupConfig, transportConfig];
}

it('loads the compile-only boundary access assertions', () => {
  expect(typeof requireBoundaryPolicy).toBe('function');
  expectTypeOf<Parameters<ServerTransportProvider['connect']>[1]['checkBoundaryAccess']>().toEqualTypeOf<
    BoundaryAccessCheck | typeof NO_BOUNDARY_ACCESS_CHECK
  >();
});
