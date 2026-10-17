// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ForemanReviewReceiver} from "../src/cre/ForemanReviewReceiver.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";
import {IERC165} from "../src/cre/IERC165.sol";

contract ForemanReviewReceiverTest is Test {
    ForemanReviewReceiver rx;
    address forwarder = makeAddr("forwarder");
    address stranger = makeAddr("stranger");

    bytes32 constant REASON = keccak256("reason");
    bytes32 constant EVIDENCE = keccak256("evidence");

    event ReviewAttested(
        uint256 indexed jobId,
        uint256 indexed index,
        uint8 verdict,
        bytes32 reasonHash,
        bytes32 evidenceHash,
        uint256 timestamp
    );

    function setUp() public {
        rx = new ForemanReviewReceiver(forwarder);
    }

    function _report(uint256 jobId, uint256 index, uint8 verdict) internal pure returns (bytes memory) {
        return abi.encode(jobId, index, verdict, REASON, EVIDENCE);
    }

    function test_onlyForwarder() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ForemanReviewReceiver.NotForwarder.selector, stranger, forwarder));
        rx.onReport("", _report(1, 0, 0));
    }

    function test_decodesAndStores() public {
        vm.warp(1_700_000_000);
        vm.prank(forwarder);
        rx.onReport(hex"abcd", _report(7, 2, 1));

        (uint8 v, bytes32 r, bytes32 e, uint64 ts) = rx.attestation(7, 2);
        assertEq(v, 1);
        assertEq(r, REASON);
        assertEq(e, EVIDENCE);
        assertEq(ts, 1_700_000_000);
        assertEq(rx.attestationCount(), 1);
    }

    function test_emitsEvent() public {
        vm.warp(123456);
        vm.expectEmit(true, true, false, true, address(rx));
        emit ReviewAttested(3, 1, 2, REASON, EVIDENCE, 123456);
        vm.prank(forwarder);
        rx.onReport("", _report(3, 1, 2));
    }

    function test_latestWinsAndCounterIncrements() public {
        vm.startPrank(forwarder);
        rx.onReport("", _report(1, 0, 1));
        rx.onReport("", _report(1, 0, 0));
        rx.onReport("", _report(1, 1, 2));
        vm.stopPrank();

        (uint8 v,,,) = rx.attestation(1, 0);
        assertEq(v, 0);
        assertEq(rx.attestationCount(), 3);
    }

    function test_unattestedIsEmpty() public view {
        (,,, uint64 ts) = rx.attestation(99, 99);
        assertEq(ts, 0);
    }

    function test_rejectsInvalidVerdict() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ForemanReviewReceiver.InvalidVerdict.selector, uint8(3)));
        rx.onReport("", _report(1, 0, 3));
    }

    function test_rejectsMalformedReport() public {
        vm.prank(forwarder);
        vm.expectRevert();
        rx.onReport("", hex"1234");
    }

    function test_supportsInterface() public view {
        assertTrue(rx.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(rx.supportsInterface(type(IERC165).interfaceId));
        assertTrue(rx.supportsInterface(0x01ffc9a7));
        assertFalse(rx.supportsInterface(0xffffffff));
        // IReceiver id is the onReport selector alone (ERC-165 id is inherited, not folded in).
        assertEq(type(IReceiver).interfaceId, IReceiver.onReport.selector);
    }

    function test_constructorRejectsZeroForwarder() public {
        vm.expectRevert(bytes("forwarder=0"));
        new ForemanReviewReceiver(address(0));
    }
}
