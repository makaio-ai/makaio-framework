// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MultiActionToast } from '../MultiActionToast.js';

describe('MultiActionToast', () => {
  const basePayload = {
    toastId: 'toast-1',
    level: 'warning' as const,
    message: 'You have unsaved changes.',
    actions: [
      { id: 'save', label: 'Save', variant: 'default' as const },
      { id: 'discard', label: 'Discard', variant: 'destructive' as const },
    ],
  };

  it('renders with data-component attribute', () => {
    const { container } = render(<MultiActionToast payload={basePayload} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(container.querySelector('[data-component="MultiActionToast"]')).toBeTruthy();
  });

  it('renders message content', () => {
    const { getByText } = render(<MultiActionToast payload={basePayload} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(getByText('You have unsaved changes.')).toBeTruthy();
  });

  it('renders optional title when provided', () => {
    const payload = { ...basePayload, title: 'Unsaved Changes' };

    const { getByText } = render(<MultiActionToast payload={payload} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(getByText('Unsaved Changes')).toBeTruthy();
  });

  it('does not render title element when title is absent', () => {
    const { queryByText } = render(<MultiActionToast payload={basePayload} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(queryByText('Unsaved Changes')).toBeNull();
  });

  it('renders all action buttons', () => {
    const { getByText } = render(<MultiActionToast payload={basePayload} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(getByText('Save')).toBeTruthy();
    expect(getByText('Discard')).toBeTruthy();
  });

  it('renders a Dismiss button', () => {
    const { getByText } = render(<MultiActionToast payload={basePayload} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(getByText('Dismiss')).toBeTruthy();
  });

  it('calls onAction with correct actionId when action button is clicked', () => {
    const onAction = vi.fn();

    const { getByText } = render(<MultiActionToast payload={basePayload} onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(getByText('Save'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('save');
  });

  it('calls onDismiss when Dismiss button is clicked', () => {
    const onDismiss = vi.fn();

    const { getByText } = render(<MultiActionToast payload={basePayload} onAction={vi.fn()} onDismiss={onDismiss} />);

    fireEvent.click(getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders with empty actions array showing only Dismiss button', () => {
    const payload = { ...basePayload, actions: [] };

    const { getByText, queryByText } = render(
      <MultiActionToast payload={payload} onAction={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(getByText('Dismiss')).toBeTruthy();
    expect(queryByText('Save')).toBeNull();
  });
});
