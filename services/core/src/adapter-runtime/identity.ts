import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from './namespace.js';
import type { ResolveIdRequest, ResolveLiveIdentityRequest, ResolveLiveIdentityResponse } from './schemas.js';

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] satisfies ReadonlyArray<number>;

const SHA256_H = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] satisfies ReadonlyArray<number>;

/**
 * Rotate an unsigned 32-bit word right by the requested number of bits.
 * @param value - Source word.
 * @param bits - Number of bits to rotate.
 * @returns Rotated unsigned 32-bit word.
 */
function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Compute a SHA-256 digest using only browser-safe primitives.
 * @param input - UTF-8 string to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6) >>> 0;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  const hash: number[] = [...SHA256_H];
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      schedule[i] = view.getUint32(offset + i * 4, false);
    }

    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotateRight(schedule[i - 15] as number, 7) ^
        rotateRight(schedule[i - 15] as number, 18) ^
        ((schedule[i - 15] as number) >>> 3);
      const s1 =
        rotateRight(schedule[i - 2] as number, 17) ^
        rotateRight(schedule[i - 2] as number, 19) ^
        ((schedule[i - 2] as number) >>> 10);
      schedule[i] = (((schedule[i - 16] as number) + s0 + (schedule[i - 7] as number) + s1) >>> 0) as number;
    }

    let [a, b, c, d, e, f, g, h] = hash;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e as number, 6) ^ rotateRight(e as number, 11) ^ rotateRight(e as number, 25);
      const choice = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const temp1 = (((h as number) + s1 + choice + SHA256_K[i] + (schedule[i] as number)) >>> 0) as number;
      const s0 = rotateRight(a as number, 2) ^ rotateRight(a as number, 13) ^ rotateRight(a as number, 22);
      const majority =
        ((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number));
      const temp2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = ((d as number) + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + (a as number)) >>> 0;
    hash[1] = (hash[1]! + (b as number)) >>> 0;
    hash[2] = (hash[2]! + (c as number)) >>> 0;
    hash[3] = (hash[3]! + (d as number)) >>> 0;
    hash[4] = (hash[4]! + (e as number)) >>> 0;
    hash[5] = (hash[5]! + (f as number)) >>> 0;
    hash[6] = (hash[6]! + (g as number)) >>> 0;
    hash[7] = (hash[7]! + (h as number)) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
}

/**
 * Build the non-lossy key for one live adapter incarnation.
 * @param identity - Exact adapter identity to encode.
 * @returns Stable composite key for the identity.
 */
function liveIdentityKey(
  identity: Pick<ResolveLiveIdentityResponse, 'adapterId' | 'adapterName' | 'machineId' | 'ownerInstanceId'>,
): string {
  return JSON.stringify([identity.adapterId, identity.adapterName, identity.machineId, identity.ownerInstanceId]);
}

/**
 * Narrow an owner-optional proof request to an exact runtime incarnation.
 * @param identity - Live-identity request to inspect.
 * @returns Whether the request names an owner instance.
 */
function hasOwnerInstanceId(identity: ResolveLiveIdentityRequest): identity is ResolveLiveIdentityResponse {
  return identity.ownerInstanceId !== undefined;
}

/**
 * Build the deterministic runtime adapter id for a machine-local adapter.
 * @param machineId - Runtime machine identifier.
 * @param adapterName - Stable adapter driver name.
 * @returns Deterministic UUID-shaped runtime adapter id.
 */
export function buildDeterministicAdapterId(machineId: string, adapterName: string): string {
  const hex = sha256Hex(JSON.stringify([machineId, adapterName]));
  return [hex.slice(0, 8), hex.slice(8, 12), `5${hex.slice(13, 16)}`, `a${hex.slice(17, 20)}`, hex.slice(20, 32)].join(
    '-',
  );
}

/**
 * Derive an adapter id request against the requested machine.
 *
 * This deliberately does not inspect local runtime state. Local callers that
 * need a dispatchable adapter must use the live-instance resolver installed by
 * {@link registerAdapterRuntimeIdentityHandlers}; explicitly foreign requests
 * remain deterministic until a targeted remote lookup is available.
 * @param request - Forward lookup payload.
 * @param currentMachineId - Runtime-default machine identifier.
 * @returns Deterministic UUID-shaped runtime adapter id.
 */
export function resolveDeterministicAdapterId(request: ResolveIdRequest, currentMachineId?: string): string {
  const resolvedMachineId = request.machineId ?? currentMachineId;
  if (!resolvedMachineId) {
    throw new Error(
      `resolveId requires machineId when no runtime default machine is configured for adapterName="${request.adapterName}"`,
    );
  }

  return buildDeterministicAdapterId(resolvedMachineId, request.adapterName);
}

