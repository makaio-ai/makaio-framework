/**
 * Parties of a call: who sends a message (the caller) and on whose behalf it
 * runs (the principal), plus the kinds the core itself assigns.
 */

import { z } from 'zod';
import type { ContributionName } from './names.js';
import { ContributionNameSchema } from './names.js';

/**
 * Kind of a party: `<owner>.<name>`, the same shape as a contribution name.
 *
 * Kinds under `makaio.` belong to the core. The set of kinds is open: no code
 * branches over a closed list, so this is deliberately not a union.
 */
export type PartyKind = ContributionName;

/**
 * A claim value attached to a party: JSON-like data only (plain objects,
 * arrays, strings, finite numbers, booleans, `null`). Checked by {@link isCallClaim}.
 */
export type CallClaim = string | number | boolean | null | readonly CallClaim[] | { readonly [key: string]: CallClaim };

/**
 * One participant of a call.
 *
 * `claims` carry facts about the party (for example an execution id) and stay
 * on the host that checked them; they never travel in a {@link PartyRef}.
 */
export interface Party {
  /** Kind of the party. */
  readonly kind: PartyKind;
  /** Identifier of the party within its kind. */
  readonly id: string;
  /** Facts the checking host attests about the party. */
  readonly claims?: { readonly [key: string]: CallClaim };
}

/**
 * A party reduced to what may travel between hosts: kind and id, never `claims`.
 */
export interface PartyRef {
  /** Kind of the party. */
  readonly kind: PartyKind;
  /** Identifier of the party within its kind. */
  readonly id: string;
  /** Exists only so that a value typed {@link Party} (which may carry `claims`) is not assignable to a `PartyRef`. */
  readonly claims?: never;
}

/** An extension running in the process of the host; the `id` is its name. */
export const MAKAIO_EXTENSION_PARTY_KIND = 'makaio.extension';

/** Host code running in the process; the `id` is random per context. */
export const MAKAIO_HOST_PARTY_KIND = 'makaio.host';

/** A connection over the local loopback. */
export const MAKAIO_LOOPBACK_PARTY_KIND = 'makaio.loopback';

/** A CLI process on the local connection. */
export const MAKAIO_CLI_LOCAL_PARTY_KIND = 'makaio.cli-local';

/** An end-to-end test connection. */
export const MAKAIO_E2E_PEER_PARTY_KIND = 'makaio.e2e-peer';

/** A worker-thread transport without a peer. */
export const MAKAIO_WORKER_THREAD_PARTY_KIND = 'makaio.worker-thread';

/**
 * A worker running a job; the `id` stays the `executionAttemptId` and the claims stay `{ executionId }`.
 */
export const MAKAIO_JOB_RUN_PARTY_KIND = 'makaio.job-run';

/** The rule evaluation acting as caller. */
export const MAKAIO_RULES_PARTY_KIND = 'makaio.rules';

/** An unidentified party, only at a boundary the host explicitly declares open. */
export const MAKAIO_ANONYMOUS_PARTY_KIND = 'makaio.anonymous';

/** An attested external account that has no mapping to a known party. */
export const MAKAIO_WITNESSED_ACCOUNT_PARTY_KIND = 'makaio.witnessed-account';

/** A worker provider. */
export const MAKAIO_WORKER_PROVIDER_PARTY_KIND = 'makaio.worker-provider';

/** One step execution (for example an agent session) inside a job run; the principal of work a job run does for it. */
export const MAKAIO_STEP_EXECUTION_PARTY_KIND = 'makaio.step-execution';

/**
 * The party kinds the core itself contributes, keyed by a camelCase name.
 *
 * These are only the kinds the core contributes: {@link PartyKind} stays an
 * open string, and no code may branch over this object as a closed enumeration.
 */
export const CorePartyKind = {
  extension: MAKAIO_EXTENSION_PARTY_KIND,
  host: MAKAIO_HOST_PARTY_KIND,
  loopback: MAKAIO_LOOPBACK_PARTY_KIND,
  cliLocal: MAKAIO_CLI_LOCAL_PARTY_KIND,
  e2ePeer: MAKAIO_E2E_PEER_PARTY_KIND,
  workerThread: MAKAIO_WORKER_THREAD_PARTY_KIND,
  jobRun: MAKAIO_JOB_RUN_PARTY_KIND,
  rules: MAKAIO_RULES_PARTY_KIND,
  anonymous: MAKAIO_ANONYMOUS_PARTY_KIND,
  witnessedAccount: MAKAIO_WITNESSED_ACCOUNT_PARTY_KIND,
  workerProvider: MAKAIO_WORKER_PROVIDER_PARTY_KIND,
  stepExecution: MAKAIO_STEP_EXECUTION_PARTY_KIND,
} as const;

/**
 * A party kind the core itself contributes (a value of {@link CorePartyKind}).
 *
 * Every `MakaioPartyKind` is a {@link PartyKind}, not the other way round:
 * `PartyKind` stays open and no code may branch over this type as a closed enumeration.
 */
