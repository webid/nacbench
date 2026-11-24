import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Moon,
  RefreshCw,
  Sun,
  Wallet,
  XCircle,
} from 'lucide-react';
import { NETWORK_LIST } from '../lib/networks';
import type { Theme } from '../lib/theme';
import type { EvmWalletState, GatewayHealth, NetworkConfig, NetworkId } from '../lib/types';

interface HeaderProps {
  network: NetworkConfig;
  health: GatewayHealth | null;
  healthLoading: boolean;
  evmWallet: EvmWalletState;
  walletBusy: boolean;
  walletError: string | null;
  theme: Theme;
  onToggleTheme: () => void;
  onSelectNetwork: (id: NetworkId) => void;
  onRefreshHealth: () => void;
  onConnectEvm: (rdns?: string) => Promise<void>;
  onSwitchChain: () => Promise<void>;
}

/** Collapse raw HTML / whitespace from upstream RPC error bodies into one readable line. */
function summarizeRpcError(raw: string): string {
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function shortenAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type SyncState = 'loading' | 'synced' | 'partial' | 'offline';

const SYNC_LABEL: Record<SyncState, string> = {
  loading: 'Checking RPC…',
  synced: 'Live · 1:1 synced',
  partial: 'Partial sync',
  offline: 'RPC unreachable',
};

function SyncHealth({
  network,
  health,
  healthLoading,
  onRefreshHealth,
}: Pick<HeaderProps, 'network' | 'health' | 'healthLoading' | 'onRefreshHealth'>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const syncState: SyncState =
    healthLoading && !health
      ? 'loading'
      : !health
        ? 'loading'
        : health.evmOk && health.michelsonOk && health.synced
          ? 'synced'
          : health.evmOk || health.michelsonOk
            ? 'partial'
            : 'offline';

  const dotClass =
    syncState === 'synced'
      ? 'dot-ok'
      : syncState === 'offline'
        ? 'dot-danger'
        : syncState === 'partial'
          ? 'dot-warn'
          : '';

  const head =
    health?.evmHead !== null && health?.evmHead !== undefined
      ? `#${health.evmHead.toLocaleString()}`
      : null;

  return (
    <div className="sync" ref={wrapRef}>
      <button
        type="button"
        className="sync-pill"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((v) => !v)}
        title="Live RPC health for both runtimes"
      >
        <span className={`dot ${dotClass}`} aria-hidden="true" />
        <span aria-live="polite">{SYNC_LABEL[syncState]}</span>
        {head && syncState === 'synced' && <span className="mono muted xsmall sync-head">{head}</span>}
        <ChevronDown size={13} className="chev" aria-hidden="true" />
      </button>

      {open && (
        <div id={popId} className="popover stack-sm" role="dialog" aria-label="Live sync details">
          <div className="row-between">
            <span className="popover-title">{network.label}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onRefreshHealth}
              disabled={healthLoading}
            >
              <RefreshCw size={12} className={healthLoading ? 'spin' : undefined} aria-hidden="true" />
              {healthLoading ? 'Probing…' : 'Re-probe'}
            </button>
          </div>

          <dl className="telemetry-list">
            <dt>EVM head</dt>
            <dd>
              {head ?? '—'} <span className="muted">· chain {network.evm.chainId}</span>
            </dd>
            <dt>Michelson level</dt>
            <dd>
              {health?.michelsonLevel !== null && health?.michelsonLevel !== undefined
                ? `#${health.michelsonLevel.toLocaleString()}`
                : '—'}
            </dd>
            <dt>Michelson chain</dt>
            <dd>{network.michelson.chainId}</dd>
            <dt>Block sync</dt>
            <dd className={health?.synced ? 'text-ok' : health ? 'text-warn' : undefined}>
              {health ? (health.synced ? '1:1 (EVM N == Michelson N)' : 'Skewed') : '—'}
            </dd>
            <dt title="EXTCODESIZE of 0xff00…0007 must be 0 — use low-level .call">
              Precompile 0xff…0007
            </dt>
            <dd
              className={
                health?.precompileZeroCode === true
                  ? undefined
                  : health?.precompileZeroCode === false
                    ? 'text-warn'
                    : undefined
              }
            >
              {health?.precompileZeroCode === true
                ? 'EXTCODESIZE = 0'
                : health?.precompileZeroCode === false
                  ? 'HAS CODE'
                  : '—'}
            </dd>
            <dt>Gateway {network.michelson.evmGateway.slice(0, 8)}…</dt>
            <dd>
              {health
                ? `${health.gatewayEntrypoints.length} entrypoints · ${health.gatewayViews.length} views`
                : '—'}
            </dd>
            <dt>Michelson op gas cap</dt>
            <dd>
              {(health?.hardGasLimit ?? network.michelson.hardGasLimitPerOperation).toLocaleString()}
            </dd>
            {health?.kernelVersion && (
              <>
                <dt>Kernel</dt>
                <dd title={health.kernelVersion}>{health.kernelVersion.slice(0, 14)}</dd>
              </>
            )}
            {health?.checkedAt && (
              <>
                <dt>Checked</dt>
                <dd>{new Date(health.checkedAt).toLocaleTimeString()}</dd>
              </>
            )}
          </dl>

          <div className="divider" />
          <div className="row xsmall" style={{ gap: 14 }}>
            <a href={network.evm.explorerUrl} target="_blank" rel="noreferrer">
              Blockscout <ExternalLink size={11} aria-hidden="true" />
            </a>
            <a href={network.michelson.explorerUrl} target="_blank" rel="noreferrer">
              TzKT <ExternalLink size={11} aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export function Header({
  network,
  health,
  healthLoading,
  evmWallet,
  walletBusy,
  walletError,
  theme,
  onToggleTheme,
  onSelectNetwork,
  onRefreshHealth,
  onConnectEvm,
  onSwitchChain,
}: HeaderProps) {
  const wrongChain =
    evmWallet.address !== null &&
    evmWallet.chainId !== null &&
    evmWallet.chainId !== network.evm.chainId;

  const nextThemeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <header className="header">
      <div className="container">
        <div className="header-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L3 7V17L12 22V2Z" fill="var(--evm)" fillOpacity="0.88" />
                <path d="M12 2L21 7V17L12 22V2Z" fill="var(--michelson)" fillOpacity="0.88" />
                <path d="M12 7L7 10V14L12 17L17 14V10L12 7Z" fill="var(--surface)" />
              </svg>
            </div>
            <div className="brand-text">
              <h1 className="brand-title">NACBench</h1>
              <span className="brand-sub">Tezos X NAC workbench · {network.badge}</span>
            </div>
          </div>

          <div className="header-actions">
            <label htmlFor="nac-network-select" className="sr-only">
              Network
            </label>
            <select
              id="nac-network-select"
              className="select net-select"
              value={network.id}
              onChange={(e) => onSelectNetwork(e.target.value as NetworkId)}
              aria-label="Select Tezos X network"
            >
              {NETWORK_LIST.map((net) => (
                <option key={net.id} value={net.id}>
                  {net.label} · {net.evm.chainId}
                </option>
              ))}
            </select>

            <SyncHealth
              network={network}
              health={health}
              healthLoading={healthLoading}
              onRefreshHealth={onRefreshHealth}
            />
          </div>

          <div className="header-wallet row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            {evmWallet.address ? (
              <>
                <span className="sync-pill" style={{ cursor: 'default' }} title={evmWallet.address}>
                  <span className={`dot ${wrongChain ? 'dot-warn' : 'dot-ok'}`} aria-hidden="true" />
                  <span className="mono">{shortenAddress(evmWallet.address)}</span>
                </span>
                {wrongChain && (
                  <button
                    type="button"
                    className="btn btn-sm btn-warn"
                    onClick={() => void onSwitchChain()}
                    disabled={walletBusy}
                  >
                    Switch to {network.evm.chainId}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                style={{ height: 32 }}
                onClick={() => void onConnectEvm()}
                disabled={walletBusy}
              >
                <Wallet size={13} aria-hidden="true" />
                {walletBusy ? 'Connecting…' : 'Connect wallet'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm theme-toggle"
              onClick={onToggleTheme}
              aria-label={nextThemeLabel}
              title={nextThemeLabel}
            >
              {theme === 'dark' ? (
                <Sun size={15} aria-hidden="true" />
              ) : (
                <Moon size={15} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {(walletError || health?.error) && (
          <div className="header-alerts stack-sm">
            {walletError && (
              <div className="alert alert-danger" role="alert">
                <XCircle size={14} aria-hidden="true" />
                <span>{walletError}</span>
              </div>
            )}
            {health?.error && (
              <div className="alert alert-warn" title={health.error}>
                <AlertTriangle size={14} aria-hidden="true" />
                <span className="xsmall">
                  <strong className="strong">Live RPC warning ({network.label}):</strong>{' '}
                  <span className="mono">{summarizeRpcError(health.error)}</span>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
