// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Micheline} from "./Micheline.sol";
import {NativeAtomicGatewayLib} from "./NativeAtomicGatewayLib.sol";

/// @title NacCanaryEvm
/// @notice Minimal, zero-TVL Previewnet v0.11 Canary contract for NACBench.
/// @dev Exercises all five Tezos X Native Atomic Composability (NAC) patterns against a paired
///      Michelson `nac_canary` KT1 contract:
///      1. `probeWrite`    -> `%record_ping(string)` with `10^12` wei-to-mutez alignment check
///      2. `probeRoundTrip`-> `%echo_callback(nat)` -> `onMichelsonCallback(uint256,uint256)`
///      3. `probeView`     -> `callMichelsonView(..., "get_state_digest", nat)`
///      4. `probeRollback` -> `%force_fail(string)` proving atomic rollback of `rollbackSentinel`
///      5. `probeOog`      -> `%burn_gas(nat)` measuring gas and catching or bubbling `429 OOG`
///      Plus read-only `echoView`, `inspectOrigin`, and `inspectResolve` helpers.
contract NacCanaryEvm {
    address public immutable owner;
    address public authorizedKt1Alias;

    uint256 public writeCount;
    uint256 public roundTripCount;
    uint256 public rollbackSentinel;

    uint256 public lastCallbackNonce;
    address public lastCallbackSender;
    uint256 public lastMichelsonCallbackCount;

    bool public lastOogOk;
    uint256 public lastOogGasUsed;
    bytes public lastOogReturnData;

    bool public inRoundTrip;
    bool public callbackReceivedThisTx;

    error NotOwner();
    error EmptyTarget();
    error ReentrantRoundTrip();
    error CallbackOutsideRoundTrip();
    error DuplicateCallback();
    error UnauthorizedKt1Alias(address caller, address expected);
    error MissingCallback();
    error CallbackNonceMismatch(uint256 expected, uint256 actual);

    event AuthorizedKt1AliasUpdated(address indexed previousAlias, address indexed newAlias);
    event ProbeWriteExecuted(
        string kt1,
        string note,
        uint256 valueWei,
        uint256 gasCap,
        uint256 writeCount,
        bytes payload
    );
    event ProbeRoundTripExecuted(
        string kt1,
        uint256 indexed nonce,
        uint256 gasCap,
        uint256 roundTripCount,
        address indexed callbackSender,
        uint256 michelsonCallbackCount
    );
    event MichelsonCallbackReceived(
        address indexed sender, uint256 indexed nonce, uint256 michelsonCallbackCount
    );
    event ProbeRollbackUnexpectedSuccess(string kt1, string reason, uint256 rollbackSentinel);
    event ProbeOogExecuted(bool ok, uint256 gasUsed, bytes returnData);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Restricts `onMichelsonCallback` to a specific resolved KT1 EVM alias (or `address(0)` for open mode).
    function setAuthorizedKt1Alias(address aliasAddr) external {
        if (msg.sender != owner) revert NotOwner();
        address previous = authorizedKt1Alias;
        authorizedKt1Alias = aliasAddr;
        emit AuthorizedKt1AliasUpdated(previous, aliasAddr);
    }

    /// @notice Probe 1: EVM -> Michelson atomic write (`%record_ping`).
    /// @dev Enforces `msg.value % 1e12 == 0` before calling the gateway precompile.
    function probeWrite(string calldata kt1, string calldata note, uint256 gasCap)
        external
        payable
    {
        if (bytes(kt1).length == 0) revert EmptyTarget();
        Micheline.assertMutezAligned(msg.value);

        writeCount += 1;
        bytes memory payload = Micheline.encodeString(note);

        (bool ok, bytes memory returnData) =
            NativeAtomicGatewayLib.callMichelson(kt1, "record_ping", payload, msg.value, gasCap);
        if (!ok) {
            NativeAtomicGatewayLib.bubbleRevert(returnData);
        }

        emit ProbeWriteExecuted(kt1, note, msg.value, gasCap, writeCount, payload);
    }

    /// @notice Probe 2: Atomic EVM -> Michelson (`%echo_callback`) -> EVM (`onMichelsonCallback`) round-trip.
    function probeRoundTrip(string calldata kt1, uint256 nonce, uint256 gasCap) external {
        if (bytes(kt1).length == 0) revert EmptyTarget();
        if (inRoundTrip) revert ReentrantRoundTrip();

        inRoundTrip = true;
        roundTripCount += 1;
        callbackReceivedThisTx = false;

        bytes memory payload = Micheline.encodeNat(nonce);
        (bool ok, bytes memory returnData) =
            NativeAtomicGatewayLib.callMichelson(kt1, "echo_callback", payload, 0, gasCap);
        if (!ok) {
            NativeAtomicGatewayLib.bubbleRevert(returnData);
        }

        if (!callbackReceivedThisTx) revert MissingCallback();
        if (lastCallbackNonce != nonce) {
            revert CallbackNonceMismatch(nonce, lastCallbackNonce);
        }

        inRoundTrip = false;
        emit ProbeRoundTripExecuted(
            kt1, nonce, gasCap, roundTripCount, lastCallbackSender, lastMichelsonCallbackCount
        );
    }

    /// @notice Callback invoked by `nac_canary` via `%call_evm` (`onMichelsonCallback(uint256,uint256)`).
    function onMichelsonCallback(uint256 nonce, uint256 michelsonCallbackCount) external {
        if (!inRoundTrip) revert CallbackOutsideRoundTrip();
        if (authorizedKt1Alias != address(0) && msg.sender != authorizedKt1Alias) {
            revert UnauthorizedKt1Alias(msg.sender, authorizedKt1Alias);
        }
        if (callbackReceivedThisTx) revert DuplicateCallback();

        callbackReceivedThisTx = true;
        lastCallbackNonce = nonce;
        lastCallbackSender = msg.sender;
        lastMichelsonCallbackCount = michelsonCallbackCount;

        emit MichelsonCallbackReceived(msg.sender, nonce, michelsonCallbackCount);
    }

    /// @notice Probe 3: Read-only EVM -> Michelson on-chain view (`get_state_digest`) via low-level `.staticcall`.
    function probeView(string calldata kt1, uint256 x)
        external
        view
        returns (bytes memory rawMicheline)
    {
        if (bytes(kt1).length == 0) revert EmptyTarget();

        bytes memory payload = Micheline.encodeNat(x);
        (bool ok, bytes memory returnData) =
            NativeAtomicGatewayLib.callMichelsonView(kt1, "get_state_digest", payload);
        if (!ok) {
            NativeAtomicGatewayLib.bubbleRevert(returnData);
        }
        return returnData;
    }

    /// @notice Probe 4: Atomic cross-runtime rollback (`%force_fail`).
    /// @dev Increments `rollbackSentinel` before invoking Michelson `%force_fail`. When Michelson fails,
    ///      the revert bubbles out and `rollbackSentinel` is atomically reverted to its prior value.
    function probeRollback(string calldata kt1, string calldata reason, uint256 gasCap) external {
        if (bytes(kt1).length == 0) revert EmptyTarget();

        rollbackSentinel += 1;
        bytes memory payload = Micheline.encodeString(reason);
        (bool ok, bytes memory returnData) =
            NativeAtomicGatewayLib.callMichelson(kt1, "force_fail", payload, 0, gasCap);
        if (!ok) {
            NativeAtomicGatewayLib.bubbleRevert(returnData);
        }

        emit ProbeRollbackUnexpectedSuccess(kt1, reason, rollbackSentinel);
    }

    /// @notice Probe 5: Deterministic cross-runtime OOG / gas measurement (`%burn_gas`).
    /// @dev When `catchRevert` is true, records failure telemetry instead of reverting (useful for inspecting
    ///      v0.11 HTTP-429-style OOG error bytes on-chain). When false, bubbles raw revert bytes.
    function probeOog(string calldata kt1, uint256 iterations, uint256 gasCap, bool catchRevert)
        external
        returns (bool ok, bytes memory returnData, uint256 gasUsed)
    {
        if (bytes(kt1).length == 0) revert EmptyTarget();

        bytes memory payload = Micheline.encodeNat(iterations);
        uint256 gasBefore = gasleft();
        (ok, returnData) =
            NativeAtomicGatewayLib.callMichelson(kt1, "burn_gas", payload, 0, gasCap);
        uint256 gasAfter = gasleft();
        gasUsed = gasBefore > gasAfter ? gasBefore - gasAfter : 0;

        if (!ok && !catchRevert) {
            NativeAtomicGatewayLib.bubbleRevert(returnData);
        }

        lastOogOk = ok;
        lastOogGasUsed = gasUsed;
        lastOogReturnData = returnData;

        emit ProbeOogExecuted(ok, gasUsed, returnData);
    }

    /// @notice Read-only target for Michelson `staticcall_evm` testing.
    function echoView(uint256 x) external view returns (uint256 echoed, uint256 writes) {
        return (x, writeCount);
    }

    /// @notice Low-level `.staticcall` passthrough to `originOf(string,uint8)` on `0xff00...0007`.
    function inspectOrigin(string calldata addr, uint8 runtime)
        external
        view
        returns (bool ok, bytes memory data)
    {
        return NativeAtomicGatewayLib.originOf(addr, runtime);
    }

    /// @notice Low-level `.staticcall` passthrough to `resolveAddress(string,uint8,uint8)` on `0xff00...0007`.
    function inspectResolve(string calldata addr, uint8 fromRuntime, uint8 toRuntime)
        external
        view
        returns (bool ok, bytes memory data)
    {
        return NativeAtomicGatewayLib.resolveAddress(addr, fromRuntime, toRuntime);
    }
}
