// @vitest-environment jsdom
/**
 * Test suite for GlassPanel component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GlassPanel } from './GlassPanel.js';

describe('GlassPanel', () => {
  it('renders children content', () => {
    render(<GlassPanel>Test content</GlassPanel>);

    expect(screen.getByText('Test content')).toBeTruthy();
  });

  it('has data-component attribute', () => {
    const { container } = render(<GlassPanel>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel).toBeTruthy();
  });

  it('applies glass panel base styles', () => {
    const { container } = render(<GlassPanel>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).toContain('glassPanel');
  });

  it('does not apply hoverable class by default', () => {
    const { container } = render(<GlassPanel>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).not.toContain('hoverable');
  });

  it('applies hoverable class when hoverable prop is true', () => {
    const { container } = render(<GlassPanel hoverable={true}>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).toContain('hoverable');
  });

  it('applies custom className when provided', () => {
    const { container } = render(<GlassPanel className="custom-class">Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).toContain('custom-class');
  });

  it('combines multiple class names correctly', () => {
    const { container } = render(
      <GlassPanel hoverable={true} className="custom-class">
        Content
      </GlassPanel>,
    );

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).toContain('glassPanel');
    expect(panel?.className).toContain('hoverable');
    expect(panel?.className).toContain('custom-class');
  });

  it('renders complex children', () => {
    render(
      <GlassPanel>
        <div data-testid="child-1">Child 1</div>
        <div data-testid="child-2">Child 2</div>
        <button>Click me</button>
      </GlassPanel>,
    );

    expect(screen.getByTestId('child-1')).toBeTruthy();
    expect(screen.getByTestId('child-2')).toBeTruthy();
    expect(screen.getByText('Click me')).toBeTruthy();
  });

  it('forwards ref to div element', () => {
    const ref = { current: null as HTMLDivElement | null };

    const TestComponent = () => {
      return <GlassPanel ref={ref}>Content</GlassPanel>;
    };

    render(<TestComponent />);

    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.textContent).toBe('Content');
  });

  it('passes through HTML div attributes', () => {
    const onClick = vi.fn();
    const { container } = render(
      <GlassPanel onClick={onClick} data-custom="value" aria-label="Glass panel">
        Content
      </GlassPanel>,
    );

    const panel = container.querySelector('[data-component="GlassPanel"]') as HTMLDivElement;
    expect(panel.getAttribute('data-custom')).toBe('value');
    expect(panel.getAttribute('aria-label')).toBe('Glass panel');

    panel.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders with id attribute', () => {
    const { container } = render(<GlassPanel id="my-panel">Content</GlassPanel>);

    const panel = container.querySelector('#my-panel');
    expect(panel).toBeTruthy();
  });

  it('renders with role attribute', () => {
    const { container } = render(<GlassPanel role="dialog">Content</GlassPanel>);

    const panel = container.querySelector('[role="dialog"]');
    expect(panel).toBeTruthy();
  });

  it('handles empty children', () => {
    const { container } = render(<GlassPanel>{null}</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel).toBeTruthy();
    expect(panel?.textContent).toBe('');
  });

  it('handles string children', () => {
    render(<GlassPanel>Simple text</GlassPanel>);

    expect(screen.getByText('Simple text')).toBeTruthy();
  });

  it('handles number children', () => {
    render(<GlassPanel>{42}</GlassPanel>);

    expect(screen.getByText('42')).toBeTruthy();
  });

  it('supports nested GlassPanels', () => {
    const { container } = render(
      <GlassPanel className="outer">
        <GlassPanel className="inner">Nested content</GlassPanel>
      </GlassPanel>,
    );

    const panels = container.querySelectorAll('[data-component="GlassPanel"]');
    expect(panels).toHaveLength(2);
    expect(panels[0]?.className).toContain('outer');
    expect(panels[1]?.className).toContain('inner');
  });

  it('ref works with callback pattern', () => {
    let capturedRef: HTMLDivElement | null = null;

    const ParentComponent = () => {
      return (
        <GlassPanel
          ref={(el) => {
            capturedRef = el;
          }}
        >
          Content
        </GlassPanel>
      );
    };

    render(<ParentComponent />);

    expect(capturedRef).toBeInstanceOf(HTMLDivElement);
  });

  it('applies hoverable=false explicitly', () => {
    const { container } = render(<GlassPanel hoverable={false}>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).not.toContain('hoverable');
  });

  it('renders as a div element', () => {
    const { container } = render(<GlassPanel>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.tagName).toBe('DIV');
  });

  it('maintains className order', () => {
    const { container } = render(
      <GlassPanel hoverable={true} className="z-10 bg-red-500">
        Content
      </GlassPanel>,
    );

    const panel = container.querySelector('[data-component="GlassPanel"]');
    const classString = panel?.className || '';

    // Should contain all classes
    expect(classString).toContain('glassPanel');
    expect(classString).toContain('hoverable');
    expect(classString).toContain('z-10 bg-red-500');
  });

  it('handles undefined className gracefully', () => {
    const { container } = render(<GlassPanel className={undefined}>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]');
    expect(panel?.className).toContain('glassPanel');
  });

  it('renders with tabIndex for keyboard navigation', () => {
    const { container } = render(<GlassPanel tabIndex={0}>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]') as HTMLDivElement;
    expect(panel.tabIndex).toBe(0);
  });

  it('supports onMouseEnter and onMouseLeave events', () => {
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();

    const { container } = render(
      <GlassPanel onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        Content
      </GlassPanel>,
    );

    const panel = container.querySelector('[data-component="GlassPanel"]') as HTMLDivElement;

    fireEvent.mouseEnter(panel);
    expect(onMouseEnter).toHaveBeenCalledOnce();

    fireEvent.mouseLeave(panel);
    expect(onMouseLeave).toHaveBeenCalledOnce();
  });

  it('supports keyboard events', () => {
    const onKeyDown = vi.fn();

    const { container } = render(<GlassPanel onKeyDown={onKeyDown}>Content</GlassPanel>);

    const panel = container.querySelector('[data-component="GlassPanel"]') as HTMLDivElement;

    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
