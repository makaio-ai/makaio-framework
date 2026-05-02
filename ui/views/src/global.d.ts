/**
 * Framework-tier window globals used by ui-views.
 *
 * `__MAKAIO_MOBILE__` is a runtime flag injected by mobile host shells to
 * signal that the current surface is mobile. It controls navigation surface
 * selection in the Sidebar and similar shell-aware components.
 */
interface Window {
  /**
   * Optional flag set by mobile host environments.
   * When `true`, UI components switch to mobile surface mode.
   */
  __MAKAIO_MOBILE__?: boolean;
}
