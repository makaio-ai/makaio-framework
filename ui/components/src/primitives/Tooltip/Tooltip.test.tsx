// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from './Tooltip.js';

describe('Tooltip', () => {
  it('stays visible when focus moves within the trigger subtree', async () => {
    render(
      <Tooltip content="Helpful details" delay={0}>
        <div>
          <button type="button">First</button>
          <button type="button">Second</button>
        </div>
      </Tooltip>,
    );

    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    const triggerWrapper = document.querySelector('[data-component="Tooltip"]') as HTMLDivElement;

    fireEvent.mouseEnter(triggerWrapper);
    expect(await screen.findByRole('tooltip')).toBeTruthy();

    fireEvent.focusOut(first, { relatedTarget: second });
    fireEvent.focusIn(second, { relatedTarget: first });

    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('stays visible on mouse leave while focus remains inside the trigger', async () => {
    render(
      <Tooltip content="Helpful details" delay={0}>
        <div>
          <button type="button">First</button>
        </div>
      </Tooltip>,
    );

    const first = screen.getByRole('button', { name: 'First' });
    const triggerWrapper = document.querySelector('[data-component="Tooltip"]') as HTMLDivElement;

    first.focus();
    fireEvent.mouseEnter(triggerWrapper);

    expect(await screen.findByRole('tooltip')).toBeTruthy();

    fireEvent.mouseLeave(triggerWrapper);

    expect(screen.getByRole('tooltip')).toBeTruthy();
  });
});
