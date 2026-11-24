// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function prank(address sender, address origin) external;
    function deal(address account, uint256 balance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
}

abstract contract TestBase {
    // 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();

    function assertTrue(bool condition) internal pure {
        if (!condition) revert AssertionFailed();
    }

    function assertFalse(bool condition) internal pure {
        if (condition) revert AssertionFailed();
    }

    function assertGt(uint256 a, uint256 b) internal pure {
        if (a <= b) revert AssertionFailed();
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(bytes4 actual, bytes4 expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(address actual, address expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(bool actual, bool expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(bytes memory actual, bytes memory expected) internal pure {
        if (keccak256(actual) != keccak256(expected)) revert AssertionFailed();
    }

    function assertEq(string memory actual, string memory expected) internal pure {
        if (keccak256(bytes(actual)) != keccak256(bytes(expected))) revert AssertionFailed();
    }
}
