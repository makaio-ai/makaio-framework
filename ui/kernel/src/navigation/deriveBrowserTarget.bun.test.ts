/**
 * Tests for deriveBrowserTarget.
 */

import { describe, expect, it } from 'bun:test';
import { deriveBrowserTarget } from './deriveBrowserTarget.js';

describe('deriveBrowserTarget', () => {
  describe('singleton routes — reuse same window', () => {
    it('returns "project-overview" for /project-overview', () => {
      expect(deriveBrowserTarget('/project-overview')).toBe('project-overview');
    });

    it('returns "control-center" for /control-center', () => {
      expect(deriveBrowserTarget('/control-center')).toBe('control-center');
    });

    it('returns "agent-manager" for /agent-manager', () => {
      expect(deriveBrowserTarget('/agent-manager')).toBe('agent-manager');
    });
  });

  describe('/project/:projectId — reuse per project', () => {
    it('returns "project-{id}" for a parameterised project route', () => {
      expect(deriveBrowserTarget('/project/abc-123')).toBe('project-abc-123');
    });

    it('strips query string before deriving the target', () => {
      expect(deriveBrowserTarget('/project/abc?foo=bar')).toBe('project-abc');
    });
  });

  describe('/chat/:sessionId — reuse per session', () => {
    it('returns "chat-{id}" for a chat route with a session', () => {
      expect(deriveBrowserTarget('/chat/session-456')).toBe('chat-session-456');
    });
  });

  describe('/chat without session — always new window', () => {
    it('returns "_blank" for /chat with no sessionId', () => {
      expect(deriveBrowserTarget('/chat')).toBe('_blank');
    });
  });

  describe('normalisation', () => {
    it('strips trailing slash from a static singleton route', () => {
      expect(deriveBrowserTarget('/control-center/')).toBe('control-center');
    });

    it('strips trailing slash from a parameterised project route', () => {
      expect(deriveBrowserTarget('/project/abc/')).toBe('project-abc');
    });

    it('strips repeated trailing slashes before parsing segments', () => {
      expect(deriveBrowserTarget('/control-center///')).toBe('control-center');
      expect(deriveBrowserTarget('/project/abc///')).toBe('project-abc');
    });
  });

  describe('unknown routes — always new window', () => {
    it('returns "_blank" for an unrecognised path', () => {
      expect(deriveBrowserTarget('/unknown')).toBe('_blank');
    });

    it('returns "_blank" for the root path', () => {
      expect(deriveBrowserTarget('/')).toBe('_blank');
    });
  });
});
