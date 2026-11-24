import { useCallback, useEffect, useRef, useState } from 'react';
import { Binary, ExternalLink, Fingerprint, Flame } from 'lucide-react';
import { AliasInspectorModule } from './components/AliasInspectorModule';
import { CanaryLabModule } from './components/CanaryLabModule';
import { CodecModule } from './components/CodecModule';
import { Header } from './components/Header';
import { DEFAULT_NETWORK, NETWORKS } from './lib/networks';
import { fetchGatewayHealth } from './lib/rpc';
import type {
  CodecPresetId,
  EvmWalletState,
  GatewayHealth,
  ModuleTab,
  NetworkId,
} from './lib/types';
import {
  connectEvmWallet,
  discoverEip6963Providers,
  switchEvmChain,
  type Eip1193Provider,
} from './lib/wallets';

const VALID_NETWORKS = new Set<NetworkId>(['previewnet', 'shadownet', 'mainnet']);
const VALID_TABS = new Set<ModuleTab>(['codec', 'alias', 'canary']);
const VALID_PRESETS = new Set<CodecPresetId>([
  'unit',
  'string',
  'nat',
  'int',
  'bytes',
  'address',
  'pair_addr_mutez',
  'option_some',
  'or_left',
  'canary_record_ping',
  'canary_echo_callback',
  'canary_force_fail',
  'canary_burn_gas',
  'canary_get_state_digest',
]);

function readInitialUrlState(): {
  networkId: NetworkId;
  tab: ModuleTab;
  preset?: CodecPresetId;
  addr?: string;
  tx?: string;
} {
  if (typeof window === 'undefined') {
    return { networkId: DEFAULT_NETWORK, tab: 'codec' };
  }
  const params = new URLSearchParams(window.location.search);
  const rawNet = params.get('network') as NetworkId | null;
  const rawTab = params.get('tab') as ModuleTab | null;
  const rawPreset = params.get('preset') as CodecPresetId | null;
  const rawAddr = params.get('addr')?.trim() || undefined;
  const rawTx = params.get('tx')?.trim() || undefined;

  const networkId: NetworkId =
    rawNet && VALID_NETWORKS.has(rawNet) ? rawNet : DEFAULT_NETWORK;
  const preset: CodecPresetId | undefined =
    rawPreset && VALID_PRESETS.has(rawPreset) ? rawPreset : undefined;

  let tab: ModuleTab = 'codec';
  if (rawTab && VALID_TABS.has(rawTab)) {
    tab = rawTab;
  } else if (rawTx) {
    tab = 'canary';
  } else if (rawAddr) {
    tab = 'alias';
  } else if (preset) {
    tab = 'codec';
  }

  return { networkId, tab, preset, addr: rawAddr, tx: rawTx };
}

