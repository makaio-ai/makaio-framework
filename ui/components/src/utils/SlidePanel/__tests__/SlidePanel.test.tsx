// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SlidePanel } from '../SlidePanel.js';

describe('SlidePanel', () => {
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('links the dialog to its title and restores body overflow on close', () => {
    document.body.style.overflow = 'scroll';

    const { rerender } = render(
      <SlidePanel isOpen={true} onClose={() => undefined} title="Panel Title">
        Content
      </SlidePanel>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Panel Title' });
    const heading = screen.getByRole('heading', { level: 2, name: 'Panel Title' });

    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <SlidePanel isOpen={false} onClose={() => undefined} title="Panel Title">
        Content
      </SlidePanel>,
    );

    expect(document.body.style.overflow).toBe('scroll');
  });

  it('moves focus into the panel, traps tab on the last element, and restores prior focus on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open trigger';
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(
      <SlidePanel isOpen={true} onClose={() => undefined} title="Panel Title">
        <button type="button">Secondary action</button>
      </SlidePanel>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Panel Title' });
    const closeButton = within(dialog).getByRole('button', { name: 'Close panel' });
    const secondaryButton = screen.getByRole('button', { name: 'Secondary action' });

    expect(document.activeElement).toBe(closeButton);

    secondaryButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(closeButton);

    rerender(
      <SlidePanel isOpen={false} onClose={() => undefined} title="Panel Title">
        <button type="button">Secondary action</button>
      </SlidePanel>,
    );

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('returns escaped focus to the panel on Tab and Shift+Tab', () => {
    const outsideButton = document.createElement('button');
    outsideButton.textContent = 'Outside action';
    document.body.appendChild(outsideButton);

    render(
      <SlidePanel isOpen={true} onClose={() => undefined} title="Panel Title">
        <button type="button">Secondary action</button>
      </SlidePanel>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Panel Title' });
    const closeButton = within(dialog).getByRole('button', { name: 'Close panel' });
    const secondaryButton = screen.getByRole('button', { name: 'Secondary action' });

    outsideButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    outsideButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(secondaryButton);

    outsideButton.remove();
  });

  it('keeps body scroll locked until all open panels close', () => {
    document.body.style.overflow = 'scroll';

    const { rerender } = render(
      <>
        <SlidePanel isOpen={true} onClose={() => undefined} title="First Panel">
          First
        </SlidePanel>
        <SlidePanel isOpen={true} onClose={() => undefined} title="Second Panel">
          Second
        </SlidePanel>
      </>,
    );

    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <>
        <SlidePanel isOpen={false} onClose={() => undefined} title="First Panel">
          First
        </SlidePanel>
        <SlidePanel isOpen={true} onClose={() => undefined} title="Second Panel">
          Second
        </SlidePanel>
      </>,
    );

    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <>
        <SlidePanel isOpen={false} onClose={() => undefined} title="First Panel">
          First
        </SlidePanel>
        <SlidePanel isOpen={false} onClose={() => undefined} title="Second Panel">
          Second
        </SlidePanel>
      </>,
    );

    expect(document.body.style.overflow).toBe('scroll');
  });
});
