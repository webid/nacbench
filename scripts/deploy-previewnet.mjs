#!/usr/bin/env node
/**
 * Reset-proof NACBench Canary Deployer (Previewnet v0.11 / Shadownet / Mainnet Horus 8.0).
 *
 * Safety-first:
 * - Defaults to --dry-run whenever EVM_PRIVATE_KEY or TEZOS_SECRET_KEY is absent.
 * - Never prints secret keys.
 * - Discovers nac_canary's live v0.11 EVM alias via 0xff...0007 resolveAddress(kt1, 0, 1)
 *   rather than hardcoding alias math.
 *
 * Usage:
 *   node scripts/deploy-previewnet.mjs --dry-run [--offline] [--network previewnet]
 *   NETWORK=previewnet EVM_PRIVATE_KEY=0x... TEZOS_SECRET_KEY=edsk... node scripts/deploy-previewnet.mjs --live
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeOriginOf,
  decodeResolveAddress,
  encodeOriginOf,
  encodeResolveAddress,
} from "./lib/evm-abi.mjs";
import { evmRpc, loadNetworkConfig, michelsonGet } from "./lib/pinning.mjs";
import {
  buildNacCanaryInitialStorage,
  isValidEvmAddress,
  isValidTezosXAddress,
} from "./lib/tezos-address.mjs";
import { loadProjectDotEnvs } from "./lib/wallets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
loadProjectDotEnvs(ROOT);

const REQUIRED_EVM_FUNCTIONS = [
  "probeWrite",
  "probeRoundTrip",
  "onMichelsonCallback",
  "probeView",
  "probeRollback",
  "probeOog",
  "setAuthorizedKt1Alias",
  "echoView",
  "inspectOrigin",
  "inspectResolve",
];

const REQUIRED_MICHELSON_MARKERS = [
  "%record_ping",
  "%echo_callback",
  "%force_fail",
  "%burn_gas",
  "%set_paired_evm",
  "get_state_digest",
  "probe_evm_staticcall",
  "%call_evm",
];

function parseArgs(argv) {
  const args = {
    network: process.env.NETWORK || "previewnet",
    dryRun: false,
    live: false,
    offline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--live") args.live = true;
    else if (a === "--offline") args.offline = true;
    else if (a === "--network" && argv[i + 1]) args.network = argv[++i];
  }
  const tezosSecretKey = process.env.TEZOS_SECRET_KEY || process.env.TEZOS_PRIVATE_KEY;
  const hasKeys = Boolean(process.env.EVM_PRIVATE_KEY && tezosSecretKey);
  if (!args.live || !hasKeys) {
    args.dryRun = true;
  }
  return args;
}

async function inspectCompiledArtifacts() {
  const evmArtifactPath = resolve(ROOT, "contracts/evm/out/NacCanaryEvm.sol/NacCanaryEvm.json");
  // Pin explicitly to the canonical NacCanary output directory (never scan nac_canary_gateway_integration/MockGateway)
  const tzContract = resolve(ROOT, "contracts/michelson/artifacts/nac_canary/step_001_cont_0_contract.tz");
  const tzStorage = resolve(ROOT, "contracts/michelson/artifacts/nac_canary/step_001_cont_0_storage.tz");

  const report = {
    evm: { found: false, path: evmArtifactPath, missingFunctions: [], bytecodeBytes: 0, ready: false },
    michelson: { found: false, contractPath: tzContract, storagePath: tzStorage, missingMarkers: [], ready: false },
  };

  if (existsSync(evmArtifactPath)) {
    const artifact = JSON.parse(await readFile(evmArtifactPath, "utf8"));
    const fnNames = new Set((artifact.abi || []).filter((x) => x.type === "function").map((x) => x.name));
    const missing = REQUIRED_EVM_FUNCTIONS.filter((f) => !fnNames.has(f));
    const bytecode = artifact.bytecode?.object || "";
    report.evm = {
      found: true,
      path: evmArtifactPath,
      missingFunctions: missing,
      bytecodeBytes: bytecode.startsWith("0x") ? (bytecode.length - 2) / 2 : bytecode.length / 2,
      ready: missing.length === 0 && bytecode.length > 4,
    };
  }

  if (existsSync(tzContract)) {
    const tzSource = await readFile(tzContract, "utf8");
    const missingMarkers = REQUIRED_MICHELSON_MARKERS.filter((m) => !tzSource.includes(m));
    report.michelson = {
      found: true,
      contractPath: tzContract,
      storagePath: existsSync(tzStorage) ? tzStorage : null,
      missingMarkers,
      ready: missingMarkers.length === 0,
    };
  }

  return report;
}

async function checkLiveRpcPreflight(net) {
  const [chainId, blockNum, precompileCode, mChainId, mHeader, mConstants, mGateway] = await Promise.all([
    evmRpc(net.evm.rpcUrl, "eth_chainId"),
    evmRpc(net.evm.rpcUrl, "eth_blockNumber"),
    evmRpc(net.evm.rpcUrl, "eth_getCode", [net.evm.nacPrecompile, "latest"]),
    michelsonGet(net.michelson.rpcUrl, "/chains/main/chain_id"),
    michelsonGet(net.michelson.rpcUrl, "/chains/main/blocks/head/header"),
    michelsonGet(net.michelson.rpcUrl, "/chains/main/blocks/head/context/constants"),
    michelsonGet(net.michelson.rpcUrl, `/chains/main/blocks/head/context/contracts/${net.michelson.evmGateway}/entrypoints`),
  ]);

  const evmHead = blockNum.ok ? parseInt(blockNum.result, 16) : null;
  const michelsonHead = mHeader.ok ? mHeader.json?.level : null;
  const entrypoints = mGateway.ok ? Object.keys(mGateway.json?.entrypoints || {}).sort() : [];

  return {
    reachable: Boolean(chainId.ok && mChainId.ok),
    evmChainIdOk: chainId.ok && parseInt(chainId.result, 16) === net.evm.chainId,
    michelsonChainIdOk: mChainId.ok && mChainId.json === net.michelson.chainId,
    evmHead,
    michelsonHead,
    blockDrift: evmHead != null && michelsonHead != null ? Math.abs(evmHead - michelsonHead) : null,
    precompileExtcodesizeZero: precompileCode.ok && precompileCode.result === "0x",
    michelsonHardGasLimitPerOp: mConstants.ok ? Number(mConstants.json?.hard_gas_limit_per_operation) : null,
    gatewayEntrypoints: entrypoints,
    gatewayReady: entrypoints.includes("call_evm") && entrypoints.includes("materialize_alias"),
  };
}

function runCmd(bin, args, env = process.env) {
  return execFileSync(bin, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = await loadNetworkConfig(args.network);
  const artifacts = await inspectCompiledArtifacts();

  const summary = {
    mode: args.dryRun ? "dry-run" : "live",
    network: net.networkKey,
    networkName: net.name,
    evmChainId: net.evm.chainId,
    michelsonChainId: net.michelson.chainId,
    artifacts,
    preflight: null,
  };

  if (!args.offline) {
    summary.preflight = await checkLiveRpcPreflight(net);
  } else {
    summary.preflight = { skipped: true, reason: "--offline" };
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      ...summary,
      note: "DRY RUN — zero transactions broadcast. Provide --live with EVM_PRIVATE_KEY and TEZOS_SECRET_KEY to execute.",
      liveDeploymentSteps: [
        `1. Originate ${artifacts.michelson.contractPath || "contracts/michelson/artifacts/nac_canary/..._contract.tz"} on ${net.michelson.rpcUrl}`,
        `2. Deploy NacCanaryEvm on ${net.evm.rpcUrl} (chainId ${net.evm.chainId})`,
        `3. Query live resolveAddress(nacCanaryKt1, 0, 1) & originOf(nacCanaryKt1, 0) on ${net.evm.nacPrecompile}`,
        "4. Pair nac_canary.%set_paired_evm(nacCanaryEvmAddr) and NacCanaryEvm.setAuthorizedKt1Alias(kt1EvmAlias)",
        `5. Write deployment manifest to config/deployments/${net.networkKey}.json`,
      ],
    }, null, 2));
    return;
  }

  // Live deployment mode (only reached when --live + both keys explicitly provided)
  if (!artifacts.evm.ready || !artifacts.michelson.ready) {
    throw new Error(
      `Compiled artifacts incomplete. Run 'forge build --root contracts/evm' and 'python3 contracts/michelson/src/nac_canary.py' first.\n${JSON.stringify(artifacts, null, 2)}`,
    );
  }
  if (!summary.preflight?.reachable || !summary.preflight.gatewayReady) {
    throw new Error(`RPC preflight failed:\n${JSON.stringify(summary.preflight, null, 2)}`);
  }

  const octezBin = process.env.OCTEZ_CLIENT_BIN || "octez-client";
  const octezEnv = { ...process.env, TEZOS_CLIENT_UNSAFE_DISABLE_DISCLAIMER: "Y" };
  const forgeBin = process.env.FORGE_BIN || "forge";
  const castBin = process.env.CAST_BIN || "cast";

  const tezosSecretKey = process.env.TEZOS_SECRET_KEY || process.env.TEZOS_PRIVATE_KEY;

  // 1. Import deployer key, derive actual tz1/tz2/tz3 admin address, and originate Michelson NacCanary
  const aliasName = `nacbench-deployer-${Date.now()}`;
  runCmd(
    octezBin,
    ["--endpoint", net.michelson.rpcUrl, "import", "secret", "key", aliasName, `unencrypted:${tezosSecretKey}`, "--force"],
    octezEnv,
  );
  const showAddrOut = runCmd(octezBin, ["--endpoint", net.michelson.rpcUrl, "show", "address", aliasName], octezEnv);
  const addrMatch = showAddrOut.match(/Hash:\s*(tz[123][1-9A-HJ-NP-Za-km-z]{33})/);
  if (!addrMatch || !isValidTezosXAddress(addrMatch[1])) {
    throw new Error(`Failed to resolve deployer tz1/tz2/tz3 address via octez-client show address:\n${showAddrOut}`);
  }
  const deployerTz = addrMatch[1];
  const initStorage = buildNacCanaryInitialStorage(deployerTz, net.michelson.evmGateway);

  const origOut = runCmd(
    octezBin,
    [
      "--endpoint", net.michelson.rpcUrl,
      "originate", "contract", `nac_canary_${Date.now()}`,
      "transferring", "0", "from", aliasName,
      "running", artifacts.michelson.contractPath,
      "--init", initStorage,
      "--burn-cap", "2",
      "--force",
    ],
    octezEnv,
  );
  const kt1Match = origOut.match(/New contract (KT1[1-9A-HJ-NP-Za-km-z]{33}) originated/);
  if (!kt1Match || !isValidTezosXAddress(kt1Match[1])) {
    throw new Error(`Failed to parse originated KT1 address from octez-client output:\n${origOut}`);
  }
  const nacCanaryKt1 = kt1Match[1];

  // 2. Deploy NacCanaryEvm via Foundry
  const forgeOut = runCmd(forgeBin, [
    "create",
    "--root", resolve(ROOT, "contracts/evm"),
    "--rpc-url", net.evm.rpcUrl,
    "--private-key", process.env.EVM_PRIVATE_KEY,
    "--broadcast",
    "src/NacCanaryEvm.sol:NacCanaryEvm",
  ]);
  const evmMatch = forgeOut.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!evmMatch || !isValidEvmAddress(evmMatch[1])) {
    throw new Error(`Failed to parse deployed NacCanaryEvm address:\n${forgeOut}`);
  }
  const nacCanaryEvm = evmMatch[1].toLowerCase();

  // 3. Query live originOf + resolveAddress(kt1, 0, 1) on 0xff...0007
  const [originRaw, resolveRaw] = await Promise.all([
    evmRpc(net.evm.rpcUrl, "eth_call", [{ to: net.evm.nacPrecompile, data: encodeOriginOf(nacCanaryKt1, 0) }, "latest"]),
    evmRpc(net.evm.rpcUrl, "eth_call", [{ to: net.evm.nacPrecompile, data: encodeResolveAddress(nacCanaryKt1, 0, 1) }, "latest"]),
  ]);
  const originDecoded = originRaw.ok ? decodeOriginOf(originRaw.result) : null;
  const resolveDecoded = resolveRaw.ok ? decodeResolveAddress(resolveRaw.result) : null;
  const kt1EvmAlias = resolveDecoded?.translated || null;
  if (!kt1EvmAlias || !isValidEvmAddress(kt1EvmAlias)) {
    throw new Error(`Could not resolve live v0.11 EVM alias for ${nacCanaryKt1}: ${JSON.stringify(resolveDecoded)}`);
  }

  // 4. Pair both contracts (admin == deployerTz so %set_paired_evm succeeds)
  runCmd(
    octezBin,
    [
      "--endpoint", net.michelson.rpcUrl,
      "transfer", "0", "from", aliasName,
      "to", nacCanaryKt1,
      "--entrypoint", "set_paired_evm",
      "--arg", `"${nacCanaryEvm}"`,
      "--burn-cap", "0.5",
    ],
    octezEnv,
  );
  runCmd(castBin, [
    "send", nacCanaryEvm,
    "setAuthorizedKt1Alias(address)", kt1EvmAlias,
    "--rpc-url", net.evm.rpcUrl,
    "--private-key", process.env.EVM_PRIVATE_KEY,
  ]);

  // 5. Write deployment manifest
  const deployDir = resolve(ROOT, "config/deployments");
  await mkdir(deployDir, { recursive: true });
  const manifestPath = resolve(deployDir, `${net.networkKey}.json`);
  const manifest = {
    deployedAt: new Date().toISOString(),
    network: net.networkKey,
    kernelTrack: net.kernelTrack,
    evmChainId: net.evm.chainId,
    michelsonChainId: net.michelson.chainId,
    contracts: {
      nacCanaryEvm,
      nacCanaryKt1,
      nacCanaryKt1EvmAlias: kt1EvmAlias,
      nacPrecompile: net.evm.nacPrecompile,
      michelsonGateway: net.michelson.evmGateway,
    },
    v011IdentityCheck: {
      originOfKt1: originDecoded,
      resolveKt1ToEvm: resolveDecoded,
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Deployment complete. Manifest written to ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error("deploy-previewnet failed:", err.message || err);
  process.exit(1);
});
