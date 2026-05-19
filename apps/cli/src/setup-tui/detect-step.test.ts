/**
 * Tests for the DetectStep TUI component.
 *
 * Exercises rendering assertions via `ink-testing-library`. All JSX is written
 * as `React.createElement` calls so the file runs in the `unit` (node) test
 * project.
 *
 * The EventEmitter ref/unref shim required for ink v6 / ink-testing-library v3
 * compatibility is installed by the side-effect import of `test-helpers.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DetectStep } from './detect-step.js';
// Importing test-helpers also installs the EventEmitter ref/unref shim for
// ink v6 / ink-testing-library v3 compatibility.
import { makeState, makeClient } from './test-helpers.js';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('DetectStep — rendering', () => {
  it('renders bold heading', () => {
    const state = makeState({ step: 'detect' });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('Detected AI Clients');
  });

  it('renders zero clients gracefully', () => {
    const state = makeState({ step: 'detect', detectedClients: [] });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('0 client(s) selected');
  });

  it('renders multiple client names', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code'), makeClient('copilot', 'GitHub Copilot')],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Claude Code');
    expect(out).toContain('GitHub Copilot');
  });

  it('marks the first entry as cursor-focused with "❯"', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code')],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('❯');
  });

  it('shows [x] for pre-selected client', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code')],
      selectedClientIds: ['claude-code'],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('[x]');
  });

  it('shows [ ] for unselected client', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code')],
      selectedClientIds: [],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('[ ]');
  });

  it('shows "(not found)" annotation for undetected client', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('ghost', 'Ghost', false)],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('(not found)');
  });

  it('omits "(not found)" for detected client', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code', true)],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').not.toContain('(not found)');
  });

  it('shows the correct selected count for multiple selections', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('a', 'A'), makeClient('b', 'B'), makeClient('c', 'C')],
      selectedClientIds: ['a', 'c'],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    expect(lastFrame() ?? '').toContain('2 client(s) selected');
  });
});
