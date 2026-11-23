/**
 * Consumer programs for the installed-package proof of the call context declarations.
 *
 * Each program is TypeScript text that a suite writes into an isolated consumer and
 * compiles against the installed declarations (`strict`, `moduleResolution: Bundler`).
 * Every line the call context design must reject carries `@ts-expect-error`, so a
 * program compiles without diagnostics exactly when the declarations accept what an
 * author may write and reject what an author may not: an unused directive (a forgery
 * that suddenly compiles) is itself an error (TS2578).
 *
 * Import rule of every program: a kernel name (minting) comes only from
 * `@makaio/framework/bus/kernel-api`; reading names (`isMintedCallContext`) come from
 * `@makaio/framework/bus`.
 *
 * The programs only declare values and never run; declaration-only consumers need
 * `@types/node` and `@types/react` next to the installed packages when
 * `skipLibCheck` is `false`.
 */

/**
 * Program A: an extension author using the bus, the core and the contracts together.
 *
 * Rejects: a literal, a spread copy and a spread with a replaced principal as
 * `CallContext`; writes to `caller.id`, to `claims` and to nested `claims`; a literal
 * as the first argument; `own('x')` (no purpose) and `getContext()`; in both send forms
 * a payload of the wrong type, an event subject on `request`, a request subject on
 * `emit`, a channel subject and a wildcard subject on the bus; swapped arguments
 * (`request(subject, minted, payload)`, `request(payload, subject)`).
 * Accepts: both send forms on `request`, `requestOptional`, `emit`, `scoped`,
 * `withFilter`, `Namespace.scopedBus`, `IDirectChannel` and `MakaioBusLike`: the call
 * form `op(call, subject, payload, options?)` with `context.call` (handler),
 * `ctx.bus.own('start')`, `MakaioBus.own('root')` or a minted value, and the own form
 * `op(subject, payload, options?)` without any call; a context minted through the kernel
 * entry assigned to the own-context type of the contracts, to
 * `BaseMessageContext['call']` and to the handler `call` of `MakaioBus.on`;
 * `IReviewSource.fetchSnapshot` and `TransitionActionHandler.execute` take `CallContext`
 * first.
 */
