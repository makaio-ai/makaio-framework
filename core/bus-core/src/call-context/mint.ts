import type { CallClaim, CallContext, OwnWorkPurpose, Party, PartyRef } from '@makaio/core';
import { isCallClaim, PartyRefSchema, PartySchema } from '@makaio/core';
import { BusError } from '../errors/bus-error.js';
import { OWN_WORK_PURPOSES } from './own-work.js';

/**
 * Input for {@link mintCallContext}: the three parties of a call.
 *
 * A plain description, not a `CallContext`: only minting turns it into one.
 */
export interface CallContextInput {
  /** The party that sends the message. */
  readonly caller: Party;
  /** The party the work is done for. */
  readonly principal: Party;
  /** The party that vouches for the claim, when someone does. */
  readonly attestedBy?: Party;
}

/** Options of {@link mintCallContext}. */
export interface MintCallContextOptions {
  /** Carrier (kind and id) a bus instance records for the own context it hands out via `bus.own`. */
  readonly carrier?: PartyRef;
  /** The shared bus context that owns the carrier's call. */
  readonly context?: object;
  /** Why the carrier acts on its own; valid only together with `carrier`. */
  readonly purpose?: OwnWorkPurpose;
}

/**
 * Thrown when the input of {@link mintCallContext} is rejected, or when a
 * value that must be a minted call context is not one.
 *
 * The message names the place of the problem (a path such as `caller.claims`),
 * never the offending value.
 */
export class InvalidCallContextError extends BusError {}

/** Every context the core has minted. Module-level: there is exactly one registry per module instance. */
const mintedContexts = new WeakSet<object>();

/** Owner of each own context. A retained call does not keep its bus context alive. */
const ownCarriers = new WeakMap<object, { carrier: PartyRef; context?: WeakRef<object> }>();

/** Purpose of each own context that was minted with one. */
const ownPurposes = new WeakMap<object, OwnWorkPurpose>();

/**
 * Whether the core minted `value`.
 *
 * A literal, a spread or a cast of a `CallContext` is never registered, so this
 * is the proof of authenticity; the static type only restricts the honest path.
 * @param value - Anything.
 * @returns `true` for a context returned by {@link mintCallContext}.
 */
export function isMintedCallContext(value: unknown): value is CallContext {
  return typeof value === 'object' && value !== null && mintedContexts.has(value);
}

/**
 * The carrier recorded for an own context (`bus.own`).
 * @param call - A call context.
 * @returns Kind and id of the carrier, or `undefined` for a context that is not an own context.
 */
export function ownCarrierOf(call: CallContext): PartyRef | undefined {
  return ownCarriers.get(call)?.carrier;
}

/**
 * The bus context recorded for an own context.
 * @param call - A call context.
 * @returns The originating bus context, if recorded and still alive.
 */
export function ownBusContextOf(call: CallContext): object | undefined {
  return ownCarriers.get(call)?.context?.deref();
}

/**
 * The purpose recorded for an own context (`bus.own(purpose)`).
 * @param call - A call context.
 * @returns The purpose, or `undefined` for a context that is not an own context or was minted without a purpose.
 */
export function ownPurposeOf(call: CallContext): OwnWorkPurpose | undefined {
  return ownPurposes.get(call);
}

/**
 * Read the own data properties of a plain object without invoking any code.
 * @param value - Candidate object.
 * @param path - Place of the candidate, for the error message.
 * @param allowed - The only keys the object may have.
 * @returns The own values by key.
 * @throws InvalidCallContextError For a non-plain object, an unknown key, a symbol key or an accessor.
 */