/**
 * Service-lifetime adapter identity index.
 */
export class AdapterIdentityRegistry {
  private readonly adapterNamesById = new Map<string, string>();
  private readonly liveIdentities = new Map<string, ResolveLiveIdentityResponse>();
  private localAdapterIds = new Set<string>();

  /**
   * Create a new identity registry.
   * @param currentMachineId - Runtime-default machine identifier.
   */
  public constructor(private readonly currentMachineId?: string) {}

  /**
   * Replace the set of locally known adapters while preserving remote ids
   * already resolved during this service lifetime.
   * @param adapterNames - Current local adapter names.
   */
  public replaceKnownAdapterNames(adapterNames: Iterable<string>): void {
    for (const adapterId of this.localAdapterIds) {
      this.adapterNamesById.delete(adapterId);
    }
    this.localAdapterIds = new Set<string>();

    if (!this.currentMachineId) {
      return;
    }

    for (const adapterName of adapterNames) {
      const adapterId = buildDeterministicAdapterId(this.currentMachineId, adapterName);
      this.adapterNamesById.set(adapterId, adapterName);
      this.localAdapterIds.add(adapterId);
    }
  }

  /**
   * Resolve and remember an adapter id.
   * @param request - Forward lookup payload.
   * @returns Deterministic runtime adapter id.
   */
  public resolveId(request: ResolveIdRequest): string {
    const adapterId = resolveDeterministicAdapterId(request, this.currentMachineId);
    this.rememberAdapterId(adapterId, request.adapterName);
    return adapterId;
  }

  /**
   * Remember a resolved adapter id without re-deriving it.
   * @param adapterId - Runtime adapter id.
   * @param adapterName - Stable adapter driver name.
   */
  public rememberAdapterId(adapterId: string, adapterName: string): void {
    this.adapterNamesById.set(adapterId, adapterName);
  }

  /**
   * Remember an adapter identity announced by a live runtime instance.
   *
   * This is intentionally separate from {@link rememberAdapterId}: reverse
   * lookup may learn deterministic or catalog identities, but only an
   * initialization announcement proves that an opaque instance ID is currently
   * hosted by one particular machine.
   * @param identity - Exact identity reported by `adapter.initialized`.
   */
  public rememberLiveIdentity(identity: ResolveLiveIdentityResponse): void {
    this.adapterNamesById.set(identity.adapterId, identity.adapterName);
    this.liveIdentities.set(liveIdentityKey(identity), { ...identity });
  }

  /**
   * Resolve one live identity only when every supplied half matches its
   * initialization announcement.
   * @param identity - Exact identity a caller intends to dispatch to.
   * @returns The announced identity, or `undefined` when it is unknown or differs.
   */
  public resolveLiveIdentity(identity: ResolveLiveIdentityRequest): ResolveLiveIdentityResponse | undefined {
    if (hasOwnerInstanceId(identity)) {
      const announced = this.liveIdentities.get(liveIdentityKey(identity));
      return announced === undefined ? undefined : { ...announced };
    }
    const matches = [...this.liveIdentities.values()].filter(
      (announced) =>
        announced.adapterId === identity.adapterId &&
        announced.adapterName === identity.adapterName &&
        announced.machineId === identity.machineId,
    );
    return matches.length === 1 ? { ...matches[0]! } : undefined;
  }

  /**
   * Forget a withdrawn instance without disturbing a newer reuse of its ID.
   * @param identity - Exact identity withdrawn by the adapter lifecycle.
   */
  public forgetLiveIdentity(identity: ResolveLiveIdentityResponse): void {
    this.liveIdentities.delete(liveIdentityKey(identity));
  }

  /**
   * Resolve a runtime adapter id back to its known adapter name.
   * @param adapterId - Runtime adapter id.
   * @returns Adapter name when known.
   */
  public resolveAdapterName(adapterId: string): string | undefined {
    return this.adapterNamesById.get(adapterId);
  }

  /**
   * Hydrate local deterministic adapter names from the provided catalog and
   * retry the reverse lookup.
   * @param adapterId - Runtime adapter id to resolve.
   * @param listKnownAdapterNames - Canonical name supplier.
   * @returns Adapter name when known after hydration.
   */
  public async resolveAdapterNameFromKnownNames(
    adapterId: string,
    listKnownAdapterNames: () => Promise<Iterable<string>>,
  ): Promise<string | undefined> {
    const knownName = this.resolveAdapterName(adapterId);
    if (knownName) {
      return knownName;
    }

    this.replaceKnownAdapterNames(await listKnownAdapterNames());
    return this.resolveAdapterName(adapterId);
  }

