import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  Database,
  ExternalLink,
  GitCompare,
  Layers,
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

type MaterializeTab = 'evm_precompile' | 'michelson_gateway';
type BigMapKeyType = 'nat' | 'string' | 'address';
type AliasStep = 'lookup' | 'materialize' | 'diff';

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
  hint,
}: {
  snapshot: DualRuntimeSnapshot | null;
  slotLabel: string;
  hint: string;
}) {
  return (
    <div className="card-inset stack-sm">
      <div className="row-between">
        <span className="strong small">{slotLabel}</span>
        {snapshot ? (
          <span className={`pill pill-sm ${snapshot.blockSynced ? 'pill-ok' : 'pill-warn'}`}>
            {snapshot.blockSynced
              ? `Synced #${snapshot.blockNumber.toLocaleString()}`
              : `Skew: EVM #${snapshot.blockNumber} ≠ Mich #${snapshot.michelsonLevel}`}
          </span>
        ) : (
          <span className="pill pill-sm pill-muted">Not captured</span>
        )}
      </div>

      {!snapshot ? (
        <p className="field-hint" style={{ margin: 0 }}>
          {hint}
        </p>
      ) : (
        <>
          <span className="mono muted xsmall">
            Captured {new Date(snapshot.capturedAt).toLocaleTimeString()} · EVM #
            {snapshot.blockNumber.toLocaleString()} / Michelson #
            {snapshot.michelsonLevel.toLocaleString()}
          </span>

          <div className="kv-grid">
            {snapshot.evmAddress && (
              <div className="kv-item">
                <span className="kv-label row" style={{ gap: 6 }}>
                  <RuntimePill runtime="evm" small /> Balance &amp; code
                </span>
                <span className="kv-value">{weiToXtzString(snapshot.evmBalanceWei)}</span>
                <span className="mono muted xsmall break-all">
                  {snapshot.evmBalanceWei ?? '—'} wei · {snapshot.evmCodeBytes ?? 0} B
                </span>
              </div>
            )}

            {snapshot.michelsonAddress && (
              <div className="kv-item">
                <span className="kv-label row" style={{ gap: 6 }}>
                  <RuntimePill runtime="michelson" small /> Balance
                </span>
                <span className="kv-value">{mutezToXtzString(snapshot.michelsonBalanceMutez)}</span>
                <span className="mono muted xsmall break-all">
                  {snapshot.michelsonBalanceMutez ?? '—'} mutez
                </span>
              </div>
            )}
          </div>

          {snapshot.michelsonStorage !== undefined && (
            <div className="stack-xs">
              <span className="kv-label">Michelson contract storage</span>
              <pre className="code-block pre" style={{ maxHeight: 140 }}>
                {JSON.stringify(snapshot.michelsonStorage, null, 2)}
              </pre>
            </div>
          )}

          {snapshot.bigMapId !== undefined && (
            <div className="stack-xs">
              <span className="kv-label break-all">
                Big-map #{snapshot.bigMapId} · {snapshot.bigMapKeyHash ?? 'expr…'}
              </span>
              <pre className="code-block pre" style={{ maxHeight: 120 }}>
                {snapshot.bigMapValue !== undefined
                  ? JSON.stringify(snapshot.bigMapValue, null, 2)
                  : 'null (key absent at pinned block)'}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AddressCard({
  label,
  runtime,
  address,
  explorerUrl,
  copied,
  onCopy,
  children,
}: {
  label: string;
  runtime: 'evm' | 'michelson';
  address: string | null;
  explorerUrl: string | null;
  copied: boolean;
  onCopy: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="kv-item" style={{ gap: 6 }}>
      <div className="row-between">
        <span className="kv-label row" style={{ gap: 6 }}>
          {label} <RuntimePill runtime={runtime} small />
        </span>
        {address && (
          <div className="row" style={{ gap: 4 }}>
            <CopyButton iconOnly label={`Copy ${label.toLowerCase()} address`} copied={copied} onClick={onCopy} />
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm btn-icon"
                title="Open in explorer"
                aria-label={`Open ${label.toLowerCase()} address in explorer`}
              >
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>
      <span className="kv-value">{address ?? 'Unresolved'}</span>
      {children}
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
  const { copiedKey, copy: handleCopy } = useCopy();
  const autoRanInitialAddrRef = useRef(false);
  const [step, setStep] = useState<AliasStep>('lookup');

  // Step 1: Identity Inspector state
  const [inspectInput, setInspectInput] = useState<string>(
    initialAddr?.trim() || DEFAULT_FIXTURES.aliceTz1,
  );
  const [inspecting, setInspecting] = useState<boolean>(false);
  const [identityReport, setIdentityReport] = useState<IdentityReport | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // Step 2: Materializer state
  const [materializeTab, setMaterializeTab] = useState<MaterializeTab>('evm_precompile');
  const [matTzAddress, setMatTzAddress] = useState<string>(DEFAULT_FIXTURES.aliceTz1);
  const [matPublicKey, setMatPublicKey] = useState<string>(DEFAULT_FIXTURES.alicePubKey);
  const [txState, setTxState] = useState<TxLifecycleState>({ phase: 'idle' });

  // Step 3: Block-Pinned Dual-Runtime State-Diff state
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
  const [probeOpen, setProbeOpen] = useState<boolean>(false);

  const trimmedInspect = inspectInput.trim();
  const inspectIsTz4 = isTz4Address(trimmedInspect);
  const inspectIsValid = isValidEvmAddress(trimmedInspect) || isValidTezosXAddress(trimmedInspect);

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

  // Step 2 computed calldata & CLI/SDK snippets
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
      const txHash = await sendMaterializeAliasEvmTx(provider, network, matTzTrimmed, matPubTrimmed);
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

  // Step 3: live BLAKE2b expr hash preview
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

  const aliasByteLen = getCodeByteLength(identityReport?.aliasCode ?? null);
  const inputRuntime: 'evm' | 'michelson' =
    identityReport?.inferredRuntime === 1 ? 'evm' : 'michelson';
  const translatedRuntime: 'evm' | 'michelson' = inputRuntime === 'evm' ? 'michelson' : 'evm';
  const canMaterializeReported =
    identityReport?.isMaterialized === false && /^tz[123]/.test(identityReport.input);

  const canaryAddrs = loadDefaultCanaryAddresses(network.id);
  const canaryBigMapId =
    canaryAddrs.source === 'unconfigured' ? null : String(canaryAddrs.pingsBigMapId ?? 2294);

  const loadIntoMaterializer = (tzAddr: string) => {
    setMatTzAddress(tzAddr);
    if (tzAddr === DEFAULT_FIXTURES.aliceTz1) {
      setMatPublicKey(DEFAULT_FIXTURES.alicePubKey);
    }
    setTxState({ phase: 'idle' });
    setMaterializeTab('evm_precompile');
    setStep('materialize');
  };

  const txBusy = txState.phase === 'switching' || txState.phase === 'signing';
  const txProgress: { label: string; state: ProgressState }[] = [
    { label: 'Ready', state: txState.phase === 'idle' ? 'active' : 'done' },
    {
      label: txState.phase === 'switching' ? 'Switching chain' : 'Sign in wallet',
      state:
        txState.phase === 'switching' || txState.phase === 'signing'
          ? 'active'
          : txState.phase === 'submitted'
            ? 'done'
            : txState.phase === 'error'
              ? 'error'
              : 'todo',
    },
    { label: 'Submitted', state: txState.phase === 'submitted' ? 'done' : 'todo' },
  ];

  const stepPrefix = `${uid}-step`;
  const matPrefix = `${uid}-mat`;
  const snapshotsCaptured = Number(Boolean(snapshotA)) + Number(Boolean(snapshotB));

  return (
    <section aria-labelledby={`${uid}-module-title`} className="stack">
      <h2 id={`${uid}-module-title`} className="sr-only">
        Module 2 · Alias &amp; State Diff
      </h2>

      <TabList<AliasStep>
        idPrefix={stepPrefix}
        ariaLabel="Alias workflow steps"
        className="stepper"
        itemClassName="stepper-item"
        value={step}
        onChange={setStep}
        items={[
          {
            id: 'lookup',
            done: Boolean(identityReport),
            label: (
              <>
                <span className="step-num" aria-hidden="true">
                  {identityReport ? <Check size={12} /> : 1}
                </span>
                <span className="stepper-text">
                  <span className="stepper-title">Lookup identity</span>
                  <span className="stepper-sub">
                    {identityReport
                      ? identityReport.isMaterialized === false
                        ? 'Alias not materialized'
                        : identityReport.isMaterialized
                          ? 'Alias materialized'
                          : identityReport.kindLabel
                      : 'originOf · resolveAddress · no wallet'}
                  </span>
                </span>
              </>
            ),
          },
          {
            id: 'materialize',
            done: txState.phase === 'submitted',
            label: (
              <>
                <span className="step-num" aria-hidden="true">
                  {txState.phase === 'submitted' ? <Check size={12} /> : 2}
                </span>
                <span className="stepper-text">
                  <span className="stepper-title">Materialize alias</span>
                  <span className="stepper-sub">
                    {txState.phase === 'submitted'
                      ? 'Transaction submitted'
                      : '0xbfe88b4b · wallet to send, CLI free'}
                  </span>
                </span>
              </>
            ),
          },
          {
            id: 'diff',
            done: Boolean(computedDiff),
            label: (
              <>
                <span className="step-num" aria-hidden="true">
                  {computedDiff ? <Check size={12} /> : 3}
                </span>
                <span className="stepper-text">
                  <span className="stepper-title">Block-pinned state diff</span>
                  <span className="stepper-sub">
                    {snapshotsCaptured}/2 snapshots · no wallet
                  </span>
                </span>
              </>
            ),
          },
        ]}
      />

      {/* ===================== STEP 1 · LOOKUP ===================== */}
      {step === 'lookup' && (
        <TabPanel idPrefix={stepPrefix} id="lookup">
          <div className="card">
            <div className="card-header">
              <StepTitle
                n={1}
                title="Lookup cross-runtime identity"
                hint={
                  <>
                    Resolve any tz1/tz2/tz3, KT1 or 0x address via <code>originOf</code> +{' '}
                    <code>resolveAddress</code> on {network.label}.
                  </>
                }
              />
              <CopyButton
                label="Copy share link"
                copiedLabel="Link copied"
                copied={copiedKey === 'share-alias'}
                disabled={!inspectInput.trim()}
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}?network=${network.id}&tab=alias&addr=${encodeURIComponent(inspectInput.trim())}`;
                  void handleCopy('share-alias', url);
                }}
              />
            </div>

            <div className="card-body stack">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runInspection();
                }}
                className="stack-sm"
              >
                <label htmlFor={`${uid}-inspect-addr`} className="field-label">
                  Address to inspect
                </label>
                <div className="input-row">
                  <input
                    id={`${uid}-inspect-addr`}
                    className="input mono"
                    value={inspectInput}
                    onChange={(e) => setInspectInput(e.target.value)}
                    placeholder="tz1 / tz2 / tz3, KT1, or 0x address…"
                    spellCheck={false}
                    aria-invalid={inspectIsTz4 || (!!trimmedInspect && !inspectIsValid)}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={inspecting || inspectIsTz4 || !trimmedInspect}
                    style={{ minWidth: 132 }}
                  >
                    {inspecting ? (
                      <Loader2 size={14} className="spin" aria-hidden="true" />
                    ) : (
                      <Search size={14} aria-hidden="true" />
                    )}
                    {inspecting ? 'Querying…' : 'Inspect live'}
                  </button>
                </div>
                <div className="chip-row" role="group" aria-label="Address fixtures">
                  <span className="chip-row-label">Try</span>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setInspectInput(DEFAULT_FIXTURES.aliceTz1);
                      void runInspection(DEFAULT_FIXTURES.aliceTz1);
                    }}
                  >
                    Alice <span className="chip-meta mono">tz1VSUr…</span>
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setInspectInput(network.michelson.evmGateway);
                      void runInspection(network.michelson.evmGateway);
                    }}
                  >
                    Gateway <span className="chip-meta mono">KT18oDJJKX…</span>
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setInspectInput(DEFAULT_FIXTURES.freeRoutePoolEvm);
                      void runInspection(DEFAULT_FIXTURES.freeRoutePoolEvm);
                    }}
                  >
                    Free-Route pool <span className="chip-meta mono">0x0d9d…</span>
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setInspectInput(DEFAULT_FIXTURES.sampleTz4Rejected);
                      setIdentityReport(null);
                      setInspectError(null);
                    }}
                  >
                    tz4 <span className="chip-meta">rejection test</span>
                  </button>
                  <button
                    type="button"
                    className="chip"
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
                      ? `My wallet (${evmWallet.address.slice(0, 6)}…${evmWallet.address.slice(-4)})`
                      : 'Connect wallet to use mine'}
                  </button>
                </div>
              </form>

              {inspectIsTz4 && (
                <div role="alert" className="alert alert-danger">
                  <ShieldAlert size={16} aria-hidden="true" />
                  <div className="stack-xs">
                    <strong className="strong">
                      Unsupported address type: BLS12-381 (<code>tz4</code>) rejected
                    </strong>
                    <span>
                      Tezos X&apos;s Michelson runtime interface and Horus 8.0 Safe-CREATE2 alias
                      derivation do not support BLS <code>tz4</code> implicit accounts yet. Use{' '}
                      <code>tz1</code> (Ed25519), <code>tz2</code> (secp256k1), <code>tz3</code>{' '}
                      (P-256), <code>KT1</code> smart contracts, or <code>0x</code> EVM addresses.
                    </span>
                  </div>
                </div>
              )}

              {!inspectIsTz4 && trimmedInspect && !inspectIsValid && (
                <span className="field-hint text-warn">
                  Unrecognized address format — expected 36-char <code>tz1/2/3</code>/
                  <code>KT1</code> or 42-char <code>0x</code> hex address.
                </span>
              )}

              {inspectError && !inspectIsTz4 && (
                <div role="alert" className="alert alert-danger">
                  <XCircle size={15} aria-hidden="true" />
                  <span>
                    <strong>RPC inspection error:</strong> {inspectError}
                  </span>
                </div>
              )}

              {!identityReport && !inspectError && !inspecting && !inspectIsTz4 && (
                <p className="field-hint" style={{ margin: 0 }}>
                  Results show the native runtime, classification, the translated alias on the
                  other runtime, and whether that alias is materialized on-chain.
                </p>
              )}

              {identityReport && (
                <div aria-live="polite" className="stack">
                  <div className="divider" />
                  <div className="row" style={{ gap: 6 }}>
                    <span className="pill">
                      Origin <RuntimePill runtime={identityReport.homeRuntime === 1 || identityReport.inferredRuntime === 1 ? 'evm' : 'michelson'} small />
                      <span className="mono muted">
                        {identityReport.homeRuntime ?? identityReport.inferredRuntime} ={' '}
                        {identityReport.homeRuntimeLabel}
                      </span>
                    </span>
                    <span className="pill">
                      {identityReport.kindLabel}
                      <span className="mono muted">kind={identityReport.kind}</span>
                    </span>
                    {identityReport.isMaterialized !== null && (
                      <span
                        className={`pill ${identityReport.isMaterialized ? 'pill-ok' : 'pill-warn'}`}
                      >
                        {identityReport.isMaterialized
                          ? `Materialized · ${aliasByteLen.toLocaleString()} B`
                          : 'Not materialized (0x)'}
                      </span>
                    )}
                    <span className="pill pill-muted">
                      resolution: {identityReport.resolutionLabel}
                    </span>
                  </div>

                  <div className="grid-2">
                    <AddressCard
                      label="Inspected"
                      runtime={inputRuntime}
                      address={identityReport.input}
                      explorerUrl={inputExplorerUrl}
                      copied={copiedKey === 'id-in'}
                      onCopy={() => void handleCopy('id-in', identityReport.input)}
                    >
                      {identityReport.nativeAddress &&
                        identityReport.nativeAddress !== identityReport.input && (
                          <span className="mono muted xsmall break-all">
                            Native home: {identityReport.nativeAddress}
                          </span>
                        )}
                    </AddressCard>
                    <AddressCard
                      label="Translated alias"
                      runtime={translatedRuntime}
                      address={identityReport.translatedAddress}
                      explorerUrl={translatedExplorerUrl}
                      copied={copiedKey === 'id-translated'}
                      onCopy={() =>
                        void handleCopy('id-translated', identityReport.translatedAddress ?? '')
                      }
                    />
                  </div>

                  {canMaterializeReported && (
                    <div className="callout">
                      <div className="stack-xs" style={{ minWidth: 0, flex: '1 1 260px' }}>
                        <strong className="strong">Next: materialize this alias on-chain</strong>
                        <span className="field-hint">
                          The EVM alias for <code className="break-all">{identityReport.input}</code>{' '}
                          has no code yet. Step 2 pre-fills the address and builds the{' '}
                          <code>0xbfe88b4b</code> transaction and CLI commands.
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => loadIntoMaterializer(identityReport.input)}
                      >
                        Continue to step 2
                        <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  )}

                  <details className="disclosure">
                    <summary>
                      <ChevronRight size={13} className="chev" aria-hidden="true" />
                      Horus 8.0 alias semantics &amp; Safe-CREATE2 note
                    </summary>
                    <div className="disclosure-body stack-sm small">
                      <span>{identityReport.aliasTypeNote}</span>
                      <span className="muted">
                        <strong className="strong">Horus 8.0 rule:</strong> Implicit{' '}
                        <code>tz1/tz2/tz3</code> accounts use Safe-CREATE2 derivation for
                        cross-chain recovery on Ethereum/Arbitrum/Base, while <code>KT1</code>{' '}
                        contracts retain Keccak-256 aliases. Safe Singleton Factory (
                        <code className="break-all">{SAFE_SINGLETON_FACTORY}</code>) intentionally
                        returns <code>0x</code> (0 bytes) on Previewnet because it is only a
                        deterministic cross-chain CREATE2 formula constant, not a deployed contract
                        on Tezos X.
                      </span>
                    </div>
                  </details>

                  <details className="disclosure">
                    <summary>
                      <ChevronRight size={13} className="chev" aria-hidden="true" />
                      Raw precompile return payloads (originOf / resolveAddress)
                    </summary>
                    <pre className="code-block disclosure-body">
                      {`originOf:       ${identityReport.rawOriginHex || '—'}\nresolveAddress: ${identityReport.rawResolveHex || '—'}\naliasCode:      ${identityReport.aliasCode ?? '—'}`}
                    </pre>
                  </details>
                </div>
              )}
            </div>
          </div>
        </TabPanel>
      )}

      {/* ===================== STEP 2 · MATERIALIZE ===================== */}
      {step === 'materialize' && (
        <TabPanel idPrefix={stepPrefix} id="materialize">
          <div className="card">
            <div className="card-header">
              <StepTitle
                n={2}
                title="Materialize the alias"
                hint={
                  <>
                    Deploy the Horus 8.0 alias via EVM <code>0xbfe88b4b</code> (wallet) or Michelson{' '}
                    <code>%materialize_alias</code> (CLI / SDK).
                  </>
                }
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setMatTzAddress(DEFAULT_FIXTURES.aliceTz1);
                  setMatPublicKey(DEFAULT_FIXTURES.alicePubKey);
                  setTxState({ phase: 'idle' });
                }}
              >
                Fill Alice fixture
              </button>
            </div>

            <div className="card-body stack">
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={`${uid}-mat-tz`} className="field-label">
                    <span>
                      Tezos implicit account <span className="muted">(tz1 / tz2 / tz3)</span>
                    </span>
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
                    aria-invalid={matIsTz4}
                  />
                  {matIsTz4 && (
                    <span role="alert" className="field-hint text-danger">
                      BLS <code>tz4</code> is unsupported — cannot materialize on Tezos X.
                    </span>
                  )}
                </div>

                <div className="field">
                  <label htmlFor={`${uid}-mat-pk`} className="field-label">
                    <span>
                      Public key <span className="muted">(edpk… / sppk… / p2pk…)</span>
                    </span>
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
                    Required on v0.11 — an empty key reverts with <code>Missing public key</code>.
                  </span>
                </div>
              </div>

              <div className="stack-sm">
                <span className="section-label">Choose a route</span>
                <TabList<MaterializeTab>
                  idPrefix={matPrefix}
                  ariaLabel="Alias materialization route"
                  value={materializeTab}
                  onChange={setMaterializeTab}
                  items={[
                    {
                      id: 'evm_precompile',
                      label: (
                        <>
                          <RuntimePill runtime="evm" small /> Precompile <code>0xbfe88b4b</code>
                        </>
                      ),
                    },
                    {
                      id: 'michelson_gateway',
                      label: (
                        <>
                          <RuntimePill runtime="michelson" small /> Gateway{' '}
                          <code>%materialize_alias</code>
                        </>
                      ),
                    },
                  ]}
                />
              </div>

              {materializeTab === 'evm_precompile' ? (
                <TabPanel idPrefix={matPrefix} id="evm_precompile" className="stack">
                  <div className="stack-sm">
                    <div className="code-head">
                      <span className="code-label">
                        Calldata
                        <span className="mono muted xsmall break-all">
                          materializeAlias(&quot;tezos&quot;, tzAddress, publicKey) →{' '}
                          {network.evm.precompile}
                        </span>
                      </span>
                      <CopyButton
                        label="Copy calldata"
                        copied={copiedKey === 'mat-calldata'}
                        disabled={!materializeCalldata}
                        onClick={() => void handleCopy('mat-calldata', materializeCalldata)}
                      />
                    </div>
                    <pre className="code-block" style={{ maxHeight: 120 }}>
                      {materializeCalldata ||
                        'Enter a valid tz1/tz2/tz3 address to preview 0xbfe88b4b calldata.'}
                    </pre>
                  </div>

                  <div className="card-inset stack-sm">
                    <div className="row-between">
                      <div className="stack-xs" style={{ minWidth: 0, flex: '1 1 260px' }}>
                        <span className="row" style={{ gap: 8 }}>
                          <strong className="strong small">Send on {network.label}</strong>
                          <WalletNeedPill need="required" />
                        </span>
                        {evmWallet.address ? (
                          <span className="field-hint break-all">
                            From <code>{evmWallet.address}</code> (
                            {evmWallet.providerName ?? 'EVM wallet'})
                            {evmWallet.chainId !== null &&
                              evmWallet.chainId !== network.evm.chainId && (
                                <span className="text-warn">
                                  {' '}
                                  · wallet is on chain {evmWallet.chainId}; NACBench will switch to{' '}
                                  {network.evm.chainId} before sending.
                                </span>
                              )}
                          </span>
                        ) : (
                          <span className="field-hint">
                            Connect an EIP-6963 / injected EVM wallet to broadcast. No wallet? Use
                            the Michelson gateway route with <code>octez-client</code> instead.
                          </span>
                        )}
                      </div>

                      <div className="row" style={{ gap: 6 }}>
                        {evmWallet.address ? (
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={txBusy || matIsTz4 || !matTzTrimmed}
                            onClick={() => void handleSendMaterializeEvm()}
                          >
                            {txBusy ? (
                              <Loader2 size={14} className="spin" aria-hidden="true" />
                            ) : (
                              <Send size={14} aria-hidden="true" />
                            )}
                            {txState.phase === 'switching'
                              ? 'Switching chain…'
                              : txState.phase === 'signing'
                                ? 'Confirm in wallet…'
                                : 'Send materializeAlias'}
                          </button>
                        ) : (
                          <>
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
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => void onConnectEvm()}
                            >
                              <Wallet size={14} aria-hidden="true" />
                              Connect wallet
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {evmWallet.address && (
                      <Progress ariaLabel="Materialize transaction progress" steps={txProgress} />
                    )}
                  </div>

                  {txState.phase === 'submitted' && txState.txHash && (
                    <div aria-live="polite" className="alert alert-ok" style={{ alignItems: 'center' }}>
                      <ShieldCheck size={15} aria-hidden="true" />
                      <span className="break-all" style={{ flex: 1 }}>
                        Broadcast tx <code>{txState.txHash}</code>
                      </span>
                      <a
                        href={`${network.evm.explorerUrl.replace(/\/$/, '')}/tx/${txState.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm"
                      >
                        Blockscout <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    </div>
                  )}

                  {txState.phase === 'error' && txState.error && (
                    <div role="alert" className="alert alert-danger">
                      <XCircle size={14} aria-hidden="true" />
                      <div className="stack-xs" style={{ minWidth: 0 }}>
                        <strong className="strong">Transaction rejected / failed</strong>
                        {txState.decodedSummary && <span>{txState.decodedSummary}</span>}
                        <code className="xsmall break-all muted">{txState.error}</code>
                      </div>
                    </div>
                  )}
                </TabPanel>
              ) : (
                <TabPanel idPrefix={matPrefix} id="michelson_gateway" className="stack">
                  <div className="stack-sm">
                    <div className="code-head">
                      <span className="code-label">
                        Parameter
                        <span className="mono muted xsmall">
                          pair string (pair string (option string))
                        </span>
                      </span>
                      <code className="muted xsmall break-all">
                        {network.michelson.evmGateway} %materialize_alias
                      </code>
                    </div>
                    <pre className="code-block">
                      {`Pair "tezos" (Pair "${matTzTrimmed || DEFAULT_FIXTURES.aliceTz1}" ${matPubTrimmed ? `(Some "${matPubTrimmed}")` : 'None'})`}
                    </pre>
                  </div>

                  <div className="stack-sm">
                    <div className="code-head">
                      <span className="code-label">
                        <Terminal size={13} aria-hidden="true" /> octez-client command
                      </span>
                      <CopyButton
                        primary
                        label="Copy command"
                        copied={copiedKey === 'octez-cli'}
                        onClick={() => void handleCopy('octez-cli', octezClientCmd)}
                      />
                    </div>
                    <pre className="code-block pre">{octezClientCmd}</pre>
                  </div>

                  <div className="stack-sm">
                    <div className="code-head">
                      <span className="code-label">
                        <Layers size={13} aria-hidden="true" /> @tezos-x/octez.js v25.1 snippet
                      </span>
                      <CopyButton
                        label="Copy snippet"
                        copied={copiedKey === 'octez-js-mat'}
                        onClick={() => void handleCopy('octez-js-mat', octezJsSnippet)}
                      />
                    </div>
                    <pre className="code-block pre" style={{ maxHeight: 260 }}>
                      {octezJsSnippet}
                    </pre>
                  </div>
                </TabPanel>
              )}

              <div className="row-between">
                <span className="field-hint">
                  After the tx lands, re-run step 1 to confirm the alias now has code.
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setStep('lookup')}>
                  Back to lookup
                </button>
              </div>
            </div>
          </div>
        </TabPanel>
      )}

      {/* ===================== STEP 3 · STATE DIFF ===================== */}
      {step === 'diff' && (
        <TabPanel idPrefix={stepPrefix} id="diff">
          <div className="card">
            <div className="card-header">
              <StepTitle
                n={3}
                title="Block-pinned state diff"
                hint={
                  <>
                    Freeze EVM + Michelson state at the same height (
                    <code>EVM block N == Michelson level N</code>), act, then capture again.
                  </>
                }
              />
              {health && (
                <span className={`pill ${health.synced ? 'pill-ok' : 'pill-warn'}`}>
                  {health.synced && health.evmHead !== null
                    ? `Synced 1:1 · #${health.evmHead.toLocaleString()}`
                    : `EVM #${health.evmHead ?? '?'} / Mich #${health.michelsonLevel ?? '?'}`}
                </span>
              )}
            </div>

            <div className="card-body stack">
              {canaryBigMapId !== null && (
                <div className="callout">
                  <div className="stack-xs" style={{ minWidth: 0, flex: '1 1 260px' }}>
                    <strong className="strong">Quick start: live Canary pair</strong>
                    <span className="field-hint">
                      Loads the deployed NacCanaryEvm + nac_canary pair and captures snapshot A
                      with <code>big_map #{canaryBigMapId}</code>, key <code>1</code>.
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`btn ${snapshotA ? '' : 'btn-primary'}`}
                    disabled={capturingSlot !== null}
                    onClick={() => {
                      setDiffEvmAddr(canaryAddrs.evmCanary);
                      setDiffMichAddr(canaryAddrs.michelsonCanary);
                      setDiffBigMapId(canaryBigMapId);
                      setDiffBigMapKeyType('nat');
                      setDiffBigMapKey('1');
                      setDiffPinnedBlock('');
                      setProbeOpen(true);
                      void handleCaptureSnapshot('A', {
                        evmAddress: canaryAddrs.evmCanary,
                        michelsonAddress: canaryAddrs.michelsonCanary,
                        bigMapId: canaryBigMapId,
                        bigMapKeyType: 'nat',
                        bigMapKey: '1',
                        pinnedBlock: '',
                      });
                    }}
                  >
                    {capturingSlot === 'A' ? (
                      <Loader2 size={14} className="spin" aria-hidden="true" />
                    ) : (
                      <Camera size={14} aria-hidden="true" />
                    )}
                    Load Live Canary (big_map #{canaryBigMapId}, key 1)
                  </button>
                </div>
              )}

              <div className="stack-sm">
                <div className="chip-row" role="group" aria-label="Address presets">
                  <span className="chip-row-label">Or fill</span>
                  <button
                    type="button"
                    className="chip"
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
                    className="chip"
                    onClick={() => {
                      setDiffEvmAddr('0x3c0EE21DA093b0AA44c590BA0BB1883ef8080137');
                      setDiffMichAddr(DEFAULT_FIXTURES.aliceTz1);
                      setDiffBigMapId('');
                    }}
                  >
                    Alice dual-runtime
                  </button>
                </div>

                <div className="grid-2">
                  <div className="field">
                    <label htmlFor={`${uid}-diff-evm`} className="field-label">
                      <span>
                        EVM address <span className="muted">(optional)</span>
                      </span>
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
                      <span>
                        Michelson contract / account <span className="muted">(optional)</span>
                      </span>
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
              </div>

              <details
                className="disclosure"
                open={probeOpen}
                onToggle={(e) => setProbeOpen((e.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>
                  <ChevronRight size={13} className="chev" aria-hidden="true" />
                  Big-map key probe &amp; block pin
                  <span className="muted xsmall">(optional · zero-indexer BLAKE2b expr…)</span>
                </summary>
                <div className="disclosure-body stack-sm">
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: 10,
                    }}
                  >
                    <div className="field">
                      <label htmlFor={`${uid}-bm-id`} className="field-label">
                        Big-map ID
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
                        Key type
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
                    <div className="field field-span-2">
                      <label htmlFor={`${uid}-bm-key`} className="field-label">
                        Key value
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
                        Pinned block
                      </label>
                      <input
                        id={`${uid}-pin-blk`}
                        className="input mono"
                        inputMode="numeric"
                        value={diffPinnedBlock}
                        onChange={(e) => setDiffPinnedBlock(e.target.value)}
                        placeholder="Latest"
                      />
                    </div>
                  </div>

                  {liveBigMapHash && (
                    <output aria-live="polite">
                      {'error' in liveBigMapHash ? (
                        <span className="alert alert-danger">
                          <XCircle size={14} aria-hidden="true" />
                          <span>Key hash error: {liveBigMapHash.error}</span>
                        </span>
                      ) : (
                        <span className="output-line" style={{ alignItems: 'center' }}>
                          <Database size={13} aria-hidden="true" />
                          <span>BLAKE2b-256</span>
                          <code className="strong break-all">{liveBigMapHash.exprHash}</code>
                          <span className="mono xsmall break-all">
                            (packed: {liveBigMapHash.packedHex})
                          </span>
                          <CopyButton
                            label="Copy expr"
                            copied={copiedKey === 'bm-expr'}
                            onClick={() => void handleCopy('bm-expr', liveBigMapHash.exprHash)}
                          />
                        </span>
                      )}
                    </output>
                  )}
                </div>
              </details>

              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className={`btn ${!snapshotA ? 'btn-primary' : ''}`}
                  disabled={capturingSlot !== null}
                  onClick={() => void handleCaptureSnapshot('A')}
                >
                  {capturingSlot === 'A' ? (
                    <Loader2 size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <Camera size={14} aria-hidden="true" />
                  )}
                  Capture A (before)
                </button>
                <button
                  type="button"
                  className={`btn ${snapshotA && !snapshotB ? 'btn-primary' : ''}`}
                  disabled={capturingSlot !== null}
                  onClick={() => void handleCaptureSnapshot('B')}
                >
                  {capturingSlot === 'B' ? (
                    <Loader2 size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <Camera size={14} aria-hidden="true" />
                  )}
                  Capture B (after)
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!snapshotA && !snapshotB}
                  onClick={() => {
                    setSnapshotA(snapshotB);
                    setSnapshotB(snapshotA);
                  }}
                >
                  <Repeat size={13} aria-hidden="true" />
                  Swap
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
                  <XCircle size={15} aria-hidden="true" />
                  <span>
                    <strong>Snapshot capture error:</strong> {diffError}
                  </span>
                </div>
              )}

              <div className="grid-2" aria-live="polite">
                <SnapshotCard
                  snapshot={snapshotA}
                  slotLabel="A · Before"
                  hint="Capture A first to freeze both runtimes at the current block."
                />
                <SnapshotCard
                  snapshot={snapshotB}
                  slotLabel="B · After"
                  hint="Act on-chain (e.g. run a Canary probe), then capture B to compute the diff."
                />
              </div>

              {computedDiff && (
                <div aria-live="polite" className="card-inset stack-sm">
                  <div className="row-between">
                    <strong className="strong row" style={{ gap: 6 }}>
                      <GitCompare size={15} aria-hidden="true" />
                      State diff A → B
                    </strong>
                    <span className="mono muted xsmall">
                      #{computedDiff.before.blockNumber.toLocaleString()} → #
                      {computedDiff.after.blockNumber.toLocaleString()}
                    </span>
                  </div>
                  <div className="kv-grid">
                    <div className="kv-item">
                      <span className="kv-label">Δ block</span>
                      <span className="kv-value">
                        {computedDiff.blockDelta >= 0
                          ? `+${computedDiff.blockDelta}`
                          : String(computedDiff.blockDelta)}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label row" style={{ gap: 6 }}>
                        Δ balance <RuntimePill runtime="evm" small />
                      </span>
                      <span className="kv-value">
                        {formatSignedBigInt(computedDiff.evmBalanceDeltaWei, 'wei')}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label row" style={{ gap: 6 }}>
                        Δ balance <RuntimePill runtime="michelson" small />
                      </span>
                      <span className="kv-value">
                        {formatSignedBigInt(computedDiff.michelsonBalanceDeltaMutez, 'mutez')}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Storage</span>
                      <span className="kv-value">
                        {computedDiff.michelsonStorageChanged ? 'Mutated' : 'Unchanged'}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Big-map value</span>
                      <span className="kv-value">
                        {computedDiff.bigMapValueChanged ? 'Mutated' : 'Unchanged'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabPanel>
      )}
    </section>
  );
}