function readPlainRecord(value: unknown, path: string, allowed: readonly string[]): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidCallContextError(`Invalid call context: ${path} must be a plain object`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new InvalidCallContextError(`Invalid call context: ${path} must be a plain object`);
  }
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol' || !allowed.includes(key)) {
      throw new InvalidCallContextError(`Invalid call context: ${path} has an unknown key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new InvalidCallContextError(`Invalid call context: ${path}.${key} must be a data property`);
    }
    values.set(key, descriptor.value);
  }
  return values;
}

/**
 * Freeze `root` and everything reachable from it. Iterative, so deep nesting cannot overflow the stack.
 * @param root - A tree of plain objects and arrays built by this module.
 * @returns `root`, frozen.
 */
function deepFreeze<T extends object>(root: T): T {
  const pending: object[] = [root];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const key of Reflect.ownKeys(item)) {
      const child: unknown = Reflect.get(item, key);
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
  return root;
}

/**
 * Detached copy of the claims of a party.
 *
 * The copy is taken only after {@link isCallClaim} accepted the original and is
 * checked again afterwards; `structuredClone` also refuses a `Proxy`.
 * @param claims - Claims of the input party.
 * @param path - Place of the claims, for the error message.
 * @returns A copy that shares nothing with `claims`.
 * @throws InvalidCallContextError When the claims are not plain JSON-like data.
 */
function copyClaims(claims: unknown, path: string): { readonly [key: string]: CallClaim } {
  const invalid = new InvalidCallContextError(`Invalid call context: ${path} must be plain JSON-like data`);
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims) || !isCallClaim(claims)) {
    throw invalid;
  }
  let copy: unknown;
  try {
    copy = structuredClone(claims);
  } catch {
    throw invalid;
  }
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy) || !isCallClaim(copy)) {
    throw invalid;
  }
  return Object.fromEntries(Object.entries(copy));
}

/**
 * Detached, validated copy of a party.
 * @param value - The party of the input.
 * @param path - Place of the party, for the error message.
 * @returns A new party sharing nothing with `value`.
 * @throws InvalidCallContextError When the party is rejected.
 */
function copyParty(value: unknown, path: string): Party {
  const fields = readPlainRecord(value, path, ['kind', 'id', 'claims']);
  const claims = fields.has('claims') ? copyClaims(fields.get('claims'), `${path}.claims`) : undefined;
  const candidate = { kind: fields.get('kind'), id: fields.get('id'), ...(claims === undefined ? {} : { claims }) };
  const parsed = PartySchema.safeParse(candidate);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.');
    throw new InvalidCallContextError(`Invalid call context: ${path}${where ? `.${where}` : ''} is not a valid party`);
  }
  return {
    kind: parsed.data.kind,
    id: parsed.data.id,
    ...(claims === undefined ? {} : { claims }),
  };
}

/**
 * Detached, validated copy of a carrier reference.
 * @param value - The carrier of the options.
 * @returns A new reference of kind and id only.
 * @throws InvalidCallContextError When the carrier is rejected.
 */
function copyCarrier(value: unknown): PartyRef {
  const fields = readPlainRecord(value, 'carrier', ['kind', 'id']);
  const parsed = PartyRefSchema.safeParse({ kind: fields.get('kind'), id: fields.get('id') });
  if (!parsed.success) {
    throw new InvalidCallContextError('Invalid call context: carrier is not a valid party reference');
  }
  return { kind: parsed.data.kind, id: parsed.data.id };
}

/**
 * Validated purpose of the options.
 * @param value - The purpose of the options, possibly untyped.
 * @returns The purpose.
 * @throws InvalidCallContextError When the value is not one of the `OwnWorkPurpose` values.
 */
function checkPurpose(value: unknown): OwnWorkPurpose {
  const purpose = OWN_WORK_PURPOSES.find((candidate) => candidate === value);
  if (purpose === undefined) {
    throw new InvalidCallContextError('Invalid call context: purpose is not a valid own work purpose');
  }
  return purpose;
}

/**
 * Mint a call context: validate the input, copy it, freeze the copy deeply and register it.
 *
 * The only place that creates a `CallContext`. The input is never changed and
 * nothing of it stays reachable from the result. Claims must be plain
 * JSON-like data (see {@link isCallClaim}); accessors, cycles, class instances
 * and unknown keys are rejected.
 * @param input - Caller, principal and optional attestation.
 * @param options - The own work carrier, its bus context and the optional purpose.
 * @returns The registered, deeply frozen context.
 * @throws InvalidCallContextError When the input, the carrier or the purpose is rejected, or a purpose comes without a carrier.
 */
export function mintCallContext(input: CallContextInput, options?: MintCallContextOptions): CallContext {
  const fields = readPlainRecord(input, 'input', ['caller', 'principal', 'attestedBy']);
  const caller = copyParty(fields.get('caller'), 'caller');
  const principal = copyParty(fields.get('principal'), 'principal');
  const attestedBy = fields.has('attestedBy') ? copyParty(fields.get('attestedBy'), 'attestedBy') : undefined;
  const carrier = options?.carrier === undefined ? undefined : copyCarrier(options.carrier);
  const purpose = options?.purpose === undefined ? undefined : checkPurpose(options.purpose);
  if (purpose !== undefined && carrier === undefined) {
    throw new InvalidCallContextError('Invalid call context: purpose needs a carrier');
  }

  const call = deepFreeze({ caller, principal, ...(attestedBy === undefined ? {} : { attestedBy }) }) as CallContext;
  mintedContexts.add(call);
  if (carrier !== undefined) {
    const context = options?.context;
    ownCarriers.set(call, { carrier: deepFreeze(carrier), context: context && new WeakRef(context) });
  }
  if (purpose !== undefined) ownPurposes.set(call, purpose);
  return call;
}
