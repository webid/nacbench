/// <reference types="vite/client" />
import {
  WEI_PER_MUTEZ,
  base58CheckEncode,
  blake2b256,
  concatBytes,
  decodeDynamicBytesHex,
  decodeRawMichelineHex,
  decodeRevertPayload,
  decodeWordBigInt,
  encodeFunctionCall,
  hexToBytes,
  isTz4Address,
  isValidEvmAddress,
  isValidTezosXAddress,
  selectorOf,
} from './codec';
import { runMichelsonScriptView } from './rpc';
import type {
  CanaryAddresses,
  CanaryLiveState,
  NetworkConfig,
  NetworkId,
  TraceFrame,
  TxInspectionReport,
} from './types';
import { switchEvmChain, type Eip1193Provider } from './wallets';

// ---------------------------------------------------------------------------
// Verified M1 NacCanaryEvm.sol Selectors
// ---------------------------------------------------------------------------
export const CANARY_SELECTORS = {
  probeWrite: '0xa2b9cf04',
  probeRoundTrip: '0x3afa6469',
  onMichelsonCallback: '0x0464372c',
  probeView: '0x00aa2ecb',
  probeRollback: '0x6bab2b6f',
  probeOog: '0xccc96ba6',
  echoView: '0xf50f1a0e',
  setAuthorizedKt1Alias: '0xdd43e080',
} as const;

export const KNOWN_SELECTOR_NAMES: Record<string, string> = {
  [CANARY_SELECTORS.probeWrite]: 'probeWrite',
  [CANARY_SELECTORS.probeRoundTrip]: 'probeRoundTrip',
  [CANARY_SELECTORS.onMichelsonCallback]: 'onMichelsonCallback',
  [CANARY_SELECTORS.probeView]: 'probeView',
  [CANARY_SELECTORS.probeRollback]: 'probeRollback',
  [CANARY_SELECTORS.probeOog]: 'probeOog',
  [CANARY_SELECTORS.echoView]: 'echoView',
  [CANARY_SELECTORS.setAuthorizedKt1Alias]: 'setAuthorizedKt1Alias',
  [selectorOf('callMichelson(string,string,bytes)')]: 'callMichelson',
  [selectorOf('callMichelsonView(string,string,bytes)')]: 'callMichelsonView',
  [selectorOf('materializeAlias(string,string,string)')]: 'materializeAlias',
  [selectorOf('originOf(string,uint8)')]: 'originOf',
  [selectorOf('resolveAddress(string,uint8,uint8)')]: 'resolveAddress',
};

export function resolveKnownSelectorName(selector?: string): string | null {
  if (!selector) return null;
  return KNOWN_SELECTOR_NAMES[selector.trim().toLowerCase()] ?? null;
}

export const PREVIEWNET_SAMPLE_TX_HASH =
  '0x4139780ecc401d3282c7bdbf7b3279207de978d3aaa7580ceea104deee0a4d29';

// ---------------------------------------------------------------------------
// Manifest & Custom LocalStorage Address Management
// ---------------------------------------------------------------------------
interface DeploymentManifestShape {
  deployedAt?: string;
  contracts?: {
    nacCanaryEvm?: string;
    nacCanaryKt1?: string;
    nacCanaryKt1EvmAlias?: string;
    pingsBigMapId?: number;
  };
  proofTxs?: {
    verifiedAt?: string;
    probeWrite?: string;
    probeRoundTrip?: string;
    probeRollback?: string;
    probeOogCatch?: string;
    probeOogPropagate?: string;
  };
}

// Safely bundle any deployment manifests present under config/deployments/*.json (returns {} if none exist)
const manifestModules = import.meta.glob<DeploymentManifestShape>(
  '../../../../config/deployments/*.json',
  { eager: true, import: 'default' },
);

const STORAGE_KEY_PREFIX = 'nacbench:canary-addresses:';

function safeGetStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore storage errors in restricted contexts
  }
  return null;
}

export function saveCustomCanaryAddresses(
  networkId: NetworkId,
  addrs: { evmCanary: string; michelsonCanary: string; kt1Alias?: string },
): CanaryAddresses {
  const normalized: CanaryAddresses = {
    evmCanary: addrs.evmCanary.trim(),
    michelsonCanary: addrs.michelsonCanary.trim(),
    kt1Alias: addrs.kt1Alias?.trim() || undefined,
    source: 'custom',
  };
  const storage = safeGetStorage();
  if (storage) {
    storage.setItem(`${STORAGE_KEY_PREFIX}${networkId}`, JSON.stringify(normalized));
  }
  return normalized;
}

export function clearCustomCanaryAddresses(networkId: NetworkId): CanaryAddresses {
  const storage = safeGetStorage();
  if (storage) {
    storage.removeItem(`${STORAGE_KEY_PREFIX}${networkId}`);
  }
  return loadDefaultCanaryAddresses(networkId);
}

