// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ResizablePanel } from '../ResizablePanel.js';

describe('ResizablePanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not invoke onSizeChange after unmounting mid-drag', () => {
    const onSizeChange = vi.fn();

    const { unmount } = render(
      <ResizablePanel size={320} onSizeChange={onSizeChange} title="Resizable">
        Content
      </ResizablePanel>,
    );

    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 320 });
    unmount();

    // Simulate the pointer moving after the panel is gone — the stale
    // mousemove listener must have been removed, so onSizeChange must not fire.
    fireEvent.mouseMove(document, { clientX: 400 });

    expect(onSizeChange).not.toHaveBeenCalled();
  });

  it('supports keyboard resizing from the separator handle', () => {
    const onSizeChange = vi.fn();

    render(
      <ResizablePanel size={320} minSize={280} maxSize={480} onSizeChange={onSizeChange} title="Resizable">
        Content
      </ResizablePanel>,
    );

    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });

    expect(onSizeChange).toHaveBeenNthCalledWith(1, 336);
    expect(onSizeChange).toHaveBeenNthCalledWith(2, 304);
  });

  it('exposes the current pin state via aria-pressed', () => {
    render(
      <ResizablePanel
        size={320}
        isPinned={true}
        onPinChange={() => undefined}
        onSizeChange={() => undefined}
        title="Resizable"
      >
        Content
      </ResizablePanel>,
    );

    expect(screen.getByRole('button', { name: 'Unpin panel' }).getAttribute('aria-pressed')).toBe('true');
  });
});