export type MakaioPartyKind = (typeof CorePartyKind)[keyof typeof CorePartyKind];

/**
 * Whether the caller sent the message from inside the process of the host.
 *
 * Only extensions and host code send in-process; every kind a transport
 * delivers (loopback, CLI, e2e, worker thread, job-run parties) is remote.
 * Relies on the receive path refusing a delivered caller of these two kinds.
 * @param call - Anything carrying the caller, typically a `CallContext`.
 * @returns `true` for the kinds `makaio.extension` and `makaio.host` only.
 */
export function isInProcessCaller(call: { readonly caller: Omit<PartyRef, 'claims'> }): boolean {
  return call.caller.kind === MAKAIO_EXTENSION_PARTY_KIND || call.caller.kind === MAKAIO_HOST_PARTY_KIND;
}

/** Traversal stack frame; the own `kind` discriminant keeps the switch independent of the prototype chain. */
type ClaimFrame =
  | { readonly kind: 'visit'; readonly value: unknown }
  | { readonly kind: 'leave'; readonly node: object };

/**
 * Whether `key` is the canonical string of an array index below `length`.
 * @param key - Own property key of an array.
 * @param length - Length of that array.
 * @returns `true` for `"0"` up to `String(length - 1)`.
 */
function isIndexKeyBelow(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Collect the child values of a plain object or array, or `undefined` when its
 * shape is not plain data (see {@link isCallClaim} for the rule).
 * @param container - Object or array to inspect.
 * @returns The own data values, or `undefined` for a rejected shape.
 */
function plainChildren(container: object): unknown[] | undefined {
  const isArray = Array.isArray(container);
  const proto: unknown = Object.getPrototypeOf(container);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    return undefined;
  }
  const keys = Reflect.ownKeys(container);
  if (isArray && keys.length !== container.length + 1) {
    return undefined;
  }
  const children: unknown[] = [];
  for (const key of keys) {
    if (typeof key === 'symbol' || key === '__proto__') {
      return undefined;
    }
    if (isArray && key !== 'length' && !isIndexKeyBelow(key, container.length)) {
      return undefined;
    }
    if (isArray && key === 'length') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      return undefined;
    }
    children.push(descriptor.value);
  }
  return children;
}

/**
 * Whether `value` is a plain-object, array and primitive tree that fits {@link CallClaim}.
 *
 * Nothing but plain data may be reachable from a claim. Every own property key
 * is inspected through its descriptor (`Reflect.ownKeys`), not only the
 * enumerable string keys:
 * - Plain objects need the prototype `Object.prototype` or `null` (a null-prototype
 *   object is plain data and accepted). Symbol keys, the key `__proto__`,
 *   accessors (`get`/`set`) and non-enumerable properties are rejected.
 * - Arrays need the prototype `Array.prototype`. Their own keys must be exactly
 *   the indexes `0..length-1` plus `length`: no holes, no extra properties, no
 *   accessors, no non-enumerable elements.
 * - Leaves are strings, booleans, `null` and finite numbers. `undefined`, functions,
 *   symbols, `bigint`, `NaN`/`Infinity`, `Date` and other class instances are rejected.
 * - Cycles are rejected; a non-cyclic reference reached twice is accepted.
 *
 * A `Proxy` is inspected through its traps like any object; the guard reads each
 * value once and does not defend against a proxy that answers differently later.
 *
 * Iterative, so deep nesting cannot overflow the stack. Each distinct object is
 * traversed once, so shared references cost linear, not exponential, time.
 * @param value - Candidate value.
 * @returns `true` when `value` is a valid {@link CallClaim}.
 */
export function isCallClaim(value: unknown): value is CallClaim {
  const ancestors = new Set<object>();
  const validated = new Set<object>();
  const stack: ClaimFrame[] = [{ kind: 'visit', value }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.kind === 'leave') {
      ancestors.delete(frame.node);
      validated.add(frame.node);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        return false;
      }
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) {
      return false;
    }
    if (validated.has(current)) {
      continue;
    }
    const children = plainChildren(current);
    if (children === undefined) {
      return false;
    }
    ancestors.add(current);
    stack.push({ kind: 'leave', node: current });
    for (const child of children) {
      stack.push({ kind: 'visit', value: child });
    }
  }
  return true;
}

/** Zod schema for a {@link CallClaim}, backed by {@link isCallClaim}. */
export const CallClaimSchema = z.custom<CallClaim>(isCallClaim);

/** Zod schema for a {@link PartyRef}; unknown keys are rejected. */
export const PartyRefSchema = z.object({ kind: ContributionNameSchema, id: z.string().min(1) }).strict();

/** Zod schema for a {@link Party}, with or without `claims`; unknown keys are rejected. */
export const PartySchema = PartyRefSchema.extend({
  claims: z.record(z.string(), CallClaimSchema).optional(),
}).strict();
