/**
 * \@makaio/ui-components
 *
 * Pure presentational React components for the Makaio framework.
 * Props in, callbacks out — no bus, no stores, no providers.
 * @packageDocumentation
 */

export { auraTheme, defaultThemeId, ThemeContext, ThemeProvider, themes, useTheme } from './themes/index.js';
export type { Theme, ThemeContextValue } from './themes/index.js';
export { Logo } from './branding/Logo/index.js';
export type { LogoProps, LogoVariant } from './branding/Logo/index.js';
export {
  AppShell,
  ContentHeader,
  GlassPanel,
  HeaderIconAction,
  HeaderTextAction,
  IconSidebar,
  ListPage,
  NavSidebar,
  Page,
  SlotPanel,
  SplitPane,
  Topbar,
} from './layout/index.js';
export type {
  AppShellProps,
  BreadcrumbItem,
  ContentHeaderProps,
  GlassPanelProps,
  HeaderActionElement,
  HeaderIconActionProps,
  HeaderTextActionProps,
  IconSidebarProps,
  LeafPane,
  ListPageProps,
  NavItem,
  NavSidebarItem,
  NavSidebarLinkRenderer,
  NavSidebarProps,
  NavSidebarSection,
  PageProps,
  Pane,
  PaneContent,
  PaneSizeConstraints,
  SlotPanelPadding,
  SlotPanelProps,
  SplitPaneProps,
  SplitPaneType,
  TopbarProps,
} from './layout/index.js';
export {
  Badge,
  Button,
  ButtonGroupFilter,
  CollapsibleGroup,
  CollapsibleSection,
  ContextMenu,
  Dropdown,
  FilterChipGroup,
  Icon,
  IconButton,
  Input,
  isIconName,
  ModalPortal,
  Panel,
  Popover,
  Textarea,
  Toggle,
  Tooltip,
  useCollapsibleGroup,
} from './primitives/index.js';
export type {
  BadgeProps,
  BadgeSize,
  BadgeVariant,
  ButtonGroupFilterProps,
  ButtonGroupOption,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  CategoryConfig,
  CollapsibleContextValue,
  CollapsibleGroupMode,
  CollapsibleGroupProps,
  CollapsibleSectionProps,
  ContextMenuAction,
  ContextMenuProps,
  DropdownItem,
  DropdownProps,
  FilterChipGroupProps,
  FilterOption,
  IconButtonProps,
  IconButtonSize,
  IconButtonVariant,
  IconName,
  IconProps,
  InputProps,
  InputSize,
  ModalPortalProps,
  PanelPadding,
  PanelProps,
  PanelVariant,
  PopoverProps,
  TextareaProps,
  ToggleProps,
  ToggleSize,
  TooltipPosition,
  TooltipProps,
} from './primitives/index.js';
export {
  AlertTriangleIcon,
  ArchiveIcon,
  AttachmentIcon,
  ChatBubbleIcon,
  ChevronIcon,
  CloseIcon,
  CompressIcon,
  DEFAULT_ICON_PROPS,
  ForkIcon,
  GitBranchIcon,
  GripVerticalIcon,
  KebabMenuIcon,
  MessagesSquareIcon,
  PlusIcon,
  RestoreIcon,
  SearchIcon,
  SendIcon,
  SpinnerIcon,
  TrashIcon,
  UnlinkIcon,
  WrenchIcon,
} from './icons/index.js';
export type { ChevronIconProps, SVGIconProps } from './icons/index.js';
export { ConfirmDialog, FatalErrorDialog, PromptDialog, ResizablePanel, SlidePanel } from './utils/index.js';
export type {
  ConfirmDialogOption,
  ConfirmDialogProps,
  FatalErrorDialogAction,
  FatalErrorDialogProps,
  PromptDialogProps,
  ResizablePanelOrientation,
  ResizablePanelProps,
  SlidePanelProps,
} from './utils/index.js';
export { MultiActionToast } from './toast/index.js';
export type { MultiActionToastProps } from './toast/index.js';
export { useEscapeKey, useBodyScrollLock, useFocusOnOpen, useFocusTrap } from './utils/dom-hooks.js';
