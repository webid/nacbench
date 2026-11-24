# NACBench

**Live Tezos X Native Atomic Composability (NAC) Workbench, Horus 8.0 Alias Materializer & Block-Pinned Dual-Runtime Debugger**

NACBench is an open-source, zero-TVL developer workbench for building, debugging, and verifying cross-runtime smart contracts across the **Etherlink EVM** and **Tezos Michelson** interfaces on **Tezos X Previewnet v0.11 (Horus 8.0 RC)**, **Etherlink Shadownet**, and **Etherlink Mainnet**.

---

## What NACBench Includes

### 1. Interactive Web Workbench (`apps/web`)
A static React 19 + TypeScript + Vite SPA with zero backend dependencies and direct browser RPC queries:

- **Module 1 — Codec & Guardrail-Baked Snippets:**
  - Instant, zero-RPC binary Micheline ↔ Solidity ABI encoder/decoder (supports `Prim_N` `0x09`, annotated primitives `0x04`/`0x06`/`0x08`, and `0x05` PACK prefix).
  - Live **6-point Tezos X v0.11 / Horus 8.0 guardrail check**: `EXTCODESIZE == 0` precompile trap (`0xff00…0007`), `10^12` wei↔mutez dust alignment, `%call_evm` (args-only) vs `staticcall_evm` (4-byte selector) asymmetry, `5M` EVM vs `660k` Michelson op gas cap, callback alias auth, and null Michelson `SOURCE == tz1Ke2h7…`.
  - Built-in **Raw Micheline & Cross-Runtime Revert Decoder** (Solidity `Error(string)`, `Panic(uint256)`, and Previewnet raw UTF-8 `429 Too Many Requests: OOG` errors).
  - Direction-accurate copy-paste snippets for **Solidity 0.8.24**, **EVM / `@tezos-x/octez.js` v25 (`methodsObject`)**, **SmartPy (`@sp.module`)**, and a **Selector Cheat-Sheet**.
- **Module 2 — Horus 8.0 Alias Materializer & Block-Pinned State Diff:**
  - Live `originOf(string,uint8)` and `resolveAddress(string,uint8,uint8)` inspection against `0xff00…0007` with Safe-CREATE2 (`tz1`/`tz2`/`tz3`) vs Keccak-256 (`KT1`) alias classification and explicit BLS `tz4` rejection.
  - Live Horus 8.0 alias materialization via EVM precompile `materializeAlias(string,string,string)` (`0xbfe88b4b`) with EIP-6963 wallet support, plus copyable `octez-client` and `@tezos-x/octez.js` `%materialize_alias` commands.
  - **Block-Pinned Dual-Runtime State Diff (`EVM block N == Michelson level N`)** with live BLAKE2b-256 `big_map` `expr…` key hashing.
- **Module 3 — Live Canary Lab & `429 OOG` Trace Debugger:**
  - Interactive executor for all 5 paired Canary probes (`probeWrite → %record_ping`, `probeRoundTrip → %echo_callback → onMichelsonCallback`, zero-wallet `probeView` with double-ABI unwrap, `probeRollback → %force_fail`, and `probeOog → %burn_gas` catch/propagate).
  - Progressive transaction debugger (`debug_traceTransaction(callTracer)` → Blockscout v2 fallback → receipt-only), surfacing caught inner `0xff00…0007` `429 OOG` reverts even when the outer receipt has `status: 0x1`, computing deterministic mirrored Michelson `o…` operation hashes for TzKT links.

### 2. Paired Previewnet v0.11 Canary Contracts (`contracts/`)
- **EVM (`contracts/evm/src/`):** `Micheline.sol`, `NativeAtomicGatewayLib.sol` (strict low-level `.call`/`.staticcall`), and `NacCanaryEvm.sol` with full Foundry unit tests.
- **Michelson (`contracts/michelson/src/nac_canary.py`):** SmartPy v0.17+ (`@sp.module`) contract paired byte-for-byte with `NacCanaryEvm.sol` (including `%record_ping`, `%echo_callback`, `%force_fail`, `%burn_gas`, `get_state_digest`, and `probe_evm_staticcall`).

### 3. Zero-Dependency CLI Scripts (`scripts/`)
- Pure Node.js >= 20 (`node:crypto`) disposable Previewnet wallet generator, reset-proof paired deployer, read-only/live 5-probe verifier, and M0 RPC verification gate.

---

## Complementary Role Alongside `Migl992/nactrace` & `0xTzKT`

