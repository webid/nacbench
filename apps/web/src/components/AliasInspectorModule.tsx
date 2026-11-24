import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  ExternalLink,
  GitCompare,
  Info,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  Repeat,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Wallet,
  XCircle,
} from 'lucide-react';
import type {
  DualRuntimeSnapshot,
  EvmWalletState,
  GatewayHealth,
  IdentityReport,
  NetworkConfig,
} from '../lib/types';
import {
  captureBlockPinnedSnapshot,
  diffSnapshots,
  inspectCrossRuntimeIdentity,
} from '../lib/rpc';
import {
  computeBigMapKeyHash,
  decodeRevertPayload,
  encodeMaterializeAliasCalldata,
  isTz4Address,
  isValidEvmAddress,
  isValidTezosXAddress,
} from '../lib/codec';
import {
  buildOctezClientMaterializeCmd,
  buildOctezJsMaterializeSnippet,
} from '../lib/snippets';
import {
  connectEvmWallet,
  discoverEip6963Providers,
  sendMaterializeAliasEvmTx,
  switchEvmChain,
  type Eip1193Provider,
} from '../lib/wallets';
import { DEFAULT_FIXTURES, SAFE_SINGLETON_FACTORY } from '../lib/networks';
import { loadDefaultCanaryAddresses } from '../lib/canary';

type MaterializeTab = 'evm_precompile' | 'michelson_gateway';
type BigMapKeyType = 'nat' | 'string' | 'address';

interface TxLifecycleState {
  phase: 'idle' | 'switching' | 'signing' | 'submitted' | 'error';
  txHash?: string;
  error?: string;
  decodedSummary?: string;
}

function formatSignedBigInt(val: string | null, unit: string): string {
  if (val === null) return '—';
  try {
    const n = BigInt(val);
    if (n === 0n) return `0 ${unit}`;
    return `${n > 0n ? '+' : ''}${n.toString()} ${unit}`;
  } catch {
    return `${val} ${unit}`;
  }
}

function weiToXtzString(weiStr?: string): string {
  if (!weiStr || !/^-?\d+$/.test(weiStr)) return '—';
  const raw = BigInt(weiStr);
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const whole = abs / 1_000_000_000_000_000_000n;
  const frac = (abs % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, '0')
    .slice(0, 6)
    .replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''} XTZ`;
}

function mutezToXtzString(mutezStr?: string): string {
  if (!mutezStr || !/^-?\d+$/.test(mutezStr)) return '—';
  const raw = BigInt(mutezStr);
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''} XTZ`;
}

function getExplorerAddressUrl(network: NetworkConfig, address: string): string | null {
  const trimmed = address.trim();
  if (isValidEvmAddress(trimmed)) {
    return `${network.evm.explorerUrl.replace(/\/$/, '')}/address/${trimmed}`;
  }
  if (isValidTezosXAddress(trimmed)) {
    return `${network.michelson.explorerUrl.replace(/\/$/, '')}/${trimmed}`;
  }
  return null;
}

function getCodeByteLength(hexCode: string | null): number {
  if (!hexCode || hexCode === '0x') return 0;
  const clean = hexCode.startsWith('0x') ? hexCode.slice(2) : hexCode;
  return Math.floor(clean.length / 2);
}

