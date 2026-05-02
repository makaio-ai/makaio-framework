import { describe, expect, it, vi } from 'vitest';
import { createRendererConsoleEvent, logRendererConsoleEvent } from '../src/main/renderer-console.js';

describe('createRendererConsoleEvent', () => {
  it('preserves warning severity for renderer warnings', () => {
    expect(createRendererConsoleEvent(2, 'careful', 14, 'app.js')).toEqual({
      severity: 'warning',
      method: 'warn',
      text: '[Renderer:warning] careful (app.js:14)',
    });
  });

  it('preserves error severity for renderer errors', () => {
    expect(createRendererConsoleEvent(3, 'boom', 27, 'app.js')).toEqual({
      severity: 'error',
      method: 'error',
      text: '[Renderer:error] boom (app.js:27)',
    });
  });

  it('treats unknown levels as info to keep logs observable', () => {
    expect(createRendererConsoleEvent(99, 'mystery', 2, 'frame.js')).toEqual({
      severity: 'info',
      method: 'info',
      text: '[Renderer:info] mystery (frame.js:2)',
    });
  });

  it('routes normalized events to the matching main-process console method', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      logRendererConsoleEvent(createRendererConsoleEvent(2, 'careful', 14, 'app.js'));
      logRendererConsoleEvent(createRendererConsoleEvent(3, 'boom', 27, 'app.js'));
      logRendererConsoleEvent(createRendererConsoleEvent(1, 'heads up', 8, 'app.js'));

      expect(warnSpy).toHaveBeenCalledWith('[Renderer:warning] careful (app.js:14)');
      expect(errorSpy).toHaveBeenCalledWith('[Renderer:error] boom (app.js:27)');
      expect(infoSpy).toHaveBeenCalledWith('[Renderer:info] heads up (app.js:8)');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
