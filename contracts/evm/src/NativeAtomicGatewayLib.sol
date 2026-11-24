// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Micheline} from "./Micheline.sol";

/// @title NativeAtomicGatewayLib
/// @notice Low-level `.call` / `.staticcall` wrapper for the Tezos X Previewnet v0.11 NAC precompile.
/// @dev CRITICAL: On Tezos X Previewnet v0.11, `eth_getCode(0xff00000000000000000000000000000000000007)`
///      returns `0x` (`EXTCODESIZE == 0`). High-level Solidity interface calls WILL revert because
///      solc emits an EXTCODESIZE check before invoking contracts that return data.
///      Every function in this library uses low-level `.call` or `.staticcall` exclusively.
library NativeAtomicGatewayLib {
    /// @notice Enshrined Tezos X NAC gateway precompile address.
    address internal constant GATEWAY = 0xfF00000000000000000000000000000000000007;

    /// @notice Verified Previewnet v0.11 runtime identifiers.
    uint8 internal constant RUNTIME_MICHELSON = 0;
    uint8 internal constant RUNTIME_EVM = 1;

    /// @notice Verified Previewnet v0.11 `originOf` classification constants.
    uint8 internal constant ORIGIN_UNKNOWN = 0;
    uint8 internal constant ORIGIN_NATIVE = 1;

    /// @notice Verified Previewnet v0.11 `resolveAddress` resolution constants.
    uint8 internal constant RESOLUTION_UNKNOWN = 0;
    uint8 internal constant RESOLUTION_ALIAS = 1;

    /// @notice Verified Previewnet v0.11 precompile function selectors.
    bytes4 internal constant SEL_CALL_MICHELSON =
        bytes4(keccak256("callMichelson(string,string,bytes)"));
    bytes4 internal constant SEL_CALL_MICHELSON_VIEW =
        bytes4(keccak256("callMichelsonView(string,string,bytes)")); // 0x8326329c
    bytes4 internal constant SEL_ORIGIN_OF = bytes4(keccak256("originOf(string,uint8)"));
    bytes4 internal constant SEL_RESOLVE_ADDRESS =
        bytes4(keccak256("resolveAddress(string,uint8,uint8)"));
    bytes4 internal constant SEL_MATERIALIZE_ALIAS =
        bytes4(keccak256("materializeAlias(string,string,string)")); // 0xbfe88b4b

    /// @notice Fallback error when the gateway reverts with empty return data.
    error GatewayCallFailed();

    /// @notice Low-level `callMichelson(string,string,bytes)` invocation.
    /// @param destination Target KT1 (or tz1) Tezos address string.
    /// @param entrypoint Michelson entrypoint name (without leading `%`).
    /// @param payload Raw binary Micheline expression (no 0x05 PACK prefix).
    /// @param value Wei to forward (must satisfy `value % 1e12 == 0`).
    /// @param gasCap Explicit EVM gas cap for the subcall, or 0 to forward remaining gas.
    function callMichelson(
        string memory destination,
        string memory entrypoint,
        bytes memory payload,
        uint256 value,
        uint256 gasCap
    ) internal returns (bool ok, bytes memory returnData) {
        Micheline.assertMutezAligned(value);

        bytes memory callData =
            abi.encodeWithSelector(SEL_CALL_MICHELSON, destination, entrypoint, payload);

        if (gasCap == 0) {
            (ok, returnData) = GATEWAY.call{value: value}(callData);
        } else {
            (ok, returnData) = GATEWAY.call{value: value, gas: gasCap}(callData);
        }
    }

    /// @notice Low-level `callMichelsonView(string,string,bytes)` (`0x8326329c`) staticcall.
    /// @param destination Target KT1 address string.
    /// @param viewName Michelson on-chain view name.
    /// @param payload Raw binary Micheline argument (no 0x05 PACK prefix).
    function callMichelsonView(
        string memory destination,
        string memory viewName,
        bytes memory payload
    ) internal view returns (bool ok, bytes memory returnData) {
        bytes memory callData =
            abi.encodeWithSelector(SEL_CALL_MICHELSON_VIEW, destination, viewName, payload);
        (ok, returnData) = GATEWAY.staticcall(callData);
    }

    /// @notice Low-level `originOf(string,uint8)` staticcall.
    /// @param addr Address string to inspect (e.g. `tz1...`, `KT1...`, `0x...`).
    /// @param sourceRuntime Runtime of `addr`: `0` = Michelson/Tezos, `1` = EVM.
    function originOf(string memory addr, uint8 sourceRuntime)
        internal
        view
        returns (bool ok, bytes memory returnData)
    {
        bytes memory callData = abi.encodeWithSelector(SEL_ORIGIN_OF, addr, sourceRuntime);
        (ok, returnData) = GATEWAY.staticcall(callData);
    }

    /// @notice Low-level `resolveAddress(string,uint8,uint8)` staticcall.
    /// @param addr Address string to translate.
    /// @param sourceRuntime Source runtime (`0` = Michelson/Tezos, `1` = EVM).
    /// @param targetRuntime Target runtime (`0` = Michelson/Tezos, `1` = EVM).
    function resolveAddress(string memory addr, uint8 sourceRuntime, uint8 targetRuntime)
        internal
        view
        returns (bool ok, bytes memory returnData)
    {
        bytes memory callData =
            abi.encodeWithSelector(SEL_RESOLVE_ADDRESS, addr, sourceRuntime, targetRuntime);
        (ok, returnData) = GATEWAY.staticcall(callData);
    }

    /// @notice Low-level `materializeAlias(string,string,string)` (`0xbfe88b4b`) call.
    /// @param nativeRuntime Source runtime identifier string (e.g. `"tezos"`).
    /// @param nativeAddress Native address string (e.g. `tz1...`).
    /// @param publicKey Base58Check public key (e.g. `edpk...`, required for `tz1/2/3` Safe-CREATE2).
    function materializeAlias(
        string memory nativeRuntime,
        string memory nativeAddress,
        string memory publicKey
    ) internal returns (bool ok, bytes memory returnData) {
        bytes memory callData = abi.encodeWithSelector(
            SEL_MATERIALIZE_ALIAS, nativeRuntime, nativeAddress, publicKey
        );
        (ok, returnData) = GATEWAY.call(callData);
    }

    /// @notice Decodes a successful `originOf` ABI return payload.
    function decodeOriginOf(bytes memory data)
        internal
        pure
        returns (uint8 kind, uint8 homeRuntime, string memory nativeAddress)
    {
        return abi.decode(data, (uint8, uint8, string));
    }

    /// @notice Decodes a successful `resolveAddress` ABI return payload.
    function decodeResolveAddress(bytes memory data)
        internal
        pure
        returns (bool classified, uint8 resolution, string memory translated)
    {
        return abi.decode(data, (bool, uint8, string));
    }

    /// @notice Bubbles raw gateway revert bytes verbatim (including Previewnet v0.11 UTF-8 error strings).
    function bubbleRevert(bytes memory returnData) internal pure {
        if (returnData.length > 0) {
            assembly ("memory-safe") {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }
        revert GatewayCallFailed();
    }
}