function SnapshotCard({
  snapshot,
  slotLabel,
  accentClass,
}: {
  snapshot: DualRuntimeSnapshot | null;
  slotLabel: string;
  accentClass: 'panel-evm' | 'panel-michelson';
}) {
  return (
    <div className={`panel ${accentClass}`}>
      <div className="panel-header">
        <span className={`mono ${accentClass === 'panel-evm' ? 'text-evm' : 'text-michelson'}`} style={{ fontWeight: 700, fontSize: '12px' }}>
          {slotLabel}
        </span>
        {snapshot ? (
          <span className={`badge ${snapshot.blockSynced ? 'badge-ok' : 'badge-warn'}`}>
            {snapshot.blockSynced
              ? `EVM #${snapshot.blockNumber.toLocaleString()} == Michelson #${snapshot.michelsonLevel.toLocaleString()}`
              : `SKEW: EVM #${snapshot.blockNumber} ≠ Mich #${snapshot.michelsonLevel}`}
          </span>
        ) : (
          <span className="badge badge-muted">Not captured</span>
        )}
      </div>

      <div className="panel-body stack-sm">
        {!snapshot ? (
          <p className="muted" style={{ margin: 0, fontSize: '12.5px' }}>
            Capture a block-pinned dual-runtime snapshot to freeze EVM + Michelson state at identical block height.
          </p>
        ) : (
          <>
            <div className="mono muted" style={{ fontSize: '11.5px' }}>
              Captured {new Date(snapshot.capturedAt).toLocaleTimeString()} · blockSynced:{' '}
              <strong className={snapshot.blockSynced ? 'text-ok' : 'text-warn'}>
                {String(snapshot.blockSynced)}
              </strong>
            </div>

            <div className="kv-grid">
              {snapshot.evmAddress && (
                <div className="kv-item" style={{ borderColor: 'var(--evm-border)' }}>
                  <span className="kv-label text-evm">EVM Balance &amp; Code</span>
                  <span className="kv-value">{weiToXtzString(snapshot.evmBalanceWei)}</span>
                  <span className="mono muted" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
                    {snapshot.evmBalanceWei ?? '—'} wei · {snapshot.evmCodeBytes ?? 0} B
                  </span>
                </div>
              )}

              {snapshot.michelsonAddress && (
                <div className="kv-item" style={{ borderColor: 'var(--michelson-border)' }}>
                  <span className="kv-label text-michelson">Michelson Balance</span>
                  <span className="kv-value">{mutezToXtzString(snapshot.michelsonBalanceMutez)}</span>
                  <span className="mono muted" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
                    {snapshot.michelsonBalanceMutez ?? '—'} mutez
                  </span>
                </div>
              )}
            </div>

            {snapshot.michelsonStorage !== undefined && (
              <div className="stack-sm">
                <span className="field-label">Michelson Contract Storage</span>
                <pre className="code-block pre" style={{ maxHeight: '130px', overflowY: 'auto' }}>
                  {JSON.stringify(snapshot.michelsonStorage, null, 2)}
                </pre>
              </div>
            )}

            {snapshot.bigMapId !== undefined && (
              <div className="stack-sm">
                <span className="field-label">
                  Big-Map #{snapshot.bigMapId} · {snapshot.bigMapKeyHash ?? 'expr…'}
                </span>
                <pre className="code-block pre" style={{ maxHeight: '110px', overflowY: 'auto' }}>
                  {snapshot.bigMapValue !== undefined
                    ? JSON.stringify(snapshot.bigMapValue, null, 2)
                    : 'null (key absent at pinned block)'}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function AliasInspectorModule({
  network,
  health,
  evmWallet,
  onConnectEvm,
  initialAddr,
  onAddrChange,
}: {
  network: NetworkConfig;
  health: GatewayHealth | null;
  evmWallet: EvmWalletState;
  onConnectEvm: (rdns?: string) => Promise<void>;
  initialAddr?: string;
  onAddrChange?: (addr: string) => void;
}) {
  const uid = useId();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const autoRanInitialAddrRef = useRef(false);

  // Panel A: Identity Inspector state
  const [inspectInput, setInspectInput] = useState<string>(
    initialAddr?.trim() || DEFAULT_FIXTURES.aliceTz1,
  );
  const [inspecting, setInspecting] = useState<boolean>(false);
  const [identityReport, setIdentityReport] = useState<IdentityReport | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // Panel B: Materializer state
  const [materializeTab, setMaterializeTab] = useState<MaterializeTab>('evm_precompile');
  const [matTzAddress, setMatTzAddress] = useState<string>(DEFAULT_FIXTURES.aliceTz1);
  const [matPublicKey, setMatPublicKey] = useState<string>(DEFAULT_FIXTURES.alicePubKey);
  const [txState, setTxState] = useState<TxLifecycleState>({ phase: 'idle' });

  // Panel C: Block-Pinned Dual-Runtime State-Diff state
  const [diffEvmAddr, setDiffEvmAddr] = useState<string>(DEFAULT_FIXTURES.freeRoutePoolEvm);
  const [diffMichAddr, setDiffMichAddr] = useState<string>(network.michelson.evmGateway);
  const [diffBigMapId, setDiffBigMapId] = useState<string>('');
  const [diffBigMapKeyType, setDiffBigMapKeyType] = useState<BigMapKeyType>('address');
  const [diffBigMapKey, setDiffBigMapKey] = useState<string>(DEFAULT_FIXTURES.aliceTz1);
  const [diffPinnedBlock, setDiffPinnedBlock] = useState<string>('');
  const [capturingSlot, setCapturingSlot] = useState<'A' | 'B' | null>(null);
  const [snapshotA, setSnapshotA] = useState<DualRuntimeSnapshot | null>(null);
  const [snapshotB, setSnapshotB] = useState<DualRuntimeSnapshot | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

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

  const trimmedInspect = inspectInput.trim();
  const inspectIsTz4 = isTz4Address(trimmedInspect);
  const inspectIsValid =
    isValidEvmAddress(trimmedInspect) || isValidTezosXAddress(trimmedInspect);

  const runInspection = useCallback(
    async (targetAddr?: string) => {
      const addr = (targetAddr ?? inspectInput).trim();
      if (!addr) {
        setInspectError('Enter a tz1/tz2/tz3, KT1, or 0x address to inspect.');
        return;
      }
      if (isTz4Address(addr)) {
        setIdentityReport(null);
        setInspectError(
          'BLS12-381 tz4 addresses are not supported on the Tezos X Michelson interface yet.',
        );
        return;
      }
      setInspecting(true);
      setInspectError(null);
      onAddrChange?.(addr);
      try {
        const report = await inspectCrossRuntimeIdentity(network, addr);
        setIdentityReport(report);
      } catch (err) {
        setIdentityReport(null);
        setInspectError(err instanceof Error ? err.message : String(err));
      } finally {
        setInspecting(false);
      }
    },
    [inspectInput, network, onAddrChange],
  );

  // Auto-run identity inspection when opened via shareable ?addr=... URL param
  useEffect(() => {
    if (initialAddr && !autoRanInitialAddrRef.current) {
      autoRanInitialAddrRef.current = true;
      setInspectInput(initialAddr);
      void runInspection(initialAddr);
    }
  }, [initialAddr, runInspection]);

  // Panel B computed calldata & CLI/SDK snippets
  const matTzTrimmed = matTzAddress.trim();
  const matPubTrimmed = matPublicKey.trim();
  const matIsTz4 = isTz4Address(matTzTrimmed);
  const matIsImplicitTz = /^tz[123][1-9A-HJ-NP-Za-km-z]{33}$/.test(matTzTrimmed);

  const materializeCalldata = useMemo(() => {
    if (!matTzTrimmed || matIsTz4) return '';
    try {
      return encodeMaterializeAliasCalldata('tezos', matTzTrimmed, matPubTrimmed);
    } catch {
      return '';
    }
  }, [matTzTrimmed, matPubTrimmed, matIsTz4]);

  const octezClientCmd = useMemo(
    () =>
      buildOctezClientMaterializeCmd(
        network,
        matTzTrimmed || DEFAULT_FIXTURES.aliceTz1,
        matPubTrimmed || undefined,
      ),
    [network, matTzTrimmed, matPubTrimmed],
  );

  const octezJsSnippet = useMemo(
    () =>
      buildOctezJsMaterializeSnippet(
        network,
        matTzTrimmed || DEFAULT_FIXTURES.aliceTz1,
        matPubTrimmed || undefined,
      ),
    [network, matTzTrimmed, matPubTrimmed],
  );

  const handleSendMaterializeEvm = async () => {
    if (matIsTz4) {
      setTxState({
        phase: 'error',
        error: 'BLS tz4 addresses cannot be materialized on Tezos X yet.',
      });
      return;
    }
    if (!matIsImplicitTz) {
      setTxState({
        phase: 'error',
        error:
          'Provide a valid tz1, tz2, or tz3 implicit Tezos address (KT1 contracts keep Keccak-256 aliases and do not materialize via Safe-CREATE2).',
      });
      return;
    }
    if (!matPubTrimmed) {
      setTxState({
        phase: 'error',
        error:
          'Public key (edpk… / sppk… / p2pk…) is required by Previewnet v0.11 materializeAlias(string,string,string).',
      });
      return;
    }

    try {
      let provider: Eip1193Provider | null = null;
      const discovered = discoverEip6963Providers();
      if (evmWallet.providerName) {
        const matched = discovered.find((p) => p.name === evmWallet.providerName);
        if (matched) provider = matched.provider;
      }
      if (!provider && discovered.length > 0) {
        provider = discovered[0].provider;
      }
      if (!provider && typeof window !== 'undefined') {
        provider = (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
      }
      if (!provider) {
        const connected = await connectEvmWallet();
        provider = connected.provider;
      }

      if (evmWallet.chainId !== null && evmWallet.chainId !== network.evm.chainId) {
        setTxState({ phase: 'switching' });
        await switchEvmChain(provider, network);
      }

      setTxState({ phase: 'signing' });
      const txHash = await sendMaterializeAliasEvmTx(
        provider,
        network,
        matTzTrimmed,
        matPubTrimmed,
      );
      setTxState({ phase: 'submitted', txHash });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const decoded = decodeRevertPayload(rawMsg);
      setTxState({
        phase: 'error',
        error: rawMsg,
        decodedSummary: decoded.summary !== rawMsg ? decoded.summary : undefined,
      });
    }
  };

  // Panel C: live BLAKE2b expr hash preview
  const liveBigMapHash = useMemo(() => {
    const keyVal = diffBigMapKey.trim();
    if (!keyVal) return null;
    try {
      return computeBigMapKeyHash(diffBigMapKeyType, keyVal);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [diffBigMapKeyType, diffBigMapKey]);

  const handleCaptureSnapshot = async (
    slot: 'A' | 'B',
    override?: {
      evmAddress?: string;
      michelsonAddress?: string;
      bigMapId?: string;
      bigMapKeyType?: BigMapKeyType;
      bigMapKey?: string;
      pinnedBlock?: string;
    },
  ) => {
    const evmAddress = (override?.evmAddress ?? diffEvmAddr).trim() || undefined;
    const michelsonAddress = (override?.michelsonAddress ?? diffMichAddr).trim() || undefined;
    if (!evmAddress && !michelsonAddress) {
      setDiffError('Provide at least one EVM (0x…) or Michelson (KT1/tz1…) address.');
      return;
    }
    if (michelsonAddress && isTz4Address(michelsonAddress)) {
      setDiffError('BLS tz4 addresses are unsupported on the Tezos X Michelson RPC.');
      return;
    }

    const rawBigMapId = (override?.bigMapId ?? diffBigMapId).trim();
    const parsedBigMapId = rawBigMapId ? Number(rawBigMapId) : undefined;
    if (parsedBigMapId !== undefined && (!Number.isInteger(parsedBigMapId) || parsedBigMapId < 0)) {
      setDiffError('Big-Map ID must be a non-negative integer.');
      return;
    }
    const rawPinnedBlock = (override?.pinnedBlock ?? diffPinnedBlock).trim();
    const parsedPinnedBlock = rawPinnedBlock ? Number(rawPinnedBlock) : undefined;
    if (
      parsedPinnedBlock !== undefined &&
      (!Number.isInteger(parsedPinnedBlock) || parsedPinnedBlock < 0)
    ) {
      setDiffError('Pinned block override must be a non-negative integer.');
      return;
    }

    const keyType = override?.bigMapKeyType ?? diffBigMapKeyType;
    const keyVal = (override?.bigMapKey ?? diffBigMapKey).trim();

    setCapturingSlot(slot);
    setDiffError(null);
    try {
      const snap = await captureBlockPinnedSnapshot(network, {
        label: slot === 'A' ? 'Snapshot A (Before)' : 'Snapshot B (After)',
        evmAddress,
        michelsonAddress,
        bigMapId: parsedBigMapId,
        bigMapKeyType: parsedBigMapId !== undefined ? keyType : undefined,
        bigMapKey: parsedBigMapId !== undefined && keyVal ? keyVal : undefined,
        pinnedBlock: parsedPinnedBlock,
      });
      if (slot === 'A') {
        setSnapshotA(snap);
      } else {
        setSnapshotB(snap);
      }
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturingSlot(null);
    }
  };

  const computedDiff = useMemo(() => {
    if (!snapshotA || !snapshotB) return null;
    return diffSnapshots(snapshotA, snapshotB);
  }, [snapshotA, snapshotB]);

  const translatedExplorerUrl = identityReport?.translatedAddress
    ? getExplorerAddressUrl(network, identityReport.translatedAddress)
    : null;
  const inputExplorerUrl = identityReport?.input
    ? getExplorerAddressUrl(network, identityReport.input)
    : null;

  const isEvmOriginReport =
    identityReport?.homeRuntime === 1 || identityReport?.inferredRuntime === 1;
  const aliasByteLen = getCodeByteLength(identityReport?.aliasCode ?? null);

  return (
    <section aria-labelledby={`${uid}-module-title`} className="stack">
      {/* Module Header */}
      <div className="panel panel-michelson">
        <div className="panel-header">
          <div>
            <h2 id={`${uid}-module-title`} className="panel-title">
              <KeyRound size={16} className="text-michelson" aria-hidden="true" />
              Module 2 · Horus 8.0 Alias Inspector, Materializer &amp; Block-Pinned State Diff
            </h2>
            <p className="panel-subtitle">
              Live dual-runtime RPC telemetry against{' '}
              <strong style={{ color: 'var(--text-strong)' }}>{network.label}</strong>: query{' '}
              <code className="mono">originOf</code> / <code className="mono">resolveAddress</code>,
              execute <code className="mono">0xbfe88b4b</code> /{' '}
              <code className="mono">%materialize_alias</code>, and diff EVM + Michelson state at
              identical block height.
            </p>
          </div>
          <div className="row">
            {health ? (
              <span className={`badge ${health.synced ? 'badge-ok' : 'badge-warn'}`}>
                {health.synced && health.evmHead !== null
                  ? `SYNCED 1:1 · #${health.evmHead.toLocaleString()}`
                  : `EVM #${health.evmHead ?? '?'} / MICH #${health.michelsonLevel ?? '?'}`}
              </span>
            ) : (
              <span className="badge badge-muted">RPC Target: {network.id}</span>
            )}
          </div>
        </div>
      </div>

      {/* PANEL A: Horus 8.0 Identity & Safe-CREATE2 Alias Inspector */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <Search size={15} className="text-michelson" aria-hidden="true" />
            Panel A · Horus 8.0 Identity &amp; Safe-CREATE2 Alias Inspector
          </h3>
          <div className="row" style={{ gap: '6px' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!inspectInput.trim()}
              onClick={() => {
                const url = `${window.location.origin}${window.location.pathname}?network=${network.id}&tab=alias&addr=${encodeURIComponent(inspectInput.trim())}`;
                void handleCopy('share-alias', url);
              }}
            >
              {copiedKey === 'share-alias' ? <Check size={12} /> : <Link2 size={12} />}
              {copiedKey === 'share-alias' ? 'Link Copied' : 'Copy Share Link'}
            </button>
            <span className="badge badge-muted">
              0xff00…0007 originOf + resolveAddress + eth_getCode
            </span>
          </div>
        </div>

        <div className="panel-body stack">
          {/* 1-Click Fixtures */}
          <div className="row" style={{ gap: '6px' }}>
            <span className="mono muted" style={{ fontSize: '11px', marginRight: '4px' }}>
              FIXTURES:
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setInspectInput(DEFAULT_FIXTURES.aliceTz1);
                void runInspection(DEFAULT_FIXTURES.aliceTz1);
              }}
            >
              Alice <span className="mono text-michelson">tz1VSUr…</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setInspectInput(network.michelson.evmGateway);
                void runInspection(network.michelson.evmGateway);
              }}
            >
              Gateway <span className="mono text-michelson">KT18oDJJKX…</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setInspectInput(DEFAULT_FIXTURES.freeRoutePoolEvm);
                void runInspection(DEFAULT_FIXTURES.freeRoutePoolEvm);
              }}
            >
              Free-Route Pool <span className="mono text-evm">0x0d9d…</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                setInspectInput(DEFAULT_FIXTURES.sampleTz4Rejected);
                setIdentityReport(null);
                setInspectError(null);
              }}
            >
              Test tz4 Rejection
            </button>
            <button
              type="button"
              className={`btn btn-sm ${evmWallet.address ? 'btn-evm' : ''}`}
              onClick={async () => {
                if (evmWallet.address) {
                  setInspectInput(evmWallet.address);
                  await runInspection(evmWallet.address);
                } else {
                  await onConnectEvm();
                }
              }}
            >
              <Wallet size={12} aria-hidden="true" />
              {evmWallet.address
                ? `Use Connected EVM (${evmWallet.address.slice(0, 6)}…${evmWallet.address.slice(-4)})`
                : 'Use Connected EVM Wallet'}
            </button>
          </div>

          {/* Live Query Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runInspection();
            }}
            className="row"
            style={{ alignItems: 'stretch' }}
          >
            <label
              htmlFor={`${uid}-inspect-addr`}
              style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}
            >
              Tezos or EVM address to inspect
            </label>
            <input
              id={`${uid}-inspect-addr`}
              className="input mono"
              style={{ flex: '1 1 320px' }}
              value={inspectInput}
              onChange={(e) => setInspectInput(e.target.value)}
              placeholder="Enter tz1 / tz2 / tz3, KT1, or 0x address..."
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={inspecting || inspectIsTz4 || !trimmedInspect}
              style={{ minWidth: '148px' }}
            >
              {inspecting ? (
                <>
                  <Loader2 size={14} aria-hidden="true" />
                  Querying RPC…
                </>
              ) : (
                <>
                  <Search size={14} aria-hidden="true" />
                  Inspect Live
                </>
              )}
            </button>
          </form>

          {/* Explicit tz4 Rejection Banner */}
          {inspectIsTz4 && (
            <div role="alert" className="alert alert-danger">
              <ShieldAlert size={18} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
              <div className="stack-sm" style={{ gap: '4px' }}>
                <strong style={{ color: 'var(--danger)' }}>
                  Unsupported Address Type: BLS12-381 (<code className="mono">tz4</code>) Rejected
                </strong>
                <span>
                  Tezos X&apos;s Michelson runtime interface and Horus 8.0 Safe-CREATE2 alias
                  derivation do not support BLS <code className="mono">tz4</code> implicit accounts
                  yet. Use <code className="mono">tz1</code> (Ed25519),{' '}
                  <code className="mono">tz2</code> (secp256k1), <code className="mono">tz3</code>{' '}
                  (P-256), <code className="mono">KT1</code> smart contracts, or{' '}
                  <code className="mono">0x</code> EVM addresses.
                </span>
              </div>
            </div>
          )}

          {!inspectIsTz4 && trimmedInspect && !inspectIsValid && (
            <span className="field-hint text-warn">
              Unrecognized address format — expected 36-char <code className="mono">tz1/2/3</code>/
              <code className="mono">KT1</code> or 42-char <code className="mono">0x</code> hex
              address.
            </span>
          )}

          {inspectError && !inspectIsTz4 && (
            <div role="alert" className="alert alert-danger">
              <XCircle size={15} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
              <span>
                <strong>RPC Inspection Error:</strong> {inspectError}
              </span>
            </div>
          )}

          {/* Dual-Runtime Identity Result */}
          {identityReport && (
            <div
              aria-live="polite"
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
              }}
              className="stack"
            >
              <div className="row" style={{ gap: '6px' }}>
                <span className={`badge ${isEvmOriginReport ? 'badge-evm' : 'badge-michelson'}`}>
                  ORIGIN: {identityReport.homeRuntime ?? identityReport.inferredRuntime} ={' '}
                  {identityReport.homeRuntimeLabel}
                </span>
                <span
                  className={`badge ${
                    identityReport.kind === 1
                      ? 'badge-ok'
                      : identityReport.kind === 2
                        ? 'badge-evm'
                        : 'badge-muted'
                  }`}
                >
                  CLASSIFICATION: {identityReport.kindLabel} (kind={identityReport.kind})
                </span>
                {identityReport.isMaterialized !== null && (
                  <span
                    className={`badge ${identityReport.isMaterialized ? 'badge-ok' : 'badge-warn'}`}
                  >
                    {identityReport.isMaterialized
                      ? `MATERIALIZED (${aliasByteLen.toLocaleString()} bytes)`
                      : 'UNMATERIALIZED (0x)'}
                  </span>
                )}
                <span className="badge badge-muted">
                  resolution: {identityReport.resolutionLabel}
                </span>
              </div>

              <div className="grid-2">
                {/* Source Card */}
                <div
                  className="kv-item"
                  style={{
                    borderColor:
                      identityReport.inferredRuntime === 1
                        ? 'var(--evm-border)'
                        : 'var(--michelson-border)',
                    gap: '6px',
                  }}
                >
                  <div className="row-between">
                    <span
                      className={`kv-label ${
                        identityReport.inferredRuntime === 1 ? 'text-evm' : 'text-michelson'
                      }`}
                    >
                      Inspected ({identityReport.inferredRuntime === 1 ? 'EVM = 1' : 'Michelson = 0'})
                    </span>
                    <div className="row" style={{ gap: '4px' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleCopy('id-in', identityReport.input)}
                      >
                        {copiedKey === 'id-in' ? <Check size={11} /> : <Copy size={11} />}
                      </button>
                      {inputExplorerUrl && (
                        <a
                          href={inputExplorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-sm"
                          title="Open in Explorer"
                        >
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  </div>
                  <span className="kv-value">{identityReport.input}</span>
                  {identityReport.nativeAddress &&
                    identityReport.nativeAddress !== identityReport.input && (
                      <span className="mono muted" style={{ fontSize: '11px', wordBreak: 'break-all' }}>
                        Native home: {identityReport.nativeAddress}
                      </span>
                    )}
                </div>

                {/* Translated Cross-Runtime Card */}
                <div
                  className="kv-item"
                  style={{
                    borderColor:
                      identityReport.inferredRuntime === 1
                        ? 'var(--michelson-border)'
                        : 'var(--evm-border)',
                    gap: '6px',
                  }}
                >
                  <div className="row-between">
                    <span
                      className={`kv-label ${
                        identityReport.inferredRuntime === 1 ? 'text-michelson' : 'text-evm'
                      }`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <ArrowRight size={11} aria-hidden="true" />
                      Translated Alias ({identityReport.inferredRuntime === 1 ? 'Michelson = 0' : 'EVM = 1'})
                    </span>
                    {identityReport.translatedAddress && (
                      <div className="row" style={{ gap: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            handleCopy('id-translated', identityReport.translatedAddress ?? '')
                          }
                        >
                          {copiedKey === 'id-translated' ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                        {translatedExplorerUrl && (
                          <a
                            href={translatedExplorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-sm"
                            title="Open Translated Alias in Explorer"
                          >
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="kv-value">{identityReport.translatedAddress ?? 'Unresolved'}</span>
                  {identityReport.isMaterialized === false &&
                    /^tz[123]/.test(identityReport.input) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-evm"
                        style={{ alignSelf: 'flex-start', marginTop: '2px' }}
                        onClick={() => {
                          setMatTzAddress(identityReport.input);
                          if (identityReport.input === DEFAULT_FIXTURES.aliceTz1) {
                            setMatPublicKey(DEFAULT_FIXTURES.alicePubKey);
                          }
                        }}
                      >
                        Load into Materializer (Panel B) ↓
                      </button>
                    )}
                </div>
              </div>

              {/* Horus 8.0 Alias & Safe Singleton Factory Note */}
              <div className="alert alert-info" style={{ flexDirection: 'column', gap: '5px' }}>
                <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--michelson)' }}>
                  <Info size={14} aria-hidden="true" />
                  Horus 8.0 Alias Semantics &amp; Safe-CREATE2 Note
                </strong>
                <span style={{ color: 'var(--text)' }}>{identityReport.aliasTypeNote}</span>
                <span className="muted" style={{ fontSize: '12px' }}>
                  <strong style={{ color: 'var(--text)' }}>Horus 8.0 rule:</strong> Implicit{' '}
                  <code className="mono">tz1/tz2/tz3</code> accounts use Safe-CREATE2 derivation for
                  cross-chain recovery on Ethereum/Arbitrum/Base, while{' '}
                  <code className="mono">KT1</code> contracts retain Keccak-256 aliases. Safe
                  Singleton Factory (<code className="mono">{SAFE_SINGLETON_FACTORY}</code>)
                  intentionally returns <code className="mono">0x</code> (0 bytes) on Previewnet
                  because it is only a deterministic cross-chain CREATE2 formula constant, not a
                  deployed contract on Tezos X.
                </span>
              </div>

              <details>
                <summary
                  className="mono muted"
                  style={{ cursor: 'pointer', fontSize: '11.5px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                  Raw Precompile Return Payloads (originOf / resolveAddress)
                </summary>
                <pre className="code-block" style={{ marginTop: '8px' }}>
                  {`originOf:       ${identityReport.rawOriginHex || '—'}\nresolveAddress: ${identityReport.rawResolveHex || '—'}\naliasCode:      ${identityReport.aliasCode ?? '—'}`}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>

      {/* PANEL B: Horus 8.0 %materialize_alias / materializeAlias Executor */}
      <div className="panel panel-evm">
        <div className="panel-header">
          <h3 className="panel-title">
            <Send size={15} className="text-evm" aria-hidden="true" />
            Panel B · Horus 8.0 Alias Materializer (
            <code className="mono text-evm">0xbfe88b4b</code> &amp;{' '}
            <code className="mono text-michelson">%materialize_alias</code>)
          </h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setMatTzAddress(DEFAULT_FIXTURES.aliceTz1);
              setMatPublicKey(DEFAULT_FIXTURES.alicePubKey);
              setTxState({ phase: 'idle' });
            }}
          >
            Fill Alice Fixture (tz1 + edpk)
          </button>
        </div>

        <div className="panel-body stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`${uid}-mat-tz`} className="field-label">
                Native Tezos Implicit Account (tz1 / tz2 / tz3)
              </label>
              <input
                id={`${uid}-mat-tz`}
                className="input mono"
                value={matTzAddress}
                onChange={(e) => {
                  setMatTzAddress(e.target.value);
                  setTxState({ phase: 'idle' });
                }}
                placeholder="tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb"
                spellCheck={false}
              />
              {matIsTz4 && (
                <span role="alert" className="field-hint text-danger">
                  BLS <code className="mono">tz4</code> is unsupported — cannot materialize on Tezos
                  X.
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor={`${uid}-mat-pk`} className="field-label">
                Tezos Public Key (edpk… / sppk… / p2pk…)
              </label>
              <input
                id={`${uid}-mat-pk`}
                className="input mono"
                value={matPublicKey}
                onChange={(e) => {
                  setMatPublicKey(e.target.value);
                  setTxState({ phase: 'idle' });
                }}
                placeholder="edpkvGfYw3LyB1UcCahKQk4rF2tvbMUk8GFiTuMjL75uGXrpvKXhjn"
                spellCheck={false}
              />
              <span className="field-hint">
                Verified live on v0.11: EVM precompile <code className="mono">0xbfe88b4b</code>{' '}
                requires the matching public key (empty string reverts with{' '}
                <code className="mono">Missing public key</code>).
              </span>
            </div>
          </div>

          <div className="subtabs" role="tablist" aria-label="Alias materialization runtime">
            <button
              type="button"
              role="tab"
              id={`${uid}-mat-tab-evm`}
              aria-selected={materializeTab === 'evm_precompile'}
              aria-controls={`${uid}-mat-panel-evm`}
              className={`subtab ${materializeTab === 'evm_precompile' ? 'subtab-active' : ''}`}
              onClick={() => setMaterializeTab('evm_precompile')}
            >
              EVM → Tezos Precompile (<code className="mono">0xbfe88b4b</code>)
            </button>
            <button
              type="button"
              role="tab"
              id={`${uid}-mat-tab-mich`}
              aria-selected={materializeTab === 'michelson_gateway'}
              aria-controls={`${uid}-mat-panel-mich`}
              className={`subtab ${materializeTab === 'michelson_gateway' ? 'subtab-active' : ''}`}
              onClick={() => setMaterializeTab('michelson_gateway')}
            >
              Michelson → EVM (<code className="mono">KT18oDJJKX… %materialize_alias</code>)
            </button>
          </div>

          {materializeTab === 'evm_precompile' ? (
            <div
              id={`${uid}-mat-panel-evm`}
              role="tabpanel"
              aria-labelledby={`${uid}-mat-tab-evm`}
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
              }}
              className="stack-sm"
            >
              <div className="row-between">
                <div className="row" style={{ gap: '8px' }}>
                  <span className="badge badge-evm">selector: 0xbfe88b4b</span>
                  <span className="mono muted" style={{ fontSize: '11.5px' }}>
                    materializeAlias(&quot;tezos&quot;, tzAddress, publicKey) → {network.evm.precompile}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!materializeCalldata}
                  onClick={() => handleCopy('mat-calldata', materializeCalldata)}
                >
                  {copiedKey === 'mat-calldata' ? <Check size={12} /> : <Copy size={12} />}
                  {copiedKey === 'mat-calldata' ? 'Copied' : 'Copy Calldata'}
                </button>
              </div>

              <pre className="code-block text-evm" style={{ maxHeight: '110px', overflowY: 'auto' }}>
                {materializeCalldata ||
                  'Enter a valid tz1/tz2/tz3 address to preview 0xbfe88b4b calldata.'}
              </pre>

              <hr className="divider" style={{ margin: '4px 0' }} />

              <div className="row-between">
                <div className="stack-sm" style={{ gap: '3px' }}>
                  {evmWallet.address ? (
                    <>
                      <span className="text-ok row" style={{ gap: '6px', fontSize: '12.5px' }}>
                        <CheckCircle2 size={14} aria-hidden="true" />
                        Connected: <code className="mono">{evmWallet.address}</code> (
                        {evmWallet.providerName ?? 'EVM Wallet'})
                      </span>
                      {evmWallet.chainId !== null && evmWallet.chainId !== network.evm.chainId && (
                        <span className="text-warn row" style={{ gap: '5px', fontSize: '12px' }}>
                          <AlertTriangle size={13} aria-hidden="true" />
                          Wallet on chain {evmWallet.chainId}; will switch to {network.label} (
                          {network.evm.chainId}) before sending.
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="muted" style={{ fontSize: '12.5px' }}>
                      Connect an EIP-6963 / injected EVM wallet to broadcast a live{' '}
                      <code className="mono">0xbfe88b4b</code> transaction on {network.label}.
                    </span>
                  )}
                </div>

                <div className="row" style={{ gap: '6px' }}>
                  {evmWallet.address ? (
                    <button
                      type="button"
                      className="btn btn-evm"
                      disabled={
                        txState.phase === 'switching' ||
                        txState.phase === 'signing' ||
                        matIsTz4 ||
                        !matTzTrimmed
                      }
                      onClick={() => void handleSendMaterializeEvm()}
                    >
                      {txState.phase === 'switching' || txState.phase === 'signing' ? (
                        <>
                          <Loader2 size={14} aria-hidden="true" />
                          {txState.phase === 'switching' ? 'Switching Chain…' : 'Confirm in Wallet…'}
                        </>
                      ) : (
                        <>
                          <Send size={14} aria-hidden="true" />
                          Send via Connected EVM Wallet
                        </>
                      )}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void onConnectEvm()}
                      >
                        <Wallet size={14} aria-hidden="true" />
                        Connect EVM Wallet
                      </button>
                      {evmWallet.providers.slice(0, 3).map((p) => (
                        <button
                          key={p.rdns}
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void onConnectEvm(p.rdns)}
                        >
                          {p.name}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {txState.phase === 'submitted' && txState.txHash && (
                <div aria-live="polite" className="alert alert-ok row-between">
                  <span className="row" style={{ gap: '6px' }}>
                    <ShieldCheck size={16} aria-hidden="true" />
                    Broadcasted tx: <code className="mono">{txState.txHash}</code>
                  </span>
                  <a
                    href={`${network.evm.explorerUrl.replace(/\/$/, '')}/tx/${txState.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                  >
                    View on Blockscout <ExternalLink size={12} />
                  </a>
                </div>
              )}

              {txState.phase === 'error' && txState.error && (
                <div role="alert" className="alert alert-danger" style={{ flexDirection: 'column', gap: '4px' }}>
                  <strong className="row" style={{ gap: '6px' }}>
                    <XCircle size={14} aria-hidden="true" />
                    Transaction Rejected / Failed
                  </strong>
                  {txState.decodedSummary && (
                    <span style={{ color: 'var(--text-strong)' }}>{txState.decodedSummary}</span>
                  )}
                  <code className="mono" style={{ fontSize: '11.5px', wordBreak: 'break-all' }}>
                    {txState.error}
                  </code>
                </div>
              )}
            </div>
          ) : (
            <div
              id={`${uid}-mat-panel-mich`}
              role="tabpanel"
              aria-labelledby={`${uid}-mat-tab-mich`}
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
              }}
              className="stack"
            >
              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label text-michelson">
                    Verified 3-Field Parameter: pair string (pair string (option string))
                  </span>
                  <span className="badge badge-michelson">
                    {network.michelson.evmGateway} %materialize_alias
                  </span>
                </div>
                <pre className="code-block">
                  {`Pair "tezos" (Pair "${matTzTrimmed || DEFAULT_FIXTURES.aliceTz1}" ${matPubTrimmed ? `(Some "${matPubTrimmed}")` : 'None'})`}
                </pre>
              </div>

              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <Terminal size={12} aria-hidden="true" />
                    octez-client Command
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => handleCopy('octez-cli', octezClientCmd)}
                  >
                    {copiedKey === 'octez-cli' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'octez-cli' ? 'Copied' : 'Copy Command'}
                  </button>
                </div>
                <pre className="code-block pre">{octezClientCmd}</pre>
              </div>

              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <Layers size={12} aria-hidden="true" />
                    @tezos-x/octez.js v25.1 Snippet
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => handleCopy('octez-js-mat', octezJsSnippet)}
                  >
                    {copiedKey === 'octez-js-mat' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'octez-js-mat' ? 'Copied' : 'Copy Snippet'}
                  </button>
                </div>
                <pre className="code-block pre" style={{ maxHeight: '230px', overflowY: 'auto' }}>
                  {octezJsSnippet}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* PANEL C: Block-Pinned Dual-Runtime State-Diff Inspector */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <GitCompare size={15} className="text-ok" aria-hidden="true" />
            Panel C · Block-Pinned Dual-Runtime State-Diff Inspector (
            <code className="mono">EVM block N == Michelson level N</code>)
          </h3>
          <div className="row" style={{ gap: '6px' }}>
            {(() => {
              const canaryAddrs = loadDefaultCanaryAddresses(network.id);
              if (canaryAddrs.source === 'unconfigured') return null;
              const bmId = String(canaryAddrs.pingsBigMapId ?? 2294);
              return (
                <button
                  type="button"
                  className="btn btn-sm btn-michelson"
                  disabled={capturingSlot !== null}
                  onClick={() => {
                    setDiffEvmAddr(canaryAddrs.evmCanary);
                    setDiffMichAddr(canaryAddrs.michelsonCanary);
                    setDiffBigMapId(bmId);
                    setDiffBigMapKeyType('nat');
                    setDiffBigMapKey('1');
                    setDiffPinnedBlock('');
                    void handleCaptureSnapshot('A', {
                      evmAddress: canaryAddrs.evmCanary,
                      michelsonAddress: canaryAddrs.michelsonCanary,
                      bigMapId: bmId,
                      bigMapKeyType: 'nat',
                      bigMapKey: '1',
                      pinnedBlock: '',
                    });
                  }}
                >
                  Load Live Canary (big_map #{bmId}, key 1)
                </button>
              );
            })()}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDiffEvmAddr(DEFAULT_FIXTURES.freeRoutePoolEvm);
                setDiffMichAddr(network.michelson.evmGateway);
                setDiffBigMapId('');
              }}
            >
              Pool + Gateway
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDiffEvmAddr('0x3c0EE21DA093b0AA44c590BA0BB1883ef8080137');
                setDiffMichAddr(DEFAULT_FIXTURES.aliceTz1);
                setDiffBigMapId('');
              }}
            >
              Alice Dual-Runtime
            </button>
          </div>
        </div>

        <div className="panel-body stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`${uid}-diff-evm`} className="field-label">
                Optional EVM Address (0x…)
              </label>
              <input
                id={`${uid}-diff-evm`}
                className="input mono"
                value={diffEvmAddr}
                onChange={(e) => setDiffEvmAddr(e.target.value)}
                placeholder="0x0d9de5e5..."
                spellCheck={false}
              />
            </div>

            <div className="field">
              <label htmlFor={`${uid}-diff-mich`} className="field-label">
                Optional Michelson Contract / Account (KT1… / tz1…)
              </label>
              <input
                id={`${uid}-diff-mich`}
                className="input mono"
                value={diffMichAddr}
                onChange={(e) => setDiffMichAddr(e.target.value)}
                placeholder="KT18oDJJKX..."
                spellCheck={false}
              />
            </div>
          </div>

          <fieldset
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '12px',
              margin: 0,
              background: 'var(--bg-elevated)',
            }}
            className="stack-sm"
          >
            <legend
              className="mono muted"
              style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 6px' }}
            >
              Optional Michelson Big-Map Key Probe (Zero-Indexer BLAKE2b expr…) &amp; Block Pin
            </legend>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: '10px',
              }}
            >
              <div className="field">
                <label htmlFor={`${uid}-bm-id`} className="field-label">
                  Big-Map ID
                </label>
                <input
                  id={`${uid}-bm-id`}
                  className="input mono"
                  inputMode="numeric"
                  value={diffBigMapId}
                  onChange={(e) => setDiffBigMapId(e.target.value)}
                  placeholder="e.g. 12"
                />
              </div>

              <div className="field">
                <label htmlFor={`${uid}-bm-type`} className="field-label">
                  Key Type
                </label>
                <select
                  id={`${uid}-bm-type`}
                  className="select mono"
                  value={diffBigMapKeyType}
                  onChange={(e) => setDiffBigMapKeyType(e.target.value as BigMapKeyType)}
                >
                  <option value="address">address</option>
                  <option value="nat">nat</option>
                  <option value="string">string</option>
                </select>
              </div>

              <div className="field" style={{ gridColumn: 'span 2' }}>
                <label htmlFor={`${uid}-bm-key`} className="field-label">
                  Key Value
                </label>
                <input
                  id={`${uid}-bm-key`}
                  className="input mono"
                  value={diffBigMapKey}
                  onChange={(e) => setDiffBigMapKey(e.target.value)}
                  placeholder={
                    diffBigMapKeyType === 'address'
                      ? DEFAULT_FIXTURES.aliceTz1
                      : diffBigMapKeyType === 'nat'
                        ? '0'
                        : 'key'
                  }
                  spellCheck={false}
                />
              </div>

              <div className="field">
                <label htmlFor={`${uid}-pin-blk`} className="field-label">
                  Pinned Block (opt.)
                </label>
                <input
                  id={`${uid}-pin-blk`}
                  className="input mono"
                  inputMode="numeric"
                  value={diffPinnedBlock}
                  onChange={(e) => setDiffPinnedBlock(e.target.value)}
                  placeholder="Auto latest"
                />
              </div>
            </div>

            {liveBigMapHash && (
              <output
                aria-live="polite"
                className={`alert ${'error' in liveBigMapHash ? 'alert-danger' : 'alert-info'} row-between`}
                style={{ padding: '8px 11px' }}
              >
                {'error' in liveBigMapHash ? (
                  <span>Key hash error: {liveBigMapHash.error}</span>
                ) : (
                  <>
                    <span className="row" style={{ gap: '6px' }}>
                      <Database size={13} className="text-michelson" aria-hidden="true" />
                      <span className="muted">
                        BLAKE2b-256 <code className="mono">expr…</code>:
                      </span>
                      <code className="mono text-michelson" style={{ wordBreak: 'break-all' }}>
                        {liveBigMapHash.exprHash}
                      </code>
                      <span className="mono muted" style={{ fontSize: '11px' }}>
                        (packed: {liveBigMapHash.packedHex})
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleCopy('bm-expr', liveBigMapHash.exprHash)}
                    >
                      {copiedKey === 'bm-expr' ? 'Copied' : 'Copy expr'}
                    </button>
                  </>
                )}
              </output>
            )}
          </fieldset>

          {/* Snapshot Capture Controls */}
          <div className="row" style={{ gap: '8px' }}>
            <button
              type="button"
              className="btn btn-evm"
              disabled={capturingSlot !== null}
              onClick={() => void handleCaptureSnapshot('A')}
            >
              {capturingSlot === 'A' ? (
                <Loader2 size={14} aria-hidden="true" />
              ) : (
                <Camera size={14} aria-hidden="true" />
              )}
              Capture Snapshot A (Before)
            </button>

            <button
              type="button"
              className="btn btn-michelson"
              disabled={capturingSlot !== null}
              onClick={() => void handleCaptureSnapshot('B')}
            >
              {capturingSlot === 'B' ? (
                <Loader2 size={14} aria-hidden="true" />
              ) : (
                <Camera size={14} aria-hidden="true" />
              )}
              Capture Snapshot B (After)
            </button>

            <button
              type="button"
              className="btn"
              disabled={!snapshotA && !snapshotB}
              onClick={() => {
                setSnapshotA(snapshotB);
                setSnapshotB(snapshotA);
              }}
            >
              <Repeat size={13} aria-hidden="true" />
              Swap A ↔ B
            </button>

            <button
              type="button"
              className="btn btn-ghost"
              disabled={!snapshotA && !snapshotB}
              onClick={() => {
                setSnapshotA(null);
                setSnapshotB(null);
                setDiffError(null);
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
              Clear
            </button>
          </div>

          {diffError && (
            <div role="alert" className="alert alert-danger">
              <XCircle size={15} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
              <span>
                <strong>Snapshot Capture Error:</strong> {diffError}
              </span>
            </div>
          )}

          <div className="grid-2">
            <SnapshotCard
              snapshot={snapshotA}
              slotLabel="SNAPSHOT A · BEFORE"
              accentClass="panel-evm"
            />
            <SnapshotCard
              snapshot={snapshotB}
              slotLabel="SNAPSHOT B · AFTER"
              accentClass="panel-michelson"
            />
          </div>

          {/* Computed Dual-Runtime Diff */}
          {computedDiff && (
            <div
              aria-live="polite"
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--ok-soft)',
                border: '1px solid var(--ok-border)',
              }}
              className="stack-sm"
            >
              <div className="row-between">
                <strong className="text-ok row" style={{ gap: '6px' }}>
                  <GitCompare size={15} aria-hidden="true" />
                  Dual-Runtime State Diff (A → B)
                </strong>
                <span className="mono muted" style={{ fontSize: '11.5px' }}>
                  #{computedDiff.before.blockNumber.toLocaleString()} → #
                  {computedDiff.after.blockNumber.toLocaleString()}
                </span>
              </div>

              <div className="kv-grid">
                <div className="kv-item">
                  <span className="kv-label">Δ Block</span>
                  <span className="kv-value">
                    {computedDiff.blockDelta >= 0
                      ? `+${computedDiff.blockDelta}`
                      : String(computedDiff.blockDelta)}
                  </span>
                </div>

                <div className="kv-item" style={{ borderColor: 'var(--evm-border)' }}>
                  <span className="kv-label text-evm">Δ EVM Wei</span>
                  <span className="kv-value">
                    {formatSignedBigInt(computedDiff.evmBalanceDeltaWei, 'wei')}
                  </span>
                </div>

                <div className="kv-item" style={{ borderColor: 'var(--michelson-border)' }}>
                  <span className="kv-label text-michelson">Δ Michelson Mutez</span>
                  <span className="kv-value">
                    {formatSignedBigInt(computedDiff.michelsonBalanceDeltaMutez, 'mutez')}
                  </span>
                </div>

                <div className="kv-item">
                  <span className="kv-label">Storage Changed</span>
                  <span
                    className={`kv-value ${
                      computedDiff.michelsonStorageChanged ? 'text-evm' : 'text-ok'
                    }`}
                  >
                    {computedDiff.michelsonStorageChanged ? 'MUTATED' : 'UNCHANGED'}
                  </span>
                </div>

                <div className="kv-item">
                  <span className="kv-label">Big-Map Changed</span>
                  <span
                    className={`kv-value ${
                      computedDiff.bigMapValueChanged ? 'text-evm' : 'text-ok'
                    }`}
                  >
                    {computedDiff.bigMapValueChanged ? 'MUTATED' : 'UNCHANGED'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
