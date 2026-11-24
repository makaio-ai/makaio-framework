/**
 * Host-side wake dispatcher: local after-commit delivery and database-signal
 * subscription over one database handle.
 *
 * One dispatcher is kept per database handle, shared by every `HostDatabase`
 * facade built over it (`createHostDatabase` may be called more than once for
 * the same handle). The dispatcher is the single place local commit delivery
 * and the handle's {@link DatabaseSignals} capability both feed into: a topic
 * marked and committed in this process is delivered the same way a remote
 * `DatabaseSignal` for that topic is. Subscribing to the underlying capability
 * is lazy (only once something is actually listening) and torn down again once
 * nothing is.
 * @packageDocumentation
 */

import type { HostDatabase } from '@makaio/contracts';
import type { DatabaseSignal, DatabaseSignals } from './database-signals';
import { getDatabaseSignals } from './database-signals';
import type { MakaioDatabase } from './types';

/** A wake subscriber: notified that something happened, carrying no payload. */
export type WakeListener = () => void | Promise<void>;

/**
 * A generic set of registration entries, one per `add` call: adding the same
 * item twice yields two independent entries, and the remove function each
 * `add` returns removes exactly that entry, idempotently. The shared
 * registration primitive behind both the host dispatcher's topic/resync
 * registrations below and a capability's own direct subscribers (e.g.
 * Postgres's `subscribe`), so neither reimplements "same function registered
 * twice stays two registrations" over a plain `Set`, which would collapse
 * them into one by value equality.
 * @typeParam L - Type of one registered item.
 */
export interface RegistrationSet<L> {
  /**
   * Register `item` as its own new entry.
   * @param item - Item to register.
   * @returns Remove function for exactly this entry. Idempotent.
   */
  add(item: L): () => void;
  /**
   * @returns Every currently registered item, in registration order. A fresh
   *   array, safe to iterate while the caller unsubscribes or registers more.
   */
  snapshot(): L[];
  /** Remove every currently registered entry. */
  clear(): void;
  /** Number of currently registered entries. */
  readonly size: number;
}

/**
 * Create an empty {@link RegistrationSet}.
 * @typeParam L - Type of one registered item.
 * @returns A new, empty registration set.
 */
