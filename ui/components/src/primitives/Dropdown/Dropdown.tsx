import { type ReactElement, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './Dropdown.module.scss';

/**
 * Dropdown item definition
 * Represents a single menu item with optional icon, label, shortcut, and click handler
 */
export interface DropdownItem {
  /** Unique identifier for the item */
  id: string;
  /** Optional icon element to display */
  icon?: ReactNode;
  /** Display label text */
  label: string;
  /** Optional keyboard shortcut hint to display */
  shortcut?: string;
  /** Click event handler */
  onClick?: () => void;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * Dropdown component props
 */
export interface DropdownProps {
  /** Trigger element that opens the dropdown when clicked */
  trigger: ReactElement;
  /** Array of menu items or dividers */
  items: (DropdownItem | 'divider')[];
  /** Alignment of the dropdown relative to trigger */
  align?: 'start' | 'end';
  /**
   * Called when the dropdown open state changes.
   *
   * Use this to lazily initialise data that is only needed once the user
   * actually opens the menu (e.g. fetching per-item actions from the bus).
   * @param open - Whether the dropdown is now open
   */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Dropdown component
 *
 * Floating menu panel with trigger element.
 * Supports keyboard navigation (Arrow keys, Enter, Escape),
 * menu items with icons/labels/shortcuts, and dividers.
 * @param props - Dropdown component properties
 * @returns Dropdown component
 */
export function Dropdown({ trigger, items, align = 'start', onOpenChange }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Filter to only actionable items (not dividers)
  const actionableItems = items.filter((item): item is DropdownItem => item !== 'divider');

  /**
   * Close dropdown and reset selection
   */
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setSelectedIndex(0);
    onOpenChange?.(false);
  }, [onOpenChange]);

  /**
   * Toggle dropdown open state
   */
  const toggleDropdown = useCallback(() => {
    const next = !isOpen;
    setIsOpen(next);
    if (!next) {
      setSelectedIndex(0);
    }
    onOpenChange?.(next);
  }, [isOpen, onOpenChange]);

  /**
   * Handle keyboard navigation
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev < actionableItems.length - 1 ? prev + 1 : 0));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : actionableItems.length - 1));
          break;
        case 'Enter': {
          e.preventDefault();
          const selectedItem = actionableItems[selectedIndex];
          if (selectedItem && !selectedItem.disabled && selectedItem.onClick) {
            selectedItem.onClick();
            closeDropdown();
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          closeDropdown();
          break;
      }
    },
    [isOpen, selectedIndex, actionableItems, closeDropdown],
  );

  /**
   * Handle click outside to close
   */
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        closeDropdown();
      }
    },
    [closeDropdown],
  );

  /**
   * Handle trigger click
   */
  const handleTriggerClick = useCallback(() => {
    toggleDropdown();
  }, [toggleDropdown]);

  /**
   * Handle item click
   */
  const handleItemClick = useCallback(
    (item: DropdownItem) => {
      if (!item.disabled && item.onClick) {
        item.onClick();
        closeDropdown();
      }
    },
    [closeDropdown],
  );

  // Setup event listeners
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('mousedown', handleClickOutside);

      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen, handleKeyDown, handleClickOutside]);

  // Focus management
  useEffect(() => {
    if (isOpen && dropdownRef.current) {
      const firstItem = dropdownRef.current.querySelector('[data-dropdown-item]') as HTMLElement;
      firstItem?.focus();
    }
  }, [isOpen]);

  return (
    <div data-component="Dropdown" className={styles.dropdownContainer} ref={triggerRef}>
      <div
        onClick={handleTriggerClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleTriggerClick();
          }
        }}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        className={styles.triggerWrapper}
      >
        {trigger}
      </div>

      {isOpen && (
        <div
          id={menuId}
          ref={dropdownRef}
          className={`${styles.dropdownMenu} ${styles[align]}`}
          role="menu"
          tabIndex={-1}
        >
          {items.map((item, index) => {
            if (item === 'divider') {
              return <div key={`divider-${index}`} className={styles.divider} />;
            }

            const itemIndex = actionableItems.indexOf(item);
            const isSelected = itemIndex === selectedIndex;

            return (
              <button
                key={item.id}
                data-dropdown-item
                role="menuitem"
                tabIndex={isSelected ? 0 : -1}
                className={`${styles.menuItem} ${
                  item.disabled ? styles.disabled : ''
                } ${isSelected ? styles.selected : ''}`}
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
              >
                {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                <span className={styles.itemLabel}>{item.label}</span>
                {item.shortcut && <span className={styles.itemShortcut}>{item.shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
