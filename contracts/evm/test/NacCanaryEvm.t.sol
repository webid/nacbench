// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Micheline} from "../src/Micheline.sol";
import {NacCanaryEvm} from "../src/NacCanaryEvm.sol";
import {NativeAtomicGatewayLib} from "../src/NativeAtomicGatewayLib.sol";
import {TestBase} from "./TestBase.sol";
import {Kt1AliasRelay, MockNativeAtomicGateway} from "./mocks/MockNativeAtomicGateway.sol";

/// @notice Intentionally unsafe high-level interface used only to demonstrate the EXTCODESIZE == 0 trap.
interface IUnsafeHighLevelGateway {
    function callMichelson(string calldata destination, string calldata entrypoint, bytes calldata data)
        external
        payable;

    function originOf(string calldata addr, uint8 sourceRuntime)
        external
        view
        returns (uint8 kind, uint8 homeRuntime, string memory nativeAddress);
}

/// @notice External helper so `vm.expectRevert()` observes Solidity's caller-side EXTCODESIZE revert.
contract UnsafeHighLevelCaller {
    function callOriginOf(string calldata addr, uint8 sourceRuntime)
        external
        view
        returns (uint8, uint8, string memory)
    {
        return IUnsafeHighLevelGateway(NativeAtomicGatewayLib.GATEWAY).originOf(addr, sourceRuntime);
    }

    function callMichelsonVoid(string calldata dest, string calldata ep, bytes calldata payload)
        external
    {
        IUnsafeHighLevelGateway(NativeAtomicGatewayLib.GATEWAY).callMichelson(dest, ep, payload);
    }
}

