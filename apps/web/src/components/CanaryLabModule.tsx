import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  ExternalLink,
  GitCompare,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
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
  CanaryProofTxs,
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
import {
  CopyButton,
  Progress,
  RuntimePill,
  StepTitle,
  TabList,
  TabPanel,
  WalletNeedPill,
  useCopy,
  type ProgressState,
} from './ui';

const WEI_PER_MUTEZ = 1_000_000_000_000n;
const DEPLOY_CLI_STEPS = `npm run wallets:generate
# Fund printed tz1 & 0x addresses at https://faucet.previewnet.tezosx.nomadic-labs.com
npm run deploy:previewnet -- --live`;

type LabMode = 'trace' | 'probe';
type ProbePhase = 'preparing' | 'signing' | 'mining' | 'settled' | 'error';

interface ProbeExecutionRecord {
  kind: CanaryProbeKind;
  label: string;
  txHash?: string;
  status: 'running' | 'completed' | 'error';
  phase: ProbePhase;
  errorAt?: Exclude<ProbePhase, 'settled' | 'error'>;
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

type ProofKey = Exclude<keyof CanaryProofTxs, 'verifiedAt'>;

const PROOF_CHIPS: { key: ProofKey; title: string; sub: string }[] = [
  { key: 'probeOogCatch', title: 'Caught 429 OOG', sub: 'Outer tx succeeds, inner 429 caught' },
  { key: 'probeRoundTrip', title: 'Round-trip', sub: 'EVM → Michelson → EVM in one tx' },
  { key: 'probeRollback', title: 'Atomic rollback', sub: 'Reverts on-chain, sentinel unchanged' },
  { key: 'probeWrite', title: 'Atomic write', sub: 'EVM → %record_ping with value' },
  { key: 'probeOogPropagate', title: 'Propagated 429 OOG', sub: 'Revert bubbles up to the EVM tx' },
];

const PROBES: {
  kind: CanaryProbeKind;
  n: number;
  title: string;
  desc: string;
  readOnly: boolean;
}[] = [
  { kind: 'write', n: 1, title: 'Atomic write', desc: 'probeWrite → %record_ping', readOnly: false },
  {
    kind: 'roundTrip',
    n: 2,
    title: 'Round-trip',
    desc: 'probeRoundTrip → %echo_callback → EVM',
    readOnly: false,
  },
  {
    kind: 'view',
    n: 3,
    title: 'Read-only view',
    desc: 'probeView 0x8326329c · run_script_view',
    readOnly: true,
  },
  {
    kind: 'rollback',
    n: 4,
    title: 'Atomic rollback',
    desc: 'probeRollback → %force_fail',
    readOnly: false,
  },
  { kind: 'oog', n: 5, title: 'Cross-runtime 429 OOG', desc: 'probeOog → %burn_gas', readOnly: false },
];

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
  const indentPx = Math.min(frame.depth, 6) * 16;

