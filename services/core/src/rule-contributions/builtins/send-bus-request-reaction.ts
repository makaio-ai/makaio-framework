import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  NoHandlerError,
  TimeoutError,
  ValidationError,
  isRequestSchema,
  isRequestCancellation,
  resolveRegisteredRequestSubject,
} from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { isSubjectName, type CallContext } from '@makaio/core';
import { RightDenialReason, type RightAnswer } from '@makaio/contracts/rights';
import type { JsonValue, ReactionDefinition } from '@makaio/contracts';
import { JsonRecordSchema, defineReaction } from '@makaio/contracts';
import { getErrorString } from '@makaio/utils';

/**
 * Checks that an evaluation may send to the requested subject.
 * @param call - The evaluation's call.
 * @param subject - The full request subject.
 * @param payload - Resolved request payload.
 * @returns The shared rights resolver's decision.
 */
export type RuleSendAuthorization = (
  call: CallContext,
  subject: string,
  payload: Record<string, JsonValue>,
) => Promise<RightAnswer>;

/** Canonical kind of the core's generic "send one bus request" reaction. */
export const SEND_BUS_REQUEST_REACTION_KIND = 'makaio.send-bus-request';

/**
 * Resolved parameters of {@link SEND_BUS_REQUEST_REACTION_KIND}.
 *
 * Bus requests use a JSON object envelope. Candidate validation checks that
 * the target request is registered and checks independently parsed literal
 * inputs against its request schema. The handler checks the full payload
 * against that schema after the evaluator expands the parameters.
 */
export const SendBusRequestParamsSchema = z.object({
  /** Full bus subject key the request is sent to; always a fixed value in a rule. */
  subject: z.string(),
  /** Request payload, already resolved to a JSON object. */
  payload: JsonRecordSchema,
  /** Request timeout in milliseconds; absent uses the bus's own default. */
  timeoutMs: z.number().positive().optional(),
});

/**
 * Builds the core's generic "send one bus request" reaction, bound to the bus
 * the evaluation sends on.
 *
 * Sends one request for the occasion's principal and attesting party, with
 * `makaio.rules` as the caller. A valid response becomes an accepted result.
 * A missing handler yields `retry`. A timeout, cancellation or invalid
 * response yields `outcome-unknown`. A request payload violation yields
 * `invalid-payload`. Other send errors yield `send-failed`. The reaction is
 * unkeyed because the request may have an effect each time it is sent.
 * @param bus - Bus instance the evaluation sends requests on.
 * @param authorize - Checks the subject-send right for the evaluation's call.
 * @returns The reaction definition.
 */
export function createSendBusRequestReaction(bus: IMakaioBus, authorize: RuleSendAuthorization): ReactionDefinition {
  return defineReaction({
    kind: SEND_BUS_REQUEST_REACTION_KIND,
    description: "Sends one bus request to a fixed subject and carries its response as the reaction's result.",
    parameterSchema: SendBusRequestParamsSchema,
    resultSchema: JsonRecordSchema,
    keyed: false,
    handler: async (call, parameters, context) => {
      if (!isSubjectName(parameters.subject)) {
        return {
          state: 'failed',
          code: 'invalid-subject',
          reason: `'${parameters.subject}' is not an addressable bus subject ('<namespace>.<subject>')`,
        };
      }

      const answer = await authorize(call, parameters.subject, parameters.payload);
      if (!answer.granted) {
        return answer.reason === RightDenialReason.sourceUnavailable
          ? { state: 'retry', reason: answer.reason }
          : { state: 'failed', code: 'request-not-granted', reason: answer.reason };
      }
      const subjectDef = resolveRegisteredRequestSubject(bus, parameters.subject);
      const schema = busContextOf(bus).namespaceRegistry.getSchema(parameters.subject);
      if (subjectDef === undefined || schema === undefined || !isRequestSchema(schema)) {
        return { state: 'retry', reason: 'No registered request subject is available' };
      }

      let result: unknown;
      try {
        if (!(await schema.request.safeParseAsync(parameters.payload)).success) {
          return { state: 'failed', code: 'invalid-payload', reason: 'Payload does not match the request schema' };
        }
        result = await bus.request(call, subjectDef, parameters.payload, {
          signal: context.signal,
          correlationId: context.correlationId,
          idempotencyKey: context.key,
          ...(parameters.timeoutMs === undefined ? {} : { timeout: parameters.timeoutMs }),
        });
      } catch (error) {
        if (
          error instanceof TimeoutError ||
          error instanceof ValidationError ||
          isRequestCancellation(error, context.signal)
        ) {
          return { state: 'failed', code: 'outcome-unknown', reason: getErrorString(error) };
        }
        if (error instanceof NoHandlerError) {
          return { state: 'retry', reason: error.message };
        }
        return { state: 'failed', code: 'send-failed', reason: getErrorString(error) };
      }

      try {
        return { state: 'accepted', result: JsonRecordSchema.parse(result) };
      } catch (error) {
        return { state: 'failed', code: 'outcome-unknown', reason: getErrorString(error) };
      }
    },
  });
}
