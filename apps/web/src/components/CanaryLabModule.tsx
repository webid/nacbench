import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  Flame,
  GitCompare,
  Layers,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Terminal,
  Trash2,
  Wallet,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  CanaryAddresses,
  CanaryLiveState,
  CanaryProbeKind,
  DualRuntimeSnapshot,
  EvmWalletState,
  GatewayHealth,
  NetworkConfig,
  SnapshotDiff,
  TraceFrame,
  TxInspectionReport,
} from '../lib/types';
import {
  CANARY_SELECTORS,
  PREVIEWNET_SAMPLE_TX_HASH,
  clearCustomCanaryAddresses,
  encodeProbeOogCalldata,
  encodeProbeRollbackCalldata,
  encodeProbeRoundTripCalldata,
  encodeProbeWriteCalldata,
  executeReadOnlyProbeView,
  inspectTransactionHash,
  loadDefaultCanaryAddresses,
  readCanaryLiveState,
  saveCustomCanaryAddresses,
  sendCanaryProbeTx,
  waitForReceiptAndInspect,
} from '../lib/canary';
import {
  decodeRevertPayload,
  isTz4Address,
  isValidEvmAddress,
  isValidTezosXAddress,
} from '../lib/codec';
import { captureBlockPinnedSnapshot, diffSnapshots } from '../lib/rpc';
import {
  connectEvmWallet,
  discoverEip6963Providers,
  type Eip1193Provider,
} from '../lib/wallets';
import { NULL_SOURCE_ADDRESS } from '../lib/networks';

const WEI_PER_MUTEZ = 1_000_000_000_000n;
const DEPLOY_CLI_STEPS = `npm run wallets:generate
# Fund printed tz1 & 0x addresses at https://faucet.previewnet.tezosx.nomadic-labs.com
npm run deploy:previewnet -- --live`;

interface ProbeExecutionRecord {
  kind: CanaryProbeKind;
  label: string;
  txHash?: string;
  status: 'running' | 'completed' | 'error';
  message: string;
  beforeSentinel?: string;
  afterSentinel?: string;
  stateDiff?: SnapshotDiff | null;
}

interface ViewProbeResultState {
  ok: boolean;
  rawReturnHex?: string;
  rawMichelineHex?: string;
  decodedDigest?: unknown;
  echoViewResult?: { echoed: string; writes: string };
  runScriptViewResult?: unknown;
  error?: string;
}

