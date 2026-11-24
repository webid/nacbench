# Tezos X Previewnet v0.11 / Horus 8.0 — NAC Developer Field Guide

**Maintained by:** NACBench (`https://nacbench.thetezos.com` · `https://github.com/webid/nacbench`)  
**Last Live-Verified:** November 23–24, 2026 against Tezos X Previewnet v0.11 (`octez-evm-node 0.69`, kernel `30d6f6e14ebb5d4ce8ca0fa8089775dcba3a87c2`, Protocol `PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY`)  
**Cross-Referenced With:** NACBench live M0–M3 RPC probes & deployed Canary pair (`0xd6b843047210c2fbeb6b9b9073bcacb64bb68cf5` / `KT1JcRVBhqTivsAbsrjS5BuKiYtmhjb6jn3Z`), `etherlink/CHANGES_TEZOSX.md`, `@tezos-x/octez.js` v25.1, and [`Migl992/nactrace` `docs/FINDINGS.md`](https://github.com/Migl992/nactrace/blob/main/docs/FINDINGS.md).

> **Scope Rule:** Native Atomic Composability (NAC) composes **EVM** and **Michelson** synchronously inside the **same shared ~500ms Etherlink / Tezos X Smart Rollup**. Tezos Layer 1 remains behind the asynchronous Smart Rollup bridge (`bridge.etherlink.com`)—and L1 internal rollup-inbox messages are not routed to Michelson application contracts.

---

## 1. Live Previewnet v0.11 / Horus 8.0 Network & Gateway Reference

### 1.1 Endpoints, Chain IDs & Verified Gas Ceilings

| Parameter | Tezos X Previewnet (`v0.11` / Horus 8.0 RC) | Etherlink Shadownet | Etherlink Mainnet (`7.3` → Horus `8.0` Nov 30, 2026) |
| :--- | :--- | :--- | :--- |
| **EVM Chain ID** | `128064` (`0x1f440`) | `127823` (`0x1f34f`) | `42793` (`0xa729`) |
| **EVM JSON-RPC** | `https://evm.previewnet.tezosx.nomadic-labs.com` | `https://node.shadownet.etherlink.com` | `https://node.mainnet.etherlink.com` |
| **EVM Explorer** | `https://blockscout.previewnet.tezosx.nomadic-labs.com` | `https://shadownet.explorer.etherlink.com` | `https://explorer.etherlink.com` |
| **Michelson Chain ID** | `NetXY2oPPzkxUW1` | `NetXtLrzvQDobza` | `NetXohUVN5QWR4f` |
| **Michelson RPC** | `https://michelson.previewnet.tezosx.nomadic-labs.com` | `https://michelson.etherlink.shadownet.octez.io` | `https://michelson.etherlink.mainnet.octez.io` |
| **Michelson Explorer** | `https://tzkt.previewnet.tezosx.nomadic-labs.com` | `https://shadownet.etherlink.tzkt.io` | `https://etherlink.tzkt.io` |
| **`debug_traceTransaction` (`callTracer`)** | **Live on public RPC** *(verified Nov 23–24, 2026)* | Refused on public RPC (`-32053`, per `nactrace`) | Refused on public RPC (`-32053`, requires API key) |
| **EVM NAC Recommended Gas** | `3,000,000` (transfer) / **`5,000,000`** (contract call) | `3,000,000` / `5,000,000` | `3,000,000` / `5,000,000` |
| **Michelson `hard_gas_limit_per_operation`** | **`660,000`** *(lower than Tezos L1's 1,040,000!)* | `660,000` | `660,000` |
| **Michelson `hard_storage_limit_per_operation`** | `60,000` (`cost_per_byte = 1` mutez) | — | — |
| **Faucet** | `https://faucet.previewnet.tezosx.nomadic-labs.com` *(funds both `0x` and `tz1`)* | `https://shadownet.faucet.etherlink.com/` | N/A |

### 1.2 Enshrined Gateways & Verified v0.11 / Horus 8.0 ABIs

- **EVM Precompile Gateway:** `0xff00000000000000000000000000000000000007` *(returns `0x` on `eth_getCode` — `EXTCODESIZE == 0`!)*
  - `callMichelson(string destination, string entrypoint, bytes data)` → selector **`0xa1544fc3`**
  - `callMichelsonView(string destination, string viewName, bytes data)` → selector **`0x8326329c`**
  - `originOf(string addr, uint8 sourceRuntime)` → `(uint8 kind, uint8 homeRuntime, string nativeAddress)` (`0 = Michelson`, `1 = EVM`; `kind: 0 = Unknown, 1 = Native, 2 = Alias`)
  - `resolveAddress(string addr, uint8 sourceRuntime, uint8 targetRuntime)` → `(bool classified, uint8 resolution, string translated)` (`resolution: 0 = Recorded/Unknown, 1 = Derived Alias`)
  - `materializeAlias(string nativeRuntime, string nativeAddress, string publicKey)` → selector **`0xbfe88b4b`** *(requires `nativeRuntime = "tezos"` and Base58Check `edpk`/`sppk`/`p2pk` public key for `tz1/tz2/tz3` Safe-CREATE2 verification)*
- **Michelson Enshrined Gateway:** `KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw`
  - **Entrypoints (live-verified):**
    - `%call_evm`: `pair string string bytes (option (contract bytes))` *(4 fields: `(destination, selector_string, abi_args_without_selector, callback)`)*
    - `%materialize_alias`: `pair string string (option string)` *(3 fields: `(native_runtime, native_address, Some pubkey)`)*
    - `%call`: `pair string (list (pair string string)) bytes nat (option (contract bytes))`
    - `%collect_result`: `bytes`
  - **On-Chain Views (live-verified):**
    - `staticcall_evm` *(exact `snake_case`!)*: `pair string bytes -> bytes`
    - `originOf`: `pair string nat -> or unit (or nat (pair nat string))`
    - `resolveAddress`: `pair string nat nat -> option (pair nat string)`
- **Live NACBench Previewnet v0.11 Canary Reference Pair (`config/deployments/previewnet.json`):**
  - `NacCanaryEvm` (Solidity `0.8.24`): `0xd6b843047210c2fbeb6b9b9073bcacb64bb68cf5`
  - `nac_canary` (SmartPy): `KT1JcRVBhqTivsAbsrjS5BuKiYtmhjb6jn3Z`
  - Live resolved `KT1` EVM Alias: `0x9A15bA8206d7EB58DFD1B41f0Ac7C86C4aD0984F`
- **Permanently Retired / Unsupported Primitives (DO NOT USE):**
  - Retired v0.10 token wrappers: `0xff00…0009` (`0x`) and `KT18oDJJKXMKhfE1bSuAPGp92pYcwVKvCChb` (`HTTP 404`).
  - Unsupported on Etherlink Michelson interface: **BLS `tz4` accounts**, **Tickets**, **Sapling**, **Timelocks**, **Global Constants**, and paused **Jstz**.

---

## 2. The 8 Verified Cross-Runtime Footguns & Exact Fixes

| # | Footgun | Observed Failure Mode | Exact Verified Fix |
|---|---|---|---|
| **1** | **`EXTCODESIZE == 0` Zero-Bytecode Precompile Trap** | Calling `INativeAtomicGateway(0xff…0007).callMichelson(...)` through a high-level Solidity `0.8.x` interface reverts silently because `solc` injects an `EXTCODESIZE > 0` check and `eth_getCode(0xff…0007)` returns `0x`. | Always invoke `0xff00…0007` via low-level `.call{value, gas}(abi.encodeWithSelector(...))` or `.staticcall(...)` and bubble raw revert bytes via inline assembly (`NativeAtomicGatewayLib.sol`). |
| **2** | **`10^12` Wei ↔ Mutez Dust Truncation** | EVM uses 18 decimals (`wei`) and Michelson uses 6 (`mutez`). Forwarding any `msg.value` where `msg.value % 1e12 != 0` silently truncates the sub-mutez remainder across the gateway. | Enforce `require(msg.value % 1e12 == 0, "Sub-mutez dust")` in Solidity (`Micheline.assertMutezAligned`) and client-side before sending native value EVM → Michelson. |
| **3** | **`%call_evm` vs. `staticcall_evm` Selector Asymmetry** | `%call_evm` takes the 4-field record `(destination, selector_string, abi_args, callback)` and **auto-computes** the 4-byte Keccak-256 selector from `selector_string`. Passing a 4-byte selector inside `abi_args` corrupts calldata. Conversely, `staticcall_evm` (`snake_case`) **requires** the caller to manually prepend the 4-byte selector! | Strip the 4-byte selector for `%call_evm` (`data = encodeAbiParams(...)`); prepend the 4-byte selector for `staticcall_evm` (`calldata = encodeFunctionCall(sig, ...)`). |
| **4** | **`callMichelsonView` Double-ABI Unwrap** *(caught via `nactrace` `FINDINGS.md:84` & live-verified on `NacCanaryEvm.probeView`)* | The `0xff00…0007` precompile returns `callMichelsonView` output as **ABI-encoded `(bytes)`** (not bare Micheline). If your Solidity wrapper returns `returnData` as `bytes memory`, `eth_call` returns **double ABI-encoded bytes** (`abi.encode(abi.encode(rawMicheline))`), breaking naive Micheline decoders. | Either `abi.decode(returnData, (bytes))` inside Solidity before returning, OR unwrap outer ABI `bytes` off-chain and unwrap a second time when the inner payload begins with offset `0x0000…0020` (`unwrapProbeViewMichelineBytes` in `canary.ts`). |
| **5** | **Caught `429 OOG` on `receipt.status === 0x1` & Full-Budget Gas Charging** *(confirmed via `nactrace` `FINDINGS.md:29-30`)* | Michelson OOG returns EVM status **`429`** (`Cross-runtime call failed with status 429 Too Many Requests: OOG`) and charges the **full subcall gas budget**. If an EVM contract catches the failed `.call` (e.g. `probeOog(..., catchRevert=true)`), the outer receipt is **`status: 0x1` (`success`)** while only the inner `0xff00…0007` `callTracer` frame carries the `429 OOG` error! Also, Foundry's local simulator severely underestimates Etherlink deploy gas (`878k` vs `16.9M` actual) and `forge script` hits `Z.Overflow` on bare block-hash RPC args. | Set inner EVM subcall gas ≥ `5,000,000` for normal contract calls, give outer catching txs extra gas headroom (`>= 1.5M–5M`), always inspect child `0xff00…0007` trace frames even when `receipt.status === '0x1'`, and pass explicit `--gas-limit` on intentionally reverting probes so they mine on-chain instead of failing in `eth_estimateGas`. |
| **6** | **Null `SOURCE` (`tz1Ke2h7…`) & Optimized 22-Byte `/storage` Addresses** | Every EVM-originated call enters Michelson with **`SOURCE == tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU`** (the kernel attribution account). Furthermore, Michelson RPC `/context/contracts/<KT1>/storage` returns `address` fields as optimized 22-byte `{"bytes": "0000..."}` hex rather than Base58 strings. | Never authorize on `sp.source` or check `SOURCE == SENDER`; authenticate on `sp.sender` (the resolved alias) and pass explicit beneficiary bytes when behind a vault/forwarder. Decode 22-byte storage addresses (`0000`→`tz1`, `0001`→`tz2`, `0002`→`tz3`, `01`+20B+`00`→`KT1`) via Base58Check in frontends. |
| **7** | **`caller-equals-self` Spoofing & Nested Cross-VM Reentrancy** | Sending native tez to any contract's foreign alias causes `AliasForwarder` to route value back with `SENDER == SELF_ADDRESS` (Michelson) or `msg.sender == address(this)` (EVM). Nested `EVM → Michelson → EVM` callbacks can also reenter. | NEVER use `SENDER == SELF_ADDRESS` or `msg.sender == address(this)` as an internal auth check. Guard nested callbacks with explicit state-machine locks (`inRoundTrip` / `Phase.Redeem`, single-use `callbackReceivedThisTx`) and pin `authorizedKt1Alias` queried live via `resolveAddress(kt1, 0, 1)`. |
| **8** | **Horus 8.0 Safe-CREATE2 (`tz1/2/3`) vs. Keccak-256 (`KT1`) Aliases** | Horus 8.0 (RFC-26051 / MR 23037) replaces legacy hash aliases with Safe-CREATE2 rescue-wallet addresses (`0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`) **for `tz1/tz2/tz3` EOAs only**; **`KT1` smart contracts retain legacy Keccak-256 aliases**. Also, `0x914d7Fec…` intentionally has **`0x` code on Previewnet** (it is a cross-chain CREATE2 recovery constant for Ethereum/Arbitrum/Base, not a deployed Tezos X contract). | Never hardcode legacy alias math for `tz1/2/3`; query live `originOf`/`resolveAddress` on `0xff00…0007` and use `@tezos-x/octez.js` v25.1+ (`methodsObject`, never removed `.methods`). For on-demand materialization, supply the account's Base58Check `edpk`/`sppk`/`p2pk` public key to `0xbfe88b4b` (`materializeAlias("tezos", tzAddr, pubKey)`) or `KT18oDJJ…%materialize_alias`. |

---

## 3. Mirrored Hash & Block-Pinned Dual-Runtime Verification Recipes

### 3.1 Deterministic Mirrored Michelson Operation Hash (`o…`)
Confirmed from `tezosx_journal.rs`, `Migl992/nactrace` (`FINDINGS.md:114-116`), and live Previewnet verification (`0x3977046f09ded41a000370bc47ff246befd74909eb414a4a02d14a36b017f716` → `opEnkkJMcLqyuuVBfPC5neVFZ8mCYibXf8VqtP7MRvEBWNAmSry`):

```text
mirrored_michelson_op_hash = Base58Check( [0x05, 0x74] || BLAKE2b_256( utf8("michelson") || evm_tx_hash_32bytes ) )
mirrored_evm_tx_hash       = Keccak_256( utf8("evm") || tezos_op_hash_32bytes )
```

- **Important lookup rule (`nactrace` `FINDINGS.md:59`):** Use the **mirrored `o…` hash** for direct **Michelson RPC** (`/chains/main/blocks/<level>/operations`) and **TzKT** links; use the **original originating hash** when querying **`0xTzKT`** (`api.xtzkt.io`).

### 3.2 Block-Pinned Dual-Runtime State Diff (`EVM block N == Michelson level N`)
Previewnet v0.11 maintains an exact **1:1 shared block height** between EVM and Michelson (`eth_blockNumber == /chains/main/blocks/head/header.level`). To prove atomic state transitions or rollbacks without race conditions:
1. Pin a single integer height `N = parseInt(eth_blockNumber, 16)` (and `blockHex = "0x" + N.toString(16)`).
2. Query EVM at `blockHex` (`eth_getBalance`, `eth_getCode`, `eth_call` getters) and Michelson at `/chains/main/blocks/${N}/...` (`header`, `balance`, `storage`).
3. **Reading Michelson views & big-maps cleanly:**
   - `POST /chains/main/blocks/head/helpers/scripts/run_script_view` works live on Previewnet v0.11 **when `"unparsing_mode": "Readable"` is included** in the JSON body!
   - For zero-dependency historical/pinned `big_map` reads, compute the `expr…` key hash client-side: `Base58Check([13, 44, 64, 27] || BLAKE2b_256(0x05 || binaryMichelineKey))` and `GET /chains/main/blocks/${N}/context/big_maps/${bigMapId}/${exprHash}`.

---

## 4. Tezos X Ecosystem Tooling Map (Complementary Roles)

| Tool | Primary Role | Where It Shines | How It Pairs With NACBench |
| :--- | :--- | :--- | :--- |
| **[NACBench](https://nacbench.thetezos.com)** | Proactive NAC Build, Codec, Horus 8.0 Alias & Live Canary Workbench | Pre-tx binary Micheline↔ABI encoding + 6-guardrail snippets, live Horus 8.0 `0xbfe88b4b`/`%materialize_alias` execution, block-pinned arbitrary state diffs, and 5 live Previewnet v0.11 Canary probes. | Hands off every inspected/executed tx hash directly to `nactrace`, Blockscout, and mirrored-op TzKT! |
| **[`Migl992/nactrace`](https://github.com/Migl992/nactrace)** | Post-Hoc Cross-Runtime Trace Explainer (`CLI`, `@nactrace/core`, Hardhat/Foundry hooks, widget) | Deep post-tx archaeology across EVM/Michelson legs, human-readable root-cause explanations, and `0xTzKT` + RPC hybrid tracing (`https://migl992.github.io/nactrace/?hash=<h>&network=<net>`). | NACBench deep-links directly into `nactrace` rather than duplicating post-hoc trace archaeology. |
| **[`0xTzKT` (`xtzkt.io`)](https://xtzkt.io/)** | Unified Multi-Runtime Indexer & Explorer (Baking Bad) | Historical cross-runtime indexing across Tezos L1, Etherlink EVM, and Etherlink Michelson (`api.previewnet.xtzkt.io`, `api.shadownet.xtzkt.io`, `api.xtzkt.io`). | Primary historical indexer; NACBench queries direct RPCs + Blockscout so debugging keeps working even if an indexer stalls. |
| **[Blockscout](https://blockscout.previewnet.tezosx.nomadic-labs.com) & [TzKT](https://tzkt.previewnet.tezosx.nomadic-labs.com)** | Runtime-Specific Explorers | Contract verification, EVM v2 REST API (`/api/v2/transactions/...`, used as NACBench's `callTracer` fallback on Mainnet/Shadownet), and Michelson operation inspection. | Direct 1-click links in every NACBench header, alias card, and trace report. |
| **[`@tezos-x/octez.js`](https://github.com/trilitech/octez.js) & [`octez.connect`](https://tezosdappbuilder.xyz/resources)** | Official Tezos X TypeScript SDK & Wallet Connector | Horus 8.0 Safe-CREATE2 alias utils, DA-aware fee estimation, `methodsObject` contract calls (replacing deprecated `@airgap/beacon-sdk`). | NACBench Module 1 generates copy-paste `@tezos-x/octez.js` v25.1 + `octez.connect` snippets. |
| **[Tezos dApp Builder](https://tezosdappbuilder.xyz/)** | Tezos X Builders' Club Hub & v3.0 Agent Skill | Onboarding portal, `/nac` visual overview, `/usecases`, `/resources`, and v3.0 AI builder skills. | NACBench complements `/nac`'s conceptual animation with live Previewnet v0.11 RPCs & deployed Canary contracts. |

---

## 5. Ready-to-Copy `tezosdappbuilder.xyz/resources` Listing Submission

*(Formatted to match `ypsono-shipit/tezos-etherlink-dapp-builder`'s `src/data/resources.ts` "Network & tools" schema from `01-resource-map.md`. Note: flip `https://github.com/webid/nacbench` from private to public before submitting!)*

### Structured Entry (`src/data/resources.ts` PR format)
```ts
{
  title: 'NACBench',
  url: 'https://nacbench.thetezos.com',
  repo: 'https://github.com/webid/nacbench',
  group: 'Network & tools',
  type: 'Tool',
  source: 'Community · PurpleMatter',
  description:
    'Live Tezos X NAC workbench: client-side Micheline↔ABI codec & guardrail snippet generator, Horus 8.0 Safe-CREATE2 alias inspector & 1-click materializer (0xbfe88b4b / %materialize_alias), block-pinned state diffs, and deployed Previewnet v0.11 Canary probes with nactrace handoff.',
  tags: ['NAC', 'Previewnet v0.11', 'Horus 8.0', 'Micheline', 'Aliases', 'Debugger'],
}
```

### Copy-Ready Discord (`#tezos-x`) / PR Submission Blurb
```text
Listing request for tezosdappbuilder.xyz/resources (Network & tools):

- Name: NACBench
- Live URL: https://nacbench.thetezos.com
- Repo (MIT): https://github.com/webid/nacbench
- Type: Tool (zero-backend SPA + deployed Previewnet v0.11 Canary pair: 0xd6b843047210c2fbeb6b9b9073bcacb64bb68cf5 / KT1JcRVBhqTivsAbsrjS5BuKiYtmhjb6jn3Z)
- One-line summary: Interactive Tezos X NAC workbench combining a client-side Micheline↔Solidity ABI codec & guardrail snippet generator, Horus 8.0 alias inspector & materializer (0xbfe88b4b / %materialize_alias), block-pinned EVM/Michelson state diffs, and 5 live Previewnet v0.11 Canary probes with 1-click handoff to Migl992/nactrace, Blockscout, and mirrored-op TzKT.
```
