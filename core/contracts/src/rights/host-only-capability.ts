import { HostOnlyRightsError } from '../access/host-only-rights.js';
import type { RightsCapability } from './capability.js';

/**
 * Rejects every use of `ctx.rights` for a composition that has no rights hub.
 * @returns Never returns.
 * @throws HostOnlyRightsError Always, naming the host-process rule.
 */
function throwHostOnlyRights(): never {
  throw new HostOnlyRightsError();
}

/**
 * Rejects every async use of `ctx.rights` for a composition that has no rights hub, the same
 * refusal as {@link throwHostOnlyRights} but as a rejected promise instead of a synchronous
 * throw: `RightsCapability.resolve` (and every other async member a refusing capability or hub
 * exposes) must reject rather than throw synchronously, so a caller that always `await`s it —
 * never wrapping the call itself in a `try` — still observes the refusal.
 * @returns A promise that always rejects.
 * @throws HostOnlyRightsError Always, naming the host-process rule (as the promise's rejection).
 */
async function rejectHostOnlyRights(): Promise<never> {
  throw new HostOnlyRightsError();
}

/**
 * Builds the one {@link RightsCapability} every extension of a rights-less
 * composition gets as `ctx.rights`: every method refuses visibly instead of
 * granting or denying, naming the host-process rule. `resolve` — the one
 * async member — rejects (see {@link rejectHostOnlyRights}); every other
 * member is synchronous and throws immediately (see {@link throwHostOnlyRights}).
 *
 * Used both by the workflow worker's own worker-local toolset context (which
 * has no extension coordinator at all) and by an extension coordinator
 * composed with its refusing rights option (the isolated workflow runtime's
 * coordinator, which runs inside that same worker process).
 * @returns The refusing capability.
 */
export function createRefusingRightsCapability(): RightsCapability {
  return {
    resolve: rejectHostOnlyRights,
    handlerContext: throwHostOnlyRights,
    sourceChanged: throwHostOnlyRights,
    declareRightsFromData: throwHostOnlyRights,
    registerRightsSource: throwHostOnlyRights,
  } satisfies RightsCapability;
}