export function loadDefaultCanaryAddresses(networkId: NetworkId): CanaryAddresses {
  const storage = safeGetStorage();
  if (storage) {
    const raw = storage.getItem(`${STORAGE_KEY_PREFIX}${networkId}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<CanaryAddresses>;
        if (parsed.evmCanary || parsed.michelsonCanary) {
          return {
            evmCanary: (parsed.evmCanary ?? '').trim(),
            michelsonCanary: (parsed.michelsonCanary ?? '').trim(),
            kt1Alias: parsed.kt1Alias?.trim() || undefined,
            deployedAt: parsed.deployedAt,
            source: 'custom',
          };
        }
      } catch {
        // ignore corrupt storage entry
      }
    }
  }

  for (const [path, manifest] of Object.entries(manifestModules)) {
    if (path.endsWith(`/${networkId}.json`) && manifest?.contracts) {
      const evmCanary = (manifest.contracts.nacCanaryEvm ?? '').trim();
      const michelsonCanary = (manifest.contracts.nacCanaryKt1 ?? '').trim();
      if (evmCanary && michelsonCanary) {
        return {
          evmCanary,
          michelsonCanary,
          kt1Alias: manifest.contracts.nacCanaryKt1EvmAlias?.trim() || undefined,
          pingsBigMapId: manifest.contracts.pingsBigMapId,
          proofTxs: manifest.proofTxs,
          deployedAt: manifest.deployedAt,
          source: 'manifest',
        };
      }
    }
  }

  return {
    evmCanary: '',
    michelsonCanary: '',
    source: 'unconfigured',
  };
}

// ---------------------------------------------------------------------------
// External Deep-Link Builders (Complementing Migl992/nactrace)
// ---------------------------------------------------------------------------
const TEZOS_OP_HASH_PREFIX = new Uint8Array([5, 116]);
const MICHELSON_MIRROR_DOMAIN = new TextEncoder().encode('michelson');

/**
 * Compute the deterministic Tezos mirrored operation hash (`o...`, 51 chars) for a cross-runtime
 * EVM tx hash (post-Aug-13 Etherlink/Previewnet recipe verified in nactrace FINDINGS.md):
 *   base58Check([5, 116] || blake2b256(utf8("michelson") || evmTxHash32Bytes))
 */
export function computeMirroredMichelsonOpHash(evmTxHash: string): string | null {
  const clean = evmTxHash.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  const txBytes = hexToBytes(clean);
  const digest = blake2b256(concatBytes(MICHELSON_MIRROR_DOMAIN, txBytes));
  return base58CheckEncode(concatBytes(TEZOS_OP_HASH_PREFIX, digest));
}

export function buildNactraceUrl(networkId: NetworkId, txOrOpHash: string): string {
  return `https://migl992.github.io/nactrace/?hash=${encodeURIComponent(txOrOpHash.trim())}&network=${networkId}`;
}

// ---------------------------------------------------------------------------
// NacCanaryEvm ABI Calldata Encoders
// ---------------------------------------------------------------------------
export function encodeProbeWriteCalldata(kt1: string, note: string, gasCap: bigint): string {
  return encodeFunctionCall('probeWrite(string,string,uint256)', [
    { type: 'string', value: kt1.trim() },
    { type: 'string', value: note },
    { type: 'uint256', value: gasCap },
  ]);
}

export function encodeProbeRoundTripCalldata(kt1: string, nonce: bigint, gasCap: bigint): string {
  return encodeFunctionCall('probeRoundTrip(string,uint256,uint256)', [
    { type: 'string', value: kt1.trim() },
    { type: 'uint256', value: nonce },
    { type: 'uint256', value: gasCap },
  ]);
}

export function encodeProbeViewCalldata(kt1: string, x: bigint): string {
  return encodeFunctionCall('probeView(string,uint256)', [
    { type: 'string', value: kt1.trim() },
    { type: 'uint256', value: x },
  ]);
}

export function encodeProbeRollbackCalldata(kt1: string, reason: string, gasCap: bigint): string {
  return encodeFunctionCall('probeRollback(string,string,uint256)', [
    { type: 'string', value: kt1.trim() },
    { type: 'string', value: reason },
    { type: 'uint256', value: gasCap },
  ]);
}

export function encodeProbeOogCalldata(
  kt1: string,
  iterations: bigint,
  gasCap: bigint,
  catchRevert: boolean,
): string {
  return encodeFunctionCall('probeOog(string,uint256,uint256,bool)', [
    { type: 'string', value: kt1.trim() },
    { type: 'uint256', value: iterations },
    { type: 'uint256', value: gasCap },
    { type: 'bool', value: catchRevert },
  ]);
}

// ---------------------------------------------------------------------------
// Low-Level JSON-RPC & Michelson Fetch Helpers
// ---------------------------------------------------------------------------
let canaryRpcId = 1000;

interface JsonRpcRes<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  errorData?: string;
}

async function evmRpcCall<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 15_000,
  retries = 1,
): Promise<JsonRpcRes<T>> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: canaryRpcId++, method, params }),
        signal: controller.signal,
      });
      if ((res.status === 503 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 180)}` };
      }
      const json = JSON.parse(text) as {
        result?: T;
        error?: { message?: string; data?: string };
      };
      if (json.error) {
        return {
          ok: false,
          error: json.error.message ?? JSON.stringify(json.error),
          errorData: typeof json.error.data === 'string' ? json.error.data : undefined,
        };
      }
      return { ok: true, result: json.result };
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: 'RPC call failed after retry' };
}

/**
 * Send multiple JSON-RPC 2.0 requests in a single HTTP POST batch to avoid ingress 503 rate limits.
 * Retries once on 503/429 and falls back to small chunked individual calls if batching is unsupported.
 */
async function evmRpcBatch<T = unknown>(
  rpcUrl: string,
  calls: Array<{ method: string; params: unknown[] }>,
  timeoutMs = 15_000,
  retries = 1,
): Promise<Array<JsonRpcRes<T>>> {
  if (calls.length === 0) return [];
  const payload = calls.map((c) => ({
    jsonrpc: '2.0' as const,
    id: canaryRpcId++,
    method: c.method,
    params: c.params,
  }));

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if ((res.status === 503 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        break;
      }
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        const byId = new Map<
          number,
          { result?: T; error?: { message?: string; data?: string } }
        >();
        for (const item of parsed) {
          if (item && typeof item === 'object' && 'id' in item) {
            const rec = item as {
              id: number;
              result?: T;
              error?: { message?: string; data?: string };
            };
            byId.set(rec.id, rec);
          }
        }
        return payload.map((req) => {
          const entry = byId.get(req.id);
          if (!entry) return { ok: false, error: 'Missing batch response entry' };
          if (entry.error) {
            return {
              ok: false,
              error: entry.error.message ?? JSON.stringify(entry.error),
              errorData: typeof entry.error.data === 'string' ? entry.error.data : undefined,
            };
          }
          return { ok: true, result: entry.result };
        });
      }
      break;
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  // Fallback for RPCs that do not support JSON-RPC batching: run in small chunks of 3
  const out: Array<JsonRpcRes<T>> = [];
  for (let i = 0; i < calls.length; i += 3) {
    const slice = calls.slice(i, i + 3);
    const chunkRes = await Promise.all(
      slice.map((c) => evmRpcCall<T>(rpcUrl, c.method, c.params, timeoutMs, retries)),
    );
    out.push(...chunkRes);
  }
  return out;
}

async function httpGetJson<T = unknown>(
  url: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 240)}` };
    }
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function parseHexToDecString(hex?: string | null): string {
  if (!hex || hex === '0x') return '0';
  try {
    return BigInt(hex).toString();
  } catch {
    return '0';
  }
}

