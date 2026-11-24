export type NetworkId = 'previewnet' | 'shadownet' | 'mainnet';
export type ModuleTab = 'codec' | 'alias' | 'canary';

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  badge: string;
  evm: {
    rpcUrl: string;
    chainId: number;
    explorerUrl: string;
    blockscoutApiUrl?: string;
    precompile: string;
    nacRecommendedGas: number;
  };
  michelson: {
    rpcUrl: string;
    chainId: string;
    explorerUrl: string;
    evmGateway: string;
    hardGasLimitPerOperation: number;
  };
  notes: string;
}

export interface GatewayHealth {
  checkedAt: string;
  evmOk: boolean;
  michelsonOk: boolean;
  evmHead: number | null;
  michelsonLevel: number | null;
  synced: boolean;
  precompileZeroCode: boolean | null;
  gatewayEntrypoints: string[];
  gatewayViews: string[];
  kernelVersion: string | null;
  hardGasLimit: number | null;
  error?: string;
}

export interface EvmWalletState {
  address: string | null;
  chainId: number | null;
  providerName: string | null;
  providers: { rdns: string; name: string; icon?: string }[];
}

export interface TezosWalletState {
  address: string | null;
  publicKey: string | null;
  label: string | null;
}

export interface IdentityReport {
  input: string;
  inferredRuntime: 0 | 1;
  kind: number;
  kindLabel: string;
  homeRuntime: number | null;
  homeRuntimeLabel: string;
  nativeAddress: string | null;
  classified: boolean;
  resolution: number;
  resolutionLabel: string;
  translatedAddress: string | null;
  aliasCode: string | null;
  isMaterialized: boolean | null;
  aliasTypeNote: string;
  rawOriginHex: string;
  rawResolveHex: string;
}

export interface DualRuntimeSnapshot {
  label: string;
  capturedAt: string;
  blockNumber: number;
  michelsonLevel: number;
  blockSynced: boolean;
  evmAddress?: string;
  evmBalanceWei?: string;
  evmCodeBytes?: number;
  michelsonAddress?: string;
  michelsonBalanceMutez?: string;
  michelsonStorage?: unknown;
  bigMapId?: number;
  bigMapKey?: string;
  bigMapKeyHash?: string;
  bigMapValue?: unknown;
}

export interface SnapshotDiff {
  blockDelta: number;
  evmBalanceDeltaWei: string | null;
  michelsonBalanceDeltaMutez: string | null;
  michelsonStorageChanged: boolean;
  bigMapValueChanged: boolean;
  before: DualRuntimeSnapshot;
  after: DualRuntimeSnapshot;
}

export type CodecPresetId =
  | 'unit'
  | 'string'
  | 'nat'
  | 'int'
  | 'bytes'
  | 'address'
  | 'pair_addr_mutez'
  | 'option_some'
  | 'or_left'
  | 'canary_record_ping'
  | 'canary_echo_callback'
  | 'canary_force_fail'
  | 'canary_burn_gas'
  | 'canary_get_state_digest';

export interface CodecInput {
  preset: CodecPresetId;
  entrypoint: string;
  kt1Target: string;
  evmTarget: string;
  stringVal: string;
  natVal: string;
  intVal: string;
  bytesHex: string;
  addressVal: string;
  mutezVal: string;
  valueWei: string;
  evmGasCap: string;
  evmArgs?: string[];
  callDirection:
    | 'evm_to_michelson'
    | 'michelson_to_evm'
    | 'evm_view_michelson'
    | 'michelson_staticcall_evm';
}

export interface GuardrailNote {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  triggered: boolean;
}

export interface CodecResult {
  ok: boolean;
  error?: string;
  michelineHex: string;
  michelineByteLength: number;
  decodedExpression: unknown;
  gatewayCalldataHex: string;
  abiSelector: string;
  mutezAligned: boolean;
  dustRemainderWei: string;
  guardrails: GuardrailNote[];
}

export interface GeneratedSnippets {
  solidity: string;
  octezJs: string;
  smartpy: string;
  cheatsheet: string;
}

export interface CanaryProofTxs {
  verifiedAt?: string;
  probeWrite?: string;
  probeRoundTrip?: string;
  probeRollback?: string;
  probeOogCatch?: string;
  probeOogPropagate?: string;
}

export interface CanaryAddresses {
  evmCanary: string;
  michelsonCanary: string;
  kt1Alias?: string;
  pingsBigMapId?: number;
  proofTxs?: CanaryProofTxs;
  deployedAt?: string;
  source: 'manifest' | 'custom' | 'unconfigured';
}

export interface CanaryLiveState {
  blockNumber: number;
  michelsonLevel: number;
  blockSynced: boolean;
  evm: {
    writeCount: string;
    roundTripCount: string;
    rollbackSentinel: string;
    lastCallbackNonce: string;
    lastCallbackSender: string;
    lastMichelsonCallbackCount: string;
    lastOogOk: boolean;
    lastOogGasUsed: string;
    lastOogReturnData: string;
    authorizedKt1Alias: string;
    owner: string;
  } | null;
  michelson: {
    pingCount: string;
    callbackCount: string;
    lastNote: string;
    lastSender: string;
    lastSource: string;
    pairedEvmCanary: string;
    admin: string;
  } | null;
  error?: string;
}

export interface TraceFrame {
  depth: number;
  type: string;
  from: string;
  to: string;
  valueWei: string;
  gas: string;
  gasUsed: string;
  inputSelector: string;
  isGatewayPrecompile: boolean;
  error?: string;
  output?: string;
  decodedRevert?: { kind: string; status?: number; summary: string; raw: string };
}

export interface TxInspectionReport {
  txHash: string;
  networkId: NetworkId;
  receiptFound: boolean;
  status: 'success' | 'reverted' | 'pending' | 'unknown';
  blockNumber: number | null;
  from: string | null;
  to: string | null;
  gasUsed: string | null;
  traceSource: 'callTracer' | 'blockscout_fallback' | 'receipt_only';
  frames: TraceFrame[];
  gatewayHops: number;
  decodedTopRevert: { kind: string; status?: number; summary: string; raw: string } | null;
  nactraceUrl: string;
  blockscoutUrl: string;
  tzktUrl: string;
  rawTraceError?: string;
}

export type CanaryProbeKind = 'write' | 'roundTrip' | 'view' | 'rollback' | 'oog';
