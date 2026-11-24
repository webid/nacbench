export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'nacbench:theme';

function safeReadStorage(): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(THEME_STORAGE_KEY);
    }
  } catch {
    // ignore restricted storage errors
  }
  return null;
}

function safeWriteStorage(theme: Theme): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // ignore restricted storage errors
  }
}

export function getStoredTheme(): Theme | null {
  const raw = safeReadStorage();
  if (raw === 'light' || raw === 'dark') return raw;
  return null;
}

export function getSystemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveInitialTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.classList.toggle('dark', theme === 'dark');
}

export function initTheme(): Theme {
  const theme = resolveInitialTheme();
  applyTheme(theme);
  return theme;
}

export function setTheme(theme: Theme): void {
  safeWriteStorage(theme);
  applyTheme(theme);
}

export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/**
 * Track live OS prefers-color-scheme changes until the user explicitly stores a manual preference.
 */
export function subscribeSystemTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia('(prefers-color-scheme: light)');
  const listener = (event: MediaQueryListEvent) => {
    if (getStoredTheme() !== null) return;
    const next: Theme = event.matches ? 'light' : 'dark';
    applyTheme(next);
    onChange(next);
  };
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