function decodeUint256Result(rawHex?: string): string {
  if (!rawHex || rawHex === '0x') return '0';
  const clean = rawHex.replace(/^0x/i, '');
  const word = decodeWordBigInt(clean, 0);
  return word !== null ? word.toString() : '0';
}

function decodeBoolResult(rawHex?: string): boolean {
  if (!rawHex || rawHex === '0x') return false;
  const clean = rawHex.replace(/^0x/i, '');
  const word = decodeWordBigInt(clean, 0);
  return word !== null && word !== 0n;
}

function decodeAddressResult(rawHex?: string): string {
  if (!rawHex || rawHex === '0x') return '0x0000000000000000000000000000000000000000';
  const clean = rawHex.replace(/^0x/i, '');
  if (clean.length < 64) return '0x0000000000000000000000000000000000000000';
  return '0x' + clean.slice(24, 64).toLowerCase();
}

function decodeBytesResult(rawHex?: string): string {
  if (!rawHex || rawHex === '0x') return '0x';
  const clean = rawHex.replace(/^0x/i, '');
  const offset = decodeWordBigInt(clean, 0);
  if (offset === null) return rawHex;
  return decodeDynamicBytesHex(clean, offset) ?? rawHex;
}

/**
 * Unwrap live `probeView` return bytes: `0xff00…0007` `callMichelsonView` returns ABI-encoded
 * `(bytes)` and `NacCanaryEvm.probeView` returns `bytes memory` again, yielding double ABI-encoded
 * bytes (`abi.encode(abi.encode(rawMicheline))`). Unwraps outer bytes, and if the inner payload
 * itself begins with ABI dynamic-bytes offset `0x20` (>= 64 bytes), unwraps once more.
 */
