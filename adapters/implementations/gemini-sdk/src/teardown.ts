/**
 * The class a Gemini connector teardown may claim.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';

/**
 * What a graceful Gemini close proves, and where the evidence stops.
 *
 * **`detached`.** The close asks the SDK session to abort and lets go of it, and
 * this connector propagates an abort failure rather than swallowing it — only
 * *initialisation* failures are caught, so a failing abort becomes `unknown` at
 * the layer above instead of a class this connector cannot stand behind.
 *
 * What the successful path does *not* prove is an end. The SDK owns whatever sits
 * behind the session, this runtime holds no process and no subscription of its
 * own, and inferring a provider-side end from a third party's method returning
 * would be exactly the inference the taxonomy exists to prevent.
 */
export const GEMINI_TEARDOWN_REPORT: ConnectorTeardownResult = {
  evidence: 'detached',
  detail: 'The Gemini SDK session was aborted and released; the SDK owns what sits behind it.',
};

/**
 * Abort the Gemini session once any in-flight initialization has settled.
 *
 * The order is the point: a session created while the abort was already running
 * would otherwise be left live and unowned, so the initialization is awaited
 * first. Its *failure* is deliberately ignored — a failed initialization cannot
 * own a session, but a partially created one can, and that is the case this exists
 * for.
 * @param initialization - In-flight session creation, when one is running.
 * @param abortSession - Aborts whichever session exists once initialization settled.
 */
export async function abortGeminiAfterInitialization(
  initialization: Promise<unknown> | undefined,
  abortSession: () => Promise<void> | undefined,
): Promise<void> {
  try {
    await initialization;
  } catch {
    // See the contract above: a partially created session still has to be aborted.
  }
  await abortSession();
}
