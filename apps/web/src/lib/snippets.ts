import { selectorOf } from './codec';
import { NULL_SOURCE_ADDRESS } from './networks';
import type { CodecInput, CodecResult, GeneratedSnippets, NetworkConfig } from './types';

function escapeSolString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function generateGuardrailedSnippets(
  input: CodecInput,
  result: CodecResult,
  network: NetworkConfig,
): GeneratedSnippets {
  const kt1 = escapeSolString(input.kt1Target.trim() || network.michelson.evmGateway);
  const evmTarget = input.evmTarget.trim() || '0x000000000000000000000000000000000000dEaD';
  const ep = escapeSolString(input.entrypoint.trim() || 'default');
  const gasCap = input.evmGasCap.trim() || String(network.evm.nacRecommendedGas);
  const valueWei = input.valueWei.trim() || '0';
  const michelineNoPrefix = (result.michelineHex || '0x030b').replace(/^0x/i, '');
  const isView = input.callDirection === 'evm_view_michelson';

  const solidity = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Target Network: ${network.label} (Chain ID ${network.evm.chainId})
// CRITICAL: 0xff00...0007 has EXTCODESIZE == 0 -> NEVER use high-level Solidity interfaces!
contract NacSnippet {
    address internal constant NAC_GATEWAY = ${network.evm.precompile};
    uint256 internal constant WEI_PER_MUTEZ = 1e12;

    error UnalignedMutezValue(uint256 weiValue, uint256 remainder);

    function execute${isView ? 'View' : 'Call'}() external ${isView ? 'view returns (bytes memory)' : 'payable returns (bytes memory)'} {
        ${
          isView
            ? `bytes memory michelineArg = hex"${michelineNoPrefix}";
        bytes memory callData = abi.encodeWithSignature(
            "callMichelsonView(string,string,bytes)",
            "${kt1}",
            "${ep}",
            michelineArg
        );
        (bool ok, bytes memory ret) = NAC_GATEWAY.staticcall(callData);`
            : `require(msg.value % WEI_PER_MUTEZ == 0, "Sub-mutez dust truncated");
        bytes memory michelineArg = hex"${michelineNoPrefix}";
        bytes memory callData = abi.encodeWithSignature(
            "callMichelson(string,string,bytes)",
            "${kt1}",
            "${ep}",
            michelineArg
        );
        // Recommend >= 5,000,000 gas to prevent v0.11 HTTP-429 OOG cross-runtime reverts
        (bool ok, bytes memory ret) = NAC_GATEWAY.call{value: msg.value, gas: ${gasCap}}(callData);`
        }
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}`;

  const rawCalldataHex = result.gatewayCalldataHex || '0x';
  const rawCalldataNoPrefix = rawCalldataHex.replace(/^0x/i, '');
  const evmSig = ep.includes('(')
    ? ep
    : input.callDirection === 'michelson_staticcall_evm'
      ? 'echoView(uint256)'
      : 'onMichelsonCallback(uint256,uint256)';

  let valueHex = '0x0';
  try {
    const v = BigInt(valueWei);
    if (v >= 0n) valueHex = '0x' + v.toString(16);
  } catch {
    valueHex = '0x0';
  }
  const gasNum = Number(gasCap);
  const gasHex =
    Number.isFinite(gasNum) && gasNum > 0
      ? '0x' + Math.trunc(gasNum).toString(16)
      : '0x' + network.evm.nacRecommendedGas.toString(16);

  let octezJs: string;
  if (input.callDirection === 'evm_to_michelson') {
    octezJs = `// EVM -> Michelson NAC Call — ${network.label} (Chain ID ${network.evm.chainId})
// Target Precompile: ${network.evm.precompile} (EXTCODESIZE == 0)
// Direction: evm_to_michelson (uses callMichelson(string,string,bytes) calldata — NOT %call_evm!)
const WEI_PER_MUTEZ = 1_000_000_000_000n;
const valueWei = ${valueWei}n;
if (valueWei % WEI_PER_MUTEZ !== 0n) {
  throw new Error('Sub-mutez wei dust would be truncated by the gateway (must be multiple of 1e12)');
}

const txHash = await window.ethereum.request({
  method: 'eth_sendTransaction',
  params: [
    {
      from: '<connected_evm_address>',
      to: '${network.evm.precompile}',
      // Encodes callMichelson("${kt1}", "${ep}", 0x${michelineNoPrefix})
      data: '${rawCalldataHex}',
      value: '${valueHex}',
      // Recommend >= 5,000,000 EVM gas to avoid v0.11 HTTP-429 OOG cross-runtime reverts
      gas: '${gasHex}',
    },
  ],
});
console.log('Submitted EVM -> Michelson NAC tx:', txHash);`;
  } else if (input.callDirection === 'evm_view_michelson') {
    octezJs = `// EVM -> Michelson Read-Only View — ${network.label} (Chain ID ${network.evm.chainId})
// Precompile: ${network.evm.precompile} -> callMichelsonView(string,string,bytes) (0x8326329c)
const response = await fetch('${network.evm.rpcUrl}', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      {
        to: '${network.evm.precompile}',
        // Encodes callMichelsonView("${kt1}", "${ep}", 0x${michelineNoPrefix})
        data: '${rawCalldataHex}',
      },
      'latest',
    ],
  }),
});
const { result: rawMichelineHex } = await response.json();
console.log('Michelson view raw Micheline bytes:', rawMichelineHex);`;
  } else if (input.callDirection === 'michelson_to_evm') {
    octezJs = `// @tezos-x/octez.js v25.1 — ${network.label} (${network.michelson.chainId})