export const AUTHOR_PROGRAM_A = String.raw`
import { z } from 'zod';
import type { ExtensionContext, IReviewSource, TransitionActionHandler } from '@makaio/contracts';
import type { BaseMessageContext, CallClaim, CallContext, MakaioBusLike } from '@makaio/framework/core';
import { channelSubject, createBusNamespace } from '@makaio/framework/core';
import { isMintedCallContext, MakaioBus } from '@makaio/framework/bus';
import type { IDirectChannel } from '@makaio/framework/bus';
import { mintCallContext } from '@makaio/framework/bus/kernel-api';

const demo = MakaioBus.registerNamespace(
  createBusNamespace('call-context-demo', {
    note: z.object({ text: z.string() }),
    ping: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
    stream: channelSubject(z.object({ text: z.string() })),
  }),
);

const party = { kind: 'makaio.host', id: 'consumer' };
const other = { kind: 'makaio.host', id: 'other' };
const minted: CallContext = mintCallContext({ caller: party, principal: party });
declare const ctx: ExtensionContext;
declare const channel: IDirectChannel;
declare const like: MakaioBusLike;
declare const unknownValue: unknown;

// Forged contexts: only the minting entry builds a CallContext.
// @ts-expect-error a literal lacks the stamp
export const forgedLiteral: CallContext = { caller: party, principal: party };
// @ts-expect-error a spread copy lacks the stamp
export const forgedSpread: CallContext = { ...minted };
// @ts-expect-error a spread with a replaced principal lacks the stamp
export const forgedPrincipal: CallContext = { ...minted, principal: other };

// A minted value is accepted wherever the design names a call context.
export const asOwnContext: ReturnType<ExtensionContext['bus']['own']> = minted;
export const asMessageCall: BaseMessageContext['call'] = minted;
export const startContext: CallContext = ctx.bus.own('start');
export const rootContext: CallContext = MakaioBus.own('root');

// A context is read-only, including its parties and nested claims.
type Claims = NonNullable<CallContext['caller']['claims']>;
type ClaimObject = Exclude<Extract<CallClaim, object>, readonly unknown[]>;
declare const claims: Claims;
declare const nestedClaims: ClaimObject;
export function writes(call: CallContext): void {
  // @ts-expect-error caller.id is readonly
  call.caller.id = 'changed';
  // @ts-expect-error claims are readonly
  claims.x = 1;
  // @ts-expect-error nested claims are readonly
  nestedClaims.y = 1;
}

// Sending: every send has two forms. The call form names the call context of a handled message
// first and forwards its principal; the own form leaves it out and the carrier sends for itself.
export async function sends(): Promise<void> {
  const scoped = MakaioBus.scoped(demo);
  const scopedByNamespace = await demo.scopedBus(MakaioBus);
  const filtered = MakaioBus.withFilter({ text: 'x' });
  const own = ctx.bus.own('start');

  MakaioBus.on(demo.subjects.note, async (context) => {
    const asHandlerCall: typeof context.call = minted;
    await MakaioBus.request(context.call, demo.subjects.ping, { id: asHandlerCall.caller.id });
    await MakaioBus.emit(context.call, demo.subjects.note, { text: 'x' });
    await scoped.emit(context.call, demo.subjects.note, { text: 'x' });
    await scopedByNamespace.request(context.call, demo.subjects.ping, { id: 'a' });
    await filtered.emit(context.call, demo.subjects.note, { text: 'x' });
    await channel.emit(context.call, demo.subjects.note, { text: 'x' });
  });

  // Call form outside a handler: a root context, an own context or a minted value.
  await MakaioBus.request(MakaioBus.own('root'), demo.subjects.ping, { id: 'a' });
  await ctx.bus.emit(own, demo.subjects.note, { text: 'x' });
  await like.request(minted, demo.subjects.ping, { id: 'a' });
  await like.emit(minted, demo.subjects.note, { text: 'x' });
  await channel.emit(minted, demo.subjects.note, { text: 'x' });
  await channel.request(minted, demo.subjects.ping, { id: 'a' });
  await channel.requestOptional(minted, demo.subjects.ping, { id: 'a' });
  await MakaioBus.requestOptional(minted, demo.subjects.ping, { id: 'a' });
  await MakaioBus.request(minted, demo.subjects.ping, { id: 'a' }, { timeout: 1000 });
  await MakaioBus.emit(minted, demo.subjects.note, { text: 'x' }, { transports: [] });
  await scoped.request(minted, demo.subjects.ping, { id: 'a' });
  await scoped.requestOptional(minted, demo.subjects.ping, { id: 'a' });
  await scopedByNamespace.emit(minted, demo.subjects.note, { text: 'x' });

  // Own form: no call context, the carrier sends for itself.
  await MakaioBus.request(demo.subjects.ping, { id: 'a' });
  await MakaioBus.requestOptional(demo.subjects.ping, { id: 'a' });
  await MakaioBus.emit(demo.subjects.note, { text: 'x' });
  await MakaioBus.request(demo.subjects.ping, { id: 'a' }, { timeout: 1000 });
  await MakaioBus.emit(demo.subjects.note, { text: 'x' }, { transports: [] });
  await ctx.bus.emit(demo.subjects.note, { text: 'x' });
  await ctx.bus.request(demo.subjects.ping, { id: 'a' });
  await like.request(demo.subjects.ping, { id: 'a' });
  await like.emit(demo.subjects.note, { text: 'x' });
  await scoped.emit(demo.subjects.note, { text: 'x' });
  await scoped.request(demo.subjects.ping, { id: 'a' });
  await scoped.requestOptional(demo.subjects.ping, { id: 'a' });
  await scopedByNamespace.request(demo.subjects.ping, { id: 'a' });
  await scopedByNamespace.emit(demo.subjects.note, { text: 'x' });
  await filtered.emit(demo.subjects.note, { text: 'x' });
  await channel.emit(demo.subjects.note, { text: 'x' });
  await channel.request(demo.subjects.ping, { id: 'a' });
  await channel.requestOptional(demo.subjects.ping, { id: 'a' });

  // A channel subject travels on a channel only, in both forms.
  await channel.emit(minted, demo.subjects.stream, { text: 'x' });
  await channel.emit(demo.subjects.stream, { text: 'x' });
  // @ts-expect-error a channel subject is rejected on the bus (call form)
  await MakaioBus.emit(minted, demo.subjects.stream, { text: 'x' });
  // @ts-expect-error a channel subject is rejected on the bus (own form)
  await MakaioBus.emit(demo.subjects.stream, { text: 'x' });

  // Subject kind and payload are checked in both forms.
  // @ts-expect-error a payload of the wrong type (call form)
  await MakaioBus.request(minted, demo.subjects.ping, { id: 1 });
  // @ts-expect-error a payload of the wrong type (own form)
  await MakaioBus.request(demo.subjects.ping, { id: 1 });
  // @ts-expect-error an event payload of the wrong type (own form)
  await MakaioBus.emit(demo.subjects.note, { text: 1 });
  // @ts-expect-error an event subject is no request (call form)
  await MakaioBus.request(minted, demo.subjects.note, { text: 'x' });
  // @ts-expect-error an event subject is no request (own form)
  await MakaioBus.request(demo.subjects.note, { text: 'x' });
  // @ts-expect-error a request subject is no event (call form)
  await MakaioBus.emit(minted, demo.subjects.ping, { id: 'a' });
  // @ts-expect-error a request subject is no event (own form)
  await MakaioBus.emit(demo.subjects.ping, { id: 'a' });
  // @ts-expect-error a wildcard subject cannot be emitted (call form)
  await MakaioBus.emit(minted, demo.subjects.$all, {});
  // @ts-expect-error a wildcard subject cannot be emitted (own form)
  await MakaioBus.emit(demo.subjects.$all, {});

  // Swapped arguments are rejected in either position.
  // @ts-expect-error the call belongs before the subject
  await MakaioBus.request(demo.subjects.ping, minted, { id: 'a' });
  // @ts-expect-error the subject belongs before the payload
  await MakaioBus.request({ id: 'a' }, demo.subjects.ping);
  // @ts-expect-error a literal is not a call context
  await MakaioBus.request({ caller: party, principal: party }, demo.subjects.ping, { id: 'a' });
  // @ts-expect-error an own context needs a purpose of the closed list
  MakaioBus.own('x');
  // @ts-expect-error the host context is no longer reachable
  MakaioBus.getContext();
}

// Reading: the runtime check narrows to the same declaration.
export function narrowed(): CallContext | undefined {
  return isMintedCallContext(unknownValue) ? unknownValue : undefined;
}

// Contract surfaces that send downstream take the call first.
type FetchSnapshot = NonNullable<IReviewSource['fetchSnapshot']>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const fetchSnapshotTakesCall: Same<Parameters<FetchSnapshot>[0], CallContext> = true;
export const executeTakesCall: Same<Parameters<TransitionActionHandler['execute']>[0], CallContext> = true;
`;

