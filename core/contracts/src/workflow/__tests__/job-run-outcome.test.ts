import type { CallContext, ExtensionName } from '@makaio/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { HostTransaction } from '../../host-database/index.js';
import { JobRunResultSchema, type ExtensionContext, type ExtensionJobRunOutcomeContribution } from '../../index.js';
import { WorkerSchemas } from '../../worker/schemas.js';
import {
  CoreOutcomeRefusalCodeSchema,
  JobRunOutcomeNamespace,
  JobRunEndingSchema,
  JobRunErrorCodeSchema,
  OutcomeSubmitRequestSchema,
  OutcomeSubmitResponseSchema,
  type JobRunCapability,
  type CloseJobRunInput,
  type OutcomeSubmitResponse,
  type JobRunResult,
} from '../job-run-outcome.js';

const result = { status: 'completed', jobRunId: 'run', workflowId: 'workflow' } satisfies JobRunResult;

describe('job run result contract', () => {
  it('uses the engine subject and checks identity from the result envelope', () => {
    const { $meta, subject } = JobRunOutcomeNamespace.subjects.outcome.submit;
    expect(`${$meta.namespace}.${subject}`).toBe('makaio:job-runs.outcome.submit');
    expect(OutcomeSubmitRequestSchema.parse({ result })).toEqual({ result });
    expect(OutcomeSubmitRequestSchema.safeParse({ result, jobRunId: 'run' }).success).toBe(false);
    expect(OutcomeSubmitRequestSchema.safeParse({ result: { ...result, output: null } }).success).toBe(false);
    expect(OutcomeSubmitRequestSchema.safeParse({ result: { ...result, executionId: 'run' } }).success).toBe(false);
  });

  it('rejects a worker outcome whose result belongs to another execution', () => {
    const schema = WorkerSchemas['control.outcome.submit'].request;
    const legacy = { status: 'completed', executionId: 'run', workflowId: 'workflow' };
    const envelope = { executionId: legacy.executionId, result: legacy };
    expect(schema.parse(envelope)).toEqual(envelope);
    expect(schema.safeParse({ ...envelope, executionId: 'another-run' }).success).toBe(false);
    expect(schema.safeParse({ ...envelope, jobRunId: legacy.executionId }).success).toBe(false);
  });

  it.each(['accepted', 'duplicate'] as const)('carries the stored answer in the %s branch', (decision) => {
    expect(OutcomeSubmitResponseSchema.parse({ decision, answer: null })).toEqual({ decision, answer: null });
    expect(OutcomeSubmitResponseSchema.safeParse({ decision }).success).toBe(false);
    expect(OutcomeSubmitResponseSchema.safeParse({ decision, answer: null, code: 'unknown' }).success).toBe(false);
  });

  it('accepts extension refusal codes and rejects extra fields', () => {
    const refusal = {
      decision: 'refused',
      retryable: false,
      code: 'owner-policy',
      owner: 'example.acceptance',
      detail: { reason: 'policy' },
    };
    expect(OutcomeSubmitResponseSchema.parse(refusal)).toEqual(refusal);
    expect(OutcomeSubmitResponseSchema.safeParse({ ...refusal, answer: null }).success).toBe(false);
    expect(CoreOutcomeRefusalCodeSchema.safeParse(refusal.code).success).toBe(false);
    expect(CoreOutcomeRefusalCodeSchema.parse('owner-unavailable')).toBe('owner-unavailable');
    expect(JobRunErrorCodeSchema.parse('result-run-mismatch')).toBe('result-run-mismatch');
  });

  it('rejects outcome data that would be rewritten by JSON serialization', () => {
    expect(OutcomeSubmitResponseSchema.safeParse({ decision: 'accepted', answer: new Date() }).success).toBe(false);
    expect(
      OutcomeSubmitResponseSchema.safeParse({
        decision: 'refused',
        code: 'run-unknown',
        retryable: false,
        detail: { [Symbol('hidden')]: 1 },
      }).success,
    ).toBe(false);
  });

  it('checks refusal ownership and requires retryability', () => {
    type Unavailable = Extract<OutcomeSubmitResponse, { code: 'owner-unavailable' }>;
    type OwnerRefusal = Extract<OutcomeSubmitResponse, { owner: ExtensionName }>;
    expectTypeOf<Pick<Unavailable, 'decision' | 'retryable' | 'owner'>>().toEqualTypeOf<{
      decision: 'refused';
      retryable: true;
      readonly owner?: never;
    }>();
    expectTypeOf<Pick<OwnerRefusal, 'code' | 'retryable' | 'owner'>>().toEqualTypeOf<{
      code: string;
      retryable: boolean;
      owner: ExtensionName;
    }>();
    const core = { decision: 'refused', code: 'outcome-conflict', retryable: false };
    expect(OutcomeSubmitResponseSchema.safeParse({ ...core, retryable: true }).success).toBe(false);
    const unavailable = { ...core, code: 'owner-unavailable', retryable: true };
    expect(OutcomeSubmitResponseSchema.safeParse(unavailable).success).toBe(true);
    expect(OutcomeSubmitResponseSchema.safeParse({ ...unavailable, retryable: false }).success).toBe(false);
    expect(OutcomeSubmitResponseSchema.safeParse(core).success).toBe(true);
    expect(OutcomeSubmitResponseSchema.safeParse({ ...core, owner: 'example.owner' }).success).toBe(false);
    expect(OutcomeSubmitResponseSchema.safeParse({ ...core, code: 'extension-policy' }).success).toBe(false);
    expect(OutcomeSubmitResponseSchema.safeParse({ ...core, retryable: undefined }).success).toBe(false);
  });

  it.each([
    { status: 'completed' },
    { status: 'failed', error: 'failure' },
    { status: 'cancelled', reason: 'cancelled' },
  ])('preserves a JSON submission on $status and rejects lossy data', (status) => {
    const submission = { drafts: [null, { text: 'value' }] };
    const input = { result: { ...result, ...status, submission } };
    expect(OutcomeSubmitRequestSchema.parse(input)).toEqual(input);
    expect(OutcomeSubmitRequestSchema.safeParse({ result: { ...input.result, submission: new Date() } }).success).toBe(
      false,
    );
  });

  it('validates workflow terminal results and close reasons', () => {
    expect(
      OutcomeSubmitRequestSchema.safeParse({ result: { ...result, status: 'failed', error: 'failure' } }).success,
    ).toBe(true);
    expect(OutcomeSubmitRequestSchema.safeParse({ result: { ...result, status: 'cancelled' } }).success).toBe(true);
    expect(OutcomeSubmitRequestSchema.safeParse({ result: { ...result, status: 'failed' } }).success).toBe(false);
    expect(JobRunEndingSchema.safeParse({ kind: 'no-result', outcome: 'completed', cause: 'finished' }).success).toBe(
      false,
    );
    expect(JobRunEndingSchema.safeParse({ kind: 'no-result', outcome: 'lost', cause: '' }).success).toBe(false);
    expect(JobRunErrorCodeSchema.safeParse('unrecognized').success).toBe(false);
  });

  it('binds close to the received call and host transaction', () => {
    expectTypeOf<JobRunCapability['close']>().toEqualTypeOf<
      (call: CallContext, input: CloseJobRunInput) => Promise<void>
    >();
    expectTypeOf<CloseJobRunInput['tx']>().toEqualTypeOf<HostTransaction>();
    const ending = { kind: 'no-result', outcome: 'lost', cause: 'worker unavailable' };
    expect(JobRunEndingSchema.parse({ kind: 'result', result })).toEqual({ kind: 'result', result });
    expect(JobRunEndingSchema.parse(ending)).toEqual(ending);
    expect(JobRunEndingSchema.safeParse({ ...ending, result }).success).toBe(false);
  });

  it('requires an answer only for a result close', () => {
    type CloseBase = Pick<CloseJobRunInput, 'tx' | 'jobRunId'>;
    type ResultClose = CloseBase & { ending: { kind: 'result'; result: JobRunResult } };
    type NoResultClose = CloseBase & { ending: { kind: 'no-result'; outcome: 'lost'; cause: string } };
    expectTypeOf<ResultClose & { answer: null }>().toMatchTypeOf<CloseJobRunInput>();
    expectTypeOf<ResultClose>().not.toMatchTypeOf<CloseJobRunInput>();
    expectTypeOf<NoResultClose>().toMatchTypeOf<CloseJobRunInput>();
    expectTypeOf<NoResultClose & { answer: null }>().not.toMatchTypeOf<CloseJobRunInput>();
  });

  it('exposes the outcome family from the existing contracts root', () => {
    expect(JobRunResultSchema.parse(result)).toEqual(result);
    expectTypeOf<ExtensionJobRunOutcomeContribution<ExtensionContext>>().toEqualTypeOf<
      import('../../extension/index.js').ExtensionJobRunOutcomeContribution<ExtensionContext>
    >();
  });
});