// Enshrined Michelson EVM Gateway: ${network.michelson.evmGateway}
import { TezosToolkit } from '@tezos-x/octez.js';

const tezos = new TezosToolkit('${network.michelson.rpcUrl}');
const gateway = await tezos.contract.at('${network.michelson.evmGateway}');

// NOTE: %call_evm expects ABI args ONLY (NO 4-byte selector) in \`data\`;
// the function signature string is passed separately in \`selector\`.
const op = await gateway.methodsObject.call_evm({
  destination: '${evmTarget}',
  selector: '${evmSig}',
  data: '${rawCalldataNoPrefix}',
  callback: null,
}).send({
  amount: 0,
  // Stay within Michelson hard_gas_limit_per_operation (${network.michelson.hardGasLimitPerOperation})
});

await op.confirmation(1);
console.log('Confirmed cross-runtime op:', op.hash);`;
  } else {
    octezJs = `// @tezos-x/octez.js v25.1 — Michelson -> EVM staticcall_evm View (${network.label})
// Enshrined Michelson EVM Gateway: ${network.michelson.evmGateway}
import { TezosToolkit } from '@tezos-x/octez.js';

const tezos = new TezosToolkit('${network.michelson.rpcUrl}');
const gateway = await tezos.contract.at('${network.michelson.evmGateway}');

// NOTE: staticcall_evm REQUIRES full EVM calldata WITH the 4-byte selector (${result.abiSelector})!
const rawReturnBytes = await gateway.contractViews
  .staticcall_evm({
    0: '${evmTarget}',
    1: '${rawCalldataNoPrefix}',
  })
  .executeView({
    viewCaller: '${kt1}',
  });

console.log('EVM staticcall_evm return bytes:', rawReturnBytes);`;
  }

  const smartpy = `# SmartPy v0.17+ (@sp.module) — ${network.label}
# Enshrined Gateway: ${network.michelson.evmGateway}
# WARNING: EVM-originated calls arrive with sp.source == "${NULL_SOURCE_ADDRESS}".
# Always authenticate on sp.sender (resolved EVM alias), never sp.source!
import smartpy as sp

