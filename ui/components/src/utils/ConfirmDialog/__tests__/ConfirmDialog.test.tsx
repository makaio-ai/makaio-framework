// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog, type ConfirmDialogProps } from '../ConfirmDialog.js';

function installDialogStubs() {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
  }

  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
  }
}

installDialogStubs();

describe('ConfirmDialog', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('associates the title and descriptive text with the dialog and keeps the checkbox controlled', () => {
    const onDontAskAgainChange = vi.fn();
    const props: ConfirmDialogProps = {
      isOpen: true,
      title: 'Confirm Action',
      message: 'Choose carefully.',
      details: 'Extra detail.',
      showDontAskAgain: true,
      dontAskAgain: false,
      onDontAskAgainChange,
      options: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'save', label: 'Save', variant: 'primary' },
      ],
      onSelect: vi.fn(),
    };

    render(<ConfirmDialog {...props} />);

    const dialog = screen.getByRole('dialog', { name: 'Confirm Action' });
    const title = screen.getByRole('heading', { level: 2, name: 'Confirm Action' });
    const message = screen.getByText('Choose carefully.');
    const details = screen.getByText('Extra detail.');

    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(`${message.id} ${details.id}`);

    fireEvent.click(screen.getByRole('checkbox', { name: /do not show this warning again/i }));
    expect(onDontAskAgainChange).toHaveBeenCalledWith(true);
  });
});