/**
 * Program B: an author that uses only the core and the contracts (no bus entry).
 *
 * Rejects: a literal, a spread copy and a spread with a replaced principal as
 * `CallContext`; writes to `caller.id`, to `claims` and to nested `claims`.
 * Accepts: a `CallContext` value of the core assigned to the own-context type of the
 * contracts and to `BaseMessageContext['call']`, and back (one declaration of
 * `CallContext` on both sides); `MakaioBusLike.request` in call form
 * (`request(call, subject, payload)`) and in own form (`request(subject, payload)`).
 * Rejects there: a literal as the first argument and swapped arguments.
 */
export const AUTHOR_PROGRAM_B = String.raw`
import type { ExtensionContext } from '@makaio/contracts';
import type { BaseMessageContext, CallClaim, CallContext, MakaioBusLike } from '@makaio/framework/core';

const party = { kind: 'makaio.host', id: 'consumer' };
declare const call: CallContext;
declare const own: ReturnType<ExtensionContext['bus']['own']>;
declare const like: MakaioBusLike;
// Parameters<> of an overloaded member reads the LAST overload, which is the own form
// (subject, payload): index 0 is the subject, index 1 the payload.
declare const requestSubject: Parameters<MakaioBusLike['request']>[0];
declare const requestPayload: Parameters<MakaioBusLike['request']>[1];

// @ts-expect-error a literal lacks the stamp
export const forgedLiteral: CallContext = { caller: party, principal: party };
// @ts-expect-error a spread copy lacks the stamp
export const forgedSpread: CallContext = { ...call };
// @ts-expect-error a spread with a replaced principal lacks the stamp
export const forgedPrincipal: CallContext = { ...call, principal: { kind: 'makaio.host', id: 'other' } };

type OwnContext = ReturnType<ExtensionContext['bus']['own']>;
export const coreToContracts: OwnContext = call;
export const contractsToCore: CallContext = own;
export const asMessageCall: BaseMessageContext['call'] = call;

export async function sends(): Promise<void> {
  await like.request(call, requestSubject, requestPayload);
  await like.request(requestSubject, requestPayload);
  // @ts-expect-error a literal is not a call context
  await like.request({ caller: party, principal: party }, requestSubject, requestPayload);
  // @ts-expect-error the call belongs before the subject
  await like.request(requestSubject, call, requestPayload);
}

type Claims = NonNullable<CallContext['caller']['claims']>;
type ClaimObject = Exclude<Extract<CallClaim, object>, readonly unknown[]>;
declare const claims: Claims;
declare const nestedClaims: ClaimObject;
export function writes(): void {
  // @ts-expect-error caller.id is readonly
  call.caller.id = 'changed';
  // @ts-expect-error claims are readonly
  claims.x = 1;
  // @ts-expect-error nested claims are readonly
  nestedClaims.y = 1;
}
`;