export function unwrapProbeViewMichelineBytes(rawReturnHex: string): string {
  const once = decodeBytesResult(rawReturnHex);
  const clean = once.replace(/^0x/i, '').toLowerCase();
  if (
    clean.length >= 128 &&
    clean.startsWith('0000000000000000000000000000000000000000000000000000000000000020')
  ) {
    const twice = decodeDynamicBytesHex(clean, 32n);
    if (twice && twice !== '0x') {
      return twice;
    }
  }
  return once;
}

// Flatten a right-comb Michelson Pair tree (supports both nested 2-arg Pairs and flat N-arg Pairs)
function flattenRightCombPair(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [node];
  const rec = node as { prim?: string; args?: unknown[] };
  if (rec.prim !== 'Pair' || !Array.isArray(rec.args) || rec.args.length === 0) {
    return [node];
  }
  const out: unknown[] = [];
  for (let i = 0; i < rec.args.length; i++) {
    const arg = rec.args[i];
    if (i === rec.args.length - 1) {
      out.push(...flattenRightCombPair(arg));
    } else {
      out.push(arg);
    }
  }
  return out;
}

function extractMichelineScalar(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const rec = node as { string?: string; int?: string; bytes?: string };
  if (typeof rec.string === 'string') return rec.string;
  if (typeof rec.int === 'string') return rec.int;
  if (typeof rec.bytes === 'string') return `0x${rec.bytes}`;
  return '';
}

const TEZOS_ADDR_PREFIX = {
  tz1: new Uint8Array([6, 161, 159]),
  tz2: new Uint8Array([6, 161, 161]),
  tz3: new Uint8Array([6, 161, 164]),
  KT1: new Uint8Array([2, 90, 121]),
} as const;

/**
 * Decode optimized 22-byte Michelson address bytes (`{"bytes": "0000..."}` or `{"bytes": "01...00"}`)
 * returned by Previewnet Michelson RPC `/storage` into canonical Base58Check (`tz1/2/3`, `KT1`).
 */
export function decodeMichelsonAddressBytes(hex: string): string {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length < 44 || clean.length % 2 !== 0) {
    return hex.startsWith('0x') ? hex : `0x${clean}`;
  }
  const bytes = hexToBytes(clean);
  if (bytes.length === 22 && bytes[0] === 0x00) {
    const hash20 = bytes.subarray(2, 22);
    if (bytes[1] === 0x00) return base58CheckEncode(concatBytes(TEZOS_ADDR_PREFIX.tz1, hash20));
    if (bytes[1] === 0x01) return base58CheckEncode(concatBytes(TEZOS_ADDR_PREFIX.tz2, hash20));
    if (bytes[1] === 0x02) return base58CheckEncode(concatBytes(TEZOS_ADDR_PREFIX.tz3, hash20));
  }
  if (bytes.length >= 22 && bytes[0] === 0x01 && bytes[21] === 0x00) {
    const kt1 = base58CheckEncode(concatBytes(TEZOS_ADDR_PREFIX.KT1, bytes.subarray(1, 21)));
    if (bytes.length === 22) return kt1;
    const ep = new TextDecoder().decode(bytes.subarray(22));
    return ep ? `${kt1}%${ep}` : kt1;
  }
  return hex.startsWith('0x') ? hex : `0x${clean}`;
}

function extractMichelineAddress(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const rec = node as { string?: string; bytes?: string };
  if (typeof rec.string === 'string') return rec.string;
  if (typeof rec.bytes === 'string') return decodeMichelsonAddressBytes(rec.bytes);
  return '';
}

/**
 * Parse the 9-field alphabetical right-comb storage of `nac_canary.py`:
 * (admin, authorized_evm_gateway, callback_count, last_note, last_sender, last_source, paired_evm_canary, ping_count, pings)
 */
export function parseNacCanaryMichelsonStorage(storage: unknown): CanaryLiveState['michelson'] {
  const fields = flattenRightCombPair(storage);
  if (fields.length < 8) return null;
  return {
    admin: extractMichelineAddress(fields[0]),
    callbackCount: extractMichelineScalar(fields[2]) || '0',
    lastNote: extractMichelineScalar(fields[3]),
    lastSender: extractMichelineAddress(fields[4]),
    lastSource: extractMichelineAddress(fields[5]),
    pairedEvmCanary: extractMichelineScalar(fields[6]),
    pingCount: extractMichelineScalar(fields[7]) || '0',
  };
}

// ---------------------------------------------------------------------------
// Live Pinned Dual-Runtime Canary State Reader
// ---------------------------------------------------------------------------
const EVM_GETTER_SIGS = [
  'writeCount()',
  'roundTripCount()',
  'rollbackSentinel()',
  'lastCallbackNonce()',
  'lastCallbackSender()',
  'lastMichelsonCallbackCount()',
  'lastOogOk()',
  'lastOogGasUsed()',
  'lastOogReturnData()',
  'authorizedKt1Alias()',
  'owner()',
] as const;

