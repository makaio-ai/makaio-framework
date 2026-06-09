import { describe, expect, it } from 'vitest';
import { AgentSubjects } from '../namespace.js';
import { AgentSchemas } from '../schemas.js';

describe('agent structured output schemas', () => {
  describe('AgentSubjects', () => {
    it('registers retryPolicy subject with correct key', () => {
      // .subject is the schema record key, not the namespace-prefixed string
      expect(AgentSubjects.structuredOutput.retryPolicy.subject).toBe('structuredOutput.retryPolicy');
    });

    it('registers enforce subject with correct key', () => {
      expect(AgentSubjects.structuredOutput.enforce.subject).toBe('structuredOutput.enforce');
    });

    it('marks retryPolicy as a request subject', () => {
      expect(AgentSubjects.structuredOutput.retryPolicy.$meta.isRequest).toBe(true);
    });

    it('marks enforce as a request subject', () => {
      expect(AgentSubjects.structuredOutput.enforce.$meta.isRequest).toBe(true);
    });

    it('assigns the agent namespace to both subjects', () => {
      expect(AgentSubjects.structuredOutput.retryPolicy.$meta.namespace).toBe('agent');
      expect(AgentSubjects.structuredOutput.enforce.$meta.namespace).toBe('agent');
    });
  });

  describe('StructuredOutputRetryPolicySchema', () => {
    it('accepts a valid retryPolicy request', () => {
      const result = AgentSchemas['structuredOutput.retryPolicy'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterCapabilities: ['structured-output'],
        responseSchema: {
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
        attemptNumber: 1,
      });

      expect(result.success).toBe(true);
    });

    it('accepts a valid retryPolicy response', () => {
      const result = AgentSchemas['structuredOutput.retryPolicy'].response.safeParse({
        maxRetries: 3,
      });

      expect(result.success).toBe(true);
    });

    it('rejects maxRetries above 5', () => {
      const result = AgentSchemas['structuredOutput.retryPolicy'].response.safeParse({
        maxRetries: 6,
      });

      expect(result.success).toBe(false);
    });

    it('rejects negative maxRetries', () => {
      const result = AgentSchemas['structuredOutput.retryPolicy'].response.safeParse({
        maxRetries: -1,
      });

      expect(result.success).toBe(false);
    });

    it('rejects attemptNumber below 1', () => {
      const result = AgentSchemas['structuredOutput.retryPolicy'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterCapabilities: [],
        responseSchema: { schema: {} },
        attemptNumber: 0,
      });

      expect(result.success).toBe(false);
    });

    it('rejects unknown fields on the request (strict)', () => {
      const result = AgentSchemas['structuredOutput.retryPolicy'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterCapabilities: [],
        responseSchema: { schema: {} },
        attemptNumber: 1,
        unknownField: 'oops',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('StructuredOutputEnforceSchema', () => {
    it('accepts a valid enforce request', () => {
      const result = AgentSchemas['structuredOutput.enforce'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        responseSchema: { schema: { type: 'object' } },
        rawOutput: '{"answer":"maybe"}',
        validationErrors: [
          {
            message: 'must be string',
            instancePath: '/answer',
            schemaPath: '#/properties/answer/type',
          },
        ],
        adapterHasCapability: false,
      });

      expect(result.success).toBe(true);
    });

    it('accepts optional fields on enforce request', () => {
      const result = AgentSchemas['structuredOutput.enforce'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        sessionId: 'session-1',
        responseSchema: { schema: { type: 'object' } },
        rawOutput: '{}',
        validationErrors: [
          {
            message: 'must have required property answer',
            instancePath: '',
            schemaPath: '#/required',
          },
        ],
        adapterHasCapability: true,
        fallbackAdapterId: 'adapter-2',
        fallbackAdapterName: 'openai',
        fallbackModel: 'gpt-4o',
      });

      expect(result.success).toBe(true);
    });

    it('rejects enforce request without validation errors', () => {
      const result = AgentSchemas['structuredOutput.enforce'].request.safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        responseSchema: { schema: { type: 'object' } },
        rawOutput: '{}',
        validationErrors: [],
        adapterHasCapability: false,
      });

      expect(result.success).toBe(false);
    });

    it('accepts a valid enforce response when enforced', () => {
      const result = AgentSchemas['structuredOutput.enforce'].response.safeParse({
        enforced: true,
        output: '{"answer":"ok"}',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a valid enforce response when not enforced', () => {
      const result = AgentSchemas['structuredOutput.enforce'].response.safeParse({
        enforced: false,
        error: 'Fallback adapter unavailable',
      });

      expect(result.success).toBe(true);
    });

    it('rejects enforced:false without error', () => {
      const result = AgentSchemas['structuredOutput.enforce'].response.safeParse({
        enforced: false,
      });

      expect(result.success).toBe(false);
    });

    it('rejects unknown fields on the response (strict)', () => {
      const result = AgentSchemas['structuredOutput.enforce'].response.safeParse({
        enforced: true,
        output: '{"answer":"ok"}',
        unknownField: 'oops',
      });

      expect(result.success).toBe(false);
    });

    it('rejects enforced:true without output', () => {
      const result = AgentSchemas['structuredOutput.enforce'].response.safeParse({
        enforced: true,
      });

      expect(result.success).toBe(false);
    });

    it('rejects enforced:false with output present', () => {
      const result = AgentSchemas['structuredOutput.enforce'].response.safeParse({
        enforced: false,
        output: '{"answer":"ok"}',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('turn.completed structuredOutputValidation', () => {
    it('accepts a completion event without validation metadata', () => {
      const result = AgentSchemas['turn.completed'].safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test',
        adapterSessionId: 'session-1',
        messageId: 'message-1',
        outcome: 'completed',
        message: '{"answer":"ok"}',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a completion event with passed validation metadata', () => {
      const result = AgentSchemas['turn.completed'].safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test',
        adapterSessionId: 'session-1',
        messageId: 'message-1',
        outcome: 'completed',
        message: '{"answer":"ok"}',
        structuredOutputValidation: { status: 'passed' },
      });

      expect(result.success).toBe(true);
    });

    it('accepts a completion event with failed validation metadata including errors', () => {
      const result = AgentSchemas['turn.completed'].safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test',
        adapterSessionId: 'session-1',
        messageId: 'message-1',
        outcome: 'error',
        structuredOutputValidation: {
          status: 'failed',
          errors: [
            {
              message: 'must be string',
              instancePath: '/answer',
              schemaPath: '#/properties/answer/type',
            },
          ],
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('complete structuredOutputValidation', () => {
    it('accepts a complete event with validation metadata', () => {
      const result = AgentSchemas['complete'].safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test',
        adapterSessionId: 'session-1',
        messageId: 'message-1',
        outcome: 'completed',
        message: '{"answer":"ok"}',
        structuredOutputValidation: { status: 'enforced' },
      });

      expect(result.success).toBe(true);
    });

    it('accepts a complete event without validation metadata', () => {
      const result = AgentSchemas['complete'].safeParse({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test',
        adapterSessionId: 'session-1',
        messageId: 'message-1',
      });

      expect(result.success).toBe(true);
    });
  });
});
