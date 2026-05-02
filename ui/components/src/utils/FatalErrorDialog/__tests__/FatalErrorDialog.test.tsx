/**
 * Test suite for FatalErrorDialog component.
 *
 * \@vitest-environment jsdom
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FatalErrorDialog } from '../FatalErrorDialog.js';
import type { FatalErrorDialogProps } from '../FatalErrorDialog.js';

/**
 * Default props used across tests. Override per-test as needed.
 */
const defaultProps: FatalErrorDialogProps = {
  isOpen: true,
  title: 'Fatal Error',
  message: 'An unrecoverable error occurred.',
  actions: [
    { id: 'reload', label: 'Reload', variant: 'primary' },
    { id: 'dismiss', label: 'Dismiss', variant: 'secondary' },
  ],
  onAction: vi.fn(),
};

/**
 * jsdom does not implement showModal/close on HTMLDialogElement. We define
 * them as configurable stubs so that vi.spyOn can intercept them.
 *
 * Original property descriptors are captured before patching and restored in
 * afterAll so that other suites run in a clean prototype state.
 */
let originalShowModal: PropertyDescriptor | undefined;
let originalClose: PropertyDescriptor | undefined;

function installDialogStubs() {
  originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

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

function restoreDialogStubs() {
  if (originalShowModal !== undefined) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  } else {
    // The property did not exist before — delete the stub entirely.

    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  }

  if (originalClose !== undefined) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  } else {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  }
}

describe('FatalErrorDialog', () => {
  beforeAll(() => {
    installDialogStubs();
  });

  afterAll(() => {
    restoreDialogStubs();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders an open dialog when isOpen is true', () => {
    const { container } = render(<FatalErrorDialog {...defaultProps} isOpen={true} />);
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
  });

  it('renders a closed dialog when isOpen is false', () => {
    const { container } = render(<FatalErrorDialog {...defaultProps} isOpen={false} />);
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(false);
  });

  it('renders data-component="FatalErrorDialog"', () => {
    const { container } = render(<FatalErrorDialog {...defaultProps} />);

    expect(container.querySelector('[data-component="FatalErrorDialog"]')).toBeTruthy();
  });

  it('fires onAction with the correct action id when a button is clicked', () => {
    const onAction = vi.fn();
    render(<FatalErrorDialog {...defaultProps} onAction={onAction} />);

    const reloadButton = screen.getByText('Reload');
    expect(reloadButton.getAttribute('type')).toBe('button');
    fireEvent.click(reloadButton);

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith('reload');
  });

  it('fires onAction with secondary action id when secondary button is clicked', () => {
    const onAction = vi.fn();
    render(<FatalErrorDialog {...defaultProps} onAction={onAction} />);

    fireEvent.click(screen.getByText('Dismiss'));

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith('dismiss');
  });

  it('prevents Escape key dismissal via cancel event', () => {
    const { container } = render(<FatalErrorDialog {...defaultProps} />);
    const dialog = container.querySelector('[data-component="FatalErrorDialog"]') as HTMLDialogElement;

    const cancelEvent = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);

    // The handler calls preventDefault — the event should be cancelled
    expect(cancelEvent.defaultPrevented).toBe(true);
  });

  it('renders title and message', () => {
    render(<FatalErrorDialog {...defaultProps} />);

    expect(screen.getByText('Fatal Error')).toBeTruthy();
    expect(screen.getByText('An unrecoverable error occurred.')).toBeTruthy();
  });

  it('associates dialog with title via aria-labelledby', () => {
    const { container } = render(<FatalErrorDialog {...defaultProps} />);
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    const title = screen.getByRole('heading', { level: 2, name: 'Fatal Error' });

    expect(title.id).not.toBe('');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  });

  it('renders technical details in a collapsible section when provided', () => {
    render(<FatalErrorDialog {...defaultProps} details="TypeError: Cannot read property 'x' of undefined" />);

    expect(screen.getByText('Technical details')).toBeTruthy();
    expect(screen.getByText("TypeError: Cannot read property 'x' of undefined")).toBeTruthy();
  });

  it('does not render details section when details prop is omitted', () => {
    render(<FatalErrorDialog {...defaultProps} details={undefined} />);

    expect(screen.queryByText('Technical details')).toBeNull();
  });

  it('throws when rendered without any actions', () => {
    const emptyActions = JSON.parse('[]') as FatalErrorDialogProps['actions'];

    expect(() => render(<FatalErrorDialog {...defaultProps} actions={emptyActions} />)).toThrow(
      'FatalErrorDialog requires at least one action.',
    );
  });
});
