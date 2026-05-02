import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { extensionToken, type MakaioExtension } from '@makaio/contracts';
import { ClientSessionAccountObserveSchema, ClientSubjects } from '@makaio/contracts/client';
import { BaseService } from '@makaio/service-base';
import { createSessionClientAccountObserveHandler } from './handlers.js';

/** Package name for the dedicated session client account linker. */
export const SESSION_CLIENT_ACCOUNT_LINKING_PACKAGE_NAME = 'makaio.session-client-account-linking';
/**
 * Session storage package name.
 *
 * Keep this local string instead of importing `SessionStorageToken` from
 * `framework-packages.ts`, because that file already imports this package
 * manifest when assembling the framework package list.
 */
const SESSION_STORAGE_PACKAGE_NAME = extensionToken<never>('session-storage').name;

/**
 * Dedicated service that links session-scoped client observations to canonical client accounts.
 */
export class SessionClientAccountLinkingService extends BaseService {
  /**
   * Create the linker service.
   * @param bus - Bus instance used for request handling
   */
  public constructor(bus: IMakaioBus = MakaioBus) {
    super(bus);
  }

  protected override onInit(): void {
    const handleObserve = createSessionClientAccountObserveHandler(this.bus);

    this.registerHandler(ClientSubjects.session.account.observe, async (ctx) => {
      ctx.setResult(await handleObserve(ClientSessionAccountObserveSchema.request.parse(ctx.payload)));
    });
  }
}

/**
 * Runtime package for the session-side client account linker.
 */
export const sessionClientAccountLinkingPackage: MakaioExtension = {
  name: SESSION_CLIENT_ACCOUNT_LINKING_PACKAGE_NAME,
  displayName: 'Session Client Account Linking',
  dependencies: [SESSION_STORAGE_PACKAGE_NAME, 'makaio.clients-core'],
  critical: false,
  create: (ctx) => new SessionClientAccountLinkingService(ctx.bus),
};