function shortAddr(addr: string | null | undefined, head = 8, tail = 6): string {
  if (!addr) return '—';
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function formatSignedDelta(val: string | null, unit: string): string {
  if (val === null) return '—';
  try {
    const n = BigInt(val);
    if (n === 0n) return `0 ${unit}`;
    return `${n > 0n ? '+' : ''}${n.toString()} ${unit}`;
  } catch {
    return `${val} ${unit}`;
  }
}

function parseNonNegativeBigInt(raw: string, fallback: bigint): bigint {
  const cleaned = raw.trim();
  if (!/^\d+$/.test(cleaned)) return fallback;
  return BigInt(cleaned);
}

function TraceFrameRow({ frame, index }: { frame: TraceFrame; index: number }) {
  const isOog = frame.decodedRevert?.status === 429;
  const hasErr = Boolean(frame.error || frame.decodedRevert);
  const indentPx = Math.min(frame.depth, 6) * 18;

  return (
    <div
      style={{
        marginLeft: `${indentPx}px`,
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: frame.isGatewayPrecompile
          ? 'rgba(245, 165, 36, 0.08)'
          : hasErr
            ? 'rgba(244, 63, 94, 0.07)'
            : 'var(--bg-elevated)',
        border: `1px solid ${
          isOog
            ? 'var(--danger)'
            : frame.isGatewayPrecompile
              ? 'var(--evm-border)'
              : hasErr
                ? 'var(--danger-border)'
                : 'var(--border)'
        }`,
        borderLeft: `3px solid ${
          isOog
            ? 'var(--danger)'
            : frame.isGatewayPrecompile
              ? 'var(--evm)'
              : hasErr
                ? 'var(--danger)'
                : 'var(--michelson)'
        }`,
      }}
      className="stack-sm"
    >
      <div className="row-between" style={{ gap: '8px' }}>
        <div className="row" style={{ gap: '6px' }}>
          <span className="badge badge-muted">#{index}</span>
          <span className={`badge ${frame.isGatewayPrecompile ? 'badge-evm' : 'badge-michelson'}`}>
            {frame.type}
          </span>
          {frame.isGatewayPrecompile && (
            <span className="badge badge-evm">0xff00…0007 NAC GATEWAY HOP</span>
          )}
          <span className="badge badge-muted">sel: {frame.inputSelector}</span>
          {frame.decodedRevert?.status !== undefined && (
            <span className="badge badge-danger">HTTP / NAC {frame.decodedRevert.status}</span>
          )}
        </div>
        <span className="mono muted" style={{ fontSize: '11.5px' }}>
          gasUsed: <strong style={{ color: 'var(--text-strong)' }}>{frame.gasUsed}</strong> /{' '}
          {frame.gas}
        </span>
      </div>

      <div className="mono" style={{ fontSize: '11.5px', color: 'var(--text)', wordBreak: 'break-all' }}>
        <span className="muted">from</span> {frame.from}{' '}
        <span className="text-michelson">→</span>{' '}
        <span className={frame.isGatewayPrecompile ? 'text-evm' : ''}>{frame.to}</span>
        {frame.valueWei && frame.valueWei !== '0' && (
          <span className="text-evm"> · value={frame.valueWei} wei</span>
        )}
      </div>

      {frame.decodedRevert && (
        <div
          className={`alert ${isOog ? 'alert-danger' : 'alert-warn'}`}
          style={{ padding: '7px 10px', flexDirection: 'column', gap: '3px' }}
        >
          <div className="row" style={{ gap: '6px' }}>
            <span className={`badge ${isOog ? 'badge-danger' : 'badge-warn'}`}>
              {frame.decodedRevert.kind}
            </span>
            <strong style={{ color: 'var(--text-strong)', fontSize: '12px' }}>
              {frame.decodedRevert.summary}
            </strong>
          </div>
          <code className="mono muted" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
            {frame.decodedRevert.raw}
          </code>
        </div>
      )}

      {!frame.decodedRevert && frame.error && (
        <span className="mono text-danger" style={{ fontSize: '11.5px' }}>
          error: {frame.error}
        </span>
      )}

      {frame.output && frame.output !== '0x' && !frame.decodedRevert && (
        <code className="mono muted" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
          output: {frame.output.length > 140 ? `${frame.output.slice(0, 140)}…` : frame.output}
        </code>
      )}
    </div>
  );
}

export function CanaryLabModule({
  network,
  health,
  evmWallet,
  onConnectEvm,
  initialTxHash,
  onTxHashChange,
}: {
  network: NetworkConfig;
  health: GatewayHealth | null;
  evmWallet: EvmWalletState;
  onConnectEvm: (rdns?: string) => Promise<void>;
  initialTxHash?: string;
  onTxHashChange?: (txHash: string) => void;
}) {
  const uid = useId();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const autoRanInitialTxRef = useRef(false);

  // Section 1: Canary Pair Addresses & Live State
  const [addresses, setAddresses] = useState<CanaryAddresses>(() =>
    loadDefaultCanaryAddresses(network.id),
  );
  const [evmInput, setEvmInput] = useState<string>(addresses.evmCanary);
  const [kt1Input, setKt1Input] = useState<string>(addresses.michelsonCanary);
  const [addrError, setAddrError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<CanaryLiveState | null>(null);
  const [stateLoading, setStateLoading] = useState<boolean>(false);

  // Section 2: 5 Canary Probe Inputs & Status
  const [writeNote, setWriteNote] = useState<string>('nacbench-canary-ping');
  const [writeValueWei, setWriteValueWei] = useState<string>('1000000000000000');
  const [writeGasCap, setWriteGasCap] = useState<string>('5000000');

  const [rtNonce, setRtNonce] = useState<string>('42');
  const [rtGasCap, setRtGasCap] = useState<string>('5000000');

  const [viewArgX, setViewArgX] = useState<string>('7');
  const [viewBusy, setViewBusy] = useState<boolean>(false);
  const [viewResult, setViewResult] = useState<ViewProbeResultState | null>(null);

  const [rollbackReason, setRollbackReason] = useState<string>('CANARY_ROLLBACK_PROOF');
  const [rollbackGasCap, setRollbackGasCap] = useState<string>('5000000');

  const [oogIterations, setOogIterations] = useState<string>('1000');
  const [oogGasCap, setOogGasCap] = useState<string>('30000');
  const [oogCatchRevert, setOogCatchRevert] = useState<boolean>(true);

  const [activeProbe, setActiveProbe] = useState<CanaryProbeKind | null>(null);
  const [lastExecution, setLastExecution] = useState<ProbeExecutionRecord | null>(null);

  // Section 3: Live Tx-Hash Trace & 429 OOG Debugger
  const [txHashInput, setTxHashInput] = useState<string>(
    initialTxHash?.trim() ||
      addresses.proofTxs?.probeOogCatch ||
      addresses.proofTxs?.probeRoundTrip ||
      (network.id === 'previewnet' ? PREVIEWNET_SAMPLE_TX_HASH : ''),
  );
  const [traceLoading, setTraceLoading] = useState<boolean>(false);
  const [traceReport, setTraceReport] = useState<TxInspectionReport | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  // Reload default manifest/override when network switches
  useEffect(() => {
    const next = loadDefaultCanaryAddresses(network.id);
    setAddresses(next);
    setEvmInput(next.evmCanary);
    setKt1Input(next.michelsonCanary);
    setLiveState(null);
    setViewResult(null);
    setLastExecution(null);
    setTraceReport(null);
    setTraceError(null);
    setTxHashInput((prev) =>
      initialTxHash && !autoRanInitialTxRef.current
        ? initialTxHash
        : next.proofTxs?.probeOogCatch ||
            next.proofTxs?.probeRoundTrip ||
            (network.id === 'previewnet' ? PREVIEWNET_SAMPLE_TX_HASH : prev),
    );
  }, [network.id, initialTxHash]);

  const isConfigured =
    addresses.source !== 'unconfigured' &&
    isValidEvmAddress(addresses.evmCanary) &&
    isValidTezosXAddress(addresses.michelsonCanary);

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const refreshLiveState = useCallback(
    async (targetAddrs?: CanaryAddresses): Promise<CanaryLiveState | null> => {
      const active = targetAddrs ?? addresses;
      if (
        !isValidEvmAddress(active.evmCanary) ||
        !isValidTezosXAddress(active.michelsonCanary)
      ) {
        return null;
      }
      setStateLoading(true);
      try {
        const next = await readCanaryLiveState(network, active);
        setLiveState(next);
        return next;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLiveState({
          blockNumber: 0,
          michelsonLevel: 0,
          blockSynced: false,
          evm: null,
          michelson: null,
          error: msg,
        });
        return null;
      } finally {
        setStateLoading(false);
      }
    },
    [addresses, network],
  );

  // Auto-load live state whenever configured addresses exist
  useEffect(() => {
    if (isConfigured) {
      void refreshLiveState(addresses);
    }
  }, [isConfigured, addresses, refreshLiveState]);

  const handleSaveAddresses = (e: React.FormEvent) => {
    e.preventDefault();
    const evm = evmInput.trim();
    const kt1 = kt1Input.trim();
    if (!isValidEvmAddress(evm)) {
      setAddrError('Enter a valid 20-byte 0x EVM address for NacCanaryEvm.');
      return;
    }
    if (isTz4Address(kt1)) {
      setAddrError('BLS tz4 addresses are unsupported on Tezos X — provide a KT1 contract address.');
      return;
    }
    if (!isValidTezosXAddress(kt1) || !kt1.startsWith('KT1')) {
      setAddrError('Enter a valid KT1 Michelson contract address for nac_canary.');
      return;
    }
    setAddrError(null);
    const saved = saveCustomCanaryAddresses(network.id, {
      evmCanary: evm,
      michelsonCanary: kt1,
    });
    setAddresses(saved);
  };

  const handleClearAddresses = () => {
    const reset = clearCustomCanaryAddresses(network.id);
    setAddresses(reset);
    setEvmInput(reset.evmCanary);
    setKt1Input(reset.michelsonCanary);
    setAddrError(null);
    setLiveState(null);
  };

  // Resolve live EIP-1193 provider cleanly
  const resolveProvider = async (): Promise<Eip1193Provider> => {
    const discovered = discoverEip6963Providers();
    if (evmWallet.providerName) {
      const matched = discovered.find((p) => p.name === evmWallet.providerName);
      if (matched) return matched.provider;
    }
    if (discovered.length > 0) return discovered[0].provider;
    if (typeof window !== 'undefined') {
      const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (injected) return injected;
    }
    const connected = await connectEvmWallet();
    return connected.provider;
  };

  // Inspect any EVM tx hash (Section 3)
  const runTraceInspection = useCallback(
    async (explicitHash?: string) => {
      const hash = (explicitHash ?? txHashInput).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        setTraceError('Enter a valid 32-byte 0x EVM transaction hash (66 characters).');
        return;
      }
      setTraceLoading(true);
      setTraceError(null);
      onTxHashChange?.(hash);
      try {
        const report = await inspectTransactionHash(network, hash);
        setTraceReport(report);
      } catch (err) {
        setTraceReport(null);
        setTraceError(err instanceof Error ? err.message : String(err));
      } finally {
        setTraceLoading(false);
      }
    },
    [network, txHashInput, onTxHashChange],
  );

  // Auto-run trace inspection when opened via shareable ?tx=... URL param
  useEffect(() => {
    if (initialTxHash && !autoRanInitialTxRef.current) {
      autoRanInitialTxRef.current = true;
      setTxHashInput(initialTxHash);
      void runTraceInspection(initialTxHash);
    }
  }, [initialTxHash, runTraceInspection]);

  // Value alignment check for Probe 1
  const writeDustStatus = useMemo(() => {
    const cleaned = writeValueWei.trim();
    if (!/^\d+$/.test(cleaned)) {
      return { valid: false, aligned: false, mutez: '0', remainder: 'invalid' };
    }
    const wei = BigInt(cleaned);
    const remainder = wei % WEI_PER_MUTEZ;
    return {
      valid: true,
      aligned: remainder === 0n,
      mutez: (wei / WEI_PER_MUTEZ).toString(),
      remainder: remainder.toString(),
    };
  }, [writeValueWei]);

  // Unified write-probe executor with Before/After block-pinned snapshot + trace handoff
  const executeWriteProbe = async (
    kind: Exclude<CanaryProbeKind, 'view'>,
    label: string,
    calldata: string,
    opts?: { valueWei?: bigint; gasLimit?: bigint },
  ) => {
    if (!isConfigured) {
      setLastExecution({
        kind,
        label,
        status: 'error',
        message: 'Configure deployed NacCanaryEvm (0x…) and nac_canary (KT1…) addresses first.',
      });
      return;
    }
    if (!evmWallet.address) {
      await onConnectEvm();
      return;
    }

    setActiveProbe(kind);
    setLastExecution({
      kind,
      label,
      status: 'running',
      message: 'Capturing Before block-pinned dual-runtime snapshot…',
    });

    let beforeSnap: DualRuntimeSnapshot | null = null;
    let beforeSentinel: string | undefined = liveState?.evm?.rollbackSentinel;
    try {
      beforeSnap = await captureBlockPinnedSnapshot(network, {
        label: `${label} · Before`,
        evmAddress: addresses.evmCanary,
        michelsonAddress: addresses.michelsonCanary,
      });
      if (kind === 'rollback') {
        const preState = await readCanaryLiveState(network, addresses);
        beforeSentinel = preState.evm?.rollbackSentinel;
      }

      setLastExecution({
        kind,
        label,
        status: 'running',
        message: 'Awaiting EVM wallet signature & broadcast…',
        beforeSentinel,
      });

      const provider = await resolveProvider();
      const txHash = await sendCanaryProbeTx(provider, network, addresses.evmCanary, calldata, opts);
      setTxHashInput(txHash);

      setLastExecution({
        kind,
        label,
        txHash,
        status: 'running',
        message: `Broadcasted ${shortAddr(txHash, 10, 8)} — polling receipt & callTracer…`,
        beforeSentinel,
      });

      const report = await waitForReceiptAndInspect(network, txHash, 45_000);
      setTraceReport(report);
      setTraceError(null);

      const [afterSnap, postState] = await Promise.all([
        captureBlockPinnedSnapshot(network, {
          label: `${label} · After`,
          evmAddress: addresses.evmCanary,
          michelsonAddress: addresses.michelsonCanary,
        }).catch(() => null),
        refreshLiveState(addresses),
      ]);

      const stateDiff = beforeSnap && afterSnap ? diffSnapshots(beforeSnap, afterSnap) : null;
      const afterSentinel = postState?.evm?.rollbackSentinel;

      const statusText =
        kind === 'rollback'
          ? report.status === 'reverted' &&
            beforeSentinel !== undefined &&
            beforeSentinel === afterSentinel
            ? `Atomic Rollback PROVEN: tx reverted on-chain & rollbackSentinel stayed ${afterSentinel} (0 net state mutation).`
            : `Rollback tx status=${report.status}; sentinel ${beforeSentinel ?? '?'} → ${afterSentinel ?? '?'}.`
          : `Probe settled (${report.status}) via ${report.traceSource} · ${report.gatewayHops} gateway hop(s).`;

      setLastExecution({
        kind,
        label,
        txHash,
        status: 'completed',
        message: statusText,
        beforeSentinel,
        afterSentinel,
        stateDiff,
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const decoded = decodeRevertPayload(rawMsg);
      setLastExecution({
        kind,
        label,
        status: 'error',
        message: decoded.summary || rawMsg,
        beforeSentinel,
      });
    } finally {
      setActiveProbe(null);
    }
  };

  // Probe 3: Read-only view (zero wallet required)
  const handleRunReadOnlyView = async () => {
    if (!isConfigured) {
      setViewResult({
        ok: false,
        error: 'Configure deployed NacCanaryEvm (0x…) and nac_canary (KT1…) addresses first.',
      });
      return;
    }
    setViewBusy(true);
    try {
      const x = parseNonNegativeBigInt(viewArgX, 0n);
      const res = await executeReadOnlyProbeView(network, addresses, x);
      setViewResult(res);
    } catch (err) {
      setViewResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setViewBusy(false);
    }
  };

  const michelsonSourceIsNull = liveState?.michelson?.lastSource === NULL_SOURCE_ADDRESS;

  return (
    <section aria-labelledby={`${uid}-heading`} className="stack">
      {/* Module Header */}
      <div className="panel panel-evm">
        <div className="panel-header">
          <div>
            <h2 id={`${uid}-heading`} className="panel-title">
              <Flame size={16} className="text-evm" aria-hidden="true" />
              Module 3 · Live Canary Lab &amp; <code className="mono">429 OOG</code> / Revert
              Debugger
            </h2>
            <p className="panel-subtitle">
              Execute all 5 bidirectional Tezos X NAC probes against{' '}
              <strong style={{ color: 'var(--text-strong)' }}>{network.label}</strong>, capture
              Before/After block-pinned dual-runtime diffs, inspect live{' '}
              <code className="mono">callTracer</code> frames, and deep-link to{' '}
              <code className="mono">nactrace</code>.
            </p>
          </div>
          <div className="row" style={{ gap: '6px' }}>
            <span
              className={`badge ${
                addresses.source === 'manifest'
                  ? 'badge-ok'
                  : addresses.source === 'custom'
                    ? 'badge-michelson'
                    : 'badge-warn'
              }`}
            >
              Canary: {addresses.source.toUpperCase()}
            </span>
            {health && (
              <span className={`badge ${health.synced ? 'badge-ok' : 'badge-warn'}`}>
                {health.synced && health.evmHead !== null
                  ? `1:1 Head #${health.evmHead.toLocaleString()}`
                  : `EVM #${health.evmHead ?? '?'} / Mich #${health.michelsonLevel ?? '?'}`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* SECTION 1: Canary Pair Configuration & Live Dual-Runtime Telemetry    */}
      {/* ===================================================================== */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <Activity size={15} className="text-michelson" aria-hidden="true" />
            Section 1 · Canary Pair Configuration &amp; Live Dual-Runtime Telemetry
          </h3>
          <div className="row" style={{ gap: '6px' }}>
            {isConfigured && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={stateLoading}
                onClick={() => void refreshLiveState()}
              >
                {stateLoading ? (
                  <Loader2 size={12} aria-hidden="true" />
                ) : (
                  <RefreshCw size={12} aria-hidden="true" />
                )}
                Refresh Live State
              </button>
            )}
            {addresses.source === 'custom' && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={handleClearAddresses}>
                <Trash2 size={12} aria-hidden="true" />
                Reset Override
              </button>
            )}
          </div>
        </div>

        <div className="panel-body stack">
          {/* Address Input / Save Form */}
          <form onSubmit={handleSaveAddresses} className="stack-sm">
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`${uid}-evm-canary`} className="field-label">
                  NacCanaryEvm Address (0x…)
                </label>
                <input
                  id={`${uid}-evm-canary`}
                  className="input mono"
                  value={evmInput}
                  onChange={(e) => setEvmInput(e.target.value)}
                  placeholder="0x… (deployed NacCanaryEvm)"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor={`${uid}-kt1-canary`} className="field-label">
                  Michelson nac_canary Contract (KT1…)
                </label>
                <input
                  id={`${uid}-kt1-canary`}
                  className="input mono"
                  value={kt1Input}
                  onChange={(e) => setKt1Input(e.target.value)}
                  placeholder="KT1… (originated nac_canary)"
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="row-between">
              <span className="field-hint">
                Saved locally per network in <code className="mono">localStorage</code> (or auto-loaded
                from <code className="mono">config/deployments/{network.id}.json</code> after deploy).
              </span>
              <button type="submit" className="btn btn-sm btn-primary">
                <Save size={13} aria-hidden="true" />
                Save &amp; Connect Canary Pair
              </button>
            </div>

            {addrError && (
              <div role="alert" className="alert alert-danger">
                <ShieldAlert size={15} aria-hidden="true" />
                <span>{addrError}</span>
              </div>
            )}
          </form>

          {/* Non-blocking Setup Card when Unconfigured */}
          {!isConfigured && (
            <div className="alert alert-info" style={{ flexDirection: 'column', gap: '8px' }}>
              <div className="row-between" style={{ width: '100%' }}>
                <strong className="row" style={{ gap: '6px', color: 'var(--michelson)' }}>
                  <Terminal size={14} aria-hidden="true" />
                  No Canary Pair Configured for {network.label} Yet — Quick 3-Step Deploy
                </strong>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleCopy('deploy-cli', DEPLOY_CLI_STEPS)}
                >
                  {copiedKey === 'deploy-cli' ? <Check size={12} /> : <Copy size={12} />}
                  {copiedKey === 'deploy-cli' ? 'Copied' : 'Copy Commands'}
                </button>
              </div>
              <pre className="code-block pre" style={{ width: '100%' }}>
                {DEPLOY_CLI_STEPS}
              </pre>
              <span style={{ fontSize: '12px', color: 'var(--text)' }}>
                You do <strong>not</strong> need a deployed Canary pair to use the{' '}
                <strong>Section 3 Live Tx-Hash Trace &amp; 429 OOG Debugger</strong> below — paste
                any live {network.label} tx hash (or click the 1-click Previewnet sample hash) right
                now!
              </span>
            </div>
          )}

          {/* Live Side-by-Side EVM & Michelson Canary State */}
          {isConfigured && liveState && (
            <div className="stack-sm">
              <div className="row-between">
                <span className="field-label">Live Block-Pinned Canary State</span>
                <span className={`badge ${liveState.blockSynced ? 'badge-ok' : 'badge-warn'}`}>
                  {liveState.blockSynced
                    ? `EVM #${liveState.blockNumber.toLocaleString()} == Michelson #${liveState.michelsonLevel.toLocaleString()}`
                    : `EVM #${liveState.blockNumber} / Mich #${liveState.michelsonLevel}`}
                </span>
              </div>

              {liveState.error && (
                <div role="alert" className="alert alert-danger">
                  <XCircle size={15} aria-hidden="true" />
                  <span>{liveState.error}</span>
                </div>
              )}

              <div className="grid-2">
                {/* EVM Canary State */}
                <div className="panel panel-evm">
                  <div className="panel-header">
                    <span className="mono text-evm" style={{ fontWeight: 700, fontSize: '12px' }}>
                      EVM · NacCanaryEvm ({shortAddr(addresses.evmCanary)})
                    </span>
                    <span className="badge badge-evm">Runtime 1</span>
                  </div>
                  <div className="panel-body">
                    {liveState.evm ? (
                      <div className="kv-grid">
                        <div className="kv-item">
                          <span className="kv-label">writeCount</span>
                          <span className="kv-value">{liveState.evm.writeCount}</span>
                        </div>
                        <div className="kv-item">
                          <span className="kv-label">roundTripCount</span>
                          <span className="kv-value">{liveState.evm.roundTripCount}</span>
                        </div>
                        <div className="kv-item">
                          <span className="kv-label">rollbackSentinel</span>
                          <span className="kv-value text-ok">{liveState.evm.rollbackSentinel}</span>
                        </div>
                        <div className="kv-item">
                          <span className="kv-label">lastCallbackNonce</span>
                          <span className="kv-value">{liveState.evm.lastCallbackNonce}</span>
                        </div>
                        <div className="kv-item">
                          <span className="kv-label">lastOogOk</span>
                          <span
                            className={`kv-value ${
                              liveState.evm.lastOogOk ? 'text-ok' : 'text-danger'
                            }`}
                          >
                            {String(liveState.evm.lastOogOk)}
                          </span>
                        </div>
                        <div className="kv-item">
                          <span className="kv-label">lastOogGasUsed</span>
                          <span className="kv-value">{liveState.evm.lastOogGasUsed}</span>
                        </div>
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>
                        Could not decode EVM Canary getters at this address.
                      </span>
                    )}
                  </div>
                </div>

                {/* Michelson Canary State */}
                <div className="panel panel-michelson">
                  <div className="panel-header">
                    <span
                      className="mono text-michelson"
                      style={{ fontWeight: 700, fontSize: '12px' }}
                    >
                      MICHELSON · nac_canary ({shortAddr(addresses.michelsonCanary)})
                    </span>
                    <span className="badge badge-michelson">Runtime 0</span>
                  </div>
                  <div className="panel-body stack-sm">
                    {liveState.michelson ? (
                      <>
                        <div className="kv-grid">
                          <div className="kv-item">
                            <span className="kv-label">pingCount</span>
                            <span className="kv-value">{liveState.michelson.pingCount}</span>
                          </div>
                          <div className="kv-item">
                            <span className="kv-label">callbackCount</span>
                            <span className="kv-value">{liveState.michelson.callbackCount}</span>
                          </div>
                          <div className="kv-item">
                            <span className="kv-label">lastNote</span>
                            <span className="kv-value">
                              {liveState.michelson.lastNote || '""'}
                            </span>
                          </div>
                          <div className="kv-item">
                            <span className="kv-label">lastSender (SENDER)</span>
                            <span className="kv-value">
                              {shortAddr(liveState.michelson.lastSender, 10, 6)}
                            </span>
                          </div>
                        </div>

                        <div
                          className={`alert ${michelsonSourceIsNull ? 'alert-warn' : 'alert-info'}`}
                          style={{ padding: '8px 10px' }}
                        >
                          <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                          <div style={{ fontSize: '12px' }}>
                            <strong>lastSource (SOURCE):</strong>{' '}
                            <code className="mono">{liveState.michelson.lastSource || '—'}</code>
                            {michelsonSourceIsNull && (
                              <span style={{ display: 'block', marginTop: '2px' }}>
                                Null cross-runtime <code className="mono">SOURCE</code> detected (
                                <code className="mono">tz1Ke2h7…</code>) — confirms EVM→Michelson
                                calls MUST authorize via <code className="mono">SENDER</code>, never{' '}
                                <code className="mono">SOURCE</code>!
                              </span>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <span className="muted" style={{ fontSize: '12px' }}>
                        Could not parse Michelson Canary storage at this address.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* SECTION 2: 5 Interactive Live Canary Probes                           */}
      {/* ===================================================================== */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">
              <Play size={15} className="text-evm" aria-hidden="true" />
              Section 2 · 5 Interactive Bidirectional NAC Canary Probes
            </h3>
            <p className="panel-subtitle">
              Write probes broadcast real EIP-1193 transactions, capture Before/After block-pinned
              diffs, and hand the tx hash directly into the Section 3 trace debugger.
            </p>
          </div>
          <div className="row" style={{ gap: '6px' }}>
            {evmWallet.address ? (
              <span className="badge badge-ok">
                Wallet: {shortAddr(evmWallet.address, 6, 4)}
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void onConnectEvm()}
              >
                <Wallet size={13} aria-hidden="true" />
                Connect EVM Wallet (for Write Probes)
              </button>
            )}
          </div>
        </div>

        <div className="panel-body stack">
          {/* Probe Execution Banner + Auto Block-Pinned Diff */}
          {lastExecution && (
            <div
              aria-live="polite"
              className={`alert ${
                lastExecution.status === 'error'
                  ? 'alert-danger'
                  : lastExecution.status === 'completed'
                    ? 'alert-ok'
                    : 'alert-info'
              }`}
              style={{ flexDirection: 'column', gap: '8px' }}
            >
              <div className="row-between" style={{ width: '100%' }}>
                <strong className="row" style={{ gap: '6px' }}>
                  {lastExecution.status === 'running' ? (
                    <Loader2 size={14} aria-hidden="true" />
                  ) : lastExecution.status === 'completed' ? (
                    <CheckCircle2 size={14} aria-hidden="true" />
                  ) : (
                    <XCircle size={14} aria-hidden="true" />
                  )}
                  {lastExecution.label}
                </strong>
                {lastExecution.txHash && (
                  <code className="mono" style={{ fontSize: '11.5px' }}>
                    tx: {shortAddr(lastExecution.txHash, 12, 8)}
                  </code>
                )}
              </div>
              <span style={{ color: 'var(--text-strong)', fontSize: '12.5px' }}>
                {lastExecution.message}
              </span>

              {lastExecution.stateDiff && (
                <div className="kv-grid" style={{ width: '100%' }}>
                  <div className="kv-item">
                    <span className="kv-label">Δ Block (Pinned)</span>
                    <span className="kv-value">
                      {lastExecution.stateDiff.blockDelta >= 0
                        ? `+${lastExecution.stateDiff.blockDelta}`
                        : String(lastExecution.stateDiff.blockDelta)}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label text-evm">Δ EVM Wei</span>
                    <span className="kv-value">
                      {formatSignedDelta(lastExecution.stateDiff.evmBalanceDeltaWei, 'wei')}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label text-michelson">Δ Michelson Mutez</span>
                    <span className="kv-value">
                      {formatSignedDelta(
                        lastExecution.stateDiff.michelsonBalanceDeltaMutez,
                        'mutez',
                      )}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Michelson Storage</span>
                    <span
                      className={`kv-value ${
                        lastExecution.stateDiff.michelsonStorageChanged ? 'text-evm' : 'text-ok'
                      }`}
                    >
                      {lastExecution.stateDiff.michelsonStorageChanged ? 'MUTATED' : 'UNCHANGED'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 5 Probe Cards */}
          <div className="grid-2">
            {/* PROBE 1: Atomic Write */}
            <div className="panel panel-evm">
              <div className="panel-header">
                <span className="panel-title">
                  <Send size={14} className="text-evm" aria-hidden="true" />
                  Probe 1 · Atomic Write (<code className="mono">probeWrite</code> →{' '}
                  <code className="mono">%record_ping</code>)
                </span>
                <span className="badge badge-evm">{CANARY_SELECTORS.probeWrite}</span>
              </div>
              <div className="panel-body stack-sm">
                <div className="field">
                  <label htmlFor={`${uid}-p1-note`} className="field-label">
                    Note Payload (UTF-8 string)
                  </label>
                  <input
                    id={`${uid}-p1-note`}
                    className="input mono"
                    value={writeNote}
                    onChange={(e) => setWriteNote(e.target.value)}
                  />
                </div>

                <div className="grid-2">
                  <div className="field">
                    <div className="field-label">
                      <label htmlFor={`${uid}-p1-wei`}>Value (wei, 10¹² aligned)</label>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setWriteValueWei('1000000000000000')}
                      >
                        0.001 XTZ
                      </button>
                    </div>
                    <input
                      id={`${uid}-p1-wei`}
                      className="input mono"
                      inputMode="numeric"
                      value={writeValueWei}
                      onChange={(e) => setWriteValueWei(e.target.value)}
                      style={{
                        borderColor: !writeDustStatus.aligned ? 'var(--danger)' : undefined,
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${uid}-p1-gas`} className="field-label">
                      NAC Gas Cap
                    </label>
                    <input
                      id={`${uid}-p1-gas`}
                      className="input mono"
                      inputMode="numeric"
                      value={writeGasCap}
                      onChange={(e) => setWriteGasCap(e.target.value)}
                    />
                  </div>
                </div>

                <div className="row-between">
                  {writeDustStatus.aligned ? (
                    <span className="mono text-ok" style={{ fontSize: '11.5px' }}>
                      Aligned: {writeDustStatus.mutez} mutez (0 wei dust)
                    </span>
                  ) : (
                    <span className="mono text-danger" style={{ fontSize: '11.5px' }}>
                      Dust remainder: {writeDustStatus.remainder} wei (must be multiple of 10¹²)
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-evm"
                    disabled={
                      activeProbe !== null || !isConfigured || !writeDustStatus.aligned
                    }
                    onClick={() => {
                      const gasCap = parseNonNegativeBigInt(writeGasCap, 5_000_000n);
                      const valueWei = parseNonNegativeBigInt(writeValueWei, 0n);
                      const data = encodeProbeWriteCalldata(
                        addresses.michelsonCanary,
                        writeNote,
                        gasCap,
                      );
                      void executeWriteProbe('write', 'Probe 1 · probeWrite', data, {
                        valueWei,
                        gasLimit: gasCap + 500_000n,
                      });
                    }}
                  >
                    {activeProbe === 'write' ? (
                      <Loader2 size={14} aria-hidden="true" />
                    ) : (
                      <Send size={14} aria-hidden="true" />
                    )}
                    Send probeWrite
                  </button>
                </div>
              </div>
            </div>

            {/* PROBE 2: Nested Bidirectional Round-Trip */}
            <div className="panel panel-michelson">
              <div className="panel-header">
                <span className="panel-title">
                  <ArrowLeftRight size={14} className="text-michelson" aria-hidden="true" />
                  Probe 2 · Bidirectional Round-Trip (<code className="mono">probeRoundTrip</code>)
                </span>
                <span className="badge badge-michelson">{CANARY_SELECTORS.probeRoundTrip}</span>
              </div>
              <div className="panel-body stack-sm">
                <p className="muted" style={{ margin: 0, fontSize: '12px' }}>
                  EVM <code className="mono">probeRoundTrip</code> → Michelson{' '}
                  <code className="mono">%echo_callback</code> →{' '}
                  <code className="mono">%call_evm</code> → EVM{' '}
                  <code className="mono">onMichelsonCallback(uint256,uint256)</code> inside one
                  atomic transaction.
                </p>

                <div className="grid-2">
                  <div className="field">
                    <label htmlFor={`${uid}-p2-nonce`} className="field-label">
                      Callback Nonce (nat)
                    </label>
                    <input
                      id={`${uid}-p2-nonce`}
                      className="input mono"
                      inputMode="numeric"
                      value={rtNonce}
                      onChange={(e) => setRtNonce(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${uid}-p2-gas`} className="field-label">
                      NAC Gas Cap
                    </label>
                    <input
                      id={`${uid}-p2-gas`}
                      className="input mono"
                      inputMode="numeric"
                      value={rtGasCap}
                      onChange={(e) => setRtGasCap(e.target.value)}
                    />
                  </div>
                </div>

                <div className="row-between">
                  <span className="mono muted" style={{ fontSize: '11.5px' }}>
                    Callback selector: {CANARY_SELECTORS.onMichelsonCallback}
                  </span>
                  <button
                    type="button"
                    className="btn btn-michelson"
                    disabled={activeProbe !== null || !isConfigured}
                    onClick={() => {
                      const nonce = parseNonNegativeBigInt(rtNonce, 42n);
                      const gasCap = parseNonNegativeBigInt(rtGasCap, 5_000_000n);
                      const data = encodeProbeRoundTripCalldata(
                        addresses.michelsonCanary,
                        nonce,
                        gasCap,
                      );
                      void executeWriteProbe('roundTrip', 'Probe 2 · probeRoundTrip', data, {
                        gasLimit: gasCap + 1_000_000n,
                      });
                    }}
                  >
                    {activeProbe === 'roundTrip' ? (
                      <Loader2 size={14} aria-hidden="true" />
                    ) : (
                      <ArrowLeftRight size={14} aria-hidden="true" />
                    )}
                    Run Round-Trip
                  </button>
                </div>
              </div>
            </div>

            {/* PROBE 3: Synchronous Read-Only View (No Wallet Needed) */}
            <div className="panel panel-michelson" style={{ gridColumn: '1 / -1' }}>
              <div className="panel-header">
                <span className="panel-title">
                  <Eye size={14} className="text-ok" aria-hidden="true" />
                  Probe 3 · Synchronous Read-Only View (<code className="mono">probeView</code>{' '}
                  <code className="mono">0x8326329c</code> + <code className="mono">echoView</code>{' '}
                  + <code className="mono">run_script_view</code>)
                </span>
                <span className="badge badge-ok">ZERO WALLET NEEDED</span>
              </div>
              <div className="panel-body stack-sm">
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div className="field" style={{ maxWidth: '220px', flex: '1 1 160px' }}>
                    <label htmlFor={`${uid}-p3-x`} className="field-label">
                      Numeric Input x (uint256 / nat)
                    </label>
                    <input
                      id={`${uid}-p3-x`}
                      className="input mono"
                      inputMode="numeric"
                      value={viewArgX}
                      onChange={(e) => setViewArgX(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={viewBusy || !isConfigured}
                    onClick={() => void handleRunReadOnlyView()}
                  >
                    {viewBusy ? (
                      <Loader2 size={14} aria-hidden="true" />
                    ) : (
                      <Eye size={14} aria-hidden="true" />
                    )}
                    Run Read-Only View (No Wallet Needed)
                  </button>
                </div>

                {viewResult && (
                  <div aria-live="polite" className="stack-sm">
                    {!viewResult.ok && viewResult.error && (
                      <div role="alert" className="alert alert-danger">
                        <XCircle size={14} aria-hidden="true" />
                        <span>{viewResult.error}</span>
                      </div>
                    )}
                    <div className="grid-3">
                      <div className="kv-item">
                        <span className="kv-label text-evm">
                          probeView (0x8326329c) Decoded Digest
                        </span>
                        <pre className="code-block pre" style={{ marginTop: '4px', maxHeight: '140px' }}>
                          {viewResult.decodedDigest !== undefined
                            ? JSON.stringify(viewResult.decodedDigest, null, 2)
                            : '—'}
                        </pre>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label text-evm">echoView(x) EVM Direct</span>
                        <pre className="code-block pre" style={{ marginTop: '4px', maxHeight: '140px' }}>
                          {viewResult.echoViewResult
                            ? JSON.stringify(viewResult.echoViewResult, null, 2)
                            : '—'}
                        </pre>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label text-michelson">
                          Michelson run_script_view (get_state_digest)
                        </span>
                        <pre className="code-block pre" style={{ marginTop: '4px', maxHeight: '140px' }}>
                          {viewResult.runScriptViewResult !== undefined
                            ? JSON.stringify(viewResult.runScriptViewResult, null, 2)
                            : '—'}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* PROBE 4: Atomic Rollback */}
            <div className="panel" style={{ borderTop: '2px solid var(--danger)' }}>
              <div className="panel-header">
                <span className="panel-title">
                  <RotateCcw size={14} className="text-danger" aria-hidden="true" />
                  Probe 4 · Atomic Rollback (<code className="mono">probeRollback</code> →{' '}
                  <code className="mono">%force_fail</code>)
                </span>
                <span className="badge badge-danger">gasLimit: 6,000,000</span>
              </div>
              <div className="panel-body stack-sm">
                <p className="muted" style={{ margin: 0, fontSize: '12px' }}>
                  Mutates <code className="mono">rollbackSentinel += 1</code> in EVM, then triggers{' '}
                  <code className="mono">FAILWITH</code> in Michelson. Passes explicit{' '}
                  <code className="mono">gasLimit: 6,000,000</code> so the reverted tx mines
                  on-chain and proves <code className="mono">rollbackSentinel</code> rolls back to
                  its exact pre-tx value.
                </p>

                <div className="grid-2">
                  <div className="field">
                    <label htmlFor={`${uid}-p4-reason`} className="field-label">
                      Failure Reason (string)
                    </label>
                    <input
                      id={`${uid}-p4-reason`}
                      className="input mono"
                      value={rollbackReason}
                      onChange={(e) => setRollbackReason(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${uid}-p4-gas`} className="field-label">
                      NAC Gas Cap
                    </label>
                    <input
                      id={`${uid}-p4-gas`}
                      className="input mono"
                      inputMode="numeric"
                      value={rollbackGasCap}
                      onChange={(e) => setRollbackGasCap(e.target.value)}
                    />
                  </div>
                </div>

                <div className="row-between">
                  <span className="mono muted" style={{ fontSize: '11.5px' }}>
                    Current sentinel: {liveState?.evm?.rollbackSentinel ?? '—'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={activeProbe !== null || !isConfigured}
                    onClick={() => {
                      const gasCap = parseNonNegativeBigInt(rollbackGasCap, 5_000_000n);
                      const data = encodeProbeRollbackCalldata(
                        addresses.michelsonCanary,
                        rollbackReason,
                        gasCap,
                      );
                      void executeWriteProbe('rollback', 'Probe 4 · probeRollback', data, {
                        gasLimit: 6_000_000n,
                      });
                    }}
                  >
                    {activeProbe === 'rollback' ? (
                      <Loader2 size={14} aria-hidden="true" />
                    ) : (
                      <RotateCcw size={14} aria-hidden="true" />
                    )}
                    Trigger Rollback Proof
                  </button>
                </div>
              </div>
            </div>

            {/* PROBE 5: Cross-Runtime 429 OOG */}
            <div className="panel" style={{ borderTop: '2px solid var(--warn)' }}>
              <div className="panel-header">
                <span className="panel-title">
                  <Flame size={14} className="text-warn" aria-hidden="true" />
                  Probe 5 · Cross-Runtime <code className="mono">429 OOG</code> (
                  <code className="mono">probeOog</code> →{' '}
                  <code className="mono">%burn_gas</code>)
                </span>
                <span className="badge badge-warn">{CANARY_SELECTORS.probeOog}</span>
              </div>
              <div className="panel-body stack-sm">
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor={`${uid}-p5-iter`} className="field-label">
                      BLAKE2B Loop Iterations
                    </label>
                    <input
                      id={`${uid}-p5-iter`}
                      className="input mono"
                      inputMode="numeric"
                      value={oogIterations}
                      onChange={(e) => setOogIterations(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <div className="field-label">
                      <label htmlFor={`${uid}-p5-gas`}>Tight Cross-Runtime Gas Cap</label>
                      <div className="row" style={{ gap: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setOogGasCap('30000')}
                        >
                          30k
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setOogGasCap('400000')}
                        >
                          400k
                        </button>
                      </div>
                    </div>
                    <input
                      id={`${uid}-p5-gas`}
                      className="input mono"
                      inputMode="numeric"
                      value={oogGasCap}
                      onChange={(e) => setOogGasCap(e.target.value)}
                    />
                  </div>
                </div>

                <label
                  htmlFor={`${uid}-p5-catch`}
                  className="row"
                  style={{
                    gap: '8px',
                    padding: '7px 10px',
                    borderRadius: '6px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  <input
                    id={`${uid}-p5-catch`}
                    type="checkbox"
                    checked={oogCatchRevert}
                    onChange={(e) => setOogCatchRevert(e.target.checked)}
                  />
                  <span>
                    <code className="mono">catchRevert</code>:{' '}
                    <strong>
                      {oogCatchRevert
                        ? 'Isolate in EVM (store 429 payload & gas used, 6M gasLimit)'
                        : 'Propagate Revert (mine reverted tx with explicit 3M gasLimit)'}
                    </strong>
                  </span>
                </label>

                <div className="row-between">
                  <span className="mono muted" style={{ fontSize: '11.5px' }}>
                    {oogCatchRevert ? 'tx succeeds; captures 429 bytes' : 'tx reverts; proves 429 trace'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-evm"
                    disabled={activeProbe !== null || !isConfigured}
                    onClick={() => {
                      const iters = parseNonNegativeBigInt(oogIterations, 1000n);
                      const gasCap = parseNonNegativeBigInt(oogGasCap, 30_000n);
                      const data = encodeProbeOogCalldata(
                        addresses.michelsonCanary,
                        iters,
                        gasCap,
                        oogCatchRevert,
                      );
                      void executeWriteProbe('oog', 'Probe 5 · probeOog (429 OOG)', data, {
                        gasLimit: oogCatchRevert ? 6_000_000n : 3_000_000n,
                      });
                    }}
                  >
                    {activeProbe === 'oog' ? (
                      <Loader2 size={14} aria-hidden="true" />
                    ) : (
                      <Zap size={14} aria-hidden="true" />
                    )}
                    Trigger 429 OOG Probe
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* SECTION 3: Live Transaction Trace, 429 OOG Debugger & nactrace Handoff*/}
      {/* ===================================================================== */}
      <div className="panel panel-michelson">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">
              <Layers size={15} className="text-michelson" aria-hidden="true" />
              Section 3 · Live Transaction Trace, <code className="mono">429 OOG</code> / L1-Error
              Debugger &amp; <code className="mono">nactrace</code> Handoff
            </h3>
            <p className="panel-subtitle">
              Inspect any EVM transaction hash live via <code className="mono">callTracer</code>{' '}
              (with automatic Blockscout v2 internal-tx fallback) and hand off post-hoc forensics to{' '}
              <code className="mono">Migl992/nactrace</code>.
            </p>
          </div>
          {network.id === 'previewnet' && (
            <div className="row" style={{ gap: '6px' }}>
              {addresses.proofTxs?.probeRoundTrip && (
                <button
                  type="button"
                  className="btn btn-sm btn-michelson"
                  onClick={() => {
                    const h = addresses.proofTxs!.probeRoundTrip!;
                    setTxHashInput(h);
                    void runTraceInspection(h);
                  }}
                >
                  Canary Round-Trip
                </button>
              )}
              {addresses.proofTxs?.probeOogCatch && (
                <button
                  type="button"
                  className="btn btn-sm btn-evm"
                  onClick={() => {
                    const h = addresses.proofTxs!.probeOogCatch!;
                    setTxHashInput(h);
                    void runTraceInspection(h);
                  }}
                >
                  Canary Caught 429 OOG
                </button>
              )}
              {addresses.proofTxs?.probeRollback && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    const h = addresses.proofTxs!.probeRollback!;
                    setTxHashInput(h);
                    void runTraceInspection(h);
                  }}
                >
                  Canary Atomic Rollback
                </button>
              )}
              {addresses.proofTxs?.probeWrite && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const h = addresses.proofTxs!.probeWrite!;
                    setTxHashInput(h);
                    void runTraceInspection(h);
                  }}
                >
                  Canary Write
                </button>
              )}
              {addresses.proofTxs?.probeOogPropagate && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const h = addresses.proofTxs!.probeOogPropagate!;
                    setTxHashInput(h);
                    void runTraceInspection(h);
                  }}
                >
                  Propagated 429 OOG
                </button>
              )}
            </div>
          )}
        </div>

        <div className="panel-body stack">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runTraceInspection();
            }}
            className="row"
            style={{ alignItems: 'stretch' }}
          >
            <label
              htmlFor={`${uid}-tx-hash`}
              style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}
            >
              EVM transaction hash to trace
            </label>
            <input
              id={`${uid}-tx-hash`}
              className="input mono"
              style={{ flex: '1 1 360px' }}
              value={txHashInput}
              onChange={(e) => setTxHashInput(e.target.value)}
              placeholder="0x… (paste any EVM transaction hash)"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={traceLoading || !txHashInput.trim()}
              style={{ minWidth: '165px' }}
            >
              {traceLoading ? (
                <>
                  <Loader2 size={14} aria-hidden="true" />
                  Tracing Tx…
                </>
              ) : (
                <>
                  <Search size={14} aria-hidden="true" />
                  Inspect Trace
                </>
              )}
            </button>
          </form>

          {traceError && (
            <div role="alert" className="alert alert-danger">
              <XCircle size={15} aria-hidden="true" />
              <span>{traceError}</span>
            </div>
          )}

          {traceReport && (
            <div aria-live="polite" className="stack">
              {/* Receipt & Trace Source Summary Strip */}
              <div className="row-between">
                <div className="row" style={{ gap: '6px' }}>
                  <span
                    className={`badge ${
                      traceReport.status === 'success'
                        ? 'badge-ok'
                        : traceReport.status === 'reverted'
                          ? 'badge-danger'
                          : 'badge-warn'
                    }`}
                  >
                    STATUS: {traceReport.status.toUpperCase()}
                  </span>
                  <span
                    className={`badge ${
                      traceReport.traceSource === 'callTracer'
                        ? 'badge-ok'
                        : traceReport.traceSource === 'blockscout_fallback'
                          ? 'badge-warn'
                          : 'badge-muted'
                    }`}
                  >
                    {traceReport.traceSource === 'callTracer'
                      ? 'callTracer LIVE'
                      : traceReport.traceSource === 'blockscout_fallback'
                        ? 'Blockscout Fallback'
                        : 'Receipt Only'}
                  </span>
                  <span className="badge badge-evm">
                    {traceReport.gatewayHops} Gateway Hop(s)
                  </span>
                  {traceReport.blockNumber !== null && (
                    <span className="badge badge-muted">
                      Block #{traceReport.blockNumber.toLocaleString()}
                    </span>
                  )}
                  {traceReport.gasUsed !== null && (
                    <span className="badge badge-muted">
                      Gas Used: {Number(traceReport.gasUsed).toLocaleString()}
                    </span>
                  )}
                </div>

                {/* 1-Click External Deep-Links & Share Link (Complementary to Migl992/nactrace!) */}
                <div className="row" style={{ gap: '6px' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const url = `${window.location.origin}${window.location.pathname}?network=${network.id}&tab=canary&tx=${encodeURIComponent(traceReport.txHash)}`;
                      void handleCopy('share-tx', url);
                    }}
                  >
                    {copiedKey === 'share-tx' ? <Check size={12} /> : <Link2 size={12} />}
                    {copiedKey === 'share-tx' ? 'Link Copied' : 'Copy Share Link'}
                  </button>
                  <a
                    href={traceReport.nactraceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm btn-michelson"
                  >
                    Inspect in nactrace <ExternalLink size={12} />
                  </a>
                  <a
                    href={traceReport.blockscoutUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                  >
                    Blockscout <ExternalLink size={12} />
                  </a>
                  <a
                    href={traceReport.tzktUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                  >
                    TzKT <ExternalLink size={12} />
                  </a>
                </div>
              </div>

              {/* Decoded Top-Level Revert Card */}
              {traceReport.decodedTopRevert && (
                <div
                  className={`alert ${
                    traceReport.decodedTopRevert.status === 429 ? 'alert-danger' : 'alert-warn'
                  }`}
                  style={{ flexDirection: 'column', gap: '6px' }}
                >
                  <div className="row" style={{ gap: '6px' }}>
                    <ShieldAlert size={16} aria-hidden="true" />
                    <span className="badge badge-danger">
                      {traceReport.decodedTopRevert.kind}
                    </span>
                    {traceReport.decodedTopRevert.status !== undefined && (
                      <span className="badge badge-danger">
                        HTTP / NAC {traceReport.decodedTopRevert.status}
                      </span>
                    )}
                    <strong style={{ color: 'var(--text-strong)' }}>
                      {traceReport.status === 'success'
                        ? 'Caught Inner Cross-Runtime Revert (Outer Tx Succeeded)'
                        : 'Decoded Top-Level Revert'}
                    </strong>
                  </div>
                  <span style={{ color: 'var(--text-strong)', fontSize: '13px' }}>
                    {traceReport.decodedTopRevert.summary}
                  </span>
                  <code className="mono muted" style={{ fontSize: '11.5px', wordBreak: 'break-all' }}>
                    raw: {traceReport.decodedTopRevert.raw}
                  </code>
                </div>
              )}

              {traceReport.rawTraceError && traceReport.traceSource !== 'callTracer' && (
                <div className="alert alert-warn" style={{ padding: '8px 11px' }}>
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span style={{ fontSize: '12px' }}>
                    <code className="mono">debug_traceTransaction</code> unavailable on this RPC (
                    <code className="mono">{traceReport.rawTraceError}</code>) — automatically fell
                    back to <strong>{traceReport.traceSource}</strong>.
                  </span>
                </div>
              )}

              {/* Indented Call-Frame Tree */}
              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label">
                    Indented Call-Frame Tree ({traceReport.frames.length} frame(s))
                  </span>
                  <span className="mono muted" style={{ fontSize: '11px' }}>
                    NACBench pairs proactive execution with nactrace post-hoc forensics
                  </span>
                </div>

                {traceReport.frames.length > 0 ? (
                  <div className="stack-sm">
                    {traceReport.frames.map((frame, i) => (
                      <TraceFrameRow key={`${frame.depth}-${frame.from}-${frame.to}-${i}`} frame={frame} index={i} />
                    ))}
                  </div>
                ) : (
                  <div className="alert alert-info">
                    <GitCompare size={14} aria-hidden="true" />
                    <span>
                      No nested call frames returned for this transaction (receipt status:{' '}
                      <strong>{traceReport.status}</strong>). Use <strong>Inspect in nactrace</strong>{' '}
                      or <strong>Blockscout</strong> above for external explorer details.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
