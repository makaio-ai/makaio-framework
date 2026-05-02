/**
 * Schema validation tests for OpenCode log import.
 *
 * Verifies that schemas correctly parse real OpenCode log data.
 * Fixtures based on actual OpenCode v1.1.x logs (2026-01-22).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeMessageSchema, OpenCodePartSchema, OpenCodeSessionSchema } from '../src/types.js';

/**
 * Loads a fixture file from the fixtures directory.
 * @param name - The fixture file name (e.g., 'session.json')
 * @returns The file contents as a string
 */
const loadFixture = (name: string): string => {
  const fixturePath = join(__dirname, 'fixtures', name);
  return readFileSync(fixturePath, 'utf-8');
};

describe('OpenCode Schema Validation', () => {
  describe('OpenCodeSessionSchema', () => {
    it('parses valid session JSON', () => {
      const sessionJson = loadFixture('session.json');
      const result = OpenCodeSessionSchema.safeParse(JSON.parse(sessionJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('ses_43d462e9cffexz6719QK96K7Ei');
        expect(result.data.projectID).toBe('306ec0503454c53557861e73d40bcc85e6bf41be');
      }
    });
  });

  describe('OpenCodeMessageSchema', () => {
    it('parses user message with summary and variant', () => {
      const userJson = loadFixture('message-user.json');
      const result = OpenCodeMessageSchema.safeParse(JSON.parse(userJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('user');
        expect(result.data.id).toBe('msg_bb815fae3001NfwSfS3QMC3yzU');
        // User messages have nested model
        if ('model' in result.data) {
          expect(result.data.model?.providerID).toBe('openai');
        }
      }
    });

    it('parses assistant message with top-level provider/model and tokens', () => {
      const assistantJson = loadFixture('message-assistant.json');
      const result = OpenCodeMessageSchema.safeParse(JSON.parse(assistantJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('assistant');
        // Assistant messages have top-level providerID/modelID
        if ('providerID' in result.data) {
          expect(result.data.providerID).toBe('openai');
          expect(result.data.modelID).toBe('gpt-5.2-chat-latest');
          expect(result.data.tokens?.input).toBe(1500);
          expect(result.data.tokens?.output).toBe(250);
        }
      }
    });
  });

  describe('OpenCodePartSchema', () => {
    it('parses text part', () => {
      const textJson = loadFixture('part-text-assistant.json');
      const result = OpenCodePartSchema.safeParse(JSON.parse(textJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('text');
        if (result.data.type === 'text') {
          expect(result.data.text).toContain('opencode-antigravity-auth');
        }
      }
    });

    it('parses reasoning part', () => {
      const reasoningJson = loadFixture('part-reasoning.json');
      const result = OpenCodePartSchema.safeParse(JSON.parse(reasoningJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('reasoning');
        if (result.data.type === 'reasoning') {
          expect(result.data.text).toContain('Analyzing the request');
          expect(result.data.time?.start).toBe(1768320007100);
        }
      }
    });

    it('parses tool part with state', () => {
      const toolJson = loadFixture('part-tool.json');
      const result = OpenCodePartSchema.safeParse(JSON.parse(toolJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('tool');
        if (result.data.type === 'tool') {
          expect(result.data.tool).toBe('bash');
          expect(result.data.state.status).toBe('completed');
        }
      }
    });

    it('parses step-start part with snapshot', () => {
      const stepStartJson = loadFixture('part-step-start.json');
      const result = OpenCodePartSchema.safeParse(JSON.parse(stepStartJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('step-start');
        if (result.data.type === 'step-start') {
          expect(result.data.snapshot).toBe('e251b2cd9058614e42897a1c756b1f53fcd3d14d');
        }
      }
    });

    it('parses step-finish part with legacy metrics format', () => {
      const stepFinishJson = loadFixture('part-step-finish.json');
      const result = OpenCodePartSchema.safeParse(JSON.parse(stepFinishJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('step-finish');
        if (result.data.type === 'step-finish') {
          expect(result.data.metrics?.tokens?.input).toBe(1500);
        }
      }
    });

    it('parses step-finish part with current top-level tokens format', () => {
      const stepFinishJson = loadFixture('part-step-finish-current.json');
      const result = OpenCodePartSchema.safeParse(JSON.parse(stepFinishJson));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('step-finish');
        if (result.data.type === 'step-finish') {
          expect(result.data.tokens?.input).toBe(1500);
          expect(result.data.reason).toBe('tool-calls');
          expect(result.data.snapshot).toBe('e251b2cd9058614e42897a1c756b1f53fcd3d14d');
        }
      }
    });
  });
});
