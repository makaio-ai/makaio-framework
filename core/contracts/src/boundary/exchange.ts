import type { CallContext, ContributionName, Party } from '@makaio/core';
import type { HostTransaction } from '../host-database/index.js';
import type { JsonSchema, JsonValue } from '../shared/json-value.js';

/**
 * Successful result of a connection exchange.
 */
export interface ConnectionExchangeAccepted {
  /** The caller of the connection. */
  readonly party: Party;
  /**
   * Travels unchanged in the answer to the connection setup to the connecting
   * side. The core does not read it.
   */
  readonly payload: JsonValue;
  /**
   * Point in time after which the connection's note counts as deleted and the
   * transport closes the connection with a visible rejection (reason `expired`).
   */
  readonly expiresAt?: string;
  /**
   * Key under which the core notes the connection, so that a revocation
   * through `makaio:access.revoke` finds and closes it.
   */
  readonly revocationKey?: string;
  readonly commit?: never;
  /** Not present on an accepted result; see {@link ConnectionExchangeRejected}. */
  readonly reject?: never;
}

/**
 * Rejected result of a connection exchange. Forbids every key of
 * {@link ConnectionExchangeAccepted}, so a result is never accepted and
 * rejected at once.
 */
export type ConnectionExchangeRejected = {
  /** Reason of the rejection. */
  readonly reject: string;
} & { readonly [Key in Exclude<keyof ConnectionExchangeAccepted, 'reject'>]?: never };

/**
 * Prepared exchange whose final acceptance is decided by durable storage.
 */
export type ConnectionExchangeCommit = {
  /**
   * Run repeatable storage work in the host transaction. Only release the
   * returned party and payload after the transaction commits successfully.
   * @param call - The same anonymous call used for preparation.
   * @param tx - Open transaction of the host database.
   */
  readonly commit: (
    call: CallContext,
    tx: HostTransaction,
  ) => Promise<ConnectionExchangeAccepted | ConnectionExchangeRejected>;
} & { readonly [Key in Exclude<keyof ConnectionExchangeAccepted, 'commit'>]?: never };

/** Immediate result or prepared storage work that decides the final result. */
export type ConnectionExchangeResult =
  | ConnectionExchangeAccepted
  | ConnectionExchangeRejected
  | ConnectionExchangeCommit;

/**
 * Connection setup with a payload at the `makaio.bus-connection` boundary, for
 * example redeeming a one-time token. It is a change of state with a payload,
 * not a check of the verifier chain. When the setup message names an exchange,
 * the core calls it instead of the chain.
 */
export interface ConnectionExchangeContribution {
  /** Name of the exchange, owned by the contributing extension. */
  readonly exchange: ContributionName;
  /** What the exchange does, for people. */
  readonly description: string;
  /** Schema of the credential the setup message presents. */
  readonly presented: JsonSchema;
  /**
   * Runs the exchange. It runs without a transaction (foreign code never runs
   * inside a transaction of the host); database work goes into `commit` of the
   * result.
   * @param call - Anonymous call minted for this connection setup.
   * @param presented - The credential the setup message presents.
   * @returns Immediate acceptance, rejection or prepared storage work.
   */
  run(call: CallContext, presented: JsonValue): Promise<ConnectionExchangeResult>;
}
