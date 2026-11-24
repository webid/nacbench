import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { AliasInspectorModule } from './components/AliasInspectorModule';
import { CanaryLabModule } from './components/CanaryLabModule';
import { CodecModule } from './components/CodecModule';
import { Header } from './components/Header';
import { WalletNeedPill, type WalletNeed } from './components/ui';
import { DEFAULT_NETWORK, NETWORKS } from './lib/networks';
import { fetchGatewayHealth } from './lib/rpc';
import {
  resolveInitialTheme,
  subscribeSystemTheme,
  toggleTheme,
  type Theme,
} from './lib/theme';
import type {
  CodecPresetId,
  EvmWalletState,
  GatewayHealth,
  ModuleTab,
  NetworkId,
} from './lib/types';
import {
  clearWalletPreference,
  connectEvmWallet,
  getDiscoveredEip6963Providers,
  loadWalletPreference,
  onEip6963Announce,
  requestEip6963Providers,
  restoreEvmWalletSession,
  subscribeWalletEvents,
  switchEvmChain,
  type ConnectedEvmWallet,
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

interface ModuleMeta {
  id: ModuleTab;
  n: number;
  title: string;
  short: string;
  desc: string;
  wallet: WalletNeed;
  walletLabel: string;
}

const MODULES: ModuleMeta[] = [
  {
    id: 'codec',
    n: 1,
    title: 'Encode & Snippets',
    short: 'Encode',
    desc: 'Build binary Micheline / EVM ABI payloads & guardrail-safe code.',
    wallet: 'none',
    walletLabel: 'No wallet needed',
  },
  {
    id: 'alias',
    n: 2,
    title: 'Alias & State Diff',
    short: 'Alias',
    desc: 'Inspect Horus 8.0 aliases, materialize on-chain, & diff EVM vs. Michelson state.',
    wallet: 'optional',
    walletLabel: 'Wallet optional · only to send materialize tx',
  },
  {
    id: 'canary',
    n: 3,
    title: 'Canary Lab & Debugger',
    short: 'Canary',
    desc: 'Run live Previewnet v0.11 probes or inspect any cross-runtime tx trace.',
    wallet: 'optional',
    walletLabel: 'Wallet optional · traces & view probe are free',
  },
];

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
  const [theme, setThemeState] = useState<Theme>(() => resolveInitialTheme());
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
  const walletUnsubRef = useRef<(() => void) | null>(null);

  const network = NETWORKS[networkId];

  useEffect(() => subscribeSystemTheme(setThemeState), []);

  const handleToggleTheme = useCallback(() => {
    setThemeState((current) => toggleTheme(current));
  }, []);

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

  const handleDisconnectEvm = useCallback(() => {
    clearWalletPreference();
    walletUnsubRef.current?.();
    walletUnsubRef.current = null;
    activeProviderRef.current = null;
    setWalletError(null);
    setEvmWallet((prev) => ({
      ...prev,
      address: null,
      chainId: null,
      providerName: null,
    }));
  }, []);

  const bindConnectedWallet = useCallback(
    (connected: ConnectedEvmWallet) => {
      walletUnsubRef.current?.();
      activeProviderRef.current = connected.provider;

      walletUnsubRef.current = subscribeWalletEvents(connected.provider, {
        onAccountsChanged: (accounts) => {
          if (accounts.length === 0) {
            handleDisconnectEvm();
            return;
          }
          setEvmWallet((prev) => ({ ...prev, address: accounts[0] }));
        },
        onChainChanged: (chainId) => {
          setEvmWallet((prev) => ({ ...prev, chainId }));
        },
      });

      const found = getDiscoveredEip6963Providers();
      setEvmWallet({
        address: connected.address,
        chainId: connected.chainId,
        providerName: connected.providerName,
        providers: found.map((p) => ({ rdns: p.rdns, name: p.name, icon: p.icon })),
      });
    },
    [handleDisconnectEvm],
  );

  useEffect(() => {
    let cancelled = false;
    let restoring = false;

    const syncProviders = () => {
      const found = getDiscoveredEip6963Providers();
      setEvmWallet((prev) => ({
        ...prev,
        providers: found.map((p) => ({ rdns: p.rdns, name: p.name, icon: p.icon })),
      }));
    };

    const attemptSilentRestore = async () => {
      if (cancelled || restoring || activeProviderRef.current || !loadWalletPreference()) return;
      restoring = true;
      try {
        const restored = await restoreEvmWalletSession();
        if (!cancelled && restored && loadWalletPreference()) {
          bindConnectedWallet(restored);
        }
      } finally {
        restoring = false;
      }
    };

    const unsubAnnounce = onEip6963Announce(() => {
      syncProviders();
      void attemptSilentRestore();
    });

    // Broadcast eip6963:requestProvider exactly ONCE on mount
    requestEip6963Providers();
    syncProviders();
    void attemptSilentRestore();

    // Passive check for late-injected window.ethereum without re-broadcasting requestProvider
    const timer = window.setTimeout(() => {
      syncProviders();
      void attemptSilentRestore();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubAnnounce();
      walletUnsubRef.current?.();
      walletUnsubRef.current = null;
    };
  }, [bindConnectedWallet]);

  const handleConnectEvm = useCallback(
    async (rdns?: string) => {
      setWalletBusy(true);
      setWalletError(null);
      try {
        const connected = await connectEvmWallet(rdns);
        bindConnectedWallet(connected);
      } catch (err) {
        setWalletError(err instanceof Error ? err.message : String(err));
      } finally {
        setWalletBusy(false);
      }
    },
    [bindConnectedWallet],
  );

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

  const activeModule = MODULES.find((m) => m.id === activeTab) ?? MODULES[0];

  const onNavKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const idx = MODULES.findIndex((m) => m.id === activeTab);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % MODULES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (idx - 1 + MODULES.length) % MODULES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MODULES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setActiveTab(MODULES[next].id);
    document.getElementById(`tab-${MODULES[next].id}`)?.focus();
  };

  return (
    <div className="app-shell">
      <a href="#main" className="sr-only">
        Skip to workspace
      </a>
      <Header
        network={network}
        health={health}
        healthLoading={healthLoading}
        evmWallet={evmWallet}
        walletBusy={walletBusy}
        walletError={walletError}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onSelectNetwork={setNetworkId}
        onRefreshHealth={() => void refreshHealth()}
        onConnectEvm={handleConnectEvm}
        onDisconnectEvm={handleDisconnectEvm}
        onSwitchChain={handleSwitchChain}
      />

      <main className="main-content" id="main">
        <div className="container">
          <nav aria-label="NACBench workspaces">
            <div
              className="module-nav"
              role="tablist"
              aria-label="NACBench modules"
              onKeyDown={onNavKeyDown}
            >
              {MODULES.map((m) => {
                const selected = activeTab === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    id={`tab-${m.id}`}
                    aria-selected={selected}
                    aria-controls={`panel-${m.id}`}
                    tabIndex={selected ? 0 : -1}
                    className="module-tab"
                    onClick={() => setActiveTab(m.id)}
                  >
                    <span className="module-tab-head">
                      <span className="module-tab-num" aria-hidden="true">
                        {m.n}
                      </span>
                      <span className="module-tab-title">{m.title}</span>
                      <span className="module-tab-short" aria-hidden="true">
                        {m.short}
                      </span>
                    </span>
                    <span className="module-tab-desc">{m.desc}</span>
                    <span className="module-tab-meta">
                      <WalletNeedPill need={m.wallet} label={m.walletLabel} />
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="module-context" aria-hidden="true">
            <span>
              <strong className="strong">
                {activeModule.n}. {activeModule.title}
              </strong>{' '}
              — {activeModule.desc}
            </span>
            <span>
              <WalletNeedPill need={activeModule.wallet} label={activeModule.walletLabel} />
            </span>
          </div>

          <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
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
        <div className="container stack">
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <div className="stack-xs" style={{ minWidth: 0 }}>
              <span>
                <strong className="strong">NACBench</strong> · open-source (MIT) developer
                workbench for Tezos X Native Atomic Composability
              </span>
              <span className="mono xsmall muted break-all">
                Precompile {network.evm.precompile.slice(0, 10)}…0007 · Gateway{' '}
                {network.michelson.evmGateway}
              </span>
            </div>
            <span>
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
          <nav aria-label="Tezos X ecosystem links" className="footer-links">
            <a href="https://github.com/webid/nacbench" target="_blank" rel="noreferrer">
              GitHub <ExternalLink size={11} aria-hidden="true" />
            </a>
            <a
              href="https://github.com/webid/nacbench/blob/main/docs/NAC-FIELD-GUIDE.md"
              target="_blank"
              rel="noreferrer"
            >
              NAC Field Guide <ExternalLink size={11} aria-hidden="true" />
            </a>
            <a
              href="https://faucet.previewnet.tezosx.nomadic-labs.com"
              target="_blank"
              rel="noreferrer"
            >
              Previewnet Faucet <ExternalLink size={11} aria-hidden="true" />
            </a>
            <a href="https://migl992.github.io/nactrace/" target="_blank" rel="noreferrer">
              nactrace <ExternalLink size={11} aria-hidden="true" />
            </a>
            <a href="https://xtzkt.io" target="_blank" rel="noreferrer">
              0xTzKT <ExternalLink size={11} aria-hidden="true" />
            </a>
            <a href="https://tezosdappbuilder.xyz" target="_blank" rel="noreferrer">
              Tezos dApp Builder <ExternalLink size={11} aria-hidden="true" />
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
