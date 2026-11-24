// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Micheline} from "../src/Micheline.sol";
import {TestBase} from "./TestBase.sol";

contract MichelineHarness {
    function assertMutezAligned(uint256 weiValue) external pure {
        Micheline.assertMutezAligned(weiValue);
    }

    function weiToMutez(uint256 weiValue) external pure returns (uint256) {
        return Micheline.weiToMutez(weiValue);
    }

    function encodeUnit() external pure returns (bytes memory) {
        return Micheline.encodeUnit();
    }

    function encodeBool(bool value) external pure returns (bytes memory) {
        return Micheline.encodeBool(value);
    }

    function encodeString(string memory value) external pure returns (bytes memory) {
        return Micheline.encodeString(value);
    }

    function encodeBytes(bytes memory value) external pure returns (bytes memory) {
        return Micheline.encodeBytes(value);
    }

    function encodeAddressBytes(address addr) external pure returns (bytes memory) {
        return Micheline.encodeAddressBytes(addr);
    }

    function encodeNat(uint256 value) external pure returns (bytes memory) {
        return Micheline.encodeNat(value);
    }

    function encodeInt(int256 value) external pure returns (bytes memory) {
        return Micheline.encodeInt(value);
    }

    function encodePair(bytes memory left, bytes memory right)
        external
        pure
        returns (bytes memory)
    {
        return Micheline.encodePair(left, right);
    }

    function encodeLeft(bytes memory inner) external pure returns (bytes memory) {
        return Micheline.encodeLeft(inner);
    }

    function encodeRight(bytes memory inner) external pure returns (bytes memory) {
        return Micheline.encodeRight(inner);
    }

    function encodeSome(bytes memory inner) external pure returns (bytes memory) {
        return Micheline.encodeSome(inner);
    }

    function encodeNone() external pure returns (bytes memory) {
        return Micheline.encodeNone();
    }

    function encodeSeq(bytes[] memory items) external pure returns (bytes memory) {
        return Micheline.encodeSeq(items);
    }
}

contract MichelineTest is TestBase {
    MichelineHarness private harness;

    function setUp() public {
        harness = new MichelineHarness();
    }

    function testXpectGoldenNatZarithBoundaries() public view {
        assertEq(harness.encodeNat(0), hex"0000");
        assertEq(harness.encodeNat(63), hex"003f");
        assertEq(harness.encodeNat(64), hex"008001");
        assertEq(harness.encodeNat(127), hex"00bf01");
        assertEq(harness.encodeNat(128), hex"008002");
        assertEq(
            harness.encodeNat(type(uint256).max),
            hex"00bfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1f"
        );
    }

    function testXpectGoldenCompositePairVector() public view {
        address beneficiary = 0x1111111111111111111111111111111111111111;
        assertEq(
            harness.encodeAddressBytes(beneficiary),
            hex"0a000000141111111111111111111111111111111111111111"
        );

        bytes memory buyTrue64 = harness.encodePair(
            harness.encodeAddressBytes(beneficiary),
            harness.encodePair(harness.encodeBool(true), harness.encodeNat(64))
        );
        assertEq(
            buyTrue64,
            hex"07070a0000001411111111111111111111111111111111111111110707030a008001"
        );

        bytes memory buyFalse128 = harness.encodePair(
            harness.encodeAddressBytes(beneficiary),
            harness.encodePair(harness.encodeBool(false), harness.encodeNat(128))
        );
        assertEq(
            buyFalse128,
            hex"07070a00000014111111111111111111111111111111111111111107070303008002"
        );
    }

    function testSignedIntZarithBoundaries() public view {
        assertEq(harness.encodeInt(0), hex"0000");
        assertEq(harness.encodeInt(1), hex"0001");
        assertEq(harness.encodeInt(-1), hex"0041");
        assertEq(harness.encodeInt(63), hex"003f");
        assertEq(harness.encodeInt(-63), hex"007f");
        assertEq(harness.encodeInt(64), hex"008001");
        assertEq(harness.encodeInt(-64), hex"00c001");
        assertEq(harness.encodeInt(-65), hex"00c101");
        assertEq(harness.encodeInt(-127), hex"00ff01");
        assertEq(harness.encodeInt(-128), hex"00c002");

        // type(int256).max = 2^255 - 1: 6 + 35*7 + 4 = 255 bits -> 0x0f in final byte
        assertEq(
            harness.encodeInt(type(int256).max),
            hex"00bfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0f"
        );

        // type(int256).min = -2^255: sign bit (0x40) + continuation (0x80) = 0xc0,
        // 35 middle bytes of 0x80, final byte 0x10 (bit 255 = 1 << 4 in byte 36)
        assertEq(
            harness.encodeInt(type(int256).min),
            hex"00c0808080808080808080808080808080808080808080808080808080808080808080808010"
        );
    }

    function testPrimitivesStringBytesSumOptionAndSeq() public view {
        assertEq(harness.encodeUnit(), hex"030b");
        assertEq(harness.encodeBool(true), hex"030a");
        assertEq(harness.encodeBool(false), hex"0303");
        assertEq(harness.encodeNone(), hex"0306");

        assertEq(harness.encodeString(""), hex"0100000000");
        assertEq(harness.encodeString("hello"), hex"010000000568656c6c6f");
        assertEq(harness.encodeString("nac-ping"), hex"01000000086e61632d70696e67");

        assertEq(harness.encodeBytes(hex""), hex"0a00000000");
        assertEq(harness.encodeBytes(hex"deadbeef"), hex"0a00000004deadbeef");

        assertEq(harness.encodeSome(harness.encodeNat(7)), hex"05090007");
        assertEq(harness.encodeLeft(harness.encodeUnit()), hex"0505030b");
        assertEq(harness.encodeRight(harness.encodeBool(true)), hex"0508030a");

        bytes[] memory items = new bytes[](2);
        items[0] = harness.encodeNat(1);
        items[1] = harness.encodeNat(2);
        // Each nat is 2 bytes -> total seq byte length = 4 (0x00000004)
        assertEq(harness.encodeSeq(items), hex"020000000400010002");
    }

    function testMutezAlignmentGuardrail() public {
        harness.assertMutezAligned(0);
        harness.assertMutezAligned(1e12);
        harness.assertMutezAligned(1 ether);

        assertEq(harness.weiToMutez(0), 0);
        assertEq(harness.weiToMutez(1e12), 1);
        assertEq(harness.weiToMutez(1 ether), 1_000_000);

        vm.expectRevert(abi.encodeWithSelector(Micheline.UnalignedMutezValue.selector, 1, 1));
        harness.assertMutezAligned(1);

        vm.expectRevert(
            abi.encodeWithSelector(Micheline.UnalignedMutezValue.selector, 1e12 - 1, 1e12 - 1)
        );
        harness.assertMutezAligned(1e12 - 1);

        vm.expectRevert(
            abi.encodeWithSelector(Micheline.UnalignedMutezValue.selector, 1 ether + 42, 42)
        );
        harness.weiToMutez(1 ether + 42);
    }
}