NACBench is designed to **complement—not duplicate—[`Migl992/nactrace`](https://github.com/Migl992/nactrace)** and **`0xTzKT`**:

- **`nactrace`** excels at post-hoc cross-runtime transaction and operation hash archaeology (CLI, `@nactrace/core`, embeddable widget, Hardhat/Foundry tasks).
- **NACBench** covers the proactive build, materialize, and live-probe loop: Micheline↔ABI encoding, guardrailed code generation, Horus 8.0 `0xbfe88b4b` / `%materialize_alias` execution, live Canary contract probes, and arbitrary block-pinned state diffs.
- Every transaction inspected or sent in NACBench Module 3 provides 1-click handoff links to **`https://migl992.github.io/nactrace/?hash=<txHash>&network=<network>`**, **Blockscout**, and the mirrored **TzKT** operation.

---

## Verified Tezos X Previewnet v0.11 Endpoints & Live Canary Pair

| Component | Previewnet Value |
| --- | --- |
| EVM RPC / Chain ID | `https://evm.previewnet.tezosx.nomadic-labs.com` (`128064`) |
| Michelson RPC / Chain ID | `https://michelson.previewnet.tezosx.nomadic-labs.com` (`NetXY2oPPzkxUW1`) |
| EVM NAC Precompile (`EXTCODESIZE == 0`) | `0xff00000000000000000000000000000000000007` |
| Michelson Enshrined EVM Gateway | `KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw` |
| Null Cross-Runtime Michelson `SOURCE` | `tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU` |
| Verified Selectors (`0xff…0007`) | `callMichelsonView`: `0x8326329c` · `materializeAlias`: `0xbfe88b4b` |
| Recommended EVM Gas / Michelson Op Cap | `5,000,000` EVM gas / `660,000` Michelson hard op gas |
| Live `NacCanaryEvm` (Previewnet) | `0xd6b843047210c2fbeb6b9b9073bcacb64bb68cf5` |
| Live `nac_canary` KT1 (Previewnet) | `KT1JcRVBhqTivsAbsrjS5BuKiYtmhjb6jn3Z` |
| Live `nac_canary` Resolved EVM Alias | `0x9A15bA8206d7EB58DFD1B41f0Ac7C86C4aD0984F` |

> See [`docs/NAC-FIELD-GUIDE.md`](./docs/NAC-FIELD-GUIDE.md) for the complete Tezos X Previewnet v0.11 / Horus 8.0 NAC field guide, verified footguns, mirrored Michelson op hash recipe, and ecosystem submission kit.

---

## Self-Hosting on VPS (`https://nacbench.thetezos.com`)

NACBench compiles to a 100% static SPA (`apps/web/dist`) with direct browser RPC calls and ships with an Nginx + Certbot + `rsync` self-hosting kit under [`deploy/vps/`](./deploy/vps/README.md):

```bash
# One-time server provisioning on your VPS (creates /var/www/nacbench owned by <your-vps-user>:www-data, Nginx + Certbot TLS)
ssh <your-vps-host> 'mkdir -p ~/nacbench-vps-setup'
scp deploy/vps/nacbench.thetezos.com.nginx.conf deploy/vps/setup-server.sh <your-vps-host>:~/nacbench-vps-setup/
ssh -t <your-vps-host> 'sudo bash ~/nacbench-vps-setup/setup-server.sh'

# Subsequent deployments from local machine (zero sudo; or set VPS_HOST in local .env)
VPS_HOST=<your-vps-host> npm run deploy:vps
```

---

## Quickstart

### 1. Run the Web Workbench Locally
```bash
npm --prefix apps/web install
npm run web:dev
```

### 2. Generate Disposable Previewnet Wallets (Zero External Deps)
Generates a fresh Ed25519 Tezos wallet (`tz1` / `edpk` / `edsk`) and secp256k1 EVM wallet (`0x` EIP-55) into git-ignored `.env.previewnet` (`chmod 600`, refuses overwrite, never prints secrets):
```bash
npm run wallets:generate
```
Fund **both** printed public addresses (`tz1…` and `0x…`) at the Previewnet faucet:
`https://faucet.previewnet.tezosx.nomadic-labs.com`

### 3. Deploy & Verify the Live Canary Pair on Previewnet
```bash
# Offline safety dry-run first (zero broadcast)
node scripts/deploy-previewnet.mjs --dry-run --offline

# Live paired deployment (auto-loads .env.previewnet, writes config/deployments/previewnet.json)
npm run deploy:previewnet -- --live

# Read-only verification against deployed manifest
npm run verify:canary

# Live 5-probe verification + proof collector (writes deploy/evidence/previewnet/*.json)
npm run verify:canary -- --live
```

---

## Repository Structure

```text
├── apps/web/                   # React 19 + TypeScript + Vite static NACBench SPA
│   └── src/
│       ├── components/         # Header, CodecModule, AliasInspectorModule, CanaryLabModule
│       └── lib/                # Pure browser-safe codec, rpc, snippets, wallets, canary + Vitest suites
├── config/
│   └── networks.json           # Previewnet v0.11, Shadownet, and Mainnet RPC & gateway profiles
├── contracts/
│   ├── evm/                    # Foundry project: Micheline.sol, NativeAtomicGatewayLib.sol, NacCanaryEvm.sol
│   └── michelson/              # SmartPy v0.17+ nac_canary.py + compiled Michelson artifacts
└── scripts/                    # Zero-dep Node 20 M0 verifier, wallet generator, deployer & canary verifier
```

---

## Running All Tests

```bash
# Solidity contracts (Foundry)
npm run contracts:evm:test

# Michelson contract compile & SmartPy test scenarios
npm run contracts:michelson:test

# Node.js library syntax checks & cryptographic/RPC unit tests (incl. live octez-client parity)
npm run scripts:check
npm run scripts:test

# Web SPA TypeScript check, Vitest unit tests, and production Vite bundle
npm run web:typecheck
npm run web:test
npm run web:build
```

---

## License

MIT License — see [LICENSE](./LICENSE). Copyright (c) 2026 PurpleMatter / webid.