/**
 * Program C: an author that imports only the bus entry (plus the kernel entry to mint and
 * `createBusNamespace` to declare a request subject).
 *
 * The call context type is reached through the bus (`ReturnType<typeof MakaioBus.own>`),
 * without any import from the core.
 * Rejects: a literal and a spread copy as that type; a literal as the first argument of
 * `request`; `own('x')`; `getContext()`.
 * Accepts: a minted value as that type, `request` in call form
 * (`request(call, subject, payload)`, with `MakaioBus.own('root')` or a minted value) and
 * in own form (`request(subject, payload)`), and `isMintedCallContext` narrowing to the
 * same type.
 */
export const BUS_PROGRAM_C = String.raw`
import { z } from 'zod';
import { createBusNamespace } from '@makaio/framework/core';
import { isMintedCallContext, MakaioBus } from '@makaio/framework/bus';
import { mintCallContext } from '@makaio/framework/bus/kernel-api';

const demo = MakaioBus.registerNamespace(
  createBusNamespace('call-context-bus-demo', {
    ping: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
  }),
);

type BusCall = ReturnType<typeof MakaioBus.own>;
const party = { kind: 'makaio.host', id: 'consumer' };
const minted: BusCall = mintCallContext({ caller: party, principal: party });
declare const subjectLessValue: unknown;
// Subject and payload come from a registered namespace, as a consumer writes them.
// Parameters<typeof MakaioBus.request> is not used: on a generic overloaded member it reads the
// last (own form) overload with the type parameter replaced by its constraint, which yields a
// bare subject definition and an unknown-record payload that no call accepts (the subject
// resolves the payload to never), so it cannot serve as a subject/payload pair.
const requestSubject = demo.subjects.ping;
const requestPayload = { id: 'a' };

// @ts-expect-error a literal lacks the stamp
export const forgedLiteral: BusCall = { caller: party, principal: party };
// @ts-expect-error a spread copy lacks the stamp
export const forgedSpread: BusCall = { ...minted };

export const rootContext: BusCall = MakaioBus.own('root');
export function narrowed(): BusCall | undefined {
  return isMintedCallContext(subjectLessValue) ? subjectLessValue : undefined;
}

export async function sends(): Promise<void> {
  await MakaioBus.request(MakaioBus.own('root'), requestSubject, requestPayload);
  await MakaioBus.request(minted, requestSubject, requestPayload);
  await MakaioBus.request(requestSubject, requestPayload);
  // @ts-expect-error a literal is not a call context
  await MakaioBus.request({ caller: party, principal: party }, requestSubject, requestPayload);
  // @ts-expect-error an own context needs a purpose of the closed list
  MakaioBus.own('x');
  // @ts-expect-error the host context is no longer reachable
  MakaioBus.getContext();
}
`;