export async function readCanaryLiveState(
  network: NetworkConfig,
  addrs: CanaryAddresses,
): Promise<CanaryLiveState> {
  const headRes = await evmRpcCall<string>(network.evm.rpcUrl, 'eth_blockNumber');
  if (!headRes.ok || typeof headRes.result !== 'string') {
    return {
      blockNumber: 0,
      michelsonLevel: -1,
      blockSynced: false,
      evm: null,
      michelson: null,
      error: `Failed to fetch EVM head block: ${headRes.error ?? 'unknown error'}`,
    };
  }

  const blockNumber = parseInt(headRes.result, 16);
  const blockHex = '0x' + blockNumber.toString(16);

  const hasEvm = isValidEvmAddress(addrs.evmCanary);
  const hasMich = isValidTezosXAddress(addrs.michelsonCanary) && addrs.michelsonCanary.startsWith('KT1');

  const evmCallsPromise = hasEvm
    ? evmRpcBatch<string>(
        network.evm.rpcUrl,
        EVM_GETTER_SIGS.map((sig) => ({
          method: 'eth_call',
          params: [{ to: addrs.evmCanary, data: selectorOf(sig) }, blockHex],
        })),
      )
    : Promise.resolve(null);

  const [mHeaderRes, mStorageRes, evmResults] = await Promise.all([
    httpGetJson<{ level?: number }>(
      `${network.michelson.rpcUrl}/chains/main/blocks/${blockNumber}/header`,
    ),
    hasMich
      ? httpGetJson<unknown>(
          `${network.michelson.rpcUrl}/chains/main/blocks/${blockNumber}/context/contracts/${addrs.michelsonCanary}/storage`,
        )
      : Promise.resolve({ ok: false, data: undefined, error: undefined }),
    evmCallsPromise,
  ]);

  const michelsonLevel =
    mHeaderRes.ok && typeof mHeaderRes.data?.level === 'number' ? mHeaderRes.data.level : -1;
  const blockSynced = michelsonLevel === blockNumber;

  let evmState: CanaryLiveState['evm'] = null;
  const errors: string[] = [];

  if (evmResults) {
    const anyOk = evmResults.some((r) => r.ok && r.result && r.result !== '0x');
    if (anyOk) {
      evmState = {
        writeCount: decodeUint256Result(evmResults[0].result),
        roundTripCount: decodeUint256Result(evmResults[1].result),
        rollbackSentinel: decodeUint256Result(evmResults[2].result),
        lastCallbackNonce: decodeUint256Result(evmResults[3].result),
        lastCallbackSender: decodeAddressResult(evmResults[4].result),
        lastMichelsonCallbackCount: decodeUint256Result(evmResults[5].result),
        lastOogOk: decodeBoolResult(evmResults[6].result),
        lastOogGasUsed: decodeUint256Result(evmResults[7].result),
        lastOogReturnData: decodeBytesResult(evmResults[8].result),
        authorizedKt1Alias: decodeAddressResult(evmResults[9].result),
        owner: decodeAddressResult(evmResults[10].result),
      };
    } else {
      const firstErr = evmResults.find((r) => !r.ok)?.error;
      errors.push(`EVM canary getters failed: ${firstErr ?? 'empty 0x response'}`);
    }
  }

  let michelsonState: CanaryLiveState['michelson'] = null;
  if (hasMich) {
    if (mStorageRes.ok) {
      michelsonState = parseNacCanaryMichelsonStorage(mStorageRes.data);
      if (!michelsonState) {
        errors.push('Michelson storage did not match 9-field NacCanary layout');
      }
    } else if (mStorageRes.error) {
      errors.push(`Michelson storage: ${mStorageRes.error}`);
    }
  }

  return {
    blockNumber,
    michelsonLevel,
    blockSynced,
    evm: evmState,
    michelson: michelsonState,
    error: errors.length > 0 ? errors.join(' | ') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Probe 3: Read-Only View Executor (Zero Wallet Required)
// ---------------------------------------------------------------------------
export async function executeReadOnlyProbeView(
  network: NetworkConfig,
  addrs: CanaryAddresses,
  x: bigint,
): Promise<{
  ok: boolean;
  rawReturnHex?: string;
  rawMichelineHex?: string;
  decodedDigest?: unknown;
  echoViewResult?: { echoed: string; writes: string };
  runScriptViewResult?: unknown;
  error?: string;
}> {
  if (!isValidEvmAddress(addrs.evmCanary)) {
    return { ok: false, error: `Invalid EVM canary address: '${addrs.evmCanary}'` };
  }
  if (!isValidTezosXAddress(addrs.michelsonCanary)) {
    return { ok: false, error: `Invalid Michelson canary KT1 address: '${addrs.michelsonCanary}'` };
  }

  const probeViewData = encodeProbeViewCalldata(addrs.michelsonCanary, x);
  const echoViewData = encodeFunctionCall('echoView(uint256)', [{ type: 'uint256', value: x }]);

  const [probeViewRes, echoViewRes, scriptViewRes] = await Promise.all([
    evmRpcCall<string>(network.evm.rpcUrl, 'eth_call', [
      { to: addrs.evmCanary, data: probeViewData },
      'latest',
    ]),
    evmRpcCall<string>(network.evm.rpcUrl, 'eth_call', [
      { to: addrs.evmCanary, data: echoViewData },
      'latest',
    ]),
    runMichelsonScriptView(network, addrs.michelsonCanary, 'get_state_digest', {
      int: x.toString(),
    }),
  ]);

  let echoViewResult: { echoed: string; writes: string } | undefined;
  if (echoViewRes.ok && typeof echoViewRes.result === 'string') {
    const clean = echoViewRes.result.replace(/^0x/i, '');
    const echoed = decodeWordBigInt(clean, 0);
    const writes = decodeWordBigInt(clean, 1);
    if (echoed !== null && writes !== null) {
      echoViewResult = { echoed: echoed.toString(), writes: writes.toString() };
    }
  }

  if (!probeViewRes.ok || typeof probeViewRes.result !== 'string') {
    const revertSummary = probeViewRes.errorData
      ? decodeRevertPayload(probeViewRes.errorData).summary
      : probeViewRes.error ?? 'probeView eth_call failed';
    return {
      ok: false,
      echoViewResult,
      runScriptViewResult: scriptViewRes.ok ? scriptViewRes.data : undefined,
      error: revertSummary,
    };
  }

  const rawReturnHex = probeViewRes.result;
  const rawMichelineHex = unwrapProbeViewMichelineBytes(rawReturnHex);
  const decoded = decodeRawMichelineHex(rawMichelineHex);

  return {
    ok: true,
    rawReturnHex,
    rawMichelineHex,
    decodedDigest: decoded.ok ? decoded.expression : { raw: rawMichelineHex, decodeError: decoded.error },
    echoViewResult,
    runScriptViewResult: scriptViewRes.ok ? scriptViewRes.data : { error: scriptViewRes.error },
  };
}

// ---------------------------------------------------------------------------
// EIP-1193 Canary Probe Transaction Sender
// ---------------------------------------------------------------------------
export async function sendCanaryProbeTx(
  provider: Eip1193Provider,
  network: NetworkConfig,
  evmCanary: string,
  data: string,
  opts?: { valueWei?: bigint; gasLimit?: bigint },
): Promise<string> {
  const target = evmCanary.trim();
  if (!isValidEvmAddress(target)) {
    throw new Error(`Invalid EVM canary address: '${evmCanary}'`);
  }
  if (isTz4Address(target)) {
    throw new Error('BLS tz4 addresses are unsupported on Tezos X');
  }

  const valueWei = opts?.valueWei ?? 0n;
  if (valueWei < 0n) {
    throw new RangeError('valueWei cannot be negative');
  }
  if (valueWei % WEI_PER_MUTEZ !== 0n) {
    throw new RangeError(
      `Sub-mutez precision loss: ${valueWei} wei is not aligned to 10^12 wei (remainder ${valueWei % WEI_PER_MUTEZ} wei).`,
    );
  }

  const currentChainHex = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(currentChainHex, 16) !== network.evm.chainId) {
    await switchEvmChain(provider, network);
  }

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const from = accounts?.[0];
  if (!from) {
    throw new Error('Connect your EVM wallet before sending a Canary probe transaction.');
  }

  const gasLimit = opts?.gasLimit ?? BigInt(network.evm.nacRecommendedGas);
  const txParams: Record<string, string> = {
    from,
    to: target,
    data,
    gas: '0x' + gasLimit.toString(16),
  };
  if (valueWei > 0n) {
    txParams.value = '0x' + valueWei.toString(16);
  }

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  })) as string;

  return txHash;
}