export function createRegistrationSet<L>(): RegistrationSet<L> {
  const entries = new Set<{ item: L }>();
  return {
    add(item: L): () => void {
      const entry = { item };
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    snapshot: () => [...entries].map((entry) => entry.item),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

/**
 * One `subscribe`/`onResync` call, modeled as its own registration entry so
 * registering the same listener function twice yields two independent
 * registrations, and unsubscribing one removes exactly that entry.
 */
interface WakeRegistration {
  /** Whether this entry delivers a topic or a `resynced` event. */
  readonly kind: 'topic' | 'resync';
  /** The topic this entry was registered for; `undefined` for a `'resync'` entry. */
  readonly topic: string | undefined;
  /** Listener to invoke on delivery. */
  readonly listener: WakeListener;
}

/**
 * Per-handle dispatch state: every registered topic and resync entry in one
 * generic registry, plus the handle's own subscription to its
 * {@link DatabaseSignals} capability.
 */
interface WakeDispatcher {
  /** Every currently registered entry, topic and resync alike, in one registration set. */
  readonly registrations: RegistrationSet<WakeRegistration>;
  /** Unsubscribe from the capability, set while at least one registration exists. */
  capabilitySubscription: (() => void) | undefined;
  /**
   * Set once by {@link releaseHostDatabaseWake}. A closed dispatcher accepts no
   * further registrations and keeps none: closing is permanent for the handle.
   */
  closed: boolean;
}

/** Log prefix matching the storage package's logging convention. */
const LOG_PREFIX = '[makaio:storage-drizzle]';

/**
 * Invoke every listener of a snapshot of `listeners` with `event`, each
 * isolated from the others and from the caller: a synchronous throw or an
 * eventual promise rejection is caught and logged once, never re-thrown and
 * never awaited. The one delivery primitive used for both topic and resync
 * delivery here, and reused wherever else a database client delivers signals
 * directly to subscribers.
 * @param listeners - Listeners to invoke. Snapshotted before any is invoked, so a
 *   listener unsubscribing (or a new one registering) during delivery never
 *   affects the round in progress.
 * @param event - Event payload passed to every listener.
 * @param context - Short description of what triggered delivery, for the log line.
 * @typeParam E - Event payload type delivered to each listener.
 */
export function invokeListenersSafely<E>(
  listeners: Iterable<(event: E) => void | Promise<void>>,
  event: E,
  context: string,
): void {
  for (const listener of [...listeners]) {
    try {
      const outcome = listener(event);
      if (outcome instanceof Promise) {
        outcome.catch((error: unknown) => {
          console.error(`${LOG_PREFIX} a wake listener (${context}) rejected; other listeners still ran.`, error);
        });
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} a wake listener (${context}) threw; other listeners still ran.`, error);
    }
  }
}

/**
 * Collect the listeners of every registration matching `predicate`.
 * @param dispatcher - Dispatcher to read registrations from.
 * @param predicate - Matches the registrations to collect.
 * @returns Listeners of every matching registration, in registration order.
 */
function listenersMatching(
  dispatcher: WakeDispatcher,
  predicate: (registration: WakeRegistration) => boolean,
): WakeListener[] {
  const matched: WakeListener[] = [];
  for (const registration of dispatcher.registrations.snapshot()) {
    if (predicate(registration)) matched.push(registration.listener);
  }
  return matched;
}

/**
 * Deliver a set of topics to every listener currently registered for each,
 * without waiting for any of them.
 * @param dispatcher - Dispatcher to deliver through.
 * @param topics - Topics to deliver; a topic with no registered listener is a no-op.
 */
function deliverTopics(dispatcher: WakeDispatcher, topics: Iterable<string>): void {
  for (const topic of topics) {
    const listeners = listenersMatching(
      dispatcher,
      (registration) => registration.kind === 'topic' && registration.topic === topic,
    );
    if (listeners.length === 0) continue;
    invokeListenersSafely(listeners, undefined, `topic '${topic}'`);
  }
}

/**
 * Deliver a `resynced` event to every registered resync listener, without
 * waiting for any of them.
 * @param dispatcher - Dispatcher to deliver through.
 */
function deliverResync(dispatcher: WakeDispatcher): void {
  const listeners = listenersMatching(dispatcher, (registration) => registration.kind === 'resync');
  if (listeners.length === 0) return;
  invokeListenersSafely(listeners, undefined, 'resynced');
}

/**
 * Route one signal received from the handle's capability into the dispatcher
 * it belongs to.
 * @param dispatcher - Dispatcher the capability is subscribed on behalf of.
 * @param event - Signal delivered by the capability.
 */
function handleCapabilitySignal(dispatcher: WakeDispatcher, event: DatabaseSignal): void {
  if (event.kind === 'topic') {
    deliverTopics(dispatcher, [event.topic]);
  } else {
    deliverResync(dispatcher);
  }
}

/**
 * Subscribe the dispatcher to the handle's capability, if not already
 * subscribed. A no-op for a `'none'` capability or when already subscribed.
 * @param dispatcher - Dispatcher to subscribe on behalf of.
 * @param signals - Signal capability of the handle the dispatcher belongs to.
 */
function ensureCapabilitySubscription(dispatcher: WakeDispatcher, signals: DatabaseSignals): void {
  if (dispatcher.capabilitySubscription !== undefined || signals.kind !== 'database-notify') return;
  dispatcher.capabilitySubscription = signals.subscribe((event) => {
    handleCapabilitySignal(dispatcher, event);
  });
}

/**
 * Unsubscribe the dispatcher from the handle's capability once no
 * registration is left.
 * @param dispatcher - Dispatcher to release the capability subscription of.
 */
function releaseCapabilitySubscriptionIfIdle(dispatcher: WakeDispatcher): void {
  if (dispatcher.registrations.size > 0 || dispatcher.capabilitySubscription === undefined) return;
  const unsubscribe = dispatcher.capabilitySubscription;
  dispatcher.capabilitySubscription = undefined;
  unsubscribe();
}

/** One dispatcher per database handle, shared by every facade built over it. */
const dispatchers = new WeakMap<object, WakeDispatcher>();

/** The database handle each `HostDatabase` facade was created over. */
const hostHandles = new WeakMap<HostDatabase, MakaioDatabase>();

/**
 * Resolve (creating on first use) the wake dispatcher of a database handle.
 * @param db - Database handle to resolve the dispatcher for.
 * @returns That handle's dispatcher.
 */
function getDispatcher(db: object): WakeDispatcher {
  let dispatcher = dispatchers.get(db);
  if (dispatcher === undefined) {
    dispatcher = { registrations: createRegistrationSet(), capabilitySubscription: undefined, closed: false };
    dispatchers.set(db, dispatcher);
  }
  return dispatcher;
}

/**
 * Register which database handle a `HostDatabase` facade was created over.
 *
 * Called once by `createHostDatabase` for every facade it mints, so that
 * {@link getHostDatabaseWake} can resolve the shared per-handle dispatcher
 * from the facade alone.
 * @param host - Facade returned by `createHostDatabase`.
 * @param db - Database handle the facade was created over.
 */
export function registerHostDatabaseHandle(host: HostDatabase, db: MakaioDatabase): void {
  hostHandles.set(host, db);
}

/**
 * Deliver topics committed by a local transaction to this process's own
 * listeners, without waiting for any of them.
 *
 * Called only after the transaction that marked `topics` has committed
 * successfully. A handle nobody ever subscribed to (no dispatcher created
 * yet) is a no-op: there is nothing to delay dispatcher creation for.
 * @param db - Database handle the committed transaction ran on.
 * @param topics - Topics marked and committed by that transaction.
 */
export function deliverLocalWakeTopics(db: MakaioDatabase, topics: ReadonlySet<string>): void {
  if (topics.size === 0) return;
  const dispatcher = dispatchers.get(db);
  if (dispatcher === undefined) return;
  deliverTopics(dispatcher, topics);
}

/**
 * Signal capability of a handle, reduced to the description a subscriber
 * needs: whether cross-process delivery is available, and if not, why.
 */
export interface HostDatabaseWakeCapability {
  /** Matches {@link DatabaseSignals}'s own discriminant. */
  readonly kind: DatabaseSignals['kind'];
  /** Present only when `kind` is `'none'`; matches that branch's `reason`. */
  readonly reason?: Extract<DatabaseSignals, { kind: 'none' }>['reason'];
}

/** Host-side subscription surface of one database handle's wake dispatcher. */
export interface HostDatabaseWake {
  /** The handle's signal capability, reduced to its description. */
  readonly signals: HostDatabaseWakeCapability;
  /**
   * Subscribe to a topic: notified once for every local commit that marked it
   * and for every remote signal of it, for as long as the handle's capability
   * can deliver those. Subscribing to the first topic or resync listener of
   * the handle subscribes the dispatcher to the handle's capability; the
   * returned unsubscribe function reverses that once nothing is registered
   * any more.
   * @param topic - Topic to subscribe to.
   * @param listener - Invoked once per delivery. Its outcome is never awaited by the caller.
   * @returns Unsubscribe function. Idempotent.
   */
  subscribe(topic: string, listener: WakeListener): () => void;
  /**
   * Subscribe to `resynced` events: the handle's capability's connection to
   * the cross-process signal was (re-)established after having been down.
   * @param listener - Invoked once per `resynced` event. Its outcome is never awaited by the caller.
   * @returns Unsubscribe function. Idempotent.
   */
  onResync(listener: WakeListener): () => void;
  /**
   * Resolve once the handle's capability is ready to deliver signals:
   * immediately for `'none'`, once the capability itself reports readiness
   * for `'database-notify'`. Register listeners before awaiting this so a
   * signal delivered right after readiness is never missed.
   * @returns Promise that resolves once the capability is ready.
   */
  ready(): Promise<void>;
}

/**
 * Register one entry on a dispatcher, subscribing the dispatcher to the
 * handle's capability if this is its first registration. The one generic
 * registration path for both `subscribe` and `onResync`: each call adds its
 * own {@link WakeRegistration} entry through {@link RegistrationSet.add}, so
 * calling it twice with the same listener function yields two independent
 * entries.
 * @param dispatcher - Dispatcher to register on.
 * @param signals - Signal capability of the handle the dispatcher belongs to.
 * @param registration - Registration entry to add.
 * @returns Unsubscribe function. Idempotent.
 * @throws Error when the dispatcher was already released by {@link releaseHostDatabaseWake}.
 */
function registerListener(
  dispatcher: WakeDispatcher,
  signals: DatabaseSignals,
  registration: WakeRegistration,
): () => void {
  if (dispatcher.closed) {
    throw new Error(
      `${LOG_PREFIX} cannot subscribe: the database handle's wake dispatcher is closed (its client's close() already ran).`,
    );
  }
  const remove = dispatcher.registrations.add(registration);
  ensureCapabilitySubscription(dispatcher, signals);
  return () => {
    remove();
    releaseCapabilitySubscriptionIfIdle(dispatcher);
  };
}

/**
 * Resolve the host-side wake subscription surface of a `HostDatabase` facade.
 * @param host - Facade returned by `createHostDatabase`.
 * @returns The subscription surface of the facade's underlying handle.
 * @throws Error when `host` was not created by `createHostDatabase`.
 */
export function getHostDatabaseWake(host: HostDatabase): HostDatabaseWake {
  const db = hostHandles.get(host);
  if (db === undefined) {
    throw new Error(
      'getHostDatabaseWake: the facade was not created by createHostDatabase, so it carries no wake ' +
        'dispatcher binding.',
    );
  }
  const signals = getDatabaseSignals(db);
  const dispatcher = getDispatcher(db);
  const capability: HostDatabaseWakeCapability =
    signals.kind === 'none' ? { kind: signals.kind, reason: signals.reason } : { kind: signals.kind };

  return {
    signals: capability,
    subscribe: (topic, listener) => registerListener(dispatcher, signals, { kind: 'topic', topic, listener }),
    onResync: (listener) => registerListener(dispatcher, signals, { kind: 'resync', topic: undefined, listener }),
    ready: () => (signals.kind === 'database-notify' ? signals.ready() : Promise.resolve()),
  };
}

/**
 * Release a database handle's wake dispatcher: drop every registered topic
 * and resync registration, unsubscribe from the handle's capability if
 * subscribed, and make every later `subscribe`/`onResync` call on any facade
 * of this handle throw instead of silently registering a listener nobody will
 * ever release again.
 *
 * Idempotent, and safe to call before any dispatcher was ever created for
 * `db` (a handle nobody subscribed to yet): the handle is marked released
 * either way, so a facade minted afterwards still throws. Called once by
 * every client's `close()`, before the driver connection itself closes.
 * @param db - Database handle whose dispatcher to release.
 */
export function releaseHostDatabaseWake(db: object): void {
  const dispatcher = getDispatcher(db);
  if (dispatcher.closed) return;
  dispatcher.closed = true;
  dispatcher.registrations.clear();
  const unsubscribe = dispatcher.capabilitySubscription;
  dispatcher.capabilitySubscription = undefined;
  unsubscribe?.();
}
