/**
 * Call contexts for tests.
 *
 * Tests need a `CallContext` to pass as the first parameter of every send. The
 * type cannot be built from a literal, so this helper mints one through the
 * kernel entry of `bus-core`, the same way the bus does. The result is a genuine,
 * registered and frozen context that the bus accepts.
 */
import { mintCallContext } from '@makaio/bus-core/kernel-api';
import type { CallContext, Party } from '@makaio/contracts';

/** Parties of a test call; every field is optional. */
export interface TestCallOptions {
  /** The sending party. Defaults to `{ kind: 'makaio.host', id: 'test' }`. */
  readonly caller?: Party;
  /** The party the work is done for. Defaults to the caller. */
  readonly principal?: Party;
  /** The party that vouches for the claim. Absent unless given. */
  readonly attestedBy?: Party;
}

/** Default caller of a test call: the host, named `test`. */
const DEFAULT_TEST_CALLER: Party = { kind: 'makaio.host', id: 'test' };

/**
 * Mint a call context for a test.
 *
 * The context is minted by the core (`mintCallContext`), so it is registered and
 * deeply frozen and the bus accepts it. It carries no carrier: a carrier's own
 * context comes from `bus.own(purpose)`, never from here.
 * @param options - Parties of the call; `caller` defaults to the host party `test`, `principal` to the caller.
 * @returns A minted call context.
 */
export function createTestCall(options: TestCallOptions = {}): CallContext {
  const caller = options.caller ?? DEFAULT_TEST_CALLER;
  const principal = options.principal ?? caller;
  return mintCallContext({
    caller,
    principal,
    ...(options.attestedBy === undefined ? {} : { attestedBy: options.attestedBy }),
  });
}
