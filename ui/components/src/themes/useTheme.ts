import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from './ThemeProvider.js';

/**
 * Hook to access theme context
 * @returns Theme context value
 * @throws If used outside ThemeProvider
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