// ---------------------------------------------------------------------------
// Progressive Transaction Trace & 429 OOG / Revert Debugger
// ---------------------------------------------------------------------------
interface RawCallTracerFrame {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  gas?: string;
  gasUsed?: string;
  input?: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: RawCallTracerFrame[];
}

export function flattenCallTracerFrames(
  root: RawCallTracerFrame,
  precompileAddress: string,
  depth = 0,
): TraceFrame[] {
  const precompileLower = precompileAddress.toLowerCase();
  const to = root.to ?? '';
  const from = root.from ?? '';
  const input = root.input ?? '0x';
  const inputSelector = input.length >= 10 ? input.slice(0, 10).toLowerCase() : input || '0x';
  const isGatewayPrecompile = to.toLowerCase() === precompileLower;

  let decodedRevert: TraceFrame['decodedRevert'];
  const hasOutput = Boolean(root.output && root.output !== '0x');
  if (root.error || root.revertReason) {
    const candidate = hasOutput
      ? root.output!
      : root.revertReason || root.error || '';
    decodedRevert = decodeRevertPayload(candidate);
  }

  const frame: TraceFrame = {
    depth,
    type: root.type ?? 'CALL',
    from,
    to,
    valueWei: parseHexToDecString(root.value),
    gas: parseHexToDecString(root.gas),
    gasUsed: parseHexToDecString(root.gasUsed),
    inputSelector,
    isGatewayPrecompile,
    error: root.error || root.revertReason || undefined,
    output: hasOutput ? root.output : undefined,
    decodedRevert,
  };

  const result: TraceFrame[] = [frame];
  if (Array.isArray(root.calls)) {
    for (const child of root.calls) {
      result.push(...flattenCallTracerFrames(child, precompileAddress, depth + 1));
    }
  }
  return result;
}

