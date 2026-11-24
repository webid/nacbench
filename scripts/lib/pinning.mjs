/**
 * Network config loader, lightweight RPC clients, and block-pinned dual-runtime state snapshots.
 * Leverages M0-verified 1:1 block height sync (EVM block N == Michelson level N).
 * MIT License, zero dependencies.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { natBigMapKeyExpr } from "./tezos-address.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NETWORKS_PATH = resolve(__dirname, "../../config/networks.json");

export async function loadNetworksFile() {
  const raw = await readFile(NETWORKS_PATH, "utf8");
  return JSON.parse(raw);
}

export async function loadNetworkConfig(networkName = process.env.NETWORK || "previewnet") {
  const doc = await loadNetworksFile();
  const net = doc.networks[networkName];
  if (!net) {
    throw new Error(
      `Unknown network '${networkName}'. Available: ${Object.keys(doc.networks).join(", ")}`,
    );
  }
  return {
    networkKey: networkName,
    constants: doc.constants,
    ...net,
    evm: {
      ...net.evm,
      rpcUrl: process.env.EVM_RPC_URL || net.evm.rpcUrl,
    },
    michelson: {
      ...net.michelson,
      rpcUrl: process.env.MICHELSON_RPC_URL || process.env.TEZOS_RPC_URL || net.michelson.rpcUrl,
    },
  };
}

let rpcSeq = 1;
export async function evmRpc(rpcUrl, method, params = [], timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) {
      return { ok: false, httpStatus: res.status, error: json.error };
    }
    return { ok: true, httpStatus: res.status, result: json.result };
  } catch (err) {
    return { ok: false, error: String(err?.cause || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function michelsonGet(rpcUrl, path, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rpcUrl}${path}`, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body
    }
    return { ok: res.ok, httpStatus: res.status, json, text: json ? undefined : text.slice(0, 400) };
  } catch (err) {
    return { ok: false, error: String(err?.cause || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function michelsonPost(rpcUrl, path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rpcUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body
    }
    return { ok: res.ok, httpStatus: res.status, json, text: json ? undefined : text.slice(0, 400) };
  } catch (err) {
    return { ok: false, error: String(err?.cause || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a block-pinned dual-runtime snapshot at an exact shared block height
 * (EVM block N == Michelson level N).
 */
export async function fetchPinnedSnapshot(
  net,
  { blockNumber = null, evmAddress = null, michelsonKt1 = null, bigMapId = null, bigMapNatKey = null } = {},
) {
  let height = blockNumber;
  if (height === null) {
    const headRes = await evmRpc(net.evm.rpcUrl, "eth_blockNumber");
    if (!headRes.ok) throw new Error(`Failed to fetch EVM head: ${JSON.stringify(headRes.error)}`);
    height = parseInt(headRes.result, 16);
  }
  const blockHex = "0x" + height.toString(16);

  const tasks = {
    michelsonHeader: michelsonGet(net.michelson.rpcUrl, `/chains/main/blocks/${height}/header`),
  };
  if (evmAddress) {
    tasks.evmBalance = evmRpc(net.evm.rpcUrl, "eth_getBalance", [evmAddress, blockHex]);
  }
  if (michelsonKt1) {
    tasks.michelsonBalance = michelsonGet(
      net.michelson.rpcUrl,
      `/chains/main/blocks/${height}/context/contracts/${michelsonKt1}/balance`,
    );
    tasks.michelsonStorage = michelsonGet(
      net.michelson.rpcUrl,
      `/chains/main/blocks/${height}/context/contracts/${michelsonKt1}/storage`,
    );
  }
  if (bigMapId !== null && bigMapNatKey !== null) {
    const expr = natBigMapKeyExpr(bigMapNatKey);
    tasks.bigMapEntry = michelsonGet(
      net.michelson.rpcUrl,
      `/chains/main/blocks/${height}/context/big_maps/${bigMapId}/${expr}`,
    );
  }

  const keys = Object.keys(tasks);
  const resolved = await Promise.all(Object.values(tasks));
  const data = Object.fromEntries(keys.map((k, i) => [k, resolved[i]]));

  return {
    pinnedHeight: height,
    blockHex,
    michelsonLevel: data.michelsonHeader.ok ? data.michelsonHeader.json?.level : null,
    heightMatched: data.michelsonHeader.ok && data.michelsonHeader.json?.level === height,
    evm: evmAddress
      ? {
          address: evmAddress,
          balanceWei: data.evmBalance.ok ? BigInt(data.evmBalance.result).toString() : null,
        }
      : null,
    michelson: michelsonKt1
      ? {
          address: michelsonKt1,
          balanceMutez: data.michelsonBalance.ok ? String(data.michelsonBalance.json) : null,
          storage: data.michelsonStorage.ok ? data.michelsonStorage.json : null,
          bigMapEntry: data.bigMapEntry ? (data.bigMapEntry.ok ? data.bigMapEntry.json : null) : undefined,
        }
      : null,
  };
}

/** Compute structured diff between two block-pinned snapshots. */
export function diffSnapshots(before, after) {
  const evmDeltaWei =
    before?.evm?.balanceWei != null && after?.evm?.balanceWei != null
      ? (BigInt(after.evm.balanceWei) - BigInt(before.evm.balanceWei)).toString()
      : null;
  const michelsonDeltaMutez =
    before?.michelson?.balanceMutez != null && after?.michelson?.balanceMutez != null
      ? (BigInt(after.michelson.balanceMutez) - BigInt(before.michelson.balanceMutez)).toString()
      : null;
  const michelsonStorageChanged =
    JSON.stringify(before?.michelson?.storage ?? null) !==
    JSON.stringify(after?.michelson?.storage ?? null);

  return {
    beforeHeight: before?.pinnedHeight ?? null,
    afterHeight: after?.pinnedHeight ?? null,
    evmDeltaWei,
    michelsonDeltaMutez,
    michelsonStorageChanged,
  };
}
