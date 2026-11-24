import {
  encodeMaterializeAliasCalldata,
  isTz4Address,
  isValidTezosXAddress,
} from './codec';
import type { NetworkConfig } from './types';

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface DiscoveredProvider {
  rdns: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
}

export interface WalletPreference {
  rdns: string;
  providerName: string;
}

export interface ConnectedEvmWallet {
  address: string;
  chainId: number;
  providerName: string;
  rdns: string;
  provider: Eip1193Provider;
}

export interface WalletEventHandlers {
  onAccountsChanged: (accounts: string[]) => void;
  onChainChanged: (chainId: number) => void;
}

export const WALLET_STORAGE_KEY = 'nacbench:evmWallet';

interface Eip6963AnnounceEvent extends Event {
  detail?: {
    info?: { rdns?: string; name?: string; icon?: string };
    provider?: Eip1193Provider;
  };
}

const discoveredMap = new Map<string, DiscoveredProvider>();
const announceListeners = new Set<() => void>();
let listenedWindow: Window | null = null;
let isDispatchingRequest = false;
let hasRequestedOnCurrentWindow = false;
let notifyScheduled = false;

function scheduleAnnounceNotify(): void {
  if (notifyScheduled || announceListeners.size === 0) return;
  notifyScheduled = true;
  const run = () => {
    notifyScheduled = false;
    for (const listener of Array.from(announceListeners)) {
      listener();
    }
  };
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(run);
  } else {
    void Promise.resolve().then(run);
  }
}

function safeGetLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore restricted storage contexts
  }
  return null;
}

export function saveWalletPreference(pref: WalletPreference): void {
  const storage = safeGetLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(
      WALLET_STORAGE_KEY,
      JSON.stringify({ rdns: pref.rdns, providerName: pref.providerName }),
    );
  } catch {
    // ignore storage quota/privacy mode errors
  }
}

export function loadWalletPreference(): WalletPreference | null {
  const storage = safeGetLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(WALLET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WalletPreference>;
    if (
      typeof parsed?.rdns === 'string' &&
      parsed.rdns.trim().length > 0 &&
      typeof parsed?.providerName === 'string' &&
      parsed.providerName.trim().length > 0
    ) {
      return { rdns: parsed.rdns.trim(), providerName: parsed.providerName.trim() };
    }
  } catch {
    // ignore corrupt storage entries
  }
  return null;
}

export function clearWalletPreference(): void {
  const storage = safeGetLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(WALLET_STORAGE_KEY);
  } catch {
    // ignore restricted storage contexts
  }
}

export function resetWalletDiscoveryForTests(): void {
  discoveredMap.clear();
  announceListeners.clear();
  listenedWindow = null;
  isDispatchingRequest = false;
  hasRequestedOnCurrentWindow = false;
  notifyScheduled = false;
}

function ensureEip6963Listener(): void {
  if (typeof window === 'undefined' || listenedWindow === window) return;
  listenedWindow = window;
  hasRequestedOnCurrentWindow = false;
  window.addEventListener('eip6963:announceProvider', (rawEvent: Event) => {
    const event = rawEvent as Eip6963AnnounceEvent;
    const info = event.detail?.info;
    const provider = event.detail?.provider;
    if (info?.rdns && info?.name && provider) {
      const existing = discoveredMap.get(info.rdns);
      const changed =
        !existing ||
        existing.provider !== provider ||
        existing.name !== info.name ||
        existing.icon !== info.icon;
      discoveredMap.set(info.rdns, {
        rdns: info.rdns,
        name: info.name,
        icon: info.icon,
        provider,
      });
      if (changed) {
        scheduleAnnounceNotify();
      }
    }
  });
}

export function onEip6963Announce(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  ensureEip6963Listener();
  announceListeners.add(listener);
  return () => {
    announceListeners.delete(listener);
  };
}

/**
 * Pure read-only snapshot of discovered EIP-6963 providers (+ window.ethereum fallback).
 * NEVER dispatches `eip6963:requestProvider`, so it is safe to call inside event listeners.
 */
export function getDiscoveredEip6963Providers(): DiscoveredProvider[] {
  if (typeof window === 'undefined') return [];
  ensureEip6963Listener();

  const list = Array.from(discoveredMap.values());
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (list.length === 0 && injected && typeof injected.request === 'function') {
    list.push({
      rdns: 'injected.ethereum',
      name: 'Browser Wallet (window.ethereum)',
      provider: injected,
    });
  }
  return list;
}

/**
 * Broadcast a single `eip6963:requestProvider` event with re-entrancy protection.
 */
export function requestEip6963Providers(): void {
  if (typeof window === 'undefined' || isDispatchingRequest) return;
  ensureEip6963Listener();
  isDispatchingRequest = true;
  hasRequestedOnCurrentWindow = true;
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } finally {
    isDispatchingRequest = false;
  }
}

export function discoverEip6963Providers(options?: { request?: boolean }): DiscoveredProvider[] {
  if (typeof window === 'undefined') return [];
  ensureEip6963Listener();
  if (options?.request === true || (options?.request !== false && !hasRequestedOnCurrentWindow)) {
    requestEip6963Providers();
  }
  return getDiscoveredEip6963Providers();
}

