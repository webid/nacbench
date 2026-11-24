import {
  computeBigMapKeyHash,
  decodeOriginOfHex,
  decodeResolveAddressHex,
  encodeOriginOfCalldata,
  encodeResolveAddressCalldata,
  isTz4Address,
  isValidEvmAddress,
} from './codec';
import { SAFE_SINGLETON_FACTORY } from './networks';
import type {
  DualRuntimeSnapshot,
  GatewayHealth,
  IdentityReport,
  NetworkConfig,
  SnapshotDiff,
} from './types';

let rpcSeq = 1;

interface RpcCallResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

async function evmRpc<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 12_000,
): Promise<RpcCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcSeq++, method, params }),
      signal: controller.signal,
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) {
      return { ok: false, error: json.error.message ?? JSON.stringify(json.error) };
    }
    return { ok: true, result: json.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function michelsonGet<T = unknown>(
  rpcUrl: string,
  path: string,
  timeoutMs = 12_000,
): Promise<RpcCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rpcUrl}${path}`, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 240)}` };
    }
    const json = JSON.parse(text) as T;
    return { ok: true, result: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function michelsonPost<T = unknown>(
  rpcUrl: string,
  path: string,
  body: unknown,
  timeoutMs = 12_000,
): Promise<RpcCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rpcUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON response
    }
    if (!res.ok) {
      return {
        ok: false,
        error: parsed ? JSON.stringify(parsed).slice(0, 400) : `HTTP ${res.status}: ${text.slice(0, 240)}`,
      };
    }
    return { ok: true, result: parsed as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGatewayHealth(network: NetworkConfig): Promise<GatewayHealth> {
  const checkedAt = new Date().toISOString();

  const [
    evmBlockRes,
    precompileCodeRes,
    kernelVerRes,
    mHeaderRes,
    mConstantsRes,
    mEntrypointsRes,
    mScriptRes,
  ] = await Promise.all([
    evmRpc<string>(network.evm.rpcUrl, 'eth_blockNumber'),
    evmRpc<string>(network.evm.rpcUrl, 'eth_getCode', [network.evm.precompile, 'latest']),
    evmRpc<unknown>(network.evm.rpcUrl, 'tez_kernelVersion', ['latest']),
    michelsonGet<{ level?: number }>(network.michelson.rpcUrl, '/chains/main/blocks/head/header'),
    michelsonGet<{ hard_gas_limit_per_operation?: string | number }>(
      network.michelson.rpcUrl,
      '/chains/main/blocks/head/context/constants',
    ),
    michelsonGet<{ entrypoints?: Record<string, unknown> }>(
      network.michelson.rpcUrl,
      `/chains/main/blocks/head/context/contracts/${network.michelson.evmGateway}/entrypoints`,
    ),
    michelsonGet<{ code?: Array<{ prim?: string; args?: Array<{ string?: string }> }> }>(
      network.michelson.rpcUrl,
      `/chains/main/blocks/head/context/contracts/${network.michelson.evmGateway}/script`,
    ),
  ]);

  const evmHead =
    evmBlockRes.ok && typeof evmBlockRes.result === 'string'
      ? parseInt(evmBlockRes.result, 16)
      : null;

  const michelsonLevel =
    mHeaderRes.ok && typeof mHeaderRes.result?.level === 'number'
      ? mHeaderRes.result.level
      : null;

  const synced =
    evmHead !== null && michelsonLevel !== null && Math.abs(evmHead - michelsonLevel) <= 1;

  const precompileZeroCode =
    precompileCodeRes.ok && typeof precompileCodeRes.result === 'string'
      ? precompileCodeRes.result === '0x'
      : null;

  const gatewayEntrypoints =
    mEntrypointsRes.ok && mEntrypointsRes.result?.entrypoints
      ? Object.keys(mEntrypointsRes.result.entrypoints)
      : [];

  const gatewayViews =
    mScriptRes.ok && Array.isArray(mScriptRes.result?.code)
      ? mScriptRes.result.code
          .filter((node) => node.prim === 'view')
          .map((node) => node.args?.[0]?.string)
          .filter((name): name is string => typeof name === 'string')
      : [];

  let kernelVersion: string | null = null;
  if (kernelVerRes.ok && kernelVerRes.result !== undefined && kernelVerRes.result !== null) {
    kernelVersion =
      typeof kernelVerRes.result === 'string'
        ? kernelVerRes.result
        : JSON.stringify(kernelVerRes.result);
  }

  const rawGasLimit = mConstantsRes.ok
    ? mConstantsRes.result?.hard_gas_limit_per_operation
    : undefined;
  const hardGasLimit =
    rawGasLimit !== undefined && rawGasLimit !== null ? Number(rawGasLimit) : null;

  const errors: string[] = [];
  if (!evmBlockRes.ok) errors.push(`EVM: ${evmBlockRes.error ?? 'unreachable'}`);
  if (!mHeaderRes.ok) errors.push(`Michelson: ${mHeaderRes.error ?? 'unreachable'}`);

  return {
    checkedAt,
    evmOk: evmBlockRes.ok,
    michelsonOk: mHeaderRes.ok,
    evmHead,
    michelsonLevel,
    synced,
    precompileZeroCode,
    gatewayEntrypoints,
    gatewayViews,
    kernelVersion,
    hardGasLimit,
    error: errors.length > 0 ? errors.join(' | ') : undefined,
  };
}

function buildAliasTypeNote(
  input: string,
  inferredRuntime: 0 | 1,
  isMaterialized: boolean | null,
): string {
  const trimmed = input.trim();
  if (isTz4Address(trimmed)) {
    return 'BLS tz4 addresses are explicitly unsupported on Tezos X / Etherlink Michelson runtime.';
  }
  if (trimmed.startsWith('KT1')) {
    return isMaterialized
      ? 'KT1 originated contract alias (deterministic Keccak-256 kernel proxy — materialized on EVM).'
      : 'KT1 originated contract alias (deterministic Keccak-256 kernel mapping; non-Safe, lazily handled by kernel).';
  }
  if (/^tz[123]/.test(trimmed)) {
    return isMaterialized
      ? `Horus 8.0 tz1/2/3 Safe-CREATE2 alias is materialized on EVM (Safe Singleton Factory ${SAFE_SINGLETON_FACTORY.slice(0, 10)}… has 0x code on Previewnet; kernel handles deployment natively).`
      : `Horus 8.0 tz1/2/3 Safe-CREATE2 alias is currently unmaterialized (0x code). Provide your Base58 public key (edpk/sppk/p2pk) to materialize via 0xbfe88b4b or %materialize_alias. Note: Safe Singleton Factory (${SAFE_SINGLETON_FACTORY.slice(0, 10)}…) has 0x code on Previewnet because the kernel executes materialization directly.`;
  }
  if (inferredRuntime === 1) {
    return 'EVM-native address translated into its deterministic Tezos/Michelson alias by the Horus 8.0 gateway.';
  }
  return 'Cross-runtime identity resolved via 0xff00…0007 originOf + resolveAddress.';
}

export async function inspectCrossRuntimeIdentity(
  network: NetworkConfig,
  addr: string,
): Promise<IdentityReport> {
  const trimmed = addr.trim();
  if (!trimmed) {
    throw new Error('Please enter a tz1/tz2/tz3, KT1, or 0x EVM address.');
  }
  if (isTz4Address(trimmed)) {
    throw new Error(
      `BLS tz4 address '${trimmed}' is not supported on Tezos X Michelson interface.`,
    );
  }

  const inferredRuntime: 0 | 1 = isValidEvmAddress(trimmed) ? 1 : 0;
  const targetRuntime: 0 | 1 = inferredRuntime === 0 ? 1 : 0;

  const originCalldata = encodeOriginOfCalldata(trimmed, inferredRuntime);
  const resolveCalldata = encodeResolveAddressCalldata(trimmed, inferredRuntime, targetRuntime);

  const [originRes, resolveRes] = await Promise.all([
    evmRpc<string>(network.evm.rpcUrl, 'eth_call', [
      { to: network.evm.precompile, data: originCalldata },
      'latest',
    ]),
    evmRpc<string>(network.evm.rpcUrl, 'eth_call', [
      { to: network.evm.precompile, data: resolveCalldata },
      'latest',
    ]),
  ]);

  if (!originRes.ok && !resolveRes.ok) {
    throw new Error(
      `Precompile identity RPC failed: ${originRes.error ?? resolveRes.error ?? 'unknown error'}`,
    );
  }

  const rawOriginHex = originRes.ok && typeof originRes.result === 'string' ? originRes.result : '0x';
  const rawResolveHex =
    resolveRes.ok && typeof resolveRes.result === 'string' ? resolveRes.result : '0x';

  const origin = decodeOriginOfHex(rawOriginHex);
  const resolved = decodeResolveAddressHex(rawResolveHex);

  let aliasCode: string | null = null;
  let isMaterialized: boolean | null = null;

  if (resolved.translatedAddress && isValidEvmAddress(resolved.translatedAddress)) {
    const codeRes = await evmRpc<string>(network.evm.rpcUrl, 'eth_getCode', [
      resolved.translatedAddress,
      'latest',
    ]);
    if (codeRes.ok && typeof codeRes.result === 'string') {
      aliasCode = codeRes.result;
      isMaterialized = codeRes.result !== '0x';
    }
  } else if (inferredRuntime === 1) {
    const codeRes = await evmRpc<string>(network.evm.rpcUrl, 'eth_getCode', [trimmed, 'latest']);
    if (codeRes.ok && typeof codeRes.result === 'string') {
      aliasCode = codeRes.result;
      isMaterialized = codeRes.result !== '0x';
    }
  }

  return {
    input: trimmed,
    inferredRuntime,
    kind: origin.kind,
    kindLabel: origin.kindLabel,
    homeRuntime: origin.homeRuntime,
    homeRuntimeLabel: origin.homeRuntimeLabel,
    nativeAddress: origin.nativeAddress,
    classified: resolved.classified,
    resolution: resolved.resolution,
    resolutionLabel: resolved.resolutionLabel,
    translatedAddress: resolved.translatedAddress,
    aliasCode,
    isMaterialized,
    aliasTypeNote: buildAliasTypeNote(trimmed, inferredRuntime, isMaterialized),
    rawOriginHex,
    rawResolveHex,
  };
}

export async function captureBlockPinnedSnapshot(
  network: NetworkConfig,
  opts: {
    label: string;
    evmAddress?: string;
    michelsonAddress?: string;
    bigMapId?: number;
    bigMapKeyType?: 'nat' | 'string' | 'address';
    bigMapKey?: string;
    pinnedBlock?: number;
  },
): Promise<DualRuntimeSnapshot> {
  let height = opts.pinnedBlock;
  if (height === undefined || Number.isNaN(height)) {
    const headRes = await evmRpc<string>(network.evm.rpcUrl, 'eth_blockNumber');
    if (!headRes.ok || typeof headRes.result !== 'string') {
      throw new Error(`Failed to fetch EVM head block: ${headRes.error ?? 'unknown error'}`);
    }
    height = parseInt(headRes.result, 16);
  }

  const blockHex = '0x' + height.toString(16);
  const evmAddress = opts.evmAddress?.trim() || undefined;
  const michelsonAddress = opts.michelsonAddress?.trim() || undefined;
  const hasBigMap =
    opts.bigMapId !== undefined &&
    Number.isFinite(opts.bigMapId) &&
    opts.bigMapKey !== undefined &&
    opts.bigMapKey.trim() !== '';

  let bigMapKeyHash: string | undefined;
  if (hasBigMap && opts.bigMapKey !== undefined) {
    bigMapKeyHash = computeBigMapKeyHash(opts.bigMapKeyType ?? 'nat', opts.bigMapKey).exprHash;
  }

  const [
    mHeaderRes,
    evmBalRes,
    evmCodeRes,
    mBalRes,
    mStorageRes,
    bigMapRes,
  ] = await Promise.all([
    michelsonGet<{ level?: number }>(
      network.michelson.rpcUrl,
      `/chains/main/blocks/${height}/header`,
    ),
    evmAddress
      ? evmRpc<string>(network.evm.rpcUrl, 'eth_getBalance', [evmAddress, blockHex])
      : Promise.resolve<RpcCallResult<string>>({ ok: false }),
    evmAddress
      ? evmRpc<string>(network.evm.rpcUrl, 'eth_getCode', [evmAddress, blockHex])
      : Promise.resolve<RpcCallResult<string>>({ ok: false }),
    michelsonAddress
      ? michelsonGet<string>(
          network.michelson.rpcUrl,
          `/chains/main/blocks/${height}/context/contracts/${michelsonAddress}/balance`,
        )
      : Promise.resolve<RpcCallResult<string>>({ ok: false }),
    michelsonAddress && michelsonAddress.startsWith('KT1')
      ? michelsonGet<unknown>(
          network.michelson.rpcUrl,
          `/chains/main/blocks/${height}/context/contracts/${michelsonAddress}/storage`,
        )
      : Promise.resolve<RpcCallResult<unknown>>({ ok: false }),
    hasBigMap && bigMapKeyHash
      ? michelsonGet<unknown>(
          network.michelson.rpcUrl,
          `/chains/main/blocks/${height}/context/big_maps/${opts.bigMapId}/${bigMapKeyHash}`,
        )
      : Promise.resolve<RpcCallResult<unknown>>({ ok: false }),
  ]);

  const michelsonLevel =
    mHeaderRes.ok && typeof mHeaderRes.result?.level === 'number' ? mHeaderRes.result.level : -1;
  const blockSynced = michelsonLevel === height;

  const evmBalanceWei =
    evmAddress && evmBalRes.ok && typeof evmBalRes.result === 'string'
      ? BigInt(evmBalRes.result).toString()
      : undefined;

  const evmCodeBytes =
    evmAddress && evmCodeRes.ok && typeof evmCodeRes.result === 'string'
      ? Math.max(0, (evmCodeRes.result.length - 2) / 2)
      : undefined;

  const michelsonBalanceMutez =
    michelsonAddress && mBalRes.ok && mBalRes.result !== undefined
      ? String(mBalRes.result)
      : undefined;

  return {
    label: opts.label,
    capturedAt: new Date().toISOString(),
    blockNumber: height,
    michelsonLevel,
    blockSynced,
    evmAddress,
    evmBalanceWei,
    evmCodeBytes,
    michelsonAddress,
    michelsonBalanceMutez,
    michelsonStorage: mStorageRes.ok ? mStorageRes.result : undefined,
    bigMapId: hasBigMap ? opts.bigMapId : undefined,
    bigMapKey: hasBigMap ? opts.bigMapKey : undefined,
    bigMapKeyHash,
    bigMapValue: hasBigMap ? (bigMapRes.ok ? bigMapRes.result : null) : undefined,
  };
}

export function diffSnapshots(
  before: DualRuntimeSnapshot,
  after: DualRuntimeSnapshot,
): SnapshotDiff {
  const evmBalanceDeltaWei =
    before.evmBalanceWei !== undefined && after.evmBalanceWei !== undefined
      ? (BigInt(after.evmBalanceWei) - BigInt(before.evmBalanceWei)).toString()
      : null;

  const michelsonBalanceDeltaMutez =
    before.michelsonBalanceMutez !== undefined && after.michelsonBalanceMutez !== undefined
      ? (BigInt(after.michelsonBalanceMutez) - BigInt(before.michelsonBalanceMutez)).toString()
      : null;

  const michelsonStorageChanged =
    JSON.stringify(before.michelsonStorage ?? null) !==
    JSON.stringify(after.michelsonStorage ?? null);

  const bigMapValueChanged =
    JSON.stringify(before.bigMapValue ?? null) !== JSON.stringify(after.bigMapValue ?? null);

  return {
    blockDelta: after.blockNumber - before.blockNumber,
    evmBalanceDeltaWei,
    michelsonBalanceDeltaMutez,
    michelsonStorageChanged,
    bigMapValueChanged,
    before,
    after,
  };
}

export async function runMichelsonScriptView(
  network: NetworkConfig,
  contract: string,
  view: string,
  inputMicheline: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const res = await michelsonPost<{ data?: unknown }>(
    network.michelson.rpcUrl,
    '/chains/main/blocks/head/helpers/scripts/run_script_view',
    {
      contract: contract.trim(),
      view: view.trim(),
      input: inputMicheline,
      chain_id: network.michelson.chainId,
      unlimited_gas: true,
      unparsing_mode: 'Readable',
    },
  );
  if (!res.ok) {
    return { ok: false, error: res.error ?? 'run_script_view failed' };
  }
  return { ok: true, data: res.result?.data ?? res.result };
}
