#!/usr/bin/env node
/**
 * NACBench 5-Probe Automated Canary Verifier & Proof Collector.
 *
 * Modes:
 * - --read-only / --dry-run (default): zero transactions; verifies manifest, gateway health,
 *   originOf / resolveAddress, read-only eth_call probeView + echoView, run_script_view,
 *   and block-pinned dual-runtime snapshot.
 * - --live (requires EVM_PRIVATE_KEY + deployment manifest): executes all 5 probes
 *   (probeWrite, probeRoundTrip, probeView, probeRollback, probeOog catch + propagate),
 *   collects debug_traceTransaction (callTracer) frames + block-pinned state diffs,
 *   and writes dated proof JSON under deploy/evidence/<network>/.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeCrossRuntimeRevert,
  decodeOriginOf,
  decodeResolveAddress,
  encodeEchoViewCalldata,
  encodeFunctionCall,
  encodeOriginOf,
  encodeResolveAddress,
} from "./lib/evm-abi.mjs";
import { assertMutezAligned, bytesToHex, decodeMicheline, encodeNat } from "./lib/micheline.mjs";
import {
  diffSnapshots,
  evmRpc,
  fetchPinnedSnapshot,
  loadNetworkConfig,
  michelsonGet,
  michelsonPost,
} from "./lib/pinning.mjs";
import { loadProjectDotEnvs } from "./lib/wallets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
loadProjectDotEnvs(ROOT);

function parseArgs(argv) {
  const args = {
    network: process.env.NETWORK || "previewnet",
    readOnly: true,
    offline: false,
    evmAddr: null,
    kt1Addr: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--read-only" || a === "--dry-run") args.readOnly = true;
    else if (a === "--live") args.readOnly = false;
    else if (a === "--offline") args.offline = true;
    else if (a === "--network" && argv[i + 1]) args.network = argv[++i];
    else if (a === "--evm" && argv[i + 1]) args.evmAddr = argv[++i];
    else if (a === "--kt1" && argv[i + 1]) args.kt1Addr = argv[++i];
  }
  if (!args.readOnly && !process.env.EVM_PRIVATE_KEY) {
    args.readOnly = true;
  }
  return args;
}

async function loadDeploymentManifest(networkKey) {
  const p = resolve(ROOT, `config/deployments/${networkKey}.json`);
  if (!existsSync(p)) return { found: false, path: p, manifest: null };
  return { found: true, path: p, manifest: JSON.parse(await readFile(p, "utf8")) };
}

function tryParseReceiptJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sendCastTx(
  rpcUrl,
  privateKey,
  to,
  sig,
  sigArgs = [],
  { valueWei = null, gasLimit = null, expectRevert = false } = {},
) {
  const castBin = process.env.CAST_BIN || "cast";
  const cliArgs = ["send", to, sig, ...sigArgs, "--rpc-url", rpcUrl, "--private-key", privateKey, "--json"];
  if (valueWei !== null) cliArgs.push("--value", String(valueWei));
  if (gasLimit !== null) cliArgs.push("--gas-limit", String(gasLimit));

  try {
    const out = execFileSync(castBin, cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const receipt = tryParseReceiptJson(out);
    const revertedOnChain = receipt && (receipt.status === "0x0" || receipt.status === 0 || receipt.status === "0");
    return { ok: !revertedOnChain, revertedOnChain: Boolean(revertedOnChain), receipt };
  } catch (err) {
    // Always fail loudly on missing binary or transport/CLI errors (never false-pass as reverted!)
    if (err?.code === "ENOENT") {
      throw new Error(`Missing Foundry 'cast' binary (${castBin}): ${err.message}`);
    }
    const stdoutText = String(err?.stdout || "");
    const stderrText = String(err?.stderr || err?.message || err);
    const receipt = tryParseReceiptJson(stdoutText) || tryParseReceiptJson(stderrText);
    const revertedOnChain = Boolean(
      receipt && (receipt.status === "0x0" || receipt.status === 0 || receipt.status === "0"),
    );
    const isExplicitEvmRevert =
      revertedOnChain || /execution reverted|transaction failed|reverted/i.test(stderrText);

    if (!expectRevert || !isExplicitEvmRevert) {
      throw new Error(`cast send failed (${sig}): ${stderrText.slice(0, 800)}`);
    }
    return {
      ok: false,
      revertedOnChain,
      receipt,
      stderr: stderrText.slice(0, 800),
    };
  }
}

async function traceTxIfSupported(net, txHash) {
  if (!txHash) return null;
  const tr = await evmRpc(net.evm.rpcUrl, "debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
  return tr.ok ? { ok: true, trace: tr.result } : { ok: false, error: tr.error };
}

async function runReadOnlyChecks(net, evmAddr, kt1Addr) {
  const out = {
    gatewayHealth: {},
    identity: {},
    views: {},
    pinnedSnapshot: null,
  };

  // 1. Gateway health
  const [precompileCode, mEntrypoints, mConstants] = await Promise.all([
    evmRpc(net.evm.rpcUrl, "eth_getCode", [net.evm.nacPrecompile, "latest"]),
    michelsonGet(net.michelson.rpcUrl, `/chains/main/blocks/head/context/contracts/${net.michelson.evmGateway}/entrypoints`),
    michelsonGet(net.michelson.rpcUrl, "/chains/main/blocks/head/context/constants"),
  ]);
  const epList = mEntrypoints.ok ? Object.keys(mEntrypoints.json?.entrypoints || {}).sort() : [];
  out.gatewayHealth = {
    precompileExtcodesizeZero: precompileCode.ok && precompileCode.result === "0x",
    michelsonGatewayEntrypoints: epList,
    callEvmPresent: epList.includes("call_evm"),
    materializeAliasPresent: epList.includes("materialize_alias"),
    michelsonHardGasLimitPerOp: mConstants.ok ? Number(mConstants.json?.hard_gas_limit_per_operation) : null,
  };

  // 2. Identity checks via 0xff...0007
  if (kt1Addr) {
    const [oKt1, rKt1] = await Promise.all([
      evmRpc(net.evm.rpcUrl, "eth_call", [{ to: net.evm.nacPrecompile, data: encodeOriginOf(kt1Addr, 0) }, "latest"]),
      evmRpc(net.evm.rpcUrl, "eth_call", [{ to: net.evm.nacPrecompile, data: encodeResolveAddress(kt1Addr, 0, 1) }, "latest"]),
    ]);
    out.identity.kt1Origin = oKt1.ok ? decodeOriginOf(oKt1.result) : oKt1.error;
    out.identity.kt1ToEvm = rKt1.ok ? decodeResolveAddress(rKt1.result) : rKt1.error;
  }
  if (evmAddr) {
    const [oEvm, rEvm] = await Promise.all([
      evmRpc(net.evm.rpcUrl, "eth_call", [{ to: net.evm.nacPrecompile, data: encodeOriginOf(evmAddr, 1) }, "latest"]),
      evmRpc(net.evm.rpcUrl, "eth_call", [{ to: net.evm.nacPrecompile, data: encodeResolveAddress(evmAddr, 1, 0) }, "latest"]),
    ]);
    out.identity.evmOrigin = oEvm.ok ? decodeOriginOf(oEvm.result) : oEvm.error;
    out.identity.evmToMichelson = rEvm.ok ? decodeResolveAddress(rEvm.result) : rEvm.error;
  }

  // 3. Read-only views (probeView + echoView + run_script_view with unparsing_mode)
  if (evmAddr && kt1Addr) {
    const probeViewData = encodeFunctionCall("probeView(string,uint256)", [
      { type: "string", value: kt1Addr },
      { type: "uint256", value: 42n },
    ]);
    const echoViewData = encodeEchoViewCalldata(42n);
    const [pvRes, evRes, rsvRes] = await Promise.all([
      evmRpc(net.evm.rpcUrl, "eth_call", [{ to: evmAddr, data: probeViewData }, "latest"]),
      evmRpc(net.evm.rpcUrl, "eth_call", [{ to: evmAddr, data: echoViewData }, "latest"]),
      michelsonPost(net.michelson.rpcUrl, "/chains/main/blocks/head/helpers/scripts/run_script_view", {
        contract: kt1Addr,
        view: "get_state_digest",
        input: { int: "42" },
        chain_id: net.michelson.chainId,
        unlimited_gas: true,
        unparsing_mode: "Readable",
      }),
    ]);
    out.views.probeView = pvRes.ok
      ? { ok: true, raw: pvRes.result }
      : { ok: false, decodedRevert: decodeCrossRuntimeRevert(pvRes.error?.data) };
    out.views.echoView = evRes.ok ? { ok: true, raw: evRes.result } : { ok: false, error: evRes.error };
    out.views.runScriptView_get_state_digest = rsvRes;
  }

  // 4. Block-pinned dual-runtime snapshot
  out.pinnedSnapshot = await fetchPinnedSnapshot(net, {
    evmAddress: evmAddr,
    michelsonKt1: kt1Addr,
  });

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = await loadNetworkConfig(args.network);
  const { found: manifestFound, path: manifestPath, manifest } = await loadDeploymentManifest(net.networkKey);

  const evmAddr = args.evmAddr || manifest?.contracts?.nacCanaryEvm || null;
  const kt1Addr = args.kt1Addr || manifest?.contracts?.nacCanaryKt1 || null;

  if (args.offline) {
    console.log(JSON.stringify({
      mode: "read-only-offline",
      network: net.networkKey,
      manifestFound,
      manifestPath,
      contracts: { evmAddr, kt1Addr },
      sampleEncodings: {
        nat42Micheline: bytesToHex(encodeNat(42)),
        nat42Decoded: decodeMicheline(encodeNat(42)),
        echoView42Calldata: encodeEchoViewCalldata(42n),
      },
      note: "Offline check passed; rerun without --offline for live RPC verification.",
    }, null, 2));
    return;
  }

  const readOnlyResult = await runReadOnlyChecks(net, evmAddr, kt1Addr);

  if (args.readOnly) {
    console.log(JSON.stringify({
      executedAt: new Date().toISOString(),
      mode: "read-only",
      network: net.networkKey,
      manifestFound,
      contracts: { evmAddr, kt1Addr },
      ...readOnlyResult,
    }, null, 2));
    return;
  }

  // Full 5-probe live mode (only when --live AND EVM_PRIVATE_KEY AND deployed contracts exist)
  if (!evmAddr || !kt1Addr) {
    throw new Error(`Live 5-probe verification requires deployed addresses (manifest ${manifestPath} not found; run deploy-previewnet.mjs --live first).`);
  }

  const pk = process.env.EVM_PRIVATE_KEY;
  const gasCap = String(net.evm.recommendedGasCall || 5_000_000);
  const valueWei = assertMutezAligned(1_000_000_000_000n); // exactly 1 mutez (10^12 wei)
  const probes = {};

  // Probe 1: probeWrite
  const beforeWrite = await fetchPinnedSnapshot(net, { evmAddress: evmAddr, michelsonKt1: kt1Addr });
  const writeTx = sendCastTx(net.evm.rpcUrl, pk, evmAddr, "probeWrite(string,string,uint256)", [kt1Addr, "nacbench-m1-ping", gasCap], { valueWei });
  const afterWrite = await fetchPinnedSnapshot(net, { evmAddress: evmAddr, michelsonKt1: kt1Addr });
  probes.probeWrite = {
    txHash: writeTx.receipt?.transactionHash,
    status: writeTx.receipt?.status,
    diff: diffSnapshots(beforeWrite, afterWrite),
    trace: await traceTxIfSupported(net, writeTx.receipt?.transactionHash),
  };

  // Probe 2: probeRoundTrip (nested EVM -> Michelson -> EVM)
  const beforeRt = await fetchPinnedSnapshot(net, { evmAddress: evmAddr, michelsonKt1: kt1Addr });
  const rtTx = sendCastTx(net.evm.rpcUrl, pk, evmAddr, "probeRoundTrip(string,uint256,uint256)", [kt1Addr, "777", gasCap]);
  const afterRt = await fetchPinnedSnapshot(net, { evmAddress: evmAddr, michelsonKt1: kt1Addr });
  probes.probeRoundTrip = {
    txHash: rtTx.receipt?.transactionHash,
    status: rtTx.receipt?.status,
    diff: diffSnapshots(beforeRt, afterRt),
    trace: await traceTxIfSupported(net, rtTx.receipt?.transactionHash),
  };

  // Probe 3: probeView (read-only synchronous view)
  probes.probeView = readOnlyResult.views.probeView;

  // Probe 4: probeRollback (explicit --gas-limit so reverted tx is mined on-chain with txHash + callTracer)
  const beforeRb = await fetchPinnedSnapshot(net, { evmAddress: evmAddr, michelsonKt1: kt1Addr });
  const rbTx = sendCastTx(
    net.evm.rpcUrl,
    pk,
    evmAddr,
    "probeRollback(string,string,uint256)",
    [kt1Addr, "INTENTIONAL_ROLLBACK", gasCap],
    { gasLimit: 6_000_000, expectRevert: true },
  );
  const afterRb = await fetchPinnedSnapshot(net, { evmAddress: evmAddr, michelsonKt1: kt1Addr });
  probes.probeRollback = {
    txHash: rbTx.receipt?.transactionHash || null,
    status: rbTx.receipt?.status ?? null,
    revertedOnChain: rbTx.revertedOnChain,
    revertedAsExpected: !rbTx.ok && (rbTx.revertedOnChain || Boolean(rbTx.stderr)),
    diff: diffSnapshots(beforeRb, afterRb),
    trace: await traceTxIfSupported(net, rbTx.receipt?.transactionHash),
    errorPreview: rbTx.stderr || null,
  };

  // Probe 5: probeOog (catchRevert=true + catchRevert=false with explicit --gas-limit above Etherlink DA floor)
  const oogCatchTx = sendCastTx(
    net.evm.rpcUrl,
    pk,
    evmAddr,
    "probeOog(string,uint256,uint256,bool)",
    [kt1Addr, "1000", "30000", "true"],
    { gasLimit: 6_000_000 },
  );
  const oogPropTx = sendCastTx(
    net.evm.rpcUrl,
    pk,
    evmAddr,
    "probeOog(string,uint256,uint256,bool)",
    [kt1Addr, "1000", "30000", "false"],
    { gasLimit: 3_000_000, expectRevert: true },
  );
  probes.probeOog = {
    catchMode: {
      txHash: oogCatchTx.receipt?.transactionHash || null,
      status: oogCatchTx.receipt?.status ?? null,
      trace: await traceTxIfSupported(net, oogCatchTx.receipt?.transactionHash),
    },
    propagateMode: {
      txHash: oogPropTx.receipt?.transactionHash || null,
      status: oogPropTx.receipt?.status ?? null,
      revertedOnChain: oogPropTx.revertedOnChain,
      revertedAsExpected: !oogPropTx.ok && (oogPropTx.revertedOnChain || Boolean(oogPropTx.stderr)),
      trace: await traceTxIfSupported(net, oogPropTx.receipt?.transactionHash),
      errorPreview: oogPropTx.stderr || null,
    },
  };

  const dateTag = new Date().toISOString().slice(0, 10);
  const evidenceDir = resolve(ROOT, `deploy/evidence/${net.networkKey}`);
  await mkdir(evidenceDir, { recursive: true });
  const proofPath = resolve(evidenceDir, `canary-proof-${dateTag}.json`);
  const proof = {
    executedAt: new Date().toISOString(),
    network: net.networkKey,
    contracts: { evmAddr, kt1Addr },
    readOnlyBaseline: readOnlyResult,
    probes,
  };
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n", "utf8");
  console.log(`Live 5-probe proof written to ${proofPath}`);
}

main().catch((err) => {
  console.error("verify-canary failed:", err.message || err);
  process.exit(1);
});
