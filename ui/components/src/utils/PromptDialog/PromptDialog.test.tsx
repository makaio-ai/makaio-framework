/**
 * \@vitest-environment jsdom
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PromptDialog } from './PromptDialog.js';

// jsdom does not implement showModal/close on HTMLDialogElement.
// Capture the originals (undefined in jsdom) so afterAll can restore them and
// prevent these stubs from leaking into other test files.
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

describe('PromptDialog', () => {
  it('wires data-component and accessible labels for single-line input', () => {
    const { container } = render(
      <PromptDialog
        isOpen
        title="Add Comment"
        message="Enter your comment for this line."
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );

    const dialog = container.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('data-component')).toBe('PromptDialog');

    const title = screen.getByRole('heading', { name: 'Add Comment' });
    const message = screen.getByText('Enter your comment for this line.');
    const input = screen.getByRole('textbox');

    expect(input.getAttribute('aria-labelledby')).toBe(title.id);
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
  });

  it('includes hint text in aria-describedby for multiline input', () => {
    render(
      <PromptDialog
        isOpen
        title="Add Comment"
        message="Enter your comment for this line."
        multiline
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );

    const message = screen.getByText('Enter your comment for this line.');
    const hint = screen.getByText(/Press .*Enter to submit/);
    const textarea = screen.getByRole('textbox');

    expect(textarea.getAttribute('aria-describedby')).toBe(`${message.id} ${hint.id}`);
  });
});