interface BlockscoutTxDetail {
  from?: { hash?: string };
  to?: { hash?: string };
  value?: string;
  gas_limit?: string;
  gas_used?: string;
  raw_input?: string;
  revert_reason?: { raw?: string; method_call?: string } | string | null;
  result?: string;
  type?: string | number;
}

interface BlockscoutInternalTxItem {
  type?: string;
  call_type?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  value?: string;
  gas_limit?: string;
  gas_used?: string;
  error?: string | null;
}

function normalizeBlockscoutFallback(
  precompileAddress: string,
  txDetail?: BlockscoutTxDetail,
  internalItems: BlockscoutInternalTxItem[] = [],
): TraceFrame[] {
  const precompileLower = precompileAddress.toLowerCase();
  const frames: TraceFrame[] = [];

  if (txDetail) {
    const to = txDetail.to?.hash ?? '';
    const rawInput = txDetail.raw_input ?? '0x';
    const rawRevert =
      typeof txDetail.revert_reason === 'string'
        ? txDetail.revert_reason
        : txDetail.revert_reason?.raw || txDetail.revert_reason?.method_call || '';
    const errorStr =
      rawRevert || (txDetail.result && txDetail.result !== 'success' ? txDetail.result : undefined);

    frames.push({
      depth: 0,
      type: 'CALL',
      from: txDetail.from?.hash ?? '',
      to,
      valueWei: txDetail.value ?? '0',
      gas: txDetail.gas_limit ?? '0',
      gasUsed: txDetail.gas_used ?? '0',
      inputSelector: rawInput.length >= 10 ? rawInput.slice(0, 10).toLowerCase() : '0x',
      isGatewayPrecompile: to.toLowerCase() === precompileLower,
      error: errorStr,
      decodedRevert: errorStr ? decodeRevertPayload(errorStr) : undefined,
    });
  }

  for (const item of internalItems) {
    const to = item.to?.hash ?? '';
    const errorStr = item.error || undefined;
    frames.push({
      depth: 1,
      type: (item.call_type || item.type || 'CALL').toUpperCase(),
      from: item.from?.hash ?? '',
      to,
      valueWei: item.value ?? '0',
      gas: item.gas_limit ?? '0',
      gasUsed: item.gas_used ?? '0',
      inputSelector: '0x',
      isGatewayPrecompile: to.toLowerCase() === precompileLower,
      error: errorStr,
      decodedRevert: errorStr ? decodeRevertPayload(errorStr) : undefined,
    });
  }

  return frames;
}

function pickTopRevert(
  frames: TraceFrame[],
): { kind: string; status?: number; summary: string; raw: string } | null {
  // Prioritize deep cross-runtime 429 OOG or gateway UTF-8 reverts over generic outer reverts
  const oogFrame = frames.find((f) => f.decodedRevert?.kind === 'CROSS_RUNTIME_429_OOG');
  if (oogFrame?.decodedRevert) return oogFrame.decodedRevert;

  const gwRevert = [...frames]
    .reverse()
    .find((f) => f.isGatewayPrecompile && f.decodedRevert);
  if (gwRevert?.decodedRevert) return gwRevert.decodedRevert;

  const anyRevert = frames.find((f) => f.decodedRevert);
  return anyRevert?.decodedRevert ?? null;
}

interface EvmTxReceipt {
  status?: string;
  blockNumber?: string;
  from?: string;
  to?: string;
  gasUsed?: string;
}

