import * as methods from './methods/index.js';
import { normalizeSendArgs } from './call-context/send-args.js';
import { validateMessage } from './utils/message-safeguards.js';
import type { MakaioBusContext } from './types/bus.js';
import type { PartyRef } from '@makaio/core';

/** Payload parameter of a `methods/*` send entry (index 4), as the entry declares it. */
type PayloadOf<Operation extends (...args: never[]) => unknown> = Parameters<Operation>[4];

/** Options parameter of a `methods/*` send entry (index 5), as the entry declares it. */
type OptionsOf<Operation extends (...args: never[]) => unknown> = Parameters<Operation>[5];

/**
 * The send operations every bus view shares (main bus, scoped bus, filtered bus).
 *
 * The functions are implementation signatures over the raw arguments: the call form
 * `(call, subject, payload, options?)` and the own form `(subject, payload, options?)` are
 * resolved by `normalizeSendArgs`. The consumers bind each member to their overloaded
 * interface member with one plain `as <Interface>['<member>']`.
 */
export interface SendSurface {
  /** Emit an event. */
  readonly emit: (...args: readonly unknown[]) => ReturnType<typeof methods.emit>;
  /** Send a request and wait for the response. */
  readonly request: (...args: readonly unknown[]) => ReturnType<typeof methods.request>;
  /** Send a request; resolves with `handled: false` when no handler answers. */
  readonly requestOptional: (...args: readonly unknown[]) => ReturnType<typeof methods.requestOptional>;
}

/** The broadcast operation, which only the main bus has. */
export type BroadcastSend = (...args: readonly unknown[]) => ReturnType<typeof methods.broadcast>;

/**
 * Create the `emit`, `request` and `requestOptional` operations of a bus view.
 *
 * Each operation resolves the two overload forms first (so nothing reads `subject.subject`
 * from an unresolved argument), then validates the subject against `scope`, then enters
 * `methods/*`, which derives the call through `enterSend` exactly once per send. Options are
 * passed through untouched.
 * @param context - Shared bus context.
 * @param carrier - The party the view acts as.
 * @param scope - Namespace scope of the view, if any.
 * @returns The three send operations.
 * @throws InvalidCallContextError (from the returned operations) When the first argument is neither a minted call context nor a subject definition.
 */
export function createSendSurface(
  context: MakaioBusContext,
  carrier: PartyRef,
  scope: string | undefined,
): SendSurface {
  return {
    emit: async (...args) => {
      const { call, subject, payload, options } = normalizeSendArgs(context, carrier, 'emit', args);
      validateMessage('emit', subject, scope);
      return methods.emit(
        context,
        carrier,
        call,
        subject,
        payload as PayloadOf<typeof methods.emit>,
        options as OptionsOf<typeof methods.emit>,
      );
    },
    request: async (...args) => {
      const { call, subject, payload, options } = normalizeSendArgs(context, carrier, 'request', args);
      validateMessage('request', subject, scope);
      return methods.request(
        context,
        carrier,
        call,
        subject,
        payload as PayloadOf<typeof methods.request>,
        options as OptionsOf<typeof methods.request>,
      );
    },
    requestOptional: async (...args) => {
      const { call, subject, payload, options } = normalizeSendArgs(context, carrier, 'request', args);
      validateMessage('request', subject, scope);
      return methods.requestOptional(
        context,
        carrier,
        call,
        subject,
        payload as PayloadOf<typeof methods.requestOptional>,
        options as OptionsOf<typeof methods.requestOptional>,
      );
    },
  };
}

/**
 * Create the `broadcast` operation of the main bus.
 *
 * Scoped and filtered views never receive it. Same normalisation, validation and entry
 * order as {@link createSendSurface}.
 * @param context - Shared bus context.
 * @param carrier - The party the bus acts as.
 * @param scope - Namespace scope of the bus, if any.
 * @returns The broadcast operation.
 * @throws InvalidCallContextError (from the returned operation) When the first argument is neither a minted call context nor a subject definition.
 */
export function createBroadcastSend(
  context: MakaioBusContext,
  carrier: PartyRef,
  scope: string | undefined,
): BroadcastSend {
  return async (...args) => {
    const { call, subject, payload, options } = normalizeSendArgs(context, carrier, 'request', args);
    // 'request' mode is intentional — broadcast subjects have isRequest=true, so
    // 'emit' mode would incorrectly reject them. There is no dedicated 'broadcast'
    // mode in validateMessage; 'request' is the correct validator for these subjects.
    validateMessage('request', subject, scope);
    return methods.broadcast(
      context,
      carrier,
      call,
      subject,
      payload as PayloadOf<typeof methods.broadcast>,
      options as OptionsOf<typeof methods.broadcast>,
    );
  };
}