contract NacCanaryEvmTest is TestBase {
    string private constant CANARY_KT1 = "KT1NacCanary111111111111111111111111";
    string private constant ALICE_TZ1 = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
    string private constant ALICE_EVM_ALIAS = "0x3c0EE21DA093b0AA44c590BA0BB1883ef8080137";
    address private constant ATTACKER = address(0xBAD);
    uint256 private constant DEFAULT_GAS_CAP = 3_000_000;

    NacCanaryEvm private canary;
    MockNativeAtomicGateway private gateway;
    Kt1AliasRelay private kt1Alias;

    function setUp() public {
        MockNativeAtomicGateway impl = new MockNativeAtomicGateway();
        vm.etch(NativeAtomicGatewayLib.GATEWAY, address(impl).code);
        gateway = MockNativeAtomicGateway(NativeAtomicGatewayLib.GATEWAY);

        canary = new NacCanaryEvm();
        kt1Alias = new Kt1AliasRelay();
    }

    function testVerifiedPreviewnetSelectors() public pure {
        // Verified live on Previewnet v0.11 in 07-milestone0-verification.md
        assertEq(NativeAtomicGatewayLib.SEL_CALL_MICHELSON_VIEW, bytes4(0x8326329c));
        assertEq(NativeAtomicGatewayLib.SEL_MATERIALIZE_ALIAS, bytes4(0xbfe88b4b));
        assertEq(
            NacCanaryEvm.onMichelsonCallback.selector,
            bytes4(keccak256("onMichelsonCallback(uint256,uint256)"))
        );
        assertEq(NacCanaryEvm.echoView.selector, bytes4(keccak256("echoView(uint256)")));
    }

    function testZeroCodeGatewayTrapVsLowLevelCall() public {
        // Simulate Previewnet v0.11 where eth_getCode(0xff00...0007) == 0x (EXTCODESIZE == 0)
        vm.etch(NativeAtomicGatewayLib.GATEWAY, hex"");
        assertEq(NativeAtomicGatewayLib.GATEWAY.code.length, 0);

        UnsafeHighLevelCaller unsafeCaller = new UnsafeHighLevelCaller();

        // High-level Solidity interface calls revert on EXTCODESIZE == 0 (both return-value and void calls!)
        vm.expectRevert();
        unsafeCaller.callOriginOf(ALICE_TZ1, 0);

        vm.expectRevert();
        unsafeCaller.callMichelsonVoid(CANARY_KT1, "record_ping", Micheline.encodeString("trap"));

        // Low-level .staticcall in NativeAtomicGatewayLib does NOT revert on EXTCODESIZE == 0
        (bool ok, bytes memory data) = canary.inspectOrigin(ALICE_TZ1, 0);
        assertTrue(ok);
        assertEq(data, hex"");

        // Low-level .call in probeWrite also succeeds without EXTCODESIZE revert
        canary.probeWrite(CANARY_KT1, "zero-code-ok", DEFAULT_GAS_CAP);
        assertEq(canary.writeCount(), 1);
    }

    function testProbeWriteEncodesStringAndEnforcesMutezAlignment() public {
        vm.deal(address(this), 10 ether);
        uint256 twoMutezWei = 2e12;

        canary.probeWrite{value: twoMutezWei}(CANARY_KT1, "hello-nac", DEFAULT_GAS_CAP);

        assertEq(canary.writeCount(), 1);
        assertEq(gateway.lastDestination(), CANARY_KT1);
        assertEq(gateway.lastEntrypoint(), "record_ping");
        assertEq(gateway.lastPayload(), Micheline.encodeString("hello-nac"));
        assertEq(gateway.lastValue(), twoMutezWei);
        assertEq(address(gateway).balance, twoMutezWei);

        (uint256 echoed, uint256 writes) = canary.echoView(42);
        assertEq(echoed, 42);
        assertEq(writes, 1);

        // Sub-mutez dust must be rejected BEFORE touching the gateway or mutating writeCount
        uint256 dustyWei = 1e12 + 7;
        vm.expectRevert(abi.encodeWithSelector(Micheline.UnalignedMutezValue.selector, dustyWei, 7));
        canary.probeWrite{value: dustyWei}(CANARY_KT1, "dusty", DEFAULT_GAS_CAP);
        assertEq(canary.writeCount(), 1);
        assertEq(gateway.callCount(), 1);
    }

    function testProbeWriteBubblesRawGatewayRevert() public {
        bytes memory rawError = bytes("Cross-runtime call failed with status 500: SCRIPT_REJECTED");
        gateway.configureCallRevert(true, rawError);

        vm.expectRevert(rawError);
        canary.probeWrite(CANARY_KT1, "will-fail", DEFAULT_GAS_CAP);

        assertEq(canary.writeCount(), 0);
    }

    function testProbeRoundTripOpenAndAuthorizedAlias() public {
        // 1. Open mode (authorizedKt1Alias == address(0))
        gateway.configureCallback(address(canary), address(kt1Alias), 77, 1, 1, false);
        canary.probeRoundTrip(CANARY_KT1, 77, DEFAULT_GAS_CAP);

        assertEq(canary.roundTripCount(), 1);
        assertEq(canary.inRoundTrip(), false);
        assertEq(canary.callbackReceivedThisTx(), true);
        assertEq(canary.lastCallbackNonce(), 77);
        assertEq(canary.lastCallbackSender(), address(kt1Alias));
        assertEq(canary.lastMichelsonCallbackCount(), 1);
        assertEq(gateway.lastEntrypoint(), "echo_callback");
        assertEq(gateway.lastPayload(), Micheline.encodeNat(77));

        // 2. Owner binds authorizedKt1Alias
        vm.prank(ATTACKER);
        vm.expectRevert(NacCanaryEvm.NotOwner.selector);
        canary.setAuthorizedKt1Alias(address(kt1Alias));

        canary.setAuthorizedKt1Alias(address(kt1Alias));
        assertEq(canary.authorizedKt1Alias(), address(kt1Alias));

        // Authorized alias succeeds
        gateway.configureCallback(address(canary), address(kt1Alias), 128, 2, 1, false);
        canary.probeRoundTrip(CANARY_KT1, 128, DEFAULT_GAS_CAP);
        assertEq(canary.roundTripCount(), 2);
        assertEq(canary.lastCallbackNonce(), 128);
        assertEq(canary.lastMichelsonCallbackCount(), 2);

        // Unauthorized sender (gateway calling directly instead of kt1Alias) reverts
        gateway.configureCallback(address(canary), address(0), 129, 3, 1, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                NacCanaryEvm.UnauthorizedKt1Alias.selector, address(gateway), address(kt1Alias)
            )
        );
        canary.probeRoundTrip(CANARY_KT1, 129, DEFAULT_GAS_CAP);
        assertEq(canary.roundTripCount(), 2);
        assertEq(canary.inRoundTrip(), false);
    }

    function testRoundTripCallbackGuards() public {
        // Direct callback outside round-trip reverts
        vm.expectRevert(NacCanaryEvm.CallbackOutsideRoundTrip.selector);
        canary.onMichelsonCallback(1, 1);

        // Missing callback reverts and rolls back roundTripCount + inRoundTrip
        gateway.configureCallback(address(0), address(0), 0, 0, 0, false);
        vm.expectRevert(NacCanaryEvm.MissingCallback.selector);
        canary.probeRoundTrip(CANARY_KT1, 9, DEFAULT_GAS_CAP);
        assertEq(canary.roundTripCount(), 0);
        assertEq(canary.inRoundTrip(), false);

        // Nonce mismatch reverts
        gateway.configureCallback(address(canary), address(kt1Alias), 999, 1, 1, false);
        vm.expectRevert(abi.encodeWithSelector(NacCanaryEvm.CallbackNonceMismatch.selector, 10, 999));
        canary.probeRoundTrip(CANARY_KT1, 10, DEFAULT_GAS_CAP);
        assertEq(canary.roundTripCount(), 0);

        // Duplicate callback reverts
        gateway.configureCallback(address(canary), address(kt1Alias), 11, 1, 2, false);
        vm.expectRevert(NacCanaryEvm.DuplicateCallback.selector);
        canary.probeRoundTrip(CANARY_KT1, 11, DEFAULT_GAS_CAP);
        assertEq(canary.roundTripCount(), 0);

        // Reentrant probeRoundTrip inside callback reverts
        gateway.configureCallback(address(canary), address(kt1Alias), 12, 1, 1, true);
        vm.expectRevert(NacCanaryEvm.ReentrantRoundTrip.selector);
        canary.probeRoundTrip(CANARY_KT1, 12, DEFAULT_GAS_CAP);
        assertEq(canary.roundTripCount(), 0);
        assertEq(canary.inRoundTrip(), false);
    }

    function testProbeViewReturnsRawMichelineAndBubbles404() public {
        // Simulate Micheline Pair(ping_count=3, Pair(callback_count=1, echo=99))
        bytes memory digestMicheline = Micheline.encodePair(
            Micheline.encodeNat(3),
            Micheline.encodePair(Micheline.encodeNat(1), Micheline.encodeNat(99))
        );
        gateway.configureViewResponse(false, digestMicheline);

        bytes memory raw = canary.probeView(CANARY_KT1, 99);
        assertEq(raw, digestMicheline);

        // Simulate Previewnet v0.11 UTF-8 404 error
        bytes memory err404 = bytes(
            "Cross-runtime call failed with status 404 Not Found: view \"get_state_digest\" not found"
        );
        gateway.configureViewResponse(true, err404);
        vm.expectRevert(err404);
        canary.probeView(CANARY_KT1, 99);
    }

    function testProbeRollbackRevertsSentinelAtomically() public {
        bytes memory forceFailErr = bytes("MICHELSON_FORCE_FAIL:rollback_proof");
        gateway.configureCallRevert(true, forceFailErr);

        assertEq(canary.rollbackSentinel(), 0);
        vm.expectRevert(forceFailErr);
        canary.probeRollback(CANARY_KT1, "rollback_proof", DEFAULT_GAS_CAP);

        // Proves EVM storage write (rollbackSentinel++) rolled back atomically on Michelson failure
        assertEq(canary.rollbackSentinel(), 0);
    }

    function testProbeOogSuccessCatchAndPropagate() public {
        // 1. Clean execution with small work
        gateway.configureBurnLoops(5);
        (bool ok1, bytes memory ret1, uint256 gasUsed1) =
            canary.probeOog(CANARY_KT1, 5, DEFAULT_GAS_CAP, true);
        assertTrue(ok1);
        assertEq(ret1, hex"");
        assertGt(gasUsed1, 0);
        assertEq(canary.lastOogOk(), true);
        assertEq(canary.lastOogGasUsed(), gasUsed1);
        assertEq(gateway.lastEntrypoint(), "burn_gas");
        assertEq(gateway.lastPayload(), Micheline.encodeNat(5));

        // 2. Previewnet v0.11 429 OOG error — catchRevert = true records telemetry without reverting
        bytes memory err429 =
            bytes("Cross-runtime call failed with status 429 Too Many Requests: Out of gas");
        gateway.configureCallRevert(true, err429);
        (bool ok2, bytes memory ret2, uint256 gasUsed2) =
            canary.probeOog(CANARY_KT1, 50_000, 100_000, true);
        assertFalse(ok2);
        assertEq(ret2, err429);
        assertGt(gasUsed2, 0);
        assertEq(canary.lastOogOk(), false);
        assertEq(canary.lastOogReturnData(), err429);

        // 3. Same 429 OOG error — catchRevert = false bubbles raw bytes
        vm.expectRevert(err429);
        canary.probeOog(CANARY_KT1, 50_000, 100_000, false);

        // 4. Genuine EVM subcall OOG via tight gasCap
        gateway.configureCallRevert(false, hex"");
        gateway.configureBurnLoops(2_000);
        (bool ok3, bytes memory ret3, uint256 gasUsed3) =
            canary.probeOog(CANARY_KT1, 2_000, 25_000, true);
        assertFalse(ok3);
        assertEq(ret3, hex"");
        assertGt(gasUsed3, 20_000);
        assertEq(canary.lastOogOk(), false);

        vm.expectRevert(NativeAtomicGatewayLib.GatewayCallFailed.selector);
        canary.probeOog(CANARY_KT1, 2_000, 25_000, false);
    }

    function testInspectOriginAndResolveMatchM0Fixtures() public {
        gateway.configureOriginOf(
            NativeAtomicGatewayLib.ORIGIN_NATIVE,
            NativeAtomicGatewayLib.RUNTIME_MICHELSON,
            ALICE_TZ1
        );
        gateway.configureResolveAddress(
            true, NativeAtomicGatewayLib.RESOLUTION_ALIAS, ALICE_EVM_ALIAS
        );

        (bool okOrigin, bytes memory originData) =
            canary.inspectOrigin(ALICE_TZ1, NativeAtomicGatewayLib.RUNTIME_MICHELSON);
        assertTrue(okOrigin);
        (uint8 kind, uint8 homeRuntime, string memory nativeAddress) =
            NativeAtomicGatewayLib.decodeOriginOf(originData);
        assertEq(kind, NativeAtomicGatewayLib.ORIGIN_NATIVE);
        assertEq(homeRuntime, NativeAtomicGatewayLib.RUNTIME_MICHELSON);
        assertEq(nativeAddress, ALICE_TZ1);

        (bool okResolve, bytes memory resolveData) = canary.inspectResolve(
            ALICE_TZ1,
            NativeAtomicGatewayLib.RUNTIME_MICHELSON,
            NativeAtomicGatewayLib.RUNTIME_EVM
        );
        assertTrue(okResolve);
        (bool classified, uint8 resolution, string memory translated) =
            NativeAtomicGatewayLib.decodeResolveAddress(resolveData);
        assertTrue(classified);
        assertEq(resolution, NativeAtomicGatewayLib.RESOLUTION_ALIAS);
        assertEq(translated, ALICE_EVM_ALIAS);
    }

    function testMaterializeAliasLowLevelCall() public {
        string memory alicePubKey = "edpkvGfYw3LyB1UcCahKQk4rF2tvbMUk8GFiTuMjL75uGXrpvKXhjn";

        // Missing public key reproduces verified Previewnet v0.11 UTF-8 error
        (bool okMissing, bytes memory errMissing) =
            NativeAtomicGatewayLib.materializeAlias("tezos", ALICE_TZ1, "");
        assertFalse(okMissing);
        assertEq(
            errMissing,
            bytes("materializeAlias: Native address verification error: Missing public key")
        );

        // Valid public key succeeds via low-level .call
        (bool okValid, bytes memory retValid) =
            NativeAtomicGatewayLib.materializeAlias("tezos", ALICE_TZ1, alicePubKey);
        assertTrue(okValid);
        assertEq(retValid, hex"");
        assertEq(gateway.lastMaterializeRuntime(), "tezos");
        assertEq(gateway.lastMaterializeAddress(), ALICE_TZ1);
        assertEq(gateway.lastMaterializePublicKey(), alicePubKey);
        assertEq(gateway.materializeCallCount(), 1);
    }
}
