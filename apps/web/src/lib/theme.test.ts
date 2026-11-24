import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredTheme,
  initTheme,
  resolveInitialTheme,
  subscribeSystemTheme,
  toggleTheme,
} from './theme';

function createMockEnvironment(systemPrefersLight: boolean) {
  const store = new Map<string, string>();
  let matchesLight = systemPrefersLight;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();

  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };

  const matchMedia = vi.fn(() => ({
    get matches() {
      return matchesLight;
    },
    addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
  }));

  const classes = new Set<string>();
  const rootEl = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: '' },
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      has: (name: string) => classes.has(name),
    },
  };

  vi.stubGlobal('window', { localStorage, matchMedia });
  vi.stubGlobal('document', { documentElement: rootEl });

  return {
    store,
    rootEl,
    emitSystemChange(nextLight: boolean) {
      matchesLight = nextLight;
      const evt = { matches: nextLight } as MediaQueryListEvent;
      for (const cb of listeners) cb(evt);
    },
  };
}

describe('theme — OS preference resolution, localStorage persistence, and live system tracking', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to OS prefers-color-scheme on first visit when no stored override exists', () => {
    const envLight = createMockEnvironment(true);
    expect(getStoredTheme()).toBeNull();
    expect(resolveInitialTheme()).toBe('light');
    expect(initTheme()).toBe('light');
    expect(envLight.rootEl.dataset.theme).toBe('light');
    expect(envLight.rootEl.style.colorScheme).toBe('light');
    expect(envLight.rootEl.classList.has('dark')).toBe(false);

    const envDark = createMockEnvironment(false);
    expect(initTheme()).toBe('dark');
    expect(envDark.rootEl.dataset.theme).toBe('dark');
    expect(envDark.rootEl.style.colorScheme).toBe('dark');
    expect(envDark.rootEl.classList.has('dark')).toBe(true);
  });

  it('toggles dark <-> light, persists to nacbench:theme, and respects stored preference over OS', () => {
    const env = createMockEnvironment(false);
    initTheme();
    const next = toggleTheme('dark');
    expect(next).toBe('light');
    expect(env.store.get(THEME_STORAGE_KEY)).toBe('light');
    expect(env.rootEl.dataset.theme).toBe('light');
    expect(resolveInitialTheme()).toBe('light');

    const back = toggleTheme('light');
    expect(back).toBe('dark');
    expect(env.store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(env.rootEl.dataset.theme).toBe('dark');
  });

  it('tracks live OS theme changes only when user has not explicitly saved an override', () => {
    const env = createMockEnvironment(false);
    const seen: string[] = [];
    const unsubscribe = subscribeSystemTheme((t) => seen.push(t));

    // No stored override -> OS change updates theme live
    env.emitSystemChange(true);
    expect(seen).toEqual(['light']);
    expect(env.rootEl.dataset.theme).toBe('light');

    // User manually toggles -> OS changes must NOT override manual choice
    toggleTheme('light');
    expect(env.rootEl.dataset.theme).toBe('dark');
    env.emitSystemChange(true);
    expect(seen).toEqual(['light']);
    expect(env.rootEl.dataset.theme).toBe('dark');

    applyTheme('dark');
    unsubscribe();
  });
});
