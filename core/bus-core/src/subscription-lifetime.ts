import type { PartyRef } from '@makaio/core';
import type { BusDebugLog } from './utils/debug-log.js';

const lifetimes = new WeakMap<PartyRef, AbortSignal>();
const diagnosedCarriers = new WeakMap<AbortSignal, Set<string>>();

/** Disposer for a registration that was never installed. */
export const ignoredSubscription = (): void => {};

/**
 * Bind a lifetime to a carrier instance while preserving its party identity.
 * Derivative views keep the same instance, and independent buses may reuse the same party.
 * @param party - Identity of the bus carrier.
 * @param signal - Optional lifetime of its subscriptions.
 * @returns Carrier used by the bus and all its derived registrations.
 */
export function bindSubscriptionLifetime(party: PartyRef, signal?: AbortSignal): PartyRef {
  if (!signal) return party;
  const carrier = Object.freeze({ ...party });
  lifetimes.set(carrier, signal);
  return carrier;
}

/**
 * Resolve cancellation before installing a registration. Log a late attempt once per carrier.
 * @param carrier - Carrier registering the handler.
 * @param subject - Subject of the attempted registration, or a wildcard for bus-wide observers.
 * @param debugLog - Failure-safe bus diagnostic sink.
 * @param signal - Optional cancellation for a single subscription.
 * @returns The cancellation signal, or false if the carrier already ended.
 */
export function subscriptionSignal(
  carrier: PartyRef,
  subject: string,
  debugLog: BusDebugLog,
  signal?: AbortSignal,
): AbortSignal | undefined | false {
  const lifetime = lifetimes.get(carrier);
  if (!lifetime) return signal;
  if (!lifetime.aborted) return signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  const key = JSON.stringify([carrier.kind, carrier.id]);
  const diagnosed = diagnosedCarriers.get(lifetime) ?? new Set<string>();
  if (!diagnosed.has(key)) {
    diagnosed.add(key);
    diagnosedCarriers.set(lifetime, diagnosed);
    debugLog(
      `[MakaioBus] Carrier '${carrier.kind}:${carrier.id}', subject '${subject}': registration after carrier teardown ignored`,
    );
  }
  return false;
}

/**
 * Register a carrier callback in a set without sharing its identity with other carriers.
 * @param carrier - Carrier registering the callback.
 * @param callbacks - Callback registry.
 * @param callback - Callback to register.
 * @param debugLog - Failure-safe bus diagnostic sink.
 * @typeParam Args - Callback parameters.
 * @typeParam Result - Callback result.
 * @returns Unsubscription for this registration.
 */
export function subscribeCarrierCallback<Args extends unknown[], Result>(
  carrier: PartyRef,
  callbacks: Set<(...args: Args) => Result>,
  callback: (...args: Args) => Result,
  debugLog: BusDebugLog,
): () => void {
  const signal = subscriptionSignal(carrier, '*', debugLog);
  if (signal === false) return ignoredSubscription;
  const member = signal ? callback.bind(undefined) : callback;
  callbacks.add(member);
  return trackSubscription(() => callbacks.delete(member), signal);
}

/**
 * Unsubscribe at carrier teardown, or forget the registration on manual unsubscribe.
 * @param cleanup - Original unsubscription, including any propagation metadata.
 * @param signal - Lifetime of the carrier's registrations.
 * @returns The carrier-owned unsubscription.
 */
export function trackSubscription(cleanup: () => void, signal?: AbortSignal): () => void {
  if (!signal) return cleanup;
  // Registration can reenter and end the carrier while propagating a subscription.
  if (signal.aborted) {
    cleanup();
    return ignoredSubscription;
  }
  let subscribed = true;
  const unsubscribe = Object.assign(() => {
    if (!subscribed) return;
    subscribed = false;
    signal.removeEventListener('abort', unsubscribe);
    cleanup();
  }, cleanup);
  signal.addEventListener('abort', unsubscribe, { once: true });
  return unsubscribe;
}