/**
 * Program D: the two-package pair of the call context proof (K0): only
 * `@makaio/contracts` and `@makaio/framework`.
 *
 * Rejects: a literal and a spread copy as `CallContext`; a literal as the first
 * argument of `ctx.bus.request`.
 * Accepts: the own-context type of the contracts and a value minted through the kernel
 * entry assigned to each other and to `CallContext` of the core (one declaration), and
 * `isMintedCallContext` narrowing to `CallContext`.
 */
export const PAIR_PROGRAM_D = String.raw`
import type { ExtensionContext } from '@makaio/contracts';
import type { CallContext } from '@makaio/framework/core';
import { isMintedCallContext } from '@makaio/framework/bus';
import { mintCallContext } from '@makaio/framework/bus/kernel-api';

const party = { kind: 'makaio.host', id: 'consumer' };
const minted: CallContext = mintCallContext({ caller: party, principal: party });
declare const ctx: ExtensionContext;
declare const unknownValue: unknown;
// Parameters<> of an overloaded member reads the LAST overload, which is the own form
// (subject, payload): index 0 is the subject, index 1 the payload.
declare const requestSubject: Parameters<ExtensionContext['bus']['request']>[0];
declare const requestPayload: Parameters<ExtensionContext['bus']['request']>[1];

type OwnContext = ReturnType<ExtensionContext['bus']['own']>;
export const mintedAsOwn: OwnContext = minted;
export const ownAsCore: CallContext = ctx.bus.own('start');
export const ownAsMinted: OwnContext = ctx.bus.own('start');

// @ts-expect-error a literal lacks the stamp
export const forgedLiteral: CallContext = { caller: party, principal: party };
// @ts-expect-error a spread copy lacks the stamp
export const forgedSpread: CallContext = { ...minted };

export function narrowed(): CallContext | undefined {
  return isMintedCallContext(unknownValue) ? unknownValue : undefined;
}

export async function sends(): Promise<void> {
  await ctx.bus.request(ctx.bus.own('start'), requestSubject, requestPayload);
  await ctx.bus.request(requestSubject, requestPayload);
  // @ts-expect-error a literal is not a call context
  await ctx.bus.request({ caller: party, principal: party }, requestSubject, requestPayload);
}
`;

/** The programs by the file name a suite writes them under in the consumer. */
export const CALL_CONTEXT_PROGRAMS: Readonly<Record<string, string>> = {
  'program-a-author.ts': AUTHOR_PROGRAM_A,
  'program-b-core-contracts.ts': AUTHOR_PROGRAM_B,
  'program-c-bus.ts': BUS_PROGRAM_C,
  'program-d-pair.ts': PAIR_PROGRAM_D,
};