  /**
   * Clear all remembered ids.
   */
  public clear(): void {
    this.adapterNamesById.clear();
    this.liveIdentities.clear();
    this.localAdapterIds.clear();
  }
}

/**
 * Registered adapter identity helpers for tests and lightweight hosts.
 */
export interface RegisteredAdapterRuntimeIdentityHandlers {
  /** Mutable identity registry backing the registered handlers. */
  readonly registry: AdapterIdentityRegistry;
  /** Cleanup function that unregisters the handlers. */
  readonly cleanup: () => void;
}

/**
 * Resolve a locally live adapter name to the instance id it is registered under.
 *
 * Returning `undefined` means no dispatchable local instance currently owns the
 * name. The port is synchronous because its authoritative source is the
 * runtime's in-memory instance registry.
 */
export type ResolveLiveAdapterId = (adapterName: string) => string | undefined;
/** Resolve one exact current identity from the runtime-owned live registry. */
export type ResolveLiveAdapterIdentity = (adapterId: string) => ResolveLiveIdentityResponse | undefined;

/** Runtime identity configuration. */
export interface AdapterRuntimeIdentityHandlerOptions {
  /** Runtime-default machine identifier. */
  readonly currentMachineId?: string;
  /** Local live-instance resolver supplied by the host runtime. */
  readonly resolveLiveAdapterId?: ResolveLiveAdapterId;
  /** Current live identity resolver; makes proofs replayable after boot and retractions immediate. */
  readonly resolveLiveAdapterIdentity?: ResolveLiveAdapterIdentity;
  /** Snapshot used to seed handlers registered after adapter startup. */
  readonly listLiveAdapterIdentities?: () => Iterable<ResolveLiveIdentityResponse>;
  /** Static local names for lightweight host compatibility. */
  readonly knownAdapterNames?: Iterable<string>;
  /** Lazy local-name enumeration for reverse lookup compatibility. */
  readonly listKnownAdapterNames?: () => Promise<Iterable<string>>;
}

/**
 * Register cache maintenance for replayed adapter lifecycle events.
 * @param bus - Bus carrying adapter lifecycle events.
 * @param registry - Identity cache updated by those events.
 * @returns Cleanup callbacks for both subscriptions.
 */
function registerIdentityLifecycleHandlers(bus: IMakaioBus, registry: AdapterIdentityRegistry): Array<() => void> {
  return [
    bus.on(AdapterSubjects.initialized, (ctx) => {
      registry.rememberLiveIdentity({
        adapterId: ctx.payload.adapterId,
        adapterName: ctx.payload.adapterName,
        machineId: ctx.payload.machineId,
        ownerInstanceId: ctx.payload.ownerInstanceId,
      });
    }),
    bus.on(AdapterSubjects.deinitialized, (ctx) => {
      registry.forgetLiveIdentity({
        adapterId: ctx.payload.adapterId,
        adapterName: ctx.payload.adapterName,
        machineId: ctx.payload.machineId,
        ownerInstanceId: ctx.payload.ownerInstanceId,
      });
    }),
  ];
}

/**
 * Resolve an exact owner from the process-local authoritative registry.
 * @param options - Runtime-local authoritative resolvers.
 * @param request - Exact live-identity request.
 * @returns The locally hosted identity, when this process owns the target.
 */
function resolveLocalLiveIdentity(
  options: AdapterRuntimeIdentityHandlerOptions,
  request: ResolveLiveIdentityRequest,
): ResolveLiveIdentityResponse | undefined {
  if (request.machineId !== options.currentMachineId || !hasOwnerInstanceId(request)) return undefined;
  return options.resolveLiveAdapterIdentity?.(request.adapterId);
}

/**
 * Check whether a candidate names the owner explicitly requested by the caller.
 * @param identity - Candidate live identity.
 * @param request - Identity proof requested by the caller.
 * @returns Whether the candidate satisfies the requested owner.
 */
function matchesRequestedOwner(
  identity: ResolveLiveIdentityResponse | undefined,
  request: ResolveLiveIdentityRequest,
): boolean {
  return (
    identity !== undefined &&
    (request.ownerInstanceId === undefined || identity.ownerInstanceId === request.ownerInstanceId)
  );
}

/**
 * Check every stable half of a live-identity proof.
 * @param identity - Candidate live identity.
 * @param request - Identity proof requested by the caller.
 * @returns Whether every requested identity field matches.
 */
function matchesLiveIdentityRequest(
  identity: ResolveLiveIdentityResponse | undefined,
  request: ResolveLiveIdentityRequest,
): identity is ResolveLiveIdentityResponse {
  return (
    matchesRequestedOwner(identity, request) &&
    identity?.adapterName === request.adapterName &&
    identity.machineId === request.machineId
  );
}

