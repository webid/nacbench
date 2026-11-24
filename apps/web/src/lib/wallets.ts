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

interface Eip6963AnnounceEvent extends Event {
  detail?: {
    info?: { rdns?: string; name?: string; icon?: string };
    provider?: Eip1193Provider;
  };
}

const discoveredMap = new Map<string, DiscoveredProvider>();
let listenerInitialized = false;

function ensureEip6963Listener(): void {
  if (listenerInitialized || typeof window === 'undefined') return;
  listenerInitialized = true;
  window.addEventListener('eip6963:announceProvider', (rawEvent: Event) => {
    const event = rawEvent as Eip6963AnnounceEvent;
    const info = event.detail?.info;
    const provider = event.detail?.provider;
    if (info?.rdns && info?.name && provider) {
      discoveredMap.set(info.rdns, {
        rdns: info.rdns,
        name: info.name,
        icon: info.icon,
        provider,
      });
    }
  });
}

export function discoverEip6963Providers(): {
  rdns: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
}[] {
  if (typeof window === 'undefined') return [];
  ensureEip6963Listener();
  window.dispatchEvent(new Event('eip6963:requestProvider'));

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

export async function connectEvmWallet(rdns?: string): Promise<{
  address: string;
  chainId: number;
  providerName: string;
  provider: Eip1193Provider;
}> {
  const providers = discoverEip6963Providers();
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

  return {
    address: accounts[0],
    chainId: parseInt(chainHex, 16),
    providerName: chosen.name,
    provider: chosen.provider,
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
