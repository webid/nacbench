// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NacCanaryEvm} from "../../src/NacCanaryEvm.sol";

/// @notice Minimal relay contract simulating a KT1 contract's deterministic EVM alias address.
contract Kt1AliasRelay {
    function invokeCallback(address target, uint256 nonce, uint256 michelsonCount) external {
        NacCanaryEvm(target).onMichelsonCallback(nonce, michelsonCount);
    }

    function invokeReentrantRoundTrip(
        address target,
        string calldata kt1,
        uint256 nonce,
        uint256 gasCap
    ) external {
        NacCanaryEvm(target).probeRoundTrip(kt1, nonce, gasCap);
    }
}

/// @notice Test mock etched onto 0xff00000000000000000000000000000000000007 via `vm.etch`.
contract MockNativeAtomicGateway {
    // Recorded call telemetry
    string public lastDestination;
    string public lastEntrypoint;
    bytes public lastPayload;
    uint256 public lastValue;
    uint256 public callCount;

    // Configurable revert behavior (raw bytes, matching Previewnet v0.11 UTF-8 errors)
    bool public shouldRevertCall;
    bytes public callRevertBytes;

    // Configurable view response / revert
    bool public shouldRevertView;
    bytes public viewReturnBytes;
    bytes public viewRevertBytes;

    // Configurable callback behavior for `echo_callback`
    address public callbackTarget;
    address public callbackRelay; // If nonzero, calls via Kt1AliasRelay (simulating KT1 alias)
    uint256 public callbackNonce;
    uint256 public callbackMichelsonCount;
    uint8 public callbackInvocations;
    bool public callbackAttemptReentrancy;

    // Configurable real gas burn for `burn_gas`
    uint256 public burnLoops;

    // Fixtures for originOf / resolveAddress
    uint8 public originKind;
    uint8 public originHomeRuntime;
    string public originNativeAddress;

    bool public resolveClassified;
    uint8 public resolveResolution;
    string public resolveTranslated;

    // Recorded materializeAlias telemetry
    string public lastMaterializeRuntime;
    string public lastMaterializeAddress;
    string public lastMaterializePublicKey;
    uint256 public materializeCallCount;

    function configureCallRevert(bool enabled, bytes calldata rawRevertData) external {
        shouldRevertCall = enabled;
        callRevertBytes = rawRevertData;
    }

    function configureViewResponse(bool shouldRevert, bytes calldata data) external {
        shouldRevertView = shouldRevert;
        if (shouldRevert) {
            viewRevertBytes = data;
        } else {
            viewReturnBytes = data;
        }
    }

    function configureCallback(
        address target,
        address relay,
        uint256 nonce,
        uint256 michelsonCount,
        uint8 invocations,
        bool attemptReentrancy
    ) external {
        callbackTarget = target;
        callbackRelay = relay;
        callbackNonce = nonce;
        callbackMichelsonCount = michelsonCount;
        callbackInvocations = invocations;
        callbackAttemptReentrancy = attemptReentrancy;
    }

    function configureBurnLoops(uint256 loops) external {
        burnLoops = loops;
    }

    function configureOriginOf(uint8 kind, uint8 homeRuntime, string calldata nativeAddress)
        external
    {
        originKind = kind;
        originHomeRuntime = homeRuntime;
        originNativeAddress = nativeAddress;
    }

    function configureResolveAddress(
        bool classified,
        uint8 resolution,
        string calldata translated
    ) external {
        resolveClassified = classified;
        resolveResolution = resolution;
        resolveTranslated = translated;
    }

    function callMichelson(
        string calldata destination,
        string calldata entrypoint,
        bytes calldata data
    ) external payable {
        lastDestination = destination;
        lastEntrypoint = entrypoint;
        lastPayload = data;
        lastValue = msg.value;
        callCount += 1;

        if (shouldRevertCall) {
            bytes memory raw = callRevertBytes;
            assembly ("memory-safe") {
                revert(add(raw, 0x20), mload(raw))
            }
        }

        if (keccak256(bytes(entrypoint)) == keccak256(bytes("burn_gas")) && burnLoops > 0) {
            bytes32 acc = keccak256(data);
            for (uint256 i = 0; i < burnLoops; ++i) {
                acc = keccak256(abi.encodePacked(acc, i));
            }
            // Prevent optimizer from dead-code-eliminating the loop
            if (acc == bytes32(uint256(1))) {
                revert("unreachable");
            }
        }

        if (
            keccak256(bytes(entrypoint)) == keccak256(bytes("echo_callback"))
                && callbackTarget != address(0)
        ) {
            if (callbackAttemptReentrancy) {
                if (callbackRelay != address(0)) {
                    Kt1AliasRelay(callbackRelay).invokeReentrantRoundTrip(
                        callbackTarget, destination, callbackNonce, 500_000
                    );
                } else {
                    NacCanaryEvm(callbackTarget).probeRoundTrip(
                        destination, callbackNonce, 500_000
                    );
                }
                return;
            }

            for (uint8 i = 0; i < callbackInvocations; ++i) {
                if (callbackRelay != address(0)) {
                    Kt1AliasRelay(callbackRelay).invokeCallback(
                        callbackTarget, callbackNonce, callbackMichelsonCount
                    );
                } else {
                    NacCanaryEvm(callbackTarget).onMichelsonCallback(
                        callbackNonce, callbackMichelsonCount
                    );
                }
            }
        }
    }

    /// @dev Returns raw configured bytes directly (no extra ABI wrapping) so tests can inspect
    ///      exact Micheline payloads and Previewnet v0.11 UTF-8 revert strings.
    function callMichelsonView(string calldata, string calldata, bytes calldata) external view {
        if (shouldRevertView) {
            bytes memory rawErr = viewRevertBytes;
            assembly ("memory-safe") {
                revert(add(rawErr, 0x20), mload(rawErr))
            }
        }
        bytes memory rawOk = viewReturnBytes;
        assembly ("memory-safe") {
            return(add(rawOk, 0x20), mload(rawOk))
        }
    }

    function originOf(string calldata, uint8)
        external
        view
        returns (uint8 kind, uint8 homeRuntime, string memory nativeAddress)
    {
        return (originKind, originHomeRuntime, originNativeAddress);
    }

    function resolveAddress(string calldata, uint8, uint8)
        external
        view
        returns (bool classified, uint8 resolution, string memory translated)
    {
        return (resolveClassified, resolveResolution, resolveTranslated);
    }

    function materializeAlias(
        string calldata nativeRuntime,
        string calldata nativeAddress,
        string calldata publicKey
    ) external {
        lastMaterializeRuntime = nativeRuntime;
        lastMaterializeAddress = nativeAddress;
        lastMaterializePublicKey = publicKey;
        materializeCallCount += 1;

        if (bytes(publicKey).length == 0) {
            bytes memory rawErr =
                bytes("materializeAlias: Native address verification error: Missing public key");
            assembly ("memory-safe") {
                revert(add(rawErr, 0x20), mload(rawErr))
            }
        }
    }
}
