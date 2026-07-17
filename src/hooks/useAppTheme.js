import { useContext, useMemo } from 'react';
import { ThemeContext } from '../theme/ThemeContext.js';
import { buildColors } from '../theme/buildColors.js';
import { buildStyles, buildGlobalStyles } from '../theme/buildStyles.js';

export function useAppTheme() {
  const { theme, setTheme } = useContext(ThemeContext);
  const C = useMemo(() => buildColors(theme), [theme]);
  const S = useMemo(() => buildStyles(C), [C]);
  const G = useMemo(() => buildGlobalStyles(C), [C]);
  return { C, S, G, theme, setTheme };
}