export default function App() {
  const initialUrlRef = useRef(readInitialUrlState());
  const [networkId, setNetworkId] = useState<NetworkId>(initialUrlRef.current.networkId);
  const [activeTab, setActiveTab] = useState<ModuleTab>(initialUrlRef.current.tab);
  const [urlPreset, setUrlPreset] = useState<CodecPresetId | undefined>(
    initialUrlRef.current.preset,
  );
  const [urlAddr, setUrlAddr] = useState<string | undefined>(initialUrlRef.current.addr);
  const [urlTx, setUrlTx] = useState<string | undefined>(initialUrlRef.current.tx);

  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState<boolean>(false);

  const [evmWallet, setEvmWallet] = useState<EvmWalletState>({
    address: null,
    chainId: null,
    providerName: null,
    providers: [],
  });
  const [walletBusy, setWalletBusy] = useState<boolean>(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const activeProviderRef = useRef<Eip1193Provider | null>(null);

  const network = NETWORKS[networkId];

  // Keep shareable URL query params synced without polluting browser history stack
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    params.set('network', networkId);
    params.set('tab', activeTab);
    if (activeTab === 'codec' && urlPreset) {
      params.set('preset', urlPreset);
    } else if (activeTab === 'alias' && urlAddr) {
      params.set('addr', urlAddr);
    } else if (activeTab === 'canary' && urlTx) {
      params.set('tx', urlTx);
    }
    const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, '', nextUrl);
  }, [networkId, activeTab, urlPreset, urlAddr, urlTx]);

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const next = await fetchGatewayHealth(network);
      setHealth(next);
    } catch (err) {
      setHealth({
        checkedAt: new Date().toISOString(),
        evmOk: false,
        michelsonOk: false,
        evmHead: null,
        michelsonLevel: null,
        synced: false,
        precompileZeroCode: null,
        gatewayEntrypoints: [],
        gatewayViews: [],
        kernelVersion: null,
        hardGasLimit: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setHealthLoading(false);
    }
  }, [network]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    const syncProviders = () => {
      const found = discoverEip6963Providers();
      setEvmWallet((prev) => ({
        ...prev,
        providers: found.map((p) => ({ rdns: p.rdns, name: p.name, icon: p.icon })),
      }));
    };
    syncProviders();
    const timer = window.setTimeout(syncProviders, 400);
    return () => window.clearTimeout(timer);
  }, []);

  const handleConnectEvm = useCallback(async (rdns?: string) => {
    setWalletBusy(true);
    setWalletError(null);
    try {
      const connected = await connectEvmWallet(rdns);
      activeProviderRef.current = connected.provider;

      connected.provider.on?.('accountsChanged', (accounts: unknown) => {
        const list = Array.isArray(accounts) ? (accounts as string[]) : [];
        setEvmWallet((prev) => ({ ...prev, address: list[0] ?? null }));
      });
      connected.provider.on?.('chainChanged', (chainHex: unknown) => {
        if (typeof chainHex === 'string') {
          setEvmWallet((prev) => ({ ...prev, chainId: parseInt(chainHex, 16) }));
        }
      });

      const found = discoverEip6963Providers();
      setEvmWallet({
        address: connected.address,
        chainId: connected.chainId,
        providerName: connected.providerName,
        providers: found.map((p) => ({ rdns: p.rdns, name: p.name, icon: p.icon })),
      });
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err));
    } finally {
      setWalletBusy(false);
    }
  }, []);

  const handleSwitchChain = useCallback(async () => {
    if (!activeProviderRef.current) return;
    setWalletBusy(true);
    setWalletError(null);
    try {
      await switchEvmChain(activeProviderRef.current, network);
      setEvmWallet((prev) => ({ ...prev, chainId: network.evm.chainId }));
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err));
    } finally {
      setWalletBusy(false);
    }
  }, [network]);

  return (
    <div className="app-shell">
      <Header
        network={network}
        health={health}
        healthLoading={healthLoading}
        evmWallet={evmWallet}
        walletBusy={walletBusy}
        walletError={walletError}
        onSelectNetwork={setNetworkId}
        onRefreshHealth={() => void refreshHealth()}
        onConnectEvm={handleConnectEvm}
        onSwitchChain={handleSwitchChain}
      />

      <main className="main-content">
        <div className="container">
          <nav className="tabs" role="tablist" aria-label="NACBench modules">
            <button
              type="button"
              role="tab"
              id="tab-codec"
              aria-selected={activeTab === 'codec'}
              aria-controls="panel-codec"
              className={`tab ${activeTab === 'codec' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('codec')}
            >
              <Binary size={15} className="text-evm" />
              Codec &amp; Snippets
              <span className="badge badge-evm">Micheline · ABI</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-alias"
              aria-selected={activeTab === 'alias'}
              aria-controls="panel-alias"
              className={`tab ${activeTab === 'alias' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('alias')}
            >
              <Fingerprint size={15} className="text-michelson" />
              Horus Alias &amp; State Diff
              <span className="badge badge-michelson">0xbfe88b4b · 1:1 Sync</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-canary"
              aria-selected={activeTab === 'canary'}
              aria-controls="panel-canary"
              className={`tab ${activeTab === 'canary' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('canary')}
            >
              <Flame size={15} className="text-warn" />
              Canary Lab
              <span className="badge badge-warn">5 Probes · 429 OOG</span>
            </button>
          </nav>

          <div
            role="tabpanel"
            id={`panel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
          >
            {activeTab === 'codec' && (
              <CodecModule
                network={network}
                initialPreset={initialUrlRef.current.preset}
                onPresetChange={setUrlPreset}
              />
            )}
            {activeTab === 'alias' && (
              <AliasInspectorModule
                network={network}
                health={health}
                evmWallet={evmWallet}
                onConnectEvm={handleConnectEvm}
                initialAddr={initialUrlRef.current.addr}
                onAddrChange={setUrlAddr}
              />
            )}
            {activeTab === 'canary' && (
              <CanaryLabModule
                network={network}
                health={health}
                evmWallet={evmWallet}
                onConnectEvm={handleConnectEvm}
                initialTxHash={initialUrlRef.current.tx}
                onTxHashChange={setUrlTx}
              />
            )}
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="container stack-sm">
          <div className="row-between">
            <span>
              <strong>NACBench</strong> · Open-Source MIT Developer Workbench for Tezos X Native
              Atomic Composability
            </span>
            <span className="mono">
              Precompile {network.evm.precompile.slice(0, 10)}…0007 · Gateway{' '}
              {network.michelson.evmGateway}
            </span>
          </div>
          <div className="row-between" style={{ gap: '12px' }}>
            <nav
              aria-label="Tezos X ecosystem links"
              className="row"
              style={{ gap: '14px', fontSize: '12px' }}
            >
              <a href="https://github.com/webid/nacbench" target="_blank" rel="noreferrer">
                GitHub <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
              </a>
              <a
                href="https://github.com/webid/nacbench/blob/main/docs/NAC-FIELD-GUIDE.md"
                target="_blank"
                rel="noreferrer"
              >
                NAC Field Guide <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
              </a>
              <a
                href="https://faucet.previewnet.tezosx.nomadic-labs.com"
                target="_blank"
                rel="noreferrer"
              >
                Previewnet Faucet <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
              </a>
              <a href="https://migl992.github.io/nactrace/" target="_blank" rel="noreferrer">
                nactrace <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
              </a>
              <a href="https://xtzkt.io" target="_blank" rel="noreferrer">
                0xTzKT <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
              </a>
              <a href="https://tezosdappbuilder.xyz" target="_blank" rel="noreferrer">
                Tezos dApp Builder <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
              </a>
            </nav>
            <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
              developed by{' '}
              <a href="https://x.com/webidente" target="_blank" rel="noreferrer">
                opeculiar
              </a>{' '}
              for{' '}
              <a href="https://thetezos.com" target="_blank" rel="noreferrer">
                TheTezosCommunity
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
