import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WALLET_STORAGE_KEY,
  clearWalletPreference,
  connectEvmWallet,
  discoverEip6963Providers,
  getDiscoveredEip6963Providers,
  loadWalletPreference,
  onEip6963Announce,
  requestEip6963Providers,
  resetWalletDiscoveryForTests,
  restoreEvmWalletSession,
  saveWalletPreference,
  subscribeWalletEvents,
  type Eip1193Provider,
} from './wallets';

interface MockProviderHarness {
  provider: Eip1193Provider;
  requests: Array<{ method: string; params?: unknown[] | Record<string, unknown> }>;
  emit: (event: string, ...args: unknown[]) => void;
  listenerCount: (event: string) => number;
}

function createMockProvider(opts: {
  accounts?: string[];
  chainIdHex?: string;
}): MockProviderHarness {
  const requests: Array<{ method: string; params?: unknown[] | Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const provider: Eip1193Provider = {
    request: vi.fn(async (args) => {
      requests.push(args);
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
        return opts.accounts ?? [];
      }
      if (args.method === 'eth_chainId') {
        return opts.chainIdHex ?? '0x2352c'; // 144684 (Previewnet)
      }
      throw new Error(`Unexpected method ${args.method}`);
    }),
    on: (event, listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };

  return {
    provider,
    requests,
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) {
        cb(...args);
      }
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function createMockWindow(opts?: {
  injected?: Eip1193Provider;
  eip6963?: Array<{ rdns: string; name: string; provider: Eip1193Provider }>;
}) {
  const store = new Map<string, string>();
  const eventListeners = new Map<string, Set<(e: Event) => void>>();

  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };

  const announce = (info: { rdns: string; name: string }, provider: Eip1193Provider) => {
    const evt = { type: 'eip6963:announceProvider', detail: { info, provider } } as unknown as Event;
    for (const cb of eventListeners.get('eip6963:announceProvider') ?? []) {
      cb(evt);
    }
  };

  let requestProviderCount = 0;

  const win = {
    localStorage,
    ethereum: opts?.injected,
    addEventListener: (type: string, cb: (e: Event) => void) => {
      let set = eventListeners.get(type);
      if (!set) {
        set = new Set();
        eventListeners.set(type, set);
      }
      set.add(cb);
    },
    dispatchEvent: (event: Event) => {
      if (event.type === 'eip6963:requestProvider') {
        requestProviderCount++;
        if (requestProviderCount > 20) {
          throw new Error('Infinite eip6963:requestProvider event loop detected!');
        }
        if (opts?.eip6963) {
          for (const entry of opts.eip6963) {
            announce({ rdns: entry.rdns, name: entry.name }, entry.provider);
          }
        }
      }
      return true;
    },
  };

  vi.stubGlobal('window', win);
  return {
    store,
    announce,
    getRequestProviderCount: () => requestProviderCount,
  };
}

describe('wallets — silent reload restore, disconnect persistence, and provider events', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetWalletDiscoveryForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWalletDiscoveryForTests();
  });

  it('persists only rdns + providerName on connect and silently restores via eth_accounts on reload', async () => {
    const mm = createMockProvider({
      accounts: ['0x1111111111111111111111111111111111111111'],
      chainIdHex: '0x2352c',
    });
    const env = createMockWindow({
      eip6963: [{ rdns: 'io.metamask', name: 'MetaMask', provider: mm.provider }],
    });

    const connected = await connectEvmWallet('io.metamask');
    expect(connected.address).toBe('0x1111111111111111111111111111111111111111');
    expect(connected.chainId).toBe(144684);
    expect(connected.rdns).toBe('io.metamask');
    expect(connected.providerName).toBe('MetaMask');

    // Stored payload contains zero sensitive data (only rdns & providerName)
    const rawSaved = env.store.get(WALLET_STORAGE_KEY);
    expect(rawSaved).toBe(JSON.stringify({ rdns: 'io.metamask', providerName: 'MetaMask' }));
    expect(loadWalletPreference()).toEqual({ rdns: 'io.metamask', providerName: 'MetaMask' });

    // Simulate reload: reset discovery cache and call restoreEvmWalletSession
    mm.requests.length = 0;
    resetWalletDiscoveryForTests();

    const restored = await restoreEvmWalletSession();
    expect(restored).not.toBeNull();
    expect(restored?.address).toBe('0x1111111111111111111111111111111111111111');
    expect(restored?.chainId).toBe(144684);
    expect(restored?.rdns).toBe('io.metamask');
    expect(restored?.providerName).toBe('MetaMask');

    // Must use silent eth_accounts, NEVER eth_requestAccounts
    const methods = mm.requests.map((r) => r.method);
    expect(methods).toEqual(['eth_accounts', 'eth_chainId']);
    expect(methods).not.toContain('eth_requestAccounts');
  });

  it('prevents auto-reconnect after explicit disconnect via clearWalletPreference()', async () => {
    const injected = createMockProvider({
      accounts: ['0x2222222222222222222222222222222222222222'],
      chainIdHex: '0x2352c',
    });
    createMockWindow({ injected: injected.provider });

    saveWalletPreference({ rdns: 'injected.ethereum', providerName: 'Browser Wallet' });
    expect(loadWalletPreference()).not.toBeNull();

    // User clicks Disconnect -> clears preference
    clearWalletPreference();
    expect(loadWalletPreference()).toBeNull();

    // Subsequent reload must NOT reconnect or even query the wallet
    const restored = await restoreEvmWalletSession();
    expect(restored).toBeNull();
    expect(injected.requests).toHaveLength(0);
  });

  it('returns null without popup when silent eth_accounts returns empty array (locked/revoked)', async () => {
    const rabby = createMockProvider({ accounts: [] });
    createMockWindow({
      eip6963: [{ rdns: 'io.rabby', name: 'Rabby Wallet', provider: rabby.provider }],
    });

    saveWalletPreference({ rdns: 'io.rabby', providerName: 'Rabby Wallet' });
    const restored = await restoreEvmWalletSession();
    expect(restored).toBeNull();
    expect(rabby.requests.map((r) => r.method)).toEqual(['eth_accounts']);
  });

  it('notifies late EIP-6963 announcements and supports injected fallback preference', async () => {
    const mm = createMockProvider({
      accounts: ['0x3333333333333333333333333333333333333333'],
      chainIdHex: '0x2352c',
    });
    const env = createMockWindow({});
    saveWalletPreference({ rdns: 'injected', providerName: 'Injected' });

    // Before extension announces, restore returns null without clearing preference
    expect(await restoreEvmWalletSession()).toBeNull();
    expect(loadWalletPreference()).not.toBeNull();

    let announceHits = 0;
    const unsub = onEip6963Announce(() => {
      announceHits++;
    });
    env.announce({ rdns: 'io.metamask', name: 'MetaMask' }, mm.provider);
    await Promise.resolve();
    expect(announceHits).toBe(1);

    // Duplicate announcement of identical provider must not re-fire listeners
    env.announce({ rdns: 'io.metamask', name: 'MetaMask' }, mm.provider);
    await Promise.resolve();
    expect(announceHits).toBe(1);

    // Single discovered provider satisfies legacy 'injected' fallback
    const restored = await restoreEvmWalletSession();
    expect(restored?.address).toBe('0x3333333333333333333333333333333333333333');
    unsub();
  });

  it('never loops eip6963:requestProvider when a live wallet extension responds synchronously', async () => {
    const mm = createMockProvider({
      accounts: ['0x5555555555555555555555555555555555555555'],
      chainIdHex: '0x2352c',
    });
    const env = createMockWindow({
      eip6963: [{ rdns: 'io.metamask', name: 'MetaMask', provider: mm.provider }],
    });

    saveWalletPreference({ rdns: 'io.metamask', providerName: 'MetaMask' });

    let announceCallbacks = 0;
    let restoredAddr: string | null = null;

    // Mirrors App.tsx mount flow: subscribe to announce, broadcast ONCE, read & restore
    const unsub = onEip6963Announce(() => {
      announceCallbacks++;
      const list = getDiscoveredEip6963Providers();
      expect(list).toHaveLength(1);
      // Even a legacy discoverEip6963Providers() call must NOT re-broadcast requestProvider
      expect(discoverEip6963Providers()).toHaveLength(1);
      void restoreEvmWalletSession().then((res) => {
        if (res) restoredAddr = res.address;
      });
    });

    requestEip6963Providers();
    expect(getDiscoveredEip6963Providers()).toHaveLength(1);

    // Drain microtasks + promises
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(env.getRequestProviderCount()).toBe(1);
    expect(announceCallbacks).toBe(1);
    expect(restoredAddr).toBe('0x5555555555555555555555555555555555555555');
    expect(mm.requests.map((r) => r.method)).toEqual(['eth_accounts', 'eth_chainId']);
    unsub();
  });

  it('subscribes to accountsChanged and chainChanged and unsubscribes cleanly', () => {
    const mock = createMockProvider({});
    const accountsSeen: string[][] = [];
    const chainsSeen: number[] = [];

    const unsubscribe = subscribeWalletEvents(mock.provider, {
      onAccountsChanged: (accounts) => accountsSeen.push(accounts),
      onChainChanged: (chainId) => chainsSeen.push(chainId),
    });

    expect(mock.listenerCount('accountsChanged')).toBe(1);
    expect(mock.listenerCount('chainChanged')).toBe(1);

    mock.emit('accountsChanged', ['0x4444444444444444444444444444444444444444']);
    mock.emit('accountsChanged', []);
    mock.emit('chainChanged', '0x1f367'); // 127847

    expect(accountsSeen).toEqual([
      ['0x4444444444444444444444444444444444444444'],
      [],
    ]);
    expect(chainsSeen).toEqual([127847]);

    unsubscribe();
    expect(mock.listenerCount('accountsChanged')).toBe(0);
    expect(mock.listenerCount('chainChanged')).toBe(0);
  });
});