@sp.module
def main():
    call_evm_type: type = sp.record(
        destination=sp.string,
        selector=sp.string,
        data=sp.bytes,
        callback=sp.option[sp.contract[sp.bytes]],
    ).layout(("destination", ("selector", ("data", "callback"))))

    class NacBridgeCaller(sp.Contract):
        def __init__(self, gateway):
            self.data.gateway = sp.cast(gateway, sp.address)

        @sp.entrypoint
        def invoke_evm(self, abi_args_without_selector):
            sp.cast(abi_args_without_selector, sp.bytes)
            gw = sp.contract(
                call_evm_type, self.data.gateway, entrypoint="call_evm"
            ).unwrap_some(error="GATEWAY_MISSING")
            sp.transfer(
                sp.record(
                    destination="${evmTarget}",
                    selector="${ep.includes('(') ? ep : 'onMichelsonCallback(uint256,uint256)'}",
                    data=abi_args_without_selector,
                    callback=sp.cast(None, sp.option[sp.contract[sp.bytes]]),
                ),
                sp.mutez(0),
                gw,
            )

        @sp.onchain_view()
        def read_evm_view(self, full_calldata_with_4byte_selector):
            # staticcall_evm REQUIRES the 4-byte selector prefix!
            sp.cast(full_calldata_with_4byte_selector, sp.bytes)
            return sp.view(
                "staticcall_evm",
                self.data.gateway,
                ("${evmTarget}", full_calldata_with_4byte_selector),
                sp.bytes,
            ).unwrap_some(error="STATICCALL_EVM_FAILED")`;

  const cheatsheet = [
    `# Tezos X v0.11 / Horus 8.0 Selector & Constant Cheat-Sheet (${network.label})`,
    ``,
    `EVM NAC Precompile (EXTCODESIZE == 0) : ${network.evm.precompile}`,
    `Michelson Enshrined EVM Gateway       : ${network.michelson.evmGateway}`,
    `Null Cross-Runtime Michelson SOURCE   : ${NULL_SOURCE_ADDRESS}`,
    `Wei per Mutez Alignment Factor        : 1,000,000,000,000 (1e12)`,
    `Current Value (wei)                   : ${valueWei} (${result.mutezAligned ? 'ALIGNED' : `UNALIGNED dust=${result.dustRemainderWei}`})`,
    `EVM Recommended Gas / Michelson Cap   : ${network.evm.nacRecommendedGas.toLocaleString()} / ${network.michelson.hardGasLimitPerOperation.toLocaleString()}`,
    ``,
    `## Verified Precompile Selectors (0xff00...0007)`,
    `callMichelson(string,string,bytes)      -> ${selectorOf('callMichelson(string,string,bytes)')}`,
    `callMichelsonView(string,string,bytes)  -> ${selectorOf('callMichelsonView(string,string,bytes)')}`,
    `originOf(string,uint8)                  -> ${selectorOf('originOf(string,uint8)')}`,
    `resolveAddress(string,uint8,uint8)      -> ${selectorOf('resolveAddress(string,uint8,uint8)')}`,
    `materializeAlias(string,string,string)  -> ${selectorOf('materializeAlias(string,string,string)')}`,
    ``,
    `## Current Encoded Output`,
    `Direction     : ${input.callDirection}`,
    `Preset        : ${input.preset}`,
    `Micheline Hex : ${result.michelineHex} (${result.michelineByteLength} bytes)`,
    `ABI Selector  : ${result.abiSelector}`,
  ].join('\n');

  return { solidity, octezJs, smartpy, cheatsheet };
}

export function buildOctezClientMaterializeCmd(
  network: NetworkConfig,
  tzAddress: string,
  publicKey?: string,
): string {
  const addr = tzAddress.trim() || 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb';
  const pkOpt = publicKey?.trim() ? `Some "${publicKey.trim()}"` : 'None';
  return [
    `TEZOS_CLIENT_UNSAFE_DISABLE_DISCLAIMER=Y \\`,
    `octez-client --endpoint ${network.michelson.rpcUrl} \\`,
    `  transfer 0 from <your_alias> to ${network.michelson.evmGateway} \\`,
    `  --entrypoint materialize_alias \\`,
    `  --arg 'Pair "tezos" (Pair "${addr}" (${pkOpt}))' \\`,
    `  --burn-cap 0.5`,
  ].join('\n');
}

export function buildOctezJsMaterializeSnippet(
  network: NetworkConfig,
  tzAddress: string,
  publicKey?: string,
): string {
  const addr = tzAddress.trim() || 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb';
  const pkExpr = publicKey?.trim() ? `'${publicKey.trim()}'` : 'null';
  return `// Materialize Horus 8.0 alias via Michelson gateway %materialize_alias
import { TezosToolkit } from '@tezos-x/octez.js';

const tezos = new TezosToolkit('${network.michelson.rpcUrl}');
const gateway = await tezos.contract.at('${network.michelson.evmGateway}');

// 3-field unannotated Michelson parameter: pair string string (option string)
// Note: tz1/tz2/tz3 Safe-CREATE2 aliases require the Base58 public key (edpk/sppk/p2pk).
const op = await gateway.methodsObject
  .materialize_alias({
    0: 'tezos',
    1: '${addr}',
    2: ${pkExpr},
  })
  .send();

await op.confirmation(1);
console.log('Materialized alias op:', op.hash);`;
}
