#!/usr/bin/env node
/**
 * Milestone 0 — Live Tezos X Previewnet v0.11 RPC & Gateway Verification Gate
 * Strictly READ-ONLY: zero transactions, zero signing, zero deployments.
 * Zero external npm dependencies (pure Node.js >= 18).
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "m0-results.json");

const EVM_RPC = "https://evm.previewnet.tezosx.nomadic-labs.com";
const MICHELSON_RPC = "https://michelson.previewnet.tezosx.nomadic-labs.com";
const BLOCKSCOUT_API = "https://blockscout.previewnet.tezosx.nomadic-labs.com/api/v2";
const TZKT_API = "https://tzkt.previewnet.tezosx.nomadic-labs.com/v1";
const DASHBOARD_URL = "https://previewnet.tezosx.nomadic-labs.com/";

const NAC_PRECOMPILE = "0xff00000000000000000000000000000000000007";
const MICHELSON_GATEWAY = "KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw";
const SAFE_SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const FREE_ROUTE_POOL = "0x0d9de5e5d943c6e5118140e49b56f496d7f47003";
const RETIRED_WRAPPER_EVM = "0xff00000000000000000000000000000000000009";
const RETIRED_WRAPPER_KT1 = "KT18oDJJKXMKhfE1bSuAPGp92pYcwVKvCChb";
const TEST_TZ1_ALICE = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
const TEST_EVM_ADDR = "0x000000000000000000000000000000000000dEaD";

// ---------------------------------------------------------------------------
// Minimal Pure-JS Keccak-256 (Ethereum / Solidity function selectors)
// ---------------------------------------------------------------------------
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const KECCAK_PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];
const MASK64 = (1n << 64n) - 1n;

function rotl64(x, n) {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(st) {
  for (let round = 0; round < 24; round++) {
    const bc = new Array(5);
    for (let i = 0; i < 5; i++) {
      bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i];
      bc[0] = st[j];
      st[j] = rotl64(t, KECCAK_ROTC[i]);
      t = bc[0];
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) {
        st[j + i] ^= (~bc[(i + 1) % 5] & MASK64) & bc[(i + 2) % 5];
      }
    }
    st[0] ^= KECCAK_RC[round];
  }
}

function keccak256Hex(inputStr) {
  const bytes = new TextEncoder().encode(inputStr);
  const rate = 136; // 1088 bits
  const st = new Array(25).fill(0n);
  const paddedLen = Math.ceil((bytes.length + 1) / rate) * rate;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x01;
  buf[paddedLen - 1] |= 0x80;

  for (let offset = 0; offset < buf.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(buf[offset + i * 8 + b]) << BigInt(8 * b);
      }
      st[i] ^= lane;
    }
    keccakF1600(st);
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    let lane = st[i];
    for (let b = 0; b < 8; b++) {
      out += Number((lane >> BigInt(8 * b)) & 0xffn)
        .toString(16)
        .padStart(2, "0");
    }
  }
  return out;
}

function selectorOf(sig) {
  return "0x" + keccak256Hex(sig).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Minimal Solidity ABI Encoder / Decoder helpers
// ---------------------------------------------------------------------------
function pad32(hexNoPrefix) {
  return hexNoPrefix.padStart(64, "0");
}
function encodeUint(n) {
  return pad32(BigInt(n).toString(16));
}
function encodeAddress(addr) {
  return pad32(addr.toLowerCase().replace(/^0x/, ""));
}
function encodeBytesDynamic(bytes) {
  const lenHex = encodeUint(bytes.length);
  const dataHex = Buffer.from(bytes).toString("hex");
  const rem = dataHex.length % 64;
  const padded = rem === 0 ? dataHex : dataHex + "0".repeat(64 - rem);
  return lenHex + padded;
}
function encodeStringDynamic(str) {
  return encodeBytesDynamic(new TextEncoder().encode(str));
}

function encodeCall(sig, params) {
  // params: array of { type: 'string'|'bytes'|'uint8'|'address', value }
  const sel = selectorOf(sig);
  const headParts = [];
  const tailParts = [];
  let dynamicOffset = params.length * 32;
  for (const p of params) {
    if (p.type === "uint8") {
      headParts.push(encodeUint(p.value));
    } else if (p.type === "address") {
      headParts.push(encodeAddress(p.value));
    } else if (p.type === "string") {
      headParts.push(encodeUint(dynamicOffset));
      const enc = encodeStringDynamic(p.value);
      tailParts.push(enc);
      dynamicOffset += enc.length / 2;
    } else if (p.type === "bytes") {
      headParts.push(encodeUint(dynamicOffset));
      const raw = Buffer.from(p.value.replace(/^0x/, ""), "hex");
      const enc = encodeBytesDynamic(raw);
      tailParts.push(enc);
      dynamicOffset += enc.length / 2;
    }
  }
  return sel + headParts.join("") + tailParts.join("");
}

function decodeWordBigInt(hexNoPrefix, wordIndex) {
  const slice = hexNoPrefix.slice(wordIndex * 64, (wordIndex + 1) * 64);
  if (slice.length < 64) return null;
  return BigInt("0x" + slice);
}

function decodeDynamicString(hexNoPrefix, offsetBytes) {
  const startHex = Number(offsetBytes) * 2;
  const lenHex = hexNoPrefix.slice(startHex, startHex + 64);
  if (lenHex.length < 64) return null;
  const len = Number(BigInt("0x" + lenHex));
  const strHex = hexNoPrefix.slice(startHex + 64, startHex + 64 + len * 2);
  return Buffer.from(strHex, "hex").toString("utf8");
}

function decodeOriginOf(rawHex) {
  if (!rawHex || rawHex === "0x") return { raw: rawHex };
  const h = rawHex.replace(/^0x/, "");
  if (h.length < 192) return { raw: rawHex, note: "short response" };
  const kind = Number(decodeWordBigInt(h, 0));
  const homeRuntime = Number(decodeWordBigInt(h, 1));
  const strOffset = decodeWordBigInt(h, 2);
  const nativeAddress = decodeDynamicString(h, strOffset);
  return { kind, homeRuntime, nativeAddress, raw: rawHex };
}

function decodeResolveAddress(rawHex) {
  if (!rawHex || rawHex === "0x") return { raw: rawHex };
  const h = rawHex.replace(/^0x/, "");
  if (h.length < 192) return { raw: rawHex, note: "short response" };
  const classified = decodeWordBigInt(h, 0) !== 0n;
  const resolution = Number(decodeWordBigInt(h, 1));
  const strOffset = decodeWordBigInt(h, 2);
  const translated = decodeDynamicString(h, strOffset);
  return { classified, resolution, translated, raw: rawHex };
}

// ---------------------------------------------------------------------------
// HTTP Helpers with timeouts
// ---------------------------------------------------------------------------
let rpcId = 1;
async function evmRpc(method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(EVM_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: res.status, rawText: text.slice(0, 400) };
    }
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

async function httpGet(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    let json = null;
    if (contentType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try {
        json = JSON.parse(text);
      } catch {
        // leave null
      }
    }
    return {
      ok: res.ok,
      httpStatus: res.status,
      contentType,
      json,
      textPreview: json ? undefined : text.slice(0, 600),
    };
  } catch (err) {
    return { ok: false, error: String(err?.cause || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPostJson(url, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
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
      // leave null
    }
    return {
      ok: res.ok,
      httpStatus: res.status,
      json,
      textPreview: json ? undefined : text.slice(0, 500),
    };
  } catch (err) {
    return { ok: false, error: String(err?.cause || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main Verification Suite
// ---------------------------------------------------------------------------
async function main() {
  const results = {
    executedAt: new Date().toISOString(),
    nodeVersion: process.version,
    endpoints: { EVM_RPC, MICHELSON_RPC, BLOCKSCOUT_API, TZKT_API, DASHBOARD_URL },
    evm: {},
    michelson: {},
    precompileProbes: {},
    auxiliaryServices: {},
  };

  console.log("Running Milestone 0 live read-only verification against Tezos X Previewnet...");

  // 1. EVM basic RPC checks
  const [chainId, blockNum, clientVer, netVer, kernelVer, kernelRoot] = await Promise.all([
    evmRpc("eth_chainId"),
    evmRpc("eth_blockNumber"),
    evmRpc("web3_clientVersion"),
    evmRpc("net_version"),
    evmRpc("tez_kernelVersion", ["latest"]),
    evmRpc("tez_kernelRootHash", ["latest"]),
  ]);
  results.evm.eth_chainId = chainId;
  results.evm.eth_blockNumber = blockNum;
  results.evm.eth_blockNumberDecimal = blockNum.ok ? parseInt(blockNum.result, 16) : null;
  results.evm.web3_clientVersion = clientVer;
  results.evm.net_version = netVer;
  results.evm.tez_kernelVersion = kernelVer;
  results.evm.tez_kernelRootHash = kernelRoot;

  // 2. eth_getCode checks
  const codeTargets = {
    nacPrecompile: NAC_PRECOMPILE,
    safeSingletonFactory: SAFE_SINGLETON_FACTORY,
    freeRoutePool_fromXpectAug30: FREE_ROUTE_POOL,
    retiredWrapperEvm_0xff09: RETIRED_WRAPPER_EVM,
    precompile_0xff06: "0xff00000000000000000000000000000000000006",
  };
  results.evm.codeChecks = {};
  for (const [label, addr] of Object.entries(codeTargets)) {
    const r = await evmRpc("eth_getCode", [addr, "latest"]);
    results.evm.codeChecks[label] = {
      address: addr,
      ok: r.ok,
      byteLength: r.ok ? Math.max(0, (r.result.length - 2) / 2) : null,
      codePrefix: r.ok ? r.result.slice(0, 66) : null,
      isEmpty: r.ok ? r.result === "0x" : null,
      error: r.error,
    };
  }

  // 3. Michelson basic RPC checks + gateway script/entrypoints
  const [mChainId, mHeader, mProtocols, mVersion, mConstants, mGatewayEntrypoints, mGatewayScript, mRetiredWrapper] =
    await Promise.all([
      httpGet(`${MICHELSON_RPC}/chains/main/chain_id`),
      httpGet(`${MICHELSON_RPC}/chains/main/blocks/head/header`),
      httpGet(`${MICHELSON_RPC}/chains/main/blocks/head/protocols`),
      httpGet(`${MICHELSON_RPC}/version`),
      httpGet(`${MICHELSON_RPC}/chains/main/blocks/head/context/constants`),
      httpGet(`${MICHELSON_RPC}/chains/main/blocks/head/context/contracts/${MICHELSON_GATEWAY}/entrypoints`),
      httpGet(`${MICHELSON_RPC}/chains/main/blocks/head/context/contracts/${MICHELSON_GATEWAY}/script`),
      httpGet(`${MICHELSON_RPC}/chains/main/blocks/head/context/contracts/${RETIRED_WRAPPER_KT1}/entrypoints`),
    ]);

  results.michelson.chain_id = mChainId;
  results.michelson.header = mHeader;
  results.michelson.protocols = mProtocols;
  results.michelson.version = mVersion;
  results.michelson.constantsSummary = mConstants.ok && mConstants.json
    ? {
        hard_gas_limit_per_operation: mConstants.json.hard_gas_limit_per_operation,
        hard_gas_limit_per_block: mConstants.json.hard_gas_limit_per_block,
        hard_storage_limit_per_operation: mConstants.json.hard_storage_limit_per_operation,
        cost_per_byte: mConstants.json.cost_per_byte,
        minimal_block_delay: mConstants.json.minimal_block_delay,
        max_operation_data_length: mConstants.json.max_operation_data_length,
        michelson_maximum_type_size: mConstants.json.michelson_maximum_type_size,
      }
    : mConstants;

  results.michelson.gatewayEntrypoints = mGatewayEntrypoints;
  results.michelson.retiredWrapperKt1 = {
    address: RETIRED_WRAPPER_KT1,
    httpStatus: mRetiredWrapper.httpStatus,
    ok: mRetiredWrapper.ok,
  };

  // Extract parameter, storage, and views from gateway script
  if (mGatewayScript.ok && mGatewayScript.json?.code) {
    const codeArr = mGatewayScript.json.code;
    const paramSection = codeArr.find((x) => x.prim === "parameter");
    const storageSection = codeArr.find((x) => x.prim === "storage");
    const views = codeArr.filter((x) => x.prim === "view").map((v) => ({
      name: v.args?.[0]?.string,
      inputType: v.args?.[1],
      outputType: v.args?.[2],
    }));
    results.michelson.gatewayScriptSummary = {
      parameter: paramSection,
      storageType: storageSection,
      views,
      rawStorage: mGatewayScript.json.storage,
    };
  } else {
    results.michelson.gatewayScriptSummary = mGatewayScript;
  }

  // 4. Probe run_script_view on Michelson RPC (with unparsing_mode: "Readable")
  const runScriptViewProbe = await httpPostJson(
    `${MICHELSON_RPC}/chains/main/blocks/head/helpers/scripts/run_script_view`,
    {
      contract: MICHELSON_GATEWAY,
      view: "originOf",
      input: { prim: "Pair", args: [{ string: TEST_TZ1_ALICE }, { int: "0" }] },
      chain_id: mChainId.json || "NetXY2oPPzkxUW1",
      unlimited_gas: true,
      unparsing_mode: "Readable",
    },
  );
  results.michelson.run_script_view_probe = runScriptViewProbe;

  // 5. Auxiliary services (Dashboard, Blockscout, TzKT, Tezos X Wallet, xDex)
  const [dashRes, bsStats, bsTxs, tzktHead, tzktContracts, walletRes, xdexRes] = await Promise.all([
    httpGet(DASHBOARD_URL),
    httpGet(`${BLOCKSCOUT_API}/stats`),
    httpGet(`${BLOCKSCOUT_API}/transactions`),
    httpGet(`${TZKT_API}/head`),
    httpGet(`${TZKT_API}/contracts?limit=10&sort.desc=lastActivity`),
    httpGet("https://trilitech.github.io/tezos-x-wallet/"),
    httpGet("https://dexx-previewnet.vercel.app/"),
  ]);

  // Try to pull a real non-gateway KT1 contract from TzKT for KT1 alias testing
  let sampleUserKt1 = null;
  if (tzktContracts.ok && Array.isArray(tzktContracts.json)) {
    const found = tzktContracts.json.find(
      (c) => c.address && c.address.startsWith("KT1") && c.address !== MICHELSON_GATEWAY,
    );
    if (found) sampleUserKt1 = found.address;
  }

  // Extract dashboard version mentions
  let dashboardVersions = [];
  if (dashRes.ok && dashRes.textPreview) {
    dashboardVersions = [...new Set(dashRes.textPreview.match(/v0\.\d+/g) || [])];
  }

  results.auxiliaryServices = {
    dashboard: { ok: dashRes.ok, httpStatus: dashRes.httpStatus, versionsFoundInPreview: dashboardVersions },
    blockscoutStats: { ok: bsStats.ok, httpStatus: bsStats.httpStatus, totalBlocks: bsStats.json?.total_blocks, totalTxs: bsStats.json?.total_transactions },
    blockscoutRecentTxsCount: bsTxs.ok && Array.isArray(bsTxs.json?.items) ? bsTxs.json.items.length : 0,
    tzktHead: { ok: tzktHead.ok, httpStatus: tzktHead.httpStatus, level: tzktHead.json?.level, chainId: tzktHead.json?.chainId, timestamp: tzktHead.json?.timestamp },
    sampleUserKt1FromTzkt: sampleUserKt1,
    tezosXWalletReachable: { ok: walletRes.ok, httpStatus: walletRes.httpStatus },
    xdexFrontendReachable: { ok: xdexRes.ok, httpStatus: xdexRes.httpStatus },
  };

  // 6. Precompile originOf & resolveAddress probes (tz1, KT1 gateway, sample user KT1, EVM address)
  const identityTargets = [
    { label: "tz1_alice", addr: TEST_TZ1_ALICE },
    { label: "kt1_gateway", addr: MICHELSON_GATEWAY },
    ...(sampleUserKt1 ? [{ label: "kt1_live_user_contract", addr: sampleUserKt1 }] : []),
    { label: "evm_dead", addr: TEST_EVM_ADDR },
    { label: "evm_safe_factory", addr: SAFE_SINGLETON_FACTORY },
  ];

  results.precompileProbes.originOf = {};
  results.precompileProbes.resolveAddress = {};

  for (const t of identityTargets) {
    results.precompileProbes.originOf[t.label] = { addr: t.addr, bySourceRuntime: {} };
    for (const srcRt of [0, 1]) {
      const data = encodeCall("originOf(string,uint8)", [
        { type: "string", value: t.addr },
        { type: "uint8", value: srcRt },
      ]);
      const r = await evmRpc("eth_call", [{ to: NAC_PRECOMPILE, data }, "latest"]);
      results.precompileProbes.originOf[t.label].bySourceRuntime[srcRt] = r.ok
        ? { ok: true, decoded: decodeOriginOf(r.result) }
        : { ok: false, error: r.error };
    }

    // resolveAddress(addr, srcRt, dstRt) for (0->1) and (1->0)
    results.precompileProbes.resolveAddress[t.label] = { addr: t.addr, pairs: {} };
    for (const [srcRt, dstRt] of [[0, 1], [1, 0]]) {
      const data = encodeCall("resolveAddress(string,uint8,uint8)", [
        { type: "string", value: t.addr },
        { type: "uint8", value: srcRt },
        { type: "uint8", value: dstRt },
      ]);
      const r = await evmRpc("eth_call", [{ to: NAC_PRECOMPILE, data }, "latest"]);
      const key = `${srcRt}_to_${dstRt}`;
      if (r.ok) {
        const decoded = decodeResolveAddress(r.result);
        // If translated looks like an EVM 0x address, check its code (e.g. EIP-7702 0xef0100... or Safe proxy)
        let aliasCode = null;
        if (decoded.translated && /^0x[0-9a-fA-F]{40}$/.test(decoded.translated)) {
          const codeRes = await evmRpc("eth_getCode", [decoded.translated, "latest"]);
          aliasCode = codeRes.ok ? codeRes.result : codeRes.error;
        }
        results.precompileProbes.resolveAddress[t.label].pairs[key] = {
          ok: true,
          decoded,
          aliasCode,
        };
      } else {
        results.precompileProbes.resolveAddress[t.label].pairs[key] = { ok: false, error: r.error };
      }
    }
  }

  // 7. Probe candidate v0.11 EVM alias-materialization selectors & callMichelsonView on 0xff...07
  const candidateSigs = [
    { sig: "materializeAlias(string)", params: [{ type: "string", value: TEST_TZ1_ALICE }] },
    { sig: "materializeAlias(string,uint8)", params: [{ type: "string", value: TEST_TZ1_ALICE }, { type: "uint8", value: 0 }] },
    { sig: "materializeAlias(uint8,string)", params: [{ type: "uint8", value: 0 }, { type: "string", value: TEST_TZ1_ALICE }] },
    { sig: "materializeAlias(string,string,string)", params: [{ type: "string", value: "tezos" }, { type: "string", value: TEST_TZ1_ALICE }, { type: "string", value: "" }] },
    { sig: "materializeAlias(uint8,string,string)", params: [{ type: "uint8", value: 0 }, { type: "string", value: TEST_TZ1_ALICE }, { type: "string", value: "" }] },
    { sig: "materializeAlias(string,uint8,string)", params: [{ type: "string", value: TEST_TZ1_ALICE }, { type: "uint8", value: 0 }, { type: "string", value: "" }] },
    { sig: "materializeAlias(uint8,string,bytes)", params: [{ type: "uint8", value: 0 }, { type: "string", value: TEST_TZ1_ALICE }, { type: "bytes", value: "0x" }] },
    { sig: "materializeAlias(string,string,bytes)", params: [{ type: "string", value: "tezos" }, { type: "string", value: TEST_TZ1_ALICE }, { type: "bytes", value: "0x" }] },
    { sig: "materializeAlias(string,uint8,bytes)", params: [{ type: "string", value: TEST_TZ1_ALICE }, { type: "uint8", value: 0 }, { type: "bytes", value: "0x" }] },
    { sig: "callMichelsonView(string,string,bytes)", params: [
      { type: "string", value: MICHELSON_GATEWAY },
      { type: "string", value: "staticcall_evm" },
      { type: "bytes", value: "0x030b" },
    ]},
    { sig: "viewMichelson(string,string,bytes)", params: [
      { type: "string", value: MICHELSON_GATEWAY },
      { type: "string", value: "staticcall_evm" },
      { type: "bytes", value: "0x030b" },
    ]},
  ];

  results.precompileProbes.candidateSelectors = {};
  for (const c of candidateSigs) {
    const sel = selectorOf(c.sig);
    const data = encodeCall(c.sig, c.params);
    const r = await evmRpc("eth_call", [{ to: NAC_PRECOMPILE, data }, "latest"]);
    results.precompileProbes.candidateSelectors[c.sig] = {
      selector: sel,
      ok: r.ok,
      result: r.ok ? r.result.slice(0, 130) : undefined,
      error: r.error,
    };
  }

  // 8. Find a recent EVM tx hash and test debug_traceTransaction (callTracer)
  let sampleTxHash = null;
  if (bsTxs.ok && Array.isArray(bsTxs.json?.items) && bsTxs.json.items.length > 0) {
    sampleTxHash = bsTxs.json.items[0].hash;
  } else if (blockNum.ok) {
    const head = parseInt(blockNum.result, 16);
    for (let b = head; b > Math.max(0, head - 25); b--) {
      const blk = await evmRpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]);
      if (blk.ok && blk.result?.transactions?.length > 0) {
        sampleTxHash = blk.result.transactions[0];
        break;
      }
    }
  }

  if (sampleTxHash) {
    const traceRes = await evmRpc("debug_traceTransaction", [
      sampleTxHash,
      { tracer: "callTracer" },
    ]);
    results.evm.debug_traceTransaction = {
      sampleTxHash,
      ok: traceRes.ok,
      topFrameKeys: traceRes.ok && traceRes.result ? Object.keys(traceRes.result) : null,
      type: traceRes.ok ? traceRes.result?.type : null,
      gasUsed: traceRes.ok ? traceRes.result?.gasUsed : null,
      hasSubcalls: traceRes.ok ? Array.isArray(traceRes.result?.calls) && traceRes.result.calls.length > 0 : null,
      error: traceRes.error,
    };
  } else {
    results.evm.debug_traceTransaction = {
      sampleTxHash: null,
      ok: false,
      note: "No recent transaction found in Blockscout or last 25 blocks",
    };
  }

  // Write results JSON
  await writeFile(OUT_PATH, JSON.stringify(results, null, 2) + "\n", "utf8");
  console.log(`Wrote Milestone 0 results to ${OUT_PATH}`);
  console.log("Summary:", JSON.stringify({
    evmChainId: results.evm.eth_chainId.result,
    evmHead: results.evm.eth_blockNumberDecimal,
    michelsonChainId: results.michelson.chain_id.json,
    michelsonHead: results.michelson.header.json?.level,
    kernelVersion: results.evm.tez_kernelVersion,
    precompileByteLen: results.evm.codeChecks.nacPrecompile.byteLength,
    safeFactoryByteLen: results.evm.codeChecks.safeSingletonFactory.byteLength,
    freeRoutePoolByteLen: results.evm.codeChecks.freeRoutePool_fromXpectAug30.byteLength,
    gatewayEntrypoints: results.michelson.gatewayEntrypoints.json ? Object.keys(results.michelson.gatewayEntrypoints.json.entrypoints || {}) : results.michelson.gatewayEntrypoints,
    gatewayViews: results.michelson.gatewayScriptSummary?.views?.map((v) => v.name),
    hardGasLimitPerOp: results.michelson.constantsSummary?.hard_gas_limit_per_operation,
    runScriptViewHttpStatus: results.michelson.run_script_view_probe.httpStatus,
    debugTraceOk: results.evm.debug_traceTransaction.ok,
  }, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
