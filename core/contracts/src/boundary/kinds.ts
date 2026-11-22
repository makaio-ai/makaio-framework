import { ContributionNameSchema } from '@makaio/core';
import type { ContributionName, PartyKind } from '@makaio/core';
import type { JsonSchema } from '../shared/json-value.js';

/**
 * Kind of a boundary: a place where a caller enters the host (a connection to
 * the bus, an HTTP route). The set is open; a package contributes kinds under
 * its own name and no code of the core branches over a closed list.
 */
export type BoundaryKind = ContributionName;

/** Schema of a {@link BoundaryKind}: `<owner>.<local name>`. */
export const BoundaryKindSchema = ContributionNameSchema;

/**
 * The boundary kinds the core itself contributes: a connection to the bus, the
 * HTTP route of an extension and MCP over HTTP.
 */
export const CoreBoundaryKind = {
  /** A connection to the bus. */
  busConnection: 'makaio.bus-connection',
  /** The HTTP route of an extension. */
  httpRoute: 'makaio.http-route',
  /** MCP over HTTP. */
  mcpHttp: 'makaio.mcp-http',
} as const;

/** Union of the boundary kind names the core contributes. {@link BoundaryKind} stays open. */
export type MakaioBoundaryKind = (typeof CoreBoundaryKind)[keyof typeof CoreBoundaryKind];

/**
 * Declares a kind of boundary. A package contributes kinds under its own name.
 */
export interface BoundaryKindContribution {
  /** Name of the boundary kind, owned by the contributing extension. */
  readonly boundary: BoundaryKind;
  /** What the boundary is, for people. */
  readonly description: string;
  /**
   * Schema of the presented credential at this boundary, for example the
   * headers of an HTTP request or the message that opens a connection.
   */
  readonly presented: JsonSchema;
}

/**
 * Declares a kind of party. A package contributes kinds under its own name.
 */
export interface PartyKindContribution {
  /** Name of the party kind, owned by the contributing extension. */
  readonly kind: PartyKind;
  /** What the party is, for people. */
  readonly description: string;
  /** Schema of `Party.claims` for parties of this kind. */
  readonly claims?: JsonSchema;
}