export async function inspectTransactionHash(
  network: NetworkConfig,
  txHash: string,
): Promise<TxInspectionReport> {
  const hash = txHash.trim();
  const nactraceUrl = buildNactraceUrl(network.id, hash);
  const blockscoutUrl = `${network.evm.explorerUrl}/tx/${hash}`;

  const receiptRes = await evmRpcCall<EvmTxReceipt | null>(
    network.evm.rpcUrl,
    'eth_getTransactionReceipt',
    [hash],
  );

  const receipt = receiptRes.ok ? receiptRes.result : null;
  if (!receipt) {
    return {
      txHash: hash,
      networkId: network.id,
      receiptFound: false,
      status: 'pending',
      blockNumber: null,
      from: null,
      to: null,
      gasUsed: null,
      traceSource: 'receipt_only',
      frames: [],
      gatewayHops: 0,
      decodedTopRevert: null,
      nactraceUrl,
      blockscoutUrl,
      tzktUrl: network.michelson.explorerUrl,
      rawTraceError: receiptRes.ok ? 'Transaction receipt not found yet (pending or unknown hash)' : receiptRes.error,
    };
  }

  const blockNumber = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;
  const status: TxInspectionReport['status'] =
    receipt.status === '0x1'
      ? 'success'
      : receipt.status === '0x0'
        ? 'reverted'
        : 'unknown';
  const tzktUrl =
    blockNumber !== null
      ? `${network.michelson.explorerUrl}/${blockNumber}`
      : network.michelson.explorerUrl;

  // Step 1: Attempt live debug_traceTransaction(callTracer)
  const traceRes = await evmRpcCall<RawCallTracerFrame>(
    network.evm.rpcUrl,
    'debug_traceTransaction',
    [hash, { tracer: 'callTracer' }],
  );

  if (traceRes.ok && traceRes.result && typeof traceRes.result === 'object') {
    const frames = flattenCallTracerFrames(traceRes.result, network.evm.precompile);
    const gatewayHops = frames.filter((f) => f.isGatewayPrecompile).length;
    const mirroredOpHash = gatewayHops > 0 ? computeMirroredMichelsonOpHash(hash) : null;
    return {
      txHash: hash,
      networkId: network.id,
      receiptFound: true,
      status,
      blockNumber,
      from: receipt.from ?? null,
      to: receipt.to ?? null,
      gasUsed: parseHexToDecString(receipt.gasUsed),
      traceSource: 'callTracer',
      frames,
      gatewayHops,
      decodedTopRevert: pickTopRevert(frames),
      nactraceUrl,
      blockscoutUrl,
      tzktUrl: mirroredOpHash ? `${network.michelson.explorerUrl}/${mirroredOpHash}` : tzktUrl,
    };
  }

  // Step 2: Progressive fallback to Blockscout v2 API if available
  const rawTraceError = traceRes.error ?? 'debug_traceTransaction unavailable';
  if (network.evm.blockscoutApiUrl) {
    const [txRes, internalRes] = await Promise.all([
      httpGetJson<BlockscoutTxDetail>(`${network.evm.blockscoutApiUrl}/transactions/${hash}`),
      httpGetJson<{ items?: BlockscoutInternalTxItem[] }>(
        `${network.evm.blockscoutApiUrl}/transactions/${hash}/internal-transactions`,
      ),
    ]);

    if (txRes.ok || internalRes.ok) {
      const frames = normalizeBlockscoutFallback(
        network.evm.precompile,
        txRes.ok ? txRes.data : undefined,
        internalRes.ok && Array.isArray(internalRes.data?.items) ? internalRes.data.items : [],
      );
      const gatewayHops = frames.filter((f) => f.isGatewayPrecompile).length;
      const mirroredOpHash = gatewayHops > 0 ? computeMirroredMichelsonOpHash(hash) : null;
      return {
        txHash: hash,
        networkId: network.id,
        receiptFound: true,
        status,
        blockNumber,
        from: receipt.from ?? null,
        to: receipt.to ?? null,
        gasUsed: parseHexToDecString(receipt.gasUsed),
        traceSource: 'blockscout_fallback',
        frames,
        gatewayHops,
        decodedTopRevert: pickTopRevert(frames),
        nactraceUrl,
        blockscoutUrl,
        tzktUrl: mirroredOpHash ? `${network.michelson.explorerUrl}/${mirroredOpHash}` : tzktUrl,
        rawTraceError,
      };
    }
  }

  // Step 3: Receipt-only fallback
  return {
    txHash: hash,
    networkId: network.id,
    receiptFound: true,
    status,
    blockNumber,
    from: receipt.from ?? null,
    to: receipt.to ?? null,
    gasUsed: parseHexToDecString(receipt.gasUsed),
    traceSource: 'receipt_only',
    frames: [],
    gatewayHops: 0,
    decodedTopRevert: null,
    nactraceUrl,
    blockscoutUrl,
    tzktUrl,
    rawTraceError,
  };
}

export async function waitForReceiptAndInspect(
  network: NetworkConfig,
  txHash: string,
  timeoutMs = 30_000,
): Promise<TxInspectionReport> {
  const deadline = Date.now() + timeoutMs;
  let lastReport = await inspectTransactionHash(network, txHash);

  while (!lastReport.receiptFound && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    lastReport = await inspectTransactionHash(network, txHash);
  }
  return lastReport;
}