function parseChainId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = raw.startsWith('0x') || raw.startsWith('0X')
      ? parseInt(raw, 16)
      : parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export async function connectEvmWallet(rdns?: string): Promise<ConnectedEvmWallet> {
  let providers = getDiscoveredEip6963Providers();
  if (providers.length === 0) {
    requestEip6963Providers();
    providers = getDiscoveredEip6963Providers();
  }
  const chosen = rdns
    ? providers.find((p) => p.rdns === rdns) ?? providers[0]
    : providers[0];

  if (!chosen) {
    throw new Error(
      'No EIP-6963 or injected EVM wallet detected. Install MetaMask, Rabby, or another EVM wallet.',
    );
  }

  const accounts = (await chosen.provider.request({
    method: 'eth_requestAccounts',
  })) as string[];

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Wallet returned no authorized EVM accounts.');
  }

  const chainHex = (await chosen.provider.request({
    method: 'eth_chainId',
  })) as string;

  saveWalletPreference({ rdns: chosen.rdns, providerName: chosen.name });

  return {
    address: accounts[0],
    chainId: parseChainId(chainHex) ?? 0,
    providerName: chosen.name,
    rdns: chosen.rdns,
    provider: chosen.provider,
  };
}

/**
 * Silently restore a previously connected EVM wallet session on reload.
 * Uses `eth_accounts` (never `eth_requestAccounts`) so no wallet popup is triggered.
 */
export async function restoreEvmWalletSession(): Promise<ConnectedEvmWallet | null> {
  const pref = loadWalletPreference();
  if (!pref) return null;

  let providers = getDiscoveredEip6963Providers();
  if (providers.length === 0 && !hasRequestedOnCurrentWindow) {
    requestEip6963Providers();
    providers = getDiscoveredEip6963Providers();
  }
  let chosen = providers.find((p) => p.rdns === pref.rdns);

  if (
    !chosen &&
    (pref.rdns === 'injected' || pref.rdns === 'injected.ethereum') &&
    providers.length === 1
  ) {
    chosen = providers[0];
  }

  if (!chosen) return null;

  try {
    const accounts = (await chosen.provider.request({
      method: 'eth_accounts',
    })) as string[];

    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') {
      return null;
    }

    const chainHex = (await chosen.provider.request({
      method: 'eth_chainId',
    })) as string;

    return {
      address: accounts[0],
      chainId: parseChainId(chainHex) ?? 0,
      providerName: chosen.name,
      rdns: chosen.rdns,
      provider: chosen.provider,
    };
  } catch {
    return null;
  }
}

export function subscribeWalletEvents(
  provider: Eip1193Provider,
  handlers: WalletEventHandlers,
): () => void {
  const handleAccounts = (raw: unknown) => {
    const list = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    handlers.onAccountsChanged(list);
  };

  const handleChain = (raw: unknown) => {
    const parsed = parseChainId(raw);
    if (parsed !== null) {
      handlers.onChainChanged(parsed);
    }
  };

  provider.on?.('accountsChanged', handleAccounts);
  provider.on?.('chainChanged', handleChain);

  return () => {
    provider.removeListener?.('accountsChanged', handleAccounts);
    provider.removeListener?.('chainChanged', handleChain);
  };
}

export async function switchEvmChain(
  provider: Eip1193Provider,
  network: NetworkConfig,
): Promise<void> {
  const chainIdHex = '0x' + network.evm.chainId.toString(16);
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainIdHex,
            chainName: network.label,
            nativeCurrency: {
              name: 'Tez',
              symbol: 'XTZ',
              decimals: 18,
            },
            rpcUrls: [network.evm.rpcUrl],
            blockExplorerUrls: [network.evm.explorerUrl],
          },
        ],
      });
      return;
    }
    throw err;
  }
}

export async function sendMaterializeAliasEvmTx(
  provider: Eip1193Provider,
  network: NetworkConfig,
  tzAddress: string,
  publicKey: string,
): Promise<string> {
  const trimmedAddr = tzAddress.trim();
  const trimmedPk = publicKey.trim();

  if (isTz4Address(trimmedAddr)) {
    throw new Error('BLS tz4 addresses cannot be materialized on Tezos X Michelson runtime.');
  }
  if (!isValidTezosXAddress(trimmedAddr)) {
    throw new Error(`Invalid Tezos X address: '${tzAddress}'`);
  }
  if (/^tz[123]/.test(trimmedAddr) && !trimmedPk) {
    throw new Error(
      'Horus 8.0 requires the Base58Check public key (edpk/sppk/p2pk) to materialize a tz1/tz2/tz3 Safe-CREATE2 alias.',
    );
  }

  const currentChainHex = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(currentChainHex, 16) !== network.evm.chainId) {
    await switchEvmChain(provider, network);
  }

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const from = accounts?.[0];
  if (!from) {
    throw new Error('Connect your EVM wallet before sending a materializeAlias transaction.');
  }

  const data = encodeMaterializeAliasCalldata('tezos', trimmedAddr, trimmedPk);
  const gasHex = '0x' + network.evm.nacRecommendedGas.toString(16);

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from,
        to: network.evm.precompile,
        data,
        gas: gasHex,
      },
    ],
  })) as string;

  return txHash;
}
