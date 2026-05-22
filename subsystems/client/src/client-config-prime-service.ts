/**
 * Generic `client.config.prime` service.
 *
 * Registers the public framework-level config-prime RPC and delegates each
 * request to the corresponding client-owned `client:<id>.config.prime` subject.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { BaseService } from '@makaio/service-base';
import { primeClientConfig } from './client-config-prime.js';

/**
 * Handles the generic `client.config.prime` request subject.
 */
export class ClientConfigPrimeService extends BaseService {
  /**
   * @param bus - Bus instance used for handler registration and delegation.
   */
  public constructor(bus: IMakaioBus = MakaioBus) {
    super(bus);
  }

  /**
   * Register the generic config-prime handler.
   */
  protected override onInit(): void {
    this.registerHandler(ClientSubjects.config.prime, async (ctx) => {
      ctx.setResult(await primeClientConfig(this.bus, ctx.payload));
    });
  }
}
