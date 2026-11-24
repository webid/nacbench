// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Micheline
/// @notice Standalone binary Micheline expression encoder for Tezos X Native Atomic Composability (NAC).
/// @dev Produces raw binary Micheline expressions WITHOUT the 0x05 PACK prefix, matching the exact
///      wire format expected by the Tezos X gateway precompile (0xff00000000000000000000000000000000000007).
library Micheline {
    /// @notice Conversion ratio between EVM wei (10^18 / XTZ) and Tezos mutez (10^6 / XTZ).
    uint256 internal constant WEI_PER_MUTEZ = 1e12;

    // Micheline binary node tags
    bytes1 private constant TAG_INT = 0x00;
    bytes1 private constant TAG_STRING = 0x01;
    bytes1 private constant TAG_SEQ = 0x02;
    bytes1 private constant TAG_BYTES = 0x0a;

    // 0-arg, 0-annot primitives (node tag 0x03 + Michelson v1 primitive opcode)
    bytes2 private constant PRIM_FALSE = hex"0303";
    bytes2 private constant PRIM_NONE = hex"0306";
    bytes2 private constant PRIM_TRUE = hex"030a";
    bytes2 private constant PRIM_UNIT = hex"030b";

    // 1-arg, 0-annot primitives (node tag 0x05 + Michelson v1 primitive opcode)
    bytes2 private constant PRIM_LEFT = hex"0505";
    bytes2 private constant PRIM_RIGHT = hex"0508";
    bytes2 private constant PRIM_SOME = hex"0509";

    // 2-arg, 0-annot primitives (node tag 0x07 + Michelson v1 primitive opcode)
    bytes2 private constant PRIM_PAIR = hex"0707";

    /// @notice Thrown when a wei transfer to Michelson has sub-mutez dust (weiValue % 1e12 != 0).
    error UnalignedMutezValue(uint256 weiValue, uint256 remainder);

    /// @notice Thrown when a dynamic byte/string payload exceeds uint32 length.
    error LengthOverflow(uint256 length);

    /// @notice Enforces the Tezos X 10^12 wei-to-mutez dust guardrail.
    /// @dev Reverts if `weiValue` is not an exact multiple of 1e12 wei (1 mutez).
    function assertMutezAligned(uint256 weiValue) internal pure {
        uint256 remainder = weiValue % WEI_PER_MUTEZ;
        if (remainder != 0) {
            revert UnalignedMutezValue(weiValue, remainder);
        }
    }

    /// @notice Converts a mutez-aligned wei amount to mutez, reverting on sub-mutez dust.
    function weiToMutez(uint256 weiValue) internal pure returns (uint256) {
        assertMutezAligned(weiValue);
        return weiValue / WEI_PER_MUTEZ;
    }

    /// @notice Encodes Michelson `Unit` (`0x030b`).
    function encodeUnit() internal pure returns (bytes memory) {
        return abi.encodePacked(PRIM_UNIT);
    }

    /// @notice Encodes Michelson `bool` (`True` = `0x030a`, `False` = `0x0303`).
    function encodeBool(bool value) internal pure returns (bytes memory) {
        return abi.encodePacked(value ? PRIM_TRUE : PRIM_FALSE);
    }

    /// @notice Encodes Michelson `string` (`0x01 || uint32_be(len) || utf8_bytes`).
    function encodeString(string memory value) internal pure returns (bytes memory) {
        bytes memory raw = bytes(value);
        if (raw.length > type(uint32).max) {
            revert LengthOverflow(raw.length);
        }
        return abi.encodePacked(TAG_STRING, bytes4(uint32(raw.length)), raw);
    }

    /// @notice Encodes Michelson `bytes` (`0x0a || uint32_be(len) || raw_bytes`).
    function encodeBytes(bytes memory value) internal pure returns (bytes memory) {
        if (value.length > type(uint32).max) {
            revert LengthOverflow(value.length);
        }
        return abi.encodePacked(TAG_BYTES, bytes4(uint32(value.length)), value);
    }

    /// @notice Encodes a 20-byte EVM address as a Micheline `bytes` node.
    function encodeAddressBytes(address addr) internal pure returns (bytes memory) {
        return abi.encodePacked(TAG_BYTES, bytes4(uint32(20)), bytes20(addr));
    }

    /// @notice Encodes a Michelson `nat` as a non-negative Micheline `Int` node (`0x00 || zarith`).
    function encodeNat(uint256 value) internal pure returns (bytes memory) {
        return bytes.concat(TAG_INT, encodeSignedZarith(value, false));
    }

    /// @notice Encodes a Michelson `int` as a signed Micheline `Int` node (`0x00 || signed_zarith`).
    function encodeInt(int256 value) internal pure returns (bytes memory) {
        if (value >= 0) {
            return bytes.concat(TAG_INT, encodeSignedZarith(uint256(value), false));
        }
        uint256 magnitude;
        unchecked {
            // Safe for all negative int256 values, including type(int256).min (-2^255).
            magnitude = uint256(0) - uint256(value);
        }
        return bytes.concat(TAG_INT, encodeSignedZarith(magnitude, true));
    }

    /// @notice Encodes a binary Michelson `Pair(left, right)` (`0x0707 || left || right`).
    function encodePair(bytes memory left, bytes memory right)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(PRIM_PAIR, left, right);
    }

    /// @notice Encodes Michelson `Left(inner)` (`0x0505 || inner`).
    function encodeLeft(bytes memory inner) internal pure returns (bytes memory) {
        return bytes.concat(PRIM_LEFT, inner);
    }

    /// @notice Encodes Michelson `Right(inner)` (`0x0508 || inner`).
    function encodeRight(bytes memory inner) internal pure returns (bytes memory) {
        return bytes.concat(PRIM_RIGHT, inner);
    }

    /// @notice Encodes Michelson `Some(inner)` (`0x0509 || inner`).
    function encodeSome(bytes memory inner) internal pure returns (bytes memory) {
        return bytes.concat(PRIM_SOME, inner);
    }

    /// @notice Encodes Michelson `None` (`0x0306`).
    function encodeNone() internal pure returns (bytes memory) {
        return abi.encodePacked(PRIM_NONE);
    }

    /// @notice Encodes a Micheline sequence (`0x02 || uint32_be(byte_len) || concat(items)`).
    function encodeSeq(bytes[] memory items) internal pure returns (bytes memory) {
        bytes memory body;
        for (uint256 i = 0; i < items.length; ++i) {
            body = bytes.concat(body, items[i]);
        }
        if (body.length > type(uint32).max) {
            revert LengthOverflow(body.length);
        }
        return abi.encodePacked(TAG_SEQ, bytes4(uint32(body.length)), body);
    }

    /// @notice Encodes a magnitude + sign bit in Tezos signed Zarith format.
    /// @dev Byte 0: [continuation (bit 7)][sign (bit 6)][6 LSBs of magnitude (bits 0..5)].
    ///      Subsequent bytes: [continuation (bit 7)][7 magnitude bits (bits 0..6)].
    function encodeSignedZarith(uint256 magnitude, bool isNegative)
        internal
        pure
        returns (bytes memory encoded)
    {
        // Max uint256 (256 bits) needs 6 + 35*7 + 5 = 37 bytes.
        encoded = new bytes(37);
        uint256 remaining = magnitude >> 6;
        uint256 length = 1;
        uint8 first = uint8(magnitude & 0x3f);

        if (isNegative && magnitude > 0) {
            first |= 0x40;
        }
        if (remaining > 0) {
            first |= 0x80;
        }
        encoded[0] = bytes1(first);

        while (remaining > 0) {
            uint8 next = uint8(remaining & 0x7f);
            remaining >>= 7;
            if (remaining > 0) {
                next |= 0x80;
            }
            encoded[length] = bytes1(next);
            unchecked {
                ++length;
            }
        }

        assembly ("memory-safe") {
            mstore(encoded, length)
        }
    }
}
