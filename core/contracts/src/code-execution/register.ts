import type { MakaioBusLike } from '@makaio/core';
import { CapabilitySubjects } from '../capability/index.js';
import { CODE_EXECUTION_CAPABILITY_ID, type ICodeExecutionProvider } from './types.js';

export { CODE_EXECUTION_CAPABILITY_ID } from './types.js';

/**
 * Routing for both registration emissions: this process, and no transport.
 *
 * `capability.register` is an ordinary subject, so an unqualified emit is
 * relayed to every connected transport peer. That is wrong for a *live* object:
 * the payload's prototype methods — `execute` among them — do not survive
 * serialization, so a peer would receive a registration it can never invoke,
 * while the fields that do survive include everything the provider was composed
 * with. On the Piscina provider those are its configured environment values and
 * the redaction set derived from them, which the provider exists to keep off the
 * bus. Registration of a live object is process-local composition; making the
 * routing say so is the only thing that holds that invariant here.
 *
 * The invariant belongs on the subject, not on each registration helper — every
 * helper that registers a live object has the same problem. `capability.register`
 * cannot simply be declared `localSubject()`, though: the same subject also
 * carries plain, fully serializable provider descriptors that one process
 * registers with a service in another, and that traffic is legitimate. Moving
 * the invariant up therefore means giving the subject a `local-only` transport
 * default and making those cross-process registrants name their transport
 * explicitly — a change to the capability contract and its remote registrants,
 * not to this file.
 */
const LOCAL_COMPOSITION_ONLY = { transports: [] } as const;

/**
 * Register a CodeExecution provider with the capability registry.
 *
 * Registration is local runtime composition: the provider is handed to the
 * registry as a live object reference, is never serialized, and — see
 * {@link LOCAL_COMPOSITION_ONLY} — never reaches a transport.
 * @param bus - Makaio bus instance.
 * @param provider - Provider instance to register.
 * @returns Promise that resolves after registration handlers have completed.
 */
export function registerCodeExecutionProvider(bus: MakaioBusLike, provider: ICodeExecutionProvider): Promise<void> {
  return bus.emit(
    CapabilitySubjects.register,
    {
      capabilityId: CODE_EXECUTION_CAPABILITY_ID,
      provider,
    },
    LOCAL_COMPOSITION_ONLY,
  );
}

/**
 * Unregister a CodeExecution provider from the capability registry.
 *
 * Routed local-only for the same reason the registration is: the bucket this
 * removes from only ever held a locally composed provider, so a peer has
 * nothing to remove and the two emissions must not disagree about scope.
 * @param bus - Makaio bus instance.
 * @param providerId - Provider identifier to remove.
 * @returns Promise that resolves after unregistration handlers have completed.
 */
export function unregisterCodeExecutionProvider(bus: MakaioBusLike, providerId: string): Promise<void> {
  return bus.emit(
    CapabilitySubjects.unregister,
    {
      capabilityId: CODE_EXECUTION_CAPABILITY_ID,
      providerId,
    },
    LOCAL_COMPOSITION_ONLY,
  );
}