  return (
    <div
      style={{ marginLeft: `${indentPx}px` }}
      className={`frame stack-sm ${hasErr ? 'frame-error' : frame.isGatewayPrecompile ? 'frame-gateway' : ''}`}
    >
      <div className="row-between" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="pill pill-sm pill-muted mono">#{index}</span>
          <span className="pill pill-sm mono">{frame.type}</span>
          {frame.isGatewayPrecompile && (
            <span className="pill pill-sm pill-evm">NAC gateway hop · 0xff…0007</span>
          )}
          <span className="pill pill-sm pill-muted mono">sel {frame.inputSelector}</span>
          {frame.decodedRevert?.status !== undefined && (
            <span className="pill pill-sm pill-danger">HTTP / NAC {frame.decodedRevert.status}</span>
          )}
        </div>
        <span className="mono muted xsmall">
          gasUsed <strong className="strong">{frame.gasUsed}</strong> / {frame.gas}
        </span>
      </div>

      <div className="mono xsmall break-all">
        <span className="muted">from</span> {frame.from} <span className="muted">→</span> {frame.to}
        {frame.valueWei && frame.valueWei !== '0' && (
          <span className="muted"> · value={frame.valueWei} wei</span>
        )}
      </div>

      {frame.decodedRevert && (
        <div className="stack-xs">
          <div className="row" style={{ gap: 6 }}>
            <span className={`pill pill-sm ${isOog ? 'pill-danger' : 'pill-warn'}`}>
              {frame.decodedRevert.kind}
            </span>
            <strong className="strong small">{frame.decodedRevert.summary}</strong>
          </div>
          <code className="muted xsmall break-all">{frame.decodedRevert.raw}</code>
        </div>
      )}

      {!frame.decodedRevert && frame.error && (
        <span className="mono text-danger xsmall">error: {frame.error}</span>
      )}

      {frame.output && frame.output !== '0x' && !frame.decodedRevert && (
        <code className="muted xsmall break-all">
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
  const { copiedKey, copy: handleCopy } = useCopy();
  const autoRanInitialTxRef = useRef(false);
  const [mode, setMode] = useState<LabMode>('trace');
  const [selectedProbe, setSelectedProbe] = useState<CanaryProbeKind>('view');
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [editOpen, setEditOpen] = useState<boolean>(false);

  // Canary pair addresses & live state
  const [addresses, setAddresses] = useState<CanaryAddresses>(() =>
    loadDefaultCanaryAddresses(network.id),
  );
  const [evmInput, setEvmInput] = useState<string>(addresses.evmCanary);
  const [kt1Input, setKt1Input] = useState<string>(addresses.michelsonCanary);
  const [addrError, setAddrError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<CanaryLiveState | null>(null);
  const [stateLoading, setStateLoading] = useState<boolean>(false);

  // Probe inputs & status
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

  // Tx-hash trace debugger
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

  const refreshLiveState = useCallback(
    async (targetAddrs?: CanaryAddresses): Promise<CanaryLiveState | null> => {
      const active = targetAddrs ?? addresses;
      if (!isValidEvmAddress(active.evmCanary) || !isValidTezosXAddress(active.michelsonCanary)) {
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
    setEditOpen(false);
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

  // Inspect any EVM tx hash
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
      setMode('trace');
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
        phase: 'error',
        errorAt: 'preparing',
        message: 'Configure deployed NacCanaryEvm (0x…) and nac_canary (KT1…) addresses first.',
      });
      return;
    }
    if (!evmWallet.address) {
      await onConnectEvm();
      return;
    }

    let currentPhase: Exclude<ProbePhase, 'settled' | 'error'> = 'preparing';
    setActiveProbe(kind);
    setLastExecution({
      kind,
      label,
      status: 'running',
      phase: 'preparing',
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

      currentPhase = 'signing';
      setLastExecution({
        kind,
        label,
        status: 'running',
        phase: 'signing',
        message: 'Awaiting EVM wallet signature & broadcast…',
        beforeSentinel,
      });

      const provider = await resolveProvider();
      const txHash = await sendCanaryProbeTx(provider, network, addresses.evmCanary, calldata, opts);
      setTxHashInput(txHash);

      currentPhase = 'mining';
      setLastExecution({
        kind,
        label,
        txHash,
        status: 'running',
        phase: 'mining',
        message: `Broadcast ${shortAddr(txHash, 10, 8)} — polling receipt & callTracer…`,
        beforeSentinel,
      });

      const report = await waitForReceiptAndInspect(network, txHash, 45_000);
      setTraceReport(report);
      setTraceError(null);
      onTxHashChange?.(txHash);

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
            ? `Atomic rollback proven: tx reverted on-chain & rollbackSentinel stayed ${afterSentinel} (0 net state mutation).`
            : `Rollback tx status=${report.status}; sentinel ${beforeSentinel ?? '?'} → ${afterSentinel ?? '?'}.`
          : `Probe settled (${report.status}) via ${report.traceSource} · ${report.gatewayHops} gateway hop(s).`;

      setLastExecution({
        kind,
        label,
        txHash,
        status: 'completed',
        phase: 'settled',
        message: statusText,
        beforeSentinel,
        afterSentinel,
        stateDiff,
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const decoded = decodeRevertPayload(rawMsg);
      setLastExecution((prev) => ({
        kind,
        label,
        txHash: prev?.kind === kind ? prev.txHash : undefined,
        status: 'error',
        phase: 'error',
        errorAt: currentPhase,
        message: decoded.summary || rawMsg,
        beforeSentinel,
      }));
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

  const openTraceFor = (hash: string) => {
    setMode('trace');
    setTxHashInput(hash);
    if (traceReport?.txHash.toLowerCase() !== hash.toLowerCase()) {
      void runTraceInspection(hash);
    }
  };

  const michelsonSourceIsNull = liveState?.michelson?.lastSource === NULL_SOURCE_ADDRESS;
  const showProofChips =
    network.id === 'previewnet' && PROOF_CHIPS.some((c) => Boolean(addresses.proofTxs?.[c.key]));
  const modePrefix = `${uid}-mode`;
  const probePrefix = `${uid}-probe`;
  const probeMeta = PROBES.find((p) => p.kind === selectedProbe) ?? PROBES[0];
  const execForSelected = lastExecution && lastExecution.kind === selectedProbe ? lastExecution : null;

  const progressSteps = (() => {
    const phase = execForSelected?.phase;
    const errorAt = execForSelected?.errorAt;
    const signingState: ProgressState =
      phase === 'preparing' || phase === 'signing'
        ? 'active'
        : phase === 'mining' || phase === 'settled'
          ? 'done'
          : phase === 'error' && errorAt !== 'mining'
            ? 'error'
            : phase === 'error'
              ? 'done'
              : 'todo';
    const settledState: ProgressState =
      phase === 'mining'
        ? 'active'
        : phase === 'settled'
          ? 'done'
          : phase === 'error' && errorAt === 'mining'
            ? 'error'
            : 'todo';
    return [
      { label: 'Ready', state: (execForSelected ? 'done' : 'active') as ProgressState },
      { label: phase === 'preparing' ? 'Snapshot & sign' : 'Signing', state: signingState },
      { label: 'Settled', state: settledState },
      {
        label: 'View trace',
        state: (phase === 'settled' && execForSelected?.txHash ? 'active' : 'todo') as ProgressState,
      },
    ];
  })();

  const runButtonLabel = (sendLabel: string) =>
    evmWallet.address ? sendLabel : 'Connect wallet to send';

  const runIcon = (kind: CanaryProbeKind, Icon: typeof Send) =>
    activeProbe === kind ? (
      <Loader2 size={14} className="spin" aria-hidden="true" />
    ) : evmWallet.address ? (
      <Icon size={14} aria-hidden="true" />
    ) : (
      <Wallet size={14} aria-hidden="true" />
    );

  const syncLabel = liveState
    ? liveState.error
      ? 'Live state read failed'
      : liveState.blockSynced
        ? `Synced · #${liveState.blockNumber.toLocaleString()}`
        : `EVM #${liveState.blockNumber} / Mich #${liveState.michelsonLevel}`
    : health
      ? health.synced && health.evmHead !== null
        ? `Head #${health.evmHead.toLocaleString()}`
        : `EVM #${health.evmHead ?? '?'} / Mich #${health.michelsonLevel ?? '?'}`
      : null;
  const syncDot = liveState
    ? liveState.error
      ? 'dot-danger'
      : liveState.blockSynced
        ? 'dot-ok'
        : 'dot-warn'
    : health?.synced
      ? 'dot-ok'
      : '';

  return (
    <section aria-labelledby={`${uid}-heading`} className="stack">
      <h2 id={`${uid}-heading`} className="sr-only">
        Module 3 · Canary Lab &amp; Debugger
      </h2>

      {/* ===================== Canary status strip ===================== */}
      <div className="card">
        <div className="status-strip">
          <div className="status-strip-main">
            <span className="strong">Canary pair</span>
            <span
              className={`pill pill-sm ${addresses.source === 'unconfigured' ? 'pill-warn' : 'pill-muted'}`}
            >
              {addresses.source === 'manifest'
                ? 'Deployed manifest'
                : addresses.source === 'custom'
                  ? 'Custom override'
                  : 'Not configured'}
            </span>
            {isConfigured && (
              <span className="status-pair">
                <RuntimePill runtime="evm" small />
                <code title={addresses.evmCanary}>{shortAddr(addresses.evmCanary, 6, 4)}</code>
                <ArrowLeftRight size={12} className="muted" aria-hidden="true" />
                <span className="sr-only">paired with</span>
                <RuntimePill runtime="michelson" small />
                <code title={addresses.michelsonCanary}>
                  {shortAddr(addresses.michelsonCanary, 6, 4)}
                </code>
              </span>
            )}
            {isConfigured && (stateLoading && !liveState ? (
              <span className="row muted" style={{ gap: 6 }}>
                <Loader2 size={12} className="spin" aria-hidden="true" /> Reading live state…
              </span>
            ) : (
              syncLabel && (
                <span className="row" style={{ gap: 6 }} aria-live="polite">
                  <span className={`dot ${syncDot}`} aria-hidden="true" />
                  <span className="mono xsmall">{syncLabel}</span>
                </span>
              )
            ))}
            {michelsonSourceIsNull && (
              <button
                type="button"
                className="pill pill-sm pill-warn"
                style={{ cursor: 'pointer' }}
                onClick={() => setDetailsOpen(true)}
                title="EVM→Michelson calls see a null SOURCE — authorize via SENDER"
              >
                <AlertTriangle size={11} aria-hidden="true" /> Null SOURCE
              </button>
            )}
          </div>

          <div className="row" style={{ gap: 6 }}>
            {isConfigured && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={stateLoading}
                onClick={() => void refreshLiveState()}
              >
                <RefreshCw size={12} className={stateLoading ? 'spin' : undefined} aria-hidden="true" />
                Refresh
              </button>
            )}
            {isConfigured && (
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={detailsOpen}
                aria-controls={`${uid}-live-state`}
                onClick={() => setDetailsOpen((v) => !v)}
              >
                Live state
                <ChevronDown
                  size={13}
                  aria-hidden="true"
                  style={{ transform: detailsOpen ? 'rotate(180deg)' : undefined }}
                />
              </button>
            )}
            {isConfigured && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={editOpen}
                aria-controls={`${uid}-addr-drawer`}
                onClick={() => setEditOpen((v) => !v)}
              >
                <Settings2 size={13} aria-hidden="true" />
                Addresses
              </button>
            )}
          </div>
        </div>

        {detailsOpen && isConfigured && (
          <div className="strip-drawer stack-sm" id={`${uid}-live-state`}>
            {!liveState && (
              <span className="muted small">Live state has not been read yet — press Refresh.</span>
            )}
            {liveState?.error && (
              <div role="alert" className="alert alert-danger">
                <XCircle size={14} aria-hidden="true" />
                <span>{liveState.error}</span>
              </div>
            )}
            {liveState && (
              <div className="grid-2">
                <div className="stack-sm">
                  <span className="row small" style={{ gap: 6 }}>
                    <RuntimePill runtime="evm" small />
                    <span className="strong">NacCanaryEvm</span>
                    <code className="muted xsmall">{shortAddr(addresses.evmCanary)}</code>
                  </span>
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
                        <span className="kv-value">{liveState.evm.rollbackSentinel}</span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">lastCallbackNonce</span>
                        <span className="kv-value">{liveState.evm.lastCallbackNonce}</span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">lastOogOk</span>
                        <span className="kv-value">{String(liveState.evm.lastOogOk)}</span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">lastOogGasUsed</span>
                        <span className="kv-value">{liveState.evm.lastOogGasUsed}</span>
                      </div>
                    </div>
                  ) : (
                    <span className="muted small">Could not decode EVM Canary getters at this address.</span>
                  )}
                </div>

                <div className="stack-sm">
                  <span className="row small" style={{ gap: 6 }}>
                    <RuntimePill runtime="michelson" small />
                    <span className="strong">nac_canary</span>
                    <code className="muted xsmall">{shortAddr(addresses.michelsonCanary)}</code>
                  </span>
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
                          <span className="kv-value">{liveState.michelson.lastNote || '""'}</span>
                        </div>
                        <div className="kv-item">
                          <span className="kv-label">lastSender (SENDER)</span>
                          <span className="kv-value">
                            {shortAddr(liveState.michelson.lastSender, 10, 6)}
                          </span>
                        </div>
                      </div>
                      <div className={`alert ${michelsonSourceIsNull ? 'alert-warn' : 'alert-info'}`}>
                        <ShieldAlert size={14} aria-hidden="true" />
                        <div className="small stack-xs" style={{ minWidth: 0 }}>
                          <span className="break-all">
                            <strong className="strong">lastSource (SOURCE):</strong>{' '}
                            <code>{liveState.michelson.lastSource || '—'}</code>
                          </span>
                          {michelsonSourceIsNull && (
                            <span>
                              Null cross-runtime <code>SOURCE</code> (<code>tz1Ke2h7…</code>) —
                              EVM→Michelson calls must authorize via <code>SENDER</code>, never{' '}
                              <code>SOURCE</code>.
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <span className="muted small">
                      Could not parse Michelson Canary storage at this address.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {(editOpen || !isConfigured) && (
          <div className="strip-drawer stack" id={`${uid}-addr-drawer`}>
            {!isConfigured && (
              <div className="alert alert-info">
                <Terminal size={14} aria-hidden="true" />
                <div className="stack-sm" style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-between">
                    <strong className="strong">
                      No Canary pair configured for {network.label} yet — 3-step deploy
                    </strong>
                    <CopyButton
                      label="Copy commands"
                      copied={copiedKey === 'deploy-cli'}
                      onClick={() => void handleCopy('deploy-cli', DEPLOY_CLI_STEPS)}
                    />
                  </div>
                  <pre className="code-block pre">{DEPLOY_CLI_STEPS}</pre>
                  <span>
                    You don&apos;t need a Canary pair to <strong className="strong">inspect a
                    transaction trace</strong> below — paste any live {network.label} tx hash.
                  </span>
                </div>
              </div>
            )}

            <form onSubmit={handleSaveAddresses} className="stack-sm">
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={`${uid}-evm-canary`} className="field-label">
                    <span>
                      NacCanaryEvm <span className="muted">(0x…)</span>
                    </span>
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
                    <span>
                      nac_canary <span className="muted">(KT1…)</span>
                    </span>
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
                  Saved per network in <code>localStorage</code> (or auto-loaded from{' '}
                  <code>config/deployments/{network.id}.json</code> after deploy).
                </span>
                <div className="row" style={{ gap: 6 }}>
                  {addresses.source === 'custom' && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearAddresses}>
                      <Trash2 size={12} aria-hidden="true" />
                      Reset override
                    </button>
                  )}
                  <button type="submit" className="btn btn-sm">
                    <Save size={13} aria-hidden="true" />
                    Save &amp; connect pair
                  </button>
                </div>
              </div>

              {addrError && (
                <div role="alert" className="alert alert-danger">
                  <ShieldAlert size={14} aria-hidden="true" />
                  <span>{addrError}</span>
                </div>
              )}
            </form>
          </div>
        )}
      </div>

      {/* ===================== Mode switch ===================== */}
      <TabList<LabMode>
        idPrefix={modePrefix}
        ariaLabel="Canary Lab mode"
        className="mode-switch"
        itemClassName="mode-option"
        value={mode}
        onChange={setMode}
        items={[
          {
            id: 'trace',
            label: (
              <>
                <Search size={16} aria-hidden="true" />
                <span className="stack-xs" style={{ minWidth: 0 }}>
                  <span className="mode-title">Inspect a transaction trace</span>
                  <span className="mode-sub">No wallet needed · start from a verified proof</span>
                </span>
              </>
            ),
          },
          {
            id: 'probe',
            label: (
              <>
                <Play size={16} aria-hidden="true" />
                <span className="stack-xs" style={{ minWidth: 0 }}>
                  <span className="mode-title">Run a live probe</span>
                  <span className="mode-sub">
                    Probe 3 is read-only · probes 1, 2, 4, 5 need an EVM wallet
                  </span>
                </span>
              </>
            ),
          },
        ]}
      />

      {/* ===================== TRACE MODE ===================== */}
      {mode === 'trace' && (
        <TabPanel idPrefix={modePrefix} id="trace">
          <div className="card">
            <div className="card-header">
              <StepTitle
                title="Inspect a cross-runtime transaction"
                hint={
                  <>
                    Live <code>callTracer</code> with automatic Blockscout fallback · hand off to{' '}
                    <code>nactrace</code> for post-hoc forensics.
                  </>
                }
              />
              <WalletNeedPill need="none" />
            </div>

            <div className="card-body stack">
              {showProofChips && (
                <div className="stack-sm">
                  <span className="section-label">Start here · verified {network.label} proofs</span>
                  <div className="proof-chips" role="group" aria-label="Verified Canary proof transactions">
                    {PROOF_CHIPS.map((chip) => {
                      const hash = addresses.proofTxs?.[chip.key];
                      if (!hash) return null;
                      const pressed = traceReport?.txHash.toLowerCase() === hash.toLowerCase();
                      return (
                        <button
                          key={chip.key}
                          type="button"
                          className="proof-chip"
                          aria-pressed={pressed}
                          disabled={traceLoading}
                          onClick={() => {
                            setTxHashInput(hash);
                            void runTraceInspection(hash);
                          }}
                        >
                          <span className="proof-chip-title">
                            {chip.title}
                            {pressed && <Check size={13} aria-hidden="true" />}
                          </span>
                          <span className="proof-chip-sub">{chip.sub}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runTraceInspection();
                }}
                className="stack-sm"
              >
                <label htmlFor={`${uid}-tx-hash`} className="field-label">
                  {showProofChips ? 'Or paste any EVM transaction hash' : 'EVM transaction hash'}
                </label>
                <div className="input-row">
                  <input
                    id={`${uid}-tx-hash`}
                    className="input mono"
                    value={txHashInput}
                    onChange={(e) => setTxHashInput(e.target.value)}
                    placeholder="0x… (66-character EVM transaction hash)"
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={traceLoading || !txHashInput.trim()}
                    style={{ minWidth: 140 }}
                  >
                    {traceLoading ? (
                      <Loader2 size={14} className="spin" aria-hidden="true" />
                    ) : (
                      <Search size={14} aria-hidden="true" />
                    )}
                    {traceLoading ? 'Tracing…' : 'Inspect trace'}
                  </button>
                </div>
              </form>

              {traceError && (
                <div role="alert" className="alert alert-danger">
                  <XCircle size={14} aria-hidden="true" />
                  <span>{traceError}</span>
                </div>
              )}

              {!traceReport && !traceLoading && !traceError && (
                <p className="field-hint" style={{ margin: 0 }}>
                  You&apos;ll get the receipt status, every cross-runtime gateway hop as an indented
                  call-frame tree, decoded <code>429 OOG</code> / revert payloads, and deep links to
                  nactrace, Blockscout and the mirrored TzKT operation.
                </p>
              )}

              {traceReport && (
                <div aria-live="polite" className="stack">
                  <div className="divider" />
                  <div className="row-between">
                    <div className="row" style={{ gap: 6 }}>
                      <span
                        className={`pill ${
                          traceReport.status === 'success'
                            ? 'pill-ok'
                            : traceReport.status === 'reverted'
                              ? 'pill-danger'
                              : 'pill-warn'
                        }`}
                      >
                        {traceReport.status === 'success'
                          ? 'Success'
                          : traceReport.status === 'reverted'
                            ? 'Reverted'
                            : traceReport.status}
                      </span>
                      <span
                        className={`pill ${
                          traceReport.traceSource === 'blockscout_fallback'
                            ? 'pill-warn'
                            : traceReport.traceSource === 'receipt_only'
                              ? 'pill-muted'
                              : ''
                        }`}
                      >
                        {traceReport.traceSource === 'callTracer'
                          ? 'callTracer · live'
                          : traceReport.traceSource === 'blockscout_fallback'
                            ? 'Blockscout fallback'
                            : 'Receipt only'}
                      </span>
                      <span className="pill">{traceReport.gatewayHops} gateway hop(s)</span>
                      {traceReport.blockNumber !== null && (
                        <span className="pill pill-muted mono">
                          #{traceReport.blockNumber.toLocaleString()}
                        </span>
                      )}
                      {traceReport.gasUsed !== null && (
                        <span className="pill pill-muted mono">
                          gas {Number(traceReport.gasUsed).toLocaleString()}
                        </span>
                      )}
                    </div>

                    <div className="row" style={{ gap: 6 }}>
                      <CopyButton
                        label="Copy share link"
                        copiedLabel="Link copied"
                        copied={copiedKey === 'share-tx'}
                        onClick={() => {
                          const url = `${window.location.origin}${window.location.pathname}?network=${network.id}&tab=canary&tx=${encodeURIComponent(traceReport.txHash)}`;
                          void handleCopy('share-tx', url);
                        }}
                      />
                      <a
                        href={traceReport.nactraceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm"
                      >
                        Inspect in nactrace <ExternalLink size={12} aria-hidden="true" />
                      </a>
                      <a
                        href={traceReport.blockscoutUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm btn-ghost"
                      >
                        Blockscout <ExternalLink size={12} aria-hidden="true" />
                      </a>
                      <a
                        href={traceReport.tzktUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm btn-ghost"
                        title="Mirrored Michelson operation on TzKT"
                      >
                        TzKT op <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                  <code className="muted xsmall break-all">{traceReport.txHash}</code>

                  {traceReport.decodedTopRevert && (
                    <div
                      className={`alert ${
                        traceReport.decodedTopRevert.status === 429 ? 'alert-danger' : 'alert-warn'
                      }`}
                    >
                      <ShieldAlert size={15} aria-hidden="true" />
                      <div className="stack-xs" style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 6 }}>
                          <strong className="strong">
                            {traceReport.status === 'success'
                              ? 'Caught inner cross-runtime revert (outer tx succeeded)'
                              : 'Decoded top-level revert'}
                          </strong>
                          <span className="pill pill-sm pill-danger">
                            {traceReport.decodedTopRevert.kind}
                          </span>
                          {traceReport.decodedTopRevert.status !== undefined && (
                            <span className="pill pill-sm pill-danger">
                              HTTP / NAC {traceReport.decodedTopRevert.status}
                            </span>
                          )}
                        </div>
                        <span className="strong" style={{ fontWeight: 500 }}>
                          {traceReport.decodedTopRevert.summary}
                        </span>
                        <code className="muted xsmall break-all">
                          raw: {traceReport.decodedTopRevert.raw}
                        </code>
                      </div>
                    </div>
                  )}

                  {traceReport.rawTraceError && traceReport.traceSource !== 'callTracer' && (
                    <div className="alert alert-warn">
                      <AlertTriangle size={14} aria-hidden="true" />
                      <span className="small">
                        <code>debug_traceTransaction</code> unavailable on this RPC (
                        <code>{traceReport.rawTraceError}</code>) — fell back to{' '}
                        <strong className="strong">{traceReport.traceSource}</strong>.
                      </span>
                    </div>
                  )}

                  <div className="stack-sm">
                    <div className="row-between">
                      <span className="section-label">
                        Call-frame tree · {traceReport.frames.length} frame(s)
                      </span>
                      <span className="muted xsmall">
                        NACBench runs it · nactrace explains it post-hoc
                      </span>
                    </div>

                    {traceReport.frames.length > 0 ? (
                      <div className="stack-sm">
                        {traceReport.frames.map((frame, i) => (
                          <TraceFrameRow
                            key={`${frame.depth}-${frame.from}-${frame.to}-${i}`}
                            frame={frame}
                            index={i}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="alert alert-info">
                        <GitCompare size={14} aria-hidden="true" />
                        <span>
                          No nested call frames returned for this transaction (receipt status:{' '}
                          <strong className="strong">{traceReport.status}</strong>). Use{' '}
                          <strong className="strong">Inspect in nactrace</strong> or{' '}
                          <strong className="strong">Blockscout</strong> above for explorer details.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabPanel>
      )}

      {/* ===================== PROBE MODE ===================== */}
      {mode === 'probe' && (
        <TabPanel idPrefix={modePrefix} id="probe">
          <div className="card">
            <div className="card-header">
              <StepTitle
                title="Run a live probe"
                hint="Write probes broadcast real transactions, capture a block-pinned before/after diff, then hand the hash to the trace view."
              />
              {evmWallet.address ? (
                <span className="pill">
                  <span className="dot dot-ok" aria-hidden="true" />
                  <span className="mono">{shortAddr(evmWallet.address, 6, 4)}</span>
                </span>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => void onConnectEvm()}>
                  <Wallet size={13} aria-hidden="true" />
                  Connect wallet
                </button>
              )}
            </div>

            {!isConfigured && (
              <div className="card-body">
                <div className="alert alert-warn">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    Probes need a deployed Canary pair — configure it under{' '}
                    <strong className="strong">Addresses</strong> above.
                  </span>
                </div>
              </div>
            )}

            <div className="probe-layout">
              <TabList<CanaryProbeKind>
                idPrefix={probePrefix}
                ariaLabel="Canary probes"
                className="probe-list"
                itemClassName="probe-item"
                orientation="vertical"
                value={selectedProbe}
                onChange={setSelectedProbe}
                items={PROBES.map((p) => ({
                  id: p.kind,
                  label: (
                    <>
                      <span className="step-num" aria-hidden="true">
                        {activeProbe === p.kind ? (
                          <Loader2 size={11} className="spin" />
                        ) : (
                          p.n
                        )}
                      </span>
                      <span className="probe-item-text">
                        <span className="probe-item-title">{p.title}</span>
                        <span className="probe-desc mono muted xsmall">{p.desc}</span>
                        {p.readOnly ? (
                          <span className="pill pill-sm">
                            <Eye size={11} aria-hidden="true" /> Read-only · no wallet
                          </span>
                        ) : (
                          <span className="pill pill-sm pill-muted">
                            <Wallet size={11} aria-hidden="true" /> Requires EVM wallet
                          </span>
                        )}
                      </span>
                    </>
                  ),
                }))}
              />

              <TabPanel idPrefix={probePrefix} id={selectedProbe} className="probe-detail stack">
                <div className="row-between">
                  <h3 className="card-title">
                    Probe {probeMeta.n} · {probeMeta.title}
                  </h3>
                  <span className="pill pill-muted mono">
                    {selectedProbe === 'write'
                      ? CANARY_SELECTORS.probeWrite
                      : selectedProbe === 'roundTrip'
                        ? CANARY_SELECTORS.probeRoundTrip
                        : selectedProbe === 'view'
                          ? '0x8326329c'
                          : selectedProbe === 'rollback'
                            ? 'gasLimit 6,000,000'
                            : CANARY_SELECTORS.probeOog}
                  </span>
                </div>

                {/* PROBE 1 · WRITE */}
                {selectedProbe === 'write' && (
                  <>
                    <p className="field-hint" style={{ margin: 0 }}>
                      EVM <code>probeWrite</code> calls Michelson <code>%record_ping</code> with a
                      note and attached value through the NAC gateway in one atomic tx.
                    </p>
                    <div className="field">
                      <label htmlFor={`${uid}-p1-note`} className="field-label">
                        Note <span className="muted">(UTF-8 string)</span>
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
                          <label htmlFor={`${uid}-p1-wei`}>
                            Value <span className="muted">(wei, 10¹² aligned)</span>
                          </label>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
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
                          aria-invalid={!writeDustStatus.aligned}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`${uid}-p1-gas`} className="field-label">
                          NAC gas cap
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
                    {writeDustStatus.aligned ? (
                      <span className="output-line">
                        <Check size={13} className="text-ok" aria-hidden="true" />
                        <span className="mono">Aligned · {writeDustStatus.mutez} mutez (0 wei dust)</span>
                      </span>
                    ) : (
                      <span className="output-line text-danger" role="alert">
                        <ShieldAlert size={13} aria-hidden="true" />
                        <span className="mono">
                          Dust remainder: {writeDustStatus.remainder} wei (must be a multiple of 10¹²)
                        </span>
                      </span>
                    )}
                    <div className="row-between">
                      <Progress ariaLabel="Probe progress" steps={progressSteps} />
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={activeProbe !== null || !isConfigured || !writeDustStatus.aligned}
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
                        {runIcon('write', Send)}
                        {runButtonLabel('Send probeWrite')}
                      </button>
                    </div>
                  </>
                )}

                {/* PROBE 2 · ROUND-TRIP */}
                {selectedProbe === 'roundTrip' && (
                  <>
                    <p className="field-hint" style={{ margin: 0 }}>
                      EVM <code>probeRoundTrip</code> → Michelson <code>%echo_callback</code> →{' '}
                      <code>%call_evm</code> → EVM <code>onMichelsonCallback(uint256,uint256)</code>{' '}
                      inside one atomic transaction.
                    </p>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor={`${uid}-p2-nonce`} className="field-label">
                          Callback nonce <span className="muted">(nat)</span>
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
                          NAC gas cap
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
                    <span className="mono muted xsmall">
                      Callback selector: {CANARY_SELECTORS.onMichelsonCallback}
                    </span>
                    <div className="row-between">
                      <Progress ariaLabel="Probe progress" steps={progressSteps} />
                      <button
                        type="button"
                        className="btn btn-primary"
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
                        {runIcon('roundTrip', ArrowLeftRight)}
                        {runButtonLabel('Run round-trip')}
                      </button>
                    </div>
                  </>
                )}

                {/* PROBE 3 · READ-ONLY VIEW */}
                {selectedProbe === 'view' && (
                  <>
                    <p className="field-hint" style={{ margin: 0 }}>
                      Synchronous read-only path: <code>probeView</code> (
                      <code>callMichelsonView 0x8326329c</code>), direct <code>echoView</code>, and
                      Michelson <code>run_script_view</code>. Uses <code>eth_call</code> — no
                      wallet, no gas, nothing is broadcast.
                    </p>
                    <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
                      <div className="field" style={{ flex: '1 1 180px', maxWidth: 260 }}>
                        <label htmlFor={`${uid}-p3-x`} className="field-label">
                          Input x <span className="muted">(uint256 / nat)</span>
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
                          <Loader2 size={14} className="spin" aria-hidden="true" />
                        ) : (
                          <Eye size={14} aria-hidden="true" />
                        )}
                        {viewBusy ? 'Reading…' : 'Run read-only view'}
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
                        {viewResult.ok && (
                          <span className="output-line">
                            <Check size={13} className="text-ok" aria-hidden="true" />
                            probeView returned via callMichelsonView 0x8326329c
                          </span>
                        )}
                        <div className="grid-3">
                          <div className="stack-xs">
                            <span className="kv-label row" style={{ gap: 6 }}>
                              <RuntimePill runtime="evm" small /> probeView digest
                            </span>
                            <pre className="code-block pre" style={{ maxHeight: 160 }}>
                              {viewResult.decodedDigest !== undefined
                                ? JSON.stringify(viewResult.decodedDigest, null, 2)
                                : '—'}
                            </pre>
                          </div>
                          <div className="stack-xs">
                            <span className="kv-label row" style={{ gap: 6 }}>
                              <RuntimePill runtime="evm" small /> echoView(x)
                            </span>
                            <pre className="code-block pre" style={{ maxHeight: 160 }}>
                              {viewResult.echoViewResult
                                ? JSON.stringify(viewResult.echoViewResult, null, 2)
                                : '—'}
                            </pre>
                          </div>
                          <div className="stack-xs">
                            <span className="kv-label row" style={{ gap: 6 }}>
                              <RuntimePill runtime="michelson" small /> run_script_view
                            </span>
                            <pre className="code-block pre" style={{ maxHeight: 160 }}>
                              {viewResult.runScriptViewResult !== undefined
                                ? JSON.stringify(viewResult.runScriptViewResult, null, 2)
                                : '—'}
                            </pre>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* PROBE 4 · ROLLBACK */}
                {selectedProbe === 'rollback' && (
                  <>
                    <p className="field-hint" style={{ margin: 0 }}>
                      Mutates <code>rollbackSentinel += 1</code> in EVM, then triggers{' '}
                      <code>FAILWITH</code> in Michelson. An explicit{' '}
                      <code>gasLimit: 6,000,000</code> lets the reverted tx mine on-chain and proves{' '}
                      <code>rollbackSentinel</code> returns to its exact pre-tx value.
                    </p>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor={`${uid}-p4-reason`} className="field-label">
                          Failure reason <span className="muted">(string)</span>
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
                          NAC gas cap
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
                    <span className="mono muted xsmall">
                      Current sentinel: {liveState?.evm?.rollbackSentinel ?? '—'}
                    </span>
                    <div className="row-between">
                      <Progress ariaLabel="Probe progress" steps={progressSteps} />
                      <button
                        type="button"
                        className="btn btn-primary"
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
                        {runIcon('rollback', RotateCcw)}
                        {runButtonLabel('Trigger rollback proof')}
                      </button>
                    </div>
                  </>
                )}

                {/* PROBE 5 · 429 OOG */}
                {selectedProbe === 'oog' && (
                  <>
                    <p className="field-hint" style={{ margin: 0 }}>
                      EVM <code>probeOog</code> calls Michelson <code>%burn_gas</code> under a tight
                      cross-runtime gas cap to force <code>429 Too Many Requests: out of gas</code>.
                    </p>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor={`${uid}-p5-iter`} className="field-label">
                          BLAKE2B loop iterations
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
                          <label htmlFor={`${uid}-p5-gas`}>Tight cross-runtime gas cap</label>
                          <div className="row" style={{ gap: 4 }}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setOogGasCap('30000')}
                            >
                              30k
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
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

                    <label htmlFor={`${uid}-p5-catch`} className="checkbox-row">
                      <input
                        id={`${uid}-p5-catch`}
                        type="checkbox"
                        checked={oogCatchRevert}
                        onChange={(e) => setOogCatchRevert(e.target.checked)}
                      />
                      <span className="stack-xs">
                        <span>
                          <code>catchRevert</code>:{' '}
                          <strong className="strong">
                            {oogCatchRevert ? 'Isolate in EVM' : 'Propagate revert'}
                          </strong>
                        </span>
                        <span className="muted xsmall">
                          {oogCatchRevert
                            ? 'Tx succeeds and stores the 429 payload & gas used (gasLimit 6,000,000).'
                            : 'Tx reverts on-chain to prove the 429 trace (gasLimit 3,000,000).'}
                        </span>
                      </span>
                    </label>

                    <div className="row-between">
                      <Progress ariaLabel="Probe progress" steps={progressSteps} />
                      <button
                        type="button"
                        className="btn btn-primary"
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
                        {runIcon('oog', Zap)}
                        {runButtonLabel('Trigger 429 OOG probe')}
                      </button>
                    </div>
                  </>
                )}

                {/* Last probe execution */}
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
                  >
                    {lastExecution.status === 'running' ? (
                      <Loader2 size={14} className="spin" aria-hidden="true" />
                    ) : lastExecution.status === 'completed' ? (
                      <CheckCircle2 size={14} aria-hidden="true" />
                    ) : (
                      <XCircle size={14} aria-hidden="true" />
                    )}
                    <div className="stack-sm" style={{ minWidth: 0, flex: 1 }}>
                      <div className="row-between">
                        <strong className="strong">{lastExecution.label}</strong>
                        {lastExecution.txHash && (
                          <code className="xsmall muted">
                            tx {shortAddr(lastExecution.txHash, 12, 8)}
                          </code>
                        )}
                      </div>
                      <span>{lastExecution.message}</span>

                      {lastExecution.stateDiff && (
                        <div className="kv-grid">
                          <div className="kv-item">
                            <span className="kv-label">Δ block (pinned)</span>
                            <span className="kv-value">
                              {lastExecution.stateDiff.blockDelta >= 0
                                ? `+${lastExecution.stateDiff.blockDelta}`
                                : String(lastExecution.stateDiff.blockDelta)}
                            </span>
                          </div>
                          <div className="kv-item">
                            <span className="kv-label row" style={{ gap: 6 }}>
                              Δ <RuntimePill runtime="evm" small />
                            </span>
                            <span className="kv-value">
                              {formatSignedDelta(lastExecution.stateDiff.evmBalanceDeltaWei, 'wei')}
                            </span>
                          </div>
                          <div className="kv-item">
                            <span className="kv-label row" style={{ gap: 6 }}>
                              Δ <RuntimePill runtime="michelson" small />
                            </span>
                            <span className="kv-value">
                              {formatSignedDelta(
                                lastExecution.stateDiff.michelsonBalanceDeltaMutez,
                                'mutez',
                              )}
                            </span>
                          </div>
                          <div className="kv-item">
                            <span className="kv-label">Michelson storage</span>
                            <span className="kv-value">
                              {lastExecution.stateDiff.michelsonStorageChanged ? 'Mutated' : 'Unchanged'}
                            </span>
                          </div>
                        </div>
                      )}

                      {lastExecution.txHash && lastExecution.status !== 'running' && (
                        <div>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => openTraceFor(lastExecution.txHash!)}
                          >
                            View trace
                            <ArrowRight size={13} aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </TabPanel>
            </div>
          </div>
        </TabPanel>
      )}
    </section>
  );
}