/**
 * Register the distributed live-identity proof handler.
 * @param bus - Bus carrying proof requests.
 * @param registry - Lifecycle-backed identity registry.
 * @param options - Runtime-local authoritative resolvers.
 * @returns Cleanup callback for the handler.
 */
function registerLiveIdentityHandler(
  bus: IMakaioBus,
  registry: AdapterIdentityRegistry,
  options: AdapterRuntimeIdentityHandlerOptions,
): () => void {
  return bus.on(AdapterRuntimeSubjects.resolveLiveIdentity, async (ctx) => {
    const localRequest = ctx.payload.machineId === options.currentMachineId;
    const locallyResolved = resolveLocalLiveIdentity(options, ctx.payload);
    if (
      locallyResolved !== undefined &&
      ctx.payload.ownerInstanceId !== undefined &&
      locallyResolved.ownerInstanceId !== ctx.payload.ownerInstanceId
    ) {
      await ctx.next();
      if (ctx.result !== undefined) return;
    }

    const announced = registry.resolveLiveIdentity(ctx.payload);
    const localOwnerIsLive =
      !localRequest ||
      ctx.payload.ownerInstanceId !== undefined ||
      options.resolveLiveAdapterIdentity === undefined ||
      options.resolveLiveAdapterIdentity(ctx.payload.adapterId) !== undefined;
    const identity = localOwnerIsLive ? (locallyResolved ?? announced) : undefined;
    // Machine identity does not identify the runtime process that owns an adapter.
    // Any miss must delegate so a sibling runtime can provide its authoritative live identity.
    if (!matchesRequestedOwner(identity, ctx.payload)) {
      await ctx.next();
      if (ctx.result !== undefined) return;
    }
    if (!matchesLiveIdentityRequest(identity, ctx.payload)) {
      throw new Error(
        `No live adapter matches adapterId="${ctx.payload.adapterId}", adapterName="${ctx.payload.adapterName}", machineId="${ctx.payload.machineId}"`,
      );
    }
    ctx.setResult(identity);
  });
}

/**
 * Register runtime adapter identity handlers.
 * @param bus - Bus instance used for registration.
 * @param options - Runtime identity configuration.
 * @returns Registry instance and cleanup function.
 */
export function registerAdapterRuntimeIdentityHandlers(
  bus: IMakaioBus,
  options: AdapterRuntimeIdentityHandlerOptions = {},
): RegisteredAdapterRuntimeIdentityHandlers {
  const registry = new AdapterIdentityRegistry(options.currentMachineId);
  if (options.knownAdapterNames) {
    registry.replaceKnownAdapterNames(options.knownAdapterNames);
  }
  for (const identity of options.listLiveAdapterIdentities?.() ?? []) registry.rememberLiveIdentity(identity);

  const cleanups = [
    ...registerIdentityLifecycleHandlers(bus, registry),
    bus.on(AdapterRuntimeSubjects.resolveId, async (ctx) => {
      const localRequest = ctx.payload.machineId === undefined || ctx.payload.machineId === options.currentMachineId;
      if (localRequest && options.currentMachineId !== undefined && options.resolveLiveAdapterId !== undefined) {
        const adapterId = options.resolveLiveAdapterId(ctx.payload.adapterName);
        if (!adapterId) {
          await ctx.next();
          if (ctx.result !== undefined) return;
          throw new Error(`No live local adapter is registered for adapterName="${ctx.payload.adapterName}"`);
        }
        registry.rememberAdapterId(adapterId, ctx.payload.adapterName);
        ctx.setResult({ adapterId });
        return;
      }
      ctx.setResult({ adapterId: registry.resolveId(ctx.payload) });
    }),
    bus.on(AdapterRuntimeSubjects.getMachineId, (ctx) => {
      ctx.setResult({ machineId: options.currentMachineId });
    }),
    bus.on(AdapterRuntimeSubjects.resolveName, async (ctx) => {
      const adapterName =
        registry.resolveAdapterName(ctx.payload.adapterId) ??
        (options.listKnownAdapterNames
          ? await registry.resolveAdapterNameFromKnownNames(ctx.payload.adapterId, options.listKnownAdapterNames)
          : undefined);
      if (!adapterName) {
        throw new Error(`Adapter not found for adapterId="${ctx.payload.adapterId}"`);
      }
      ctx.setResult({ adapterName });
    }),
    registerLiveIdentityHandler(bus, registry, options),
  ];

  return {
    registry,
    cleanup: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}
