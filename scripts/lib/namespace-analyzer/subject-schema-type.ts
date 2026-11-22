/**
 * Reads subject schema wrapper layers off compiler types for the namespace analyzer.
 * @packageDocumentation
 */

import type * as ts from 'typescript';

import { inspectSubjectSchema } from '@makaio/core';
import type { SubjectMarks, SubjectSchemaLayer, TransportRoutingDefault } from '@makaio/core';

const TRANSPORT_ROUTING_DEFAULT_VALUES: ReadonlySet<string> = new Set<TransportRoutingDefault>(['all', 'local-only']);

/**
 * Narrows a string to a transport-routing policy.
 * @param value - Candidate policy string.
 * @returns `true` when `value` is a valid {@link TransportRoutingDefault}.
 */
function isTransportRoutingDefault(value: string): value is TransportRoutingDefault {
  return TRANSPORT_ROUTING_DEFAULT_VALUES.has(value);
}

/**
 * Lists the transport-routing policies a `__defaultTransports` brand type admits.
 *
 * The brand is one literal when `defaultTransports()` received a literal, and the
 * `TransportRoutingDefault` union when its policy argument was typed as that union
 * (for example a forwarded `policy: TransportRoutingDefault` parameter).
 * @param type - The type of the `__defaultTransports` brand property.
 * @returns Every admitted policy, or an empty list when any constituent is not a valid policy literal.
 */
function transportRoutingDefaultsOf(type: ts.Type): TransportRoutingDefault[] {
  const policies: TransportRoutingDefault[] = [];
  for (const member of type.isUnion() ? type.types : [type]) {
    if (!member.isStringLiteral() || !isTransportRoutingDefault(member.value)) return [];
    policies.push(member.value);
  }
  return policies;
}

/**
 * Reads one wrapper layer off a compiler type, recognizing every subject
 * wrapper brand (including the journal wrapper) alongside a `schema`
 * property.
 *
 * Adapts {@link inspectSubjectSchema}'s generic traversal to `ts.Type`
 * instead of a runtime value, so the compiler analyzer and the runtime
 * manifest export share one walk instead of duplicating it.
 * @param type - The candidate wrapper type to inspect.
 * @param checker - The TypeScript type checker for property type resolution.
 * @returns The inner schema type and the marks this layer contributes, or
 *   `undefined` if `type` carries no recognized brand.
 */
function readSubjectSchemaTypeLayer(type: ts.Type, checker: ts.TypeChecker): SubjectSchemaLayer<ts.Type> | undefined {
  const schemaProp = type.getProperty('schema');
  if (!schemaProp) return undefined;

  const marks: { -readonly [K in keyof SubjectMarks]?: SubjectMarks[K] } = {};
  if (type.getProperty('__journal')) marks.journal = {};
  if (type.getProperty('__local')) marks.local = true;
  if (type.getProperty('__channel')) marks.channel = true;
  if (type.getProperty('__collectorOnly')) marks.collectorOnly = true;
  if (type.getProperty('__hostLocalRequest')) marks.hostLocalRequest = true;

  const defaultTransportsProp = type.getProperty('__defaultTransports');
  const transportPolicies = defaultTransportsProp
    ? transportRoutingDefaultsOf(checker.getTypeOfSymbol(defaultTransportsProp))
    : [];
  // A union-typed policy still marks a routing layer, but names no single policy.
  const [onlyPolicy, ...otherPolicies] = transportPolicies;
  if (onlyPolicy !== undefined && otherPolicies.length === 0) marks.defaultTransports = onlyPolicy;

  if (Object.keys(marks).length === 0 && transportPolicies.length === 0) return undefined;

  return { schema: checker.getTypeOfSymbol(schemaProp), marks };
}

/**
 * Unwraps a subject schema wrapper type, including a journal wrapper and the
 * routing wrapper it may contain, returning the innermost schema type.
 * Returns the original type unchanged if it is not a wrapper.
 * @param type - The TypeScript type to inspect.
 * @param checker - The TypeScript type checker for property resolution.
 * @returns The unwrapped base schema type, or the original type if not wrapped.
 */
export function unwrapSubjectSchema(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  return inspectSubjectSchema(type, (candidate) => readSubjectSchemaTypeLayer(candidate, checker)).schema;
}
