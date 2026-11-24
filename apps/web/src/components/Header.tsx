import {
  Activity,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
  Zap,
} from 'lucide-react';
import { NETWORK_LIST } from '../lib/networks';
import type { EvmWalletState, GatewayHealth, NetworkConfig, NetworkId } from '../lib/types';

interface HeaderProps {
  network: NetworkConfig;
  health: GatewayHealth | null;
  healthLoading: boolean;
  evmWallet: EvmWalletState;
  walletBusy: boolean;
  walletError: string | null;
  onSelectNetwork: (id: NetworkId) => void;
  onRefreshHealth: () => void;
  onConnectEvm: (rdns?: string) => Promise<void>;
  onSwitchChain: () => Promise<void>;
}

function shortenAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function Header({
  network,
  health,
  healthLoading,
  evmWallet,
  walletBusy,
  walletError,
  onSelectNetwork,
  onRefreshHealth,
  onConnectEvm,
  onSwitchChain,
}: HeaderProps) {
  const wrongChain =
    evmWallet.address !== null &&
    evmWallet.chainId !== null &&
    evmWallet.chainId !== network.evm.chainId;

  const syncState = !health
    ? 'loading'
    : health.evmOk && health.michelsonOk && health.synced
      ? 'synced'
      : health.evmOk || health.michelsonOk
        ? 'partial'
        : 'offline';

  return (
    <header className="header">
      <div className="container">
        <div className="header-top">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L3 7V17L12 22V2Z" fill="#f5a524" fillOpacity="0.92" />
                <path d="M12 2L21 7V17L12 22V2Z" fill="#38bdf8" fillOpacity="0.92" />
                <path d="M12 7L7 10V14L12 17L17 14V10L12 7Z" fill="#0b0e14" />
                <circle cx="12" cy="12" r="2.2" fill="#22c55e" />
              </svg>
            </div>
            <div>
              <h1 className="brand-title">
                NACBench
                <span className="badge badge-michelson">{network.badge}</span>
              </h1>
              <div className="brand-sub">
                Tezos X Native Atomic Composability Workbench · Horus 8.0 Debugger
              </div>
            </div>
          </div>

          <div className="header-controls">
            <label htmlFor="nac-network-select" className="field-label" style={{ margin: 0 }}>
              Network
            </label>
            <select
              id="nac-network-select"
              className="select mono"
              style={{ width: 'auto', minWidth: 215 }}
              value={network.id}
              onChange={(e) => onSelectNetwork(e.target.value as NetworkId)}
              aria-label="Select Tezos X network"
            >
              {NETWORK_LIST.map((net) => (
                <option key={net.id} value={net.id}>
                  {net.label} (EVM {net.evm.chainId})
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-sm"
              onClick={onRefreshHealth}
              disabled={healthLoading}
              title="Re-probe live EVM and Michelson RPC endpoints"
            >
              <RefreshCw size={13} className={healthLoading ? 'spin' : undefined} />
              {healthLoading ? 'Probing…' : 'Probe RPC'}
            </button>

            {evmWallet.address ? (
              <div className="row" style={{ gap: 6 }}>
                <span className="badge badge-evm" title={evmWallet.address}>
                  <Wallet size={12} />
                  {shortenAddress(evmWallet.address)}
                </span>
                {wrongChain && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => void onSwitchChain()}
                    disabled={walletBusy}
                  >
                    Switch to {network.evm.chainId}
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-evm btn-sm"
                onClick={() => void onConnectEvm()}
                disabled={walletBusy}
              >
                <Wallet size={13} />
                {walletBusy ? 'Connecting…' : 'Connect EVM Wallet'}
              </button>
            )}
          </div>
        </div>

        <div className="telemetry-strip" aria-live="polite">
          <div className="telemetry-group">
            <span className="telemetry-item">
              <span
                className={`pulse-dot ${
                  syncState === 'synced'
                    ? 'pulse-ok'
                    : syncState === 'offline'
                      ? 'pulse-danger'
                      : 'pulse-warn'
                }`}
              />
              <strong>
                {syncState === 'synced'
                  ? '1:1 Block Sync'
                  : syncState === 'loading'
                    ? 'Probing Dual Runtimes…'
                    : syncState === 'partial'
                      ? 'Partial Telemetry'
                      : 'RPC Unreachable'}
              </strong>
            </span>

            <span className="telemetry-item mono">
              <span className="text-evm">EVM</span>
              <strong>
                {health?.evmHead !== null && health?.evmHead !== undefined
                  ? `#${health.evmHead.toLocaleString()}`
                  : '—'}
              </strong>
              <span className="muted">({network.evm.chainId})</span>
            </span>

            <span className="telemetry-item mono">
              <span className="text-michelson">MICHELSON</span>
              <strong>
                {health?.michelsonLevel !== null && health?.michelsonLevel !== undefined
                  ? `#${health.michelsonLevel.toLocaleString()}`
                  : '—'}
              </strong>
              <span className="muted">({network.michelson.chainId})</span>
            </span>

            <span
              className="telemetry-item mono"
              title="0xff00000000000000000000000000000000000007 EXTCODESIZE check"
            >
              {health?.precompileZeroCode === true ? (
                <ShieldCheck size={13} className="text-ok" />
              ) : (
                <ShieldAlert size={13} className="text-warn" />
              )}
              <span>0xff…0007:</span>
              <strong>
                {health?.precompileZeroCode === true
                  ? 'EXTCODESIZE=0'
                  : health?.precompileZeroCode === false
                    ? 'HAS CODE'
                    : '—'}
              </strong>
            </span>

            <span className="telemetry-item mono">
              <Zap size={13} className="text-michelson" />
              <span>Gateway:</span>
              <strong>
                {health
                  ? `${health.gatewayEntrypoints.length} ep / ${health.gatewayViews.length} views`
                  : '—'}
              </strong>
            </span>

            {health?.hardGasLimit && (
              <span className="telemetry-item mono">
                <Activity size={13} className="text-muted" />
                <span>Mich Op Cap:</span>
                <strong>{health.hardGasLimit.toLocaleString()}</strong>
              </span>
            )}
          </div>

          <div className="telemetry-group mono" style={{ fontSize: 11.5 }}>
            {health?.kernelVersion && (
              <span className="badge badge-muted" title="tez_kernelVersion">
                kernel {health.kernelVersion.slice(0, 14)}
              </span>
            )}
            <a href={network.evm.explorerUrl} target="_blank" rel="noreferrer">
              Blockscout <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
            <a href={network.michelson.explorerUrl} target="_blank" rel="noreferrer">
              TzKT <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
          </div>
        </div>

        {(walletError || health?.error) && (
          <div style={{ paddingBottom: 10 }}>
            {walletError && (
              <div className="alert alert-danger" style={{ padding: '7px 10px', marginBottom: 6 }}>
                <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{walletError}</span>
              </div>
            )}
            {health?.error && (
              <div className="alert alert-warn" style={{ padding: '7px 10px' }}>
                <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <span className="mono" style={{ fontSize: 11.5 }}>
                  Live RPC warning ({network.label}): {health.error}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
