// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Stagepay, IERC20 as SPToken} from "../src/vendor/Stagepay.sol";
import {ForemanPolicy} from "../src/ForemanPolicy.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract ForemanPolicyTest is Test {
    uint128 constant U = 1e6; // 1 USDC
    uint128 constant AUTO_CAP = 100 * U;
    uint128 constant DAILY_CAP = 250 * U;
    uint64 constant REVIEW = 3 days;
    bytes32 constant TERMS = keccak256("terms");
    bytes32 constant REASON = keccak256("reason");

    Stagepay sp;
    MockUSDC usdc;
    ForemanPolicy policy;

    address owner = address(this);
    address agent = makeAddr("agent");
    address freelancer = makeAddr("freelancer");
    address stranger = makeAddr("stranger");

    event JobFunded(uint256 indexed jobId, address indexed freelancer, address token, uint256 total, bytes32 termsHash);
    event AgentDecision(uint256 indexed jobId, uint256 indexed index, uint8 action, uint256 amount, bytes32 reasonHash);
    event Escalated(uint256 indexed jobId, uint256 indexed index, uint256 amount, bytes32 reasonHash);
    event OwnerCosigned(uint256 indexed jobId, uint256 indexed index, uint256 amount);
    event PausedSet(bool paused);

    function setUp() public {
        vm.warp(1_800_000_000);
        sp = new Stagepay();
        usdc = new MockUSDC();
        policy = new ForemanPolicy(address(sp), agent, AUTO_CAP, DAILY_CAP);
        usdc.mint(owner, 100_000 * U);
        usdc.approve(address(policy), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _fund(uint128[] memory amounts) internal returns (uint256 jobId) {
        uint64[] memory deadlines = new uint64[](amounts.length);
        for (uint256 i; i < amounts.length; ++i) {
            deadlines[i] = uint64(block.timestamp + 7 days);
        }
        jobId = policy.fundJob(freelancer, address(usdc), amounts, deadlines, REVIEW, TERMS);
    }

    function _amounts(uint128 a, uint128 b) internal pure returns (uint128[] memory r) {
        r = new uint128[](2);
        r[0] = a;
        r[1] = b;
    }

    function _one(uint128 a) internal pure returns (uint128[] memory r) {
        r = new uint128[](1);
        r[0] = a;
    }

    function _submit(uint256 jobId, uint256 index) internal {
        vm.prank(freelancer);
        sp.submit(jobId, index, "https://github.com/x/y/pull/1");
    }

    // --------------------------------------------------------------- setup

    function test_constructor() public view {
        assertEq(policy.owner(), owner);
        assertEq(policy.agent(), agent);
        assertEq(address(policy.stagepay()), address(sp));
        assertEq(policy.autoApproveCap(), AUTO_CAP);
        assertEq(policy.dailyCap(), DAILY_CAP);
        assertFalse(policy.paused());
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(ForemanPolicy.InvalidParams.selector);
        new ForemanPolicy(address(0), agent, AUTO_CAP, DAILY_CAP);
        vm.expectRevert(ForemanPolicy.InvalidParams.selector);
        new ForemanPolicy(address(sp), address(0), AUTO_CAP, DAILY_CAP);
    }

    function test_fundJob() public {
        uint256 before = usdc.balanceOf(owner);
        vm.expectEmit(true, true, false, true);
        emit JobFunded(1, freelancer, address(usdc), 150 * U, TERMS);
        uint256 jobId = _fund(_amounts(50 * U, 100 * U));

        assertEq(jobId, 1);
        assertTrue(policy.managed(jobId));
        assertEq(policy.jobCount(), 1);
        assertEq(policy.jobAt(0), jobId);
        assertEq(before - usdc.balanceOf(owner), 150 * U);
        assertEq(usdc.balanceOf(address(sp)), 150 * U);
        assertEq(usdc.balanceOf(address(policy)), 0);
        assertEq(usdc.allowance(address(policy), address(sp)), 0); // exactly consumed
        (address client,,,,,,) = sp.jobs(jobId);
        assertEq(client, address(policy)); // the policy is the Stagepay client
    }

    function test_fundJob_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.fundJob(freelancer, address(usdc), _one(U), new uint64[](1), REVIEW, TERMS);
    }

    // --------------------------------------------------------------- agent

    function test_agentApprove_paysFreelancer() public {
        uint256 jobId = _fund(_amounts(50 * U, 100 * U));
        _submit(jobId, 0);

        vm.expectEmit(true, true, false, true);
        emit AgentDecision(jobId, 0, 0, 50 * U, REASON);
        vm.prank(agent);
        policy.agentApprove(jobId, 0, REASON);

        assertEq(usdc.balanceOf(freelancer), 50 * U);
        assertEq(policy.spentToday(), 50 * U);
        assertEq(policy.remainingToday(), DAILY_CAP - 50 * U);
    }

    function test_agentApprove_overCapReverts() public {
        uint256 jobId = _fund(_one(AUTO_CAP + 1));
        _submit(jobId, 0);
        vm.prank(agent);
        vm.expectRevert(ForemanPolicy.OverAutoApproveCap.selector);
        policy.agentApprove(jobId, 0, REASON);
        assertEq(usdc.balanceOf(freelancer), 0);
    }

    function test_agentApprove_exactlyAtCap() public {
        uint256 jobId = _fund(_one(AUTO_CAP));
        _submit(jobId, 0);
        vm.prank(agent);
        policy.agentApprove(jobId, 0, REASON);
        assertEq(usdc.balanceOf(freelancer), AUTO_CAP);
    }

    function test_agentApprove_requiresSubmitted() public {
        uint256 jobId = _fund(_one(U));
        vm.startPrank(agent);
        vm.expectRevert(ForemanPolicy.NotSubmitted.selector);
        policy.agentApprove(jobId, 0, REASON);
        vm.expectRevert(ForemanPolicy.NotSubmitted.selector);
        policy.agentRequestRevision(jobId, 0, "x", REASON);
        vm.expectRevert(ForemanPolicy.NotSubmitted.selector);
        policy.agentEscalate(jobId, 0, REASON);
        vm.stopPrank();
    }

    function test_agentApprove_cannotDoubleRelease() public {
        uint256 jobId = _fund(_one(U));
        _submit(jobId, 0);
        vm.startPrank(agent);
        policy.agentApprove(jobId, 0, REASON);
        vm.expectRevert(ForemanPolicy.NotSubmitted.selector);
        policy.agentApprove(jobId, 0, REASON);
        vm.stopPrank();
    }

    function test_unmanagedJobReverts() public {
        // a job created straight on Stagepay by someone else is not the policy's business
        usdc.mint(stranger, 10 * U);
        vm.startPrank(stranger);
        usdc.approve(address(sp), 10 * U);
        uint64[] memory dl = new uint64[](1);
        dl[0] = uint64(block.timestamp + 1 days);
        uint256 jobId = sp.createJob(freelancer, SPToken(address(usdc)), _one(10 * U), dl, REVIEW, TERMS);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(ForemanPolicy.NotManaged.selector);
        policy.agentApprove(jobId, 0, REASON);
    }

    function test_escalate_thenOwnerCosignPays() public {
        uint256 jobId = _fund(_amounts(50 * U, 500 * U));
        _submit(jobId, 1);

        vm.expectEmit(true, true, false, true);
        emit Escalated(jobId, 1, 500 * U, REASON);
        vm.expectEmit(true, true, false, true);
        emit AgentDecision(jobId, 1, 2, 500 * U, REASON);
        vm.prank(agent);
        policy.agentEscalate(jobId, 1, REASON);
        assertTrue(policy.escalated(jobId, 1));
        assertEq(usdc.balanceOf(freelancer), 0);

        vm.expectEmit(true, true, false, true);
        emit OwnerCosigned(jobId, 1, 500 * U);
        policy.ownerCosign(jobId, 1);

        assertEq(usdc.balanceOf(freelancer), 500 * U);
        assertFalse(policy.escalated(jobId, 1));
        assertEq(policy.spentToday(), 0); // owner-approved money is outside the agent's allowance
    }

    function test_cosignWithoutEscalationReverts() public {
        uint256 jobId = _fund(_one(500 * U));
        _submit(jobId, 0);
        vm.expectRevert(ForemanPolicy.NotEscalated.selector);
        policy.ownerCosign(jobId, 0);
    }

    function test_cosignOnlyOnce() public {
        uint256 jobId = _fund(_one(500 * U));
        _submit(jobId, 0);
        vm.prank(agent);
        policy.agentEscalate(jobId, 0, REASON);
        policy.ownerCosign(jobId, 0);
        vm.expectRevert(ForemanPolicy.NotEscalated.selector);
        policy.ownerCosign(jobId, 0);
    }

    function test_dailyCapAcrossTwoMilestones() public {
        // 3 x 100 = 300 > 250 cap
        uint128[] memory a = new uint128[](3);
        a[0] = a[1] = a[2] = 100 * U;
        uint256 jobId = _fund(a);
        for (uint256 i; i < 3; ++i) {
            _submit(jobId, i);
        }
        vm.startPrank(agent);
        policy.agentApprove(jobId, 0, REASON);
        policy.agentApprove(jobId, 1, REASON);
        assertEq(policy.remainingToday(), 50 * U);
        vm.expectRevert(ForemanPolicy.OverDailyCap.selector);
        policy.agentApprove(jobId, 2, REASON);
        vm.stopPrank();
        assertEq(usdc.balanceOf(freelancer), 200 * U);
    }

    function test_dailyCapResetsNextDay() public {
        uint128[] memory a = new uint128[](3);
        a[0] = a[1] = a[2] = 100 * U;
        uint256 jobId = _fund(a);
        for (uint256 i; i < 3; ++i) {
            _submit(jobId, i);
        }
        vm.startPrank(agent);
        policy.agentApprove(jobId, 0, REASON);
        policy.agentApprove(jobId, 1, REASON);
        vm.expectRevert(ForemanPolicy.OverDailyCap.selector);
        policy.agentApprove(jobId, 2, REASON);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        // review window is 3 days so the milestone is still pending
        assertEq(policy.spentToday(), 0);
        assertEq(policy.remainingToday(), DAILY_CAP);
        vm.prank(agent);
        policy.agentApprove(jobId, 2, REASON);
        assertEq(usdc.balanceOf(freelancer), 300 * U);
    }

    function test_remainingTodayFloorsAtZero() public {
        uint256 jobId = _fund(_one(100 * U));
        _submit(jobId, 0);
        vm.prank(agent);
        policy.agentApprove(jobId, 0, REASON);
        policy.setLimits(AUTO_CAP, 10 * U); // lower the cap below what was already spent
        assertEq(policy.remainingToday(), 0);
    }

    // --------------------------------------------------------------- pause

    function test_pauseBlocksAgentButNotOwner() public {
        uint256 jobId = _fund(_amounts(50 * U, 60 * U));
        _submit(jobId, 0);
        _submit(jobId, 1);

        vm.expectEmit(false, false, false, true);
        emit PausedSet(true);
        policy.setPaused(true);
        assertTrue(policy.paused());

        vm.startPrank(agent);
        vm.expectRevert(ForemanPolicy.IsPaused.selector);
        policy.agentApprove(jobId, 0, REASON);
        vm.expectRevert(ForemanPolicy.IsPaused.selector);
        policy.agentRequestRevision(jobId, 0, "x", REASON);
        vm.expectRevert(ForemanPolicy.IsPaused.selector);
        policy.agentEscalate(jobId, 0, REASON);
        vm.stopPrank();

        policy.ownerApprove(jobId, 0); // owner still works
        assertEq(usdc.balanceOf(freelancer), 50 * U);

        policy.setPaused(false);
        vm.prank(agent);
        policy.agentApprove(jobId, 1, REASON);
        assertEq(usdc.balanceOf(freelancer), 110 * U);
    }

    // --------------------------------------------------------- access control

    function test_accessControl() public {
        uint256 jobId = _fund(_one(U));
        _submit(jobId, 0);

        vm.startPrank(stranger);
        vm.expectRevert(ForemanPolicy.NotAgent.selector);
        policy.agentApprove(jobId, 0, REASON);
        vm.expectRevert(ForemanPolicy.NotAgent.selector);
        policy.agentEscalate(jobId, 0, REASON);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.ownerCosign(jobId, 0);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.ownerApprove(jobId, 0);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.withdraw(address(usdc), stranger, 1);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.setLimits(1, 1);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.setAgent(stranger);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.setPaused(true);
        vm.stopPrank();

        // the agent cannot use owner functions, and the owner is not the agent
        vm.startPrank(agent);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.ownerApprove(jobId, 0);
        vm.expectRevert(ForemanPolicy.NotOwner.selector);
        policy.setPaused(false);
        vm.stopPrank();
        vm.expectRevert(ForemanPolicy.NotAgent.selector);
        policy.agentApprove(jobId, 0, REASON);
    }

    function test_setAgentAndLimits() public {
        policy.setAgent(stranger);
        assertEq(policy.agent(), stranger);
        policy.setLimits(1, 2);
        assertEq(policy.autoApproveCap(), 1);
        assertEq(policy.dailyCap(), 2);
        vm.expectRevert(ForemanPolicy.InvalidParams.selector);
        policy.setAgent(address(0));
    }

    // ------------------------------------------------------------ revisions

    function test_agentRevision_andStagepayCap() public {
        uint256 jobId = _fund(_one(50 * U));
        for (uint256 i; i < 3; ++i) {
            _submit(jobId, 0);
            vm.expectEmit(true, true, false, true);
            emit AgentDecision(jobId, 0, 1, 50 * U, REASON);
            vm.prank(agent);
            policy.agentRequestRevision(jobId, 0, "please fix X", REASON);
            assertEq(sp.getMilestone(jobId, 0).revisions, i + 1);
        }
        // 4th revision: Stagepay refuses, the policy cannot get around it
        _submit(jobId, 0);
        vm.prank(agent);
        vm.expectRevert(Stagepay.RevisionLimit.selector);
        policy.agentRequestRevision(jobId, 0, "again", REASON);
        // but approving still works
        vm.prank(agent);
        policy.agentApprove(jobId, 0, REASON);
        assertEq(usdc.balanceOf(freelancer), 50 * U);
    }

    // -------------------------------------------------- refunds and settlement

    function test_cancelExpired_refundThenWithdraw() public {
        uint256 jobId = _fund(_amounts(50 * U, 70 * U));
        vm.warp(block.timestamp + 8 days); // past the 7 day deadline
        policy.ownerCancelExpired(jobId, 0);
        assertEq(usdc.balanceOf(address(policy)), 50 * U); // refund lands in the policy

        address treasury = makeAddr("treasury");
        policy.withdraw(address(usdc), treasury, 50 * U);
        assertEq(usdc.balanceOf(treasury), 50 * U);
        assertEq(usdc.balanceOf(address(policy)), 0);
    }

    function test_ownerSplit() public {
        uint256 jobId = _fund(_one(100 * U));
        _submit(jobId, 0);
        policy.ownerProposeSplit(jobId, 0, 40 * U);
        vm.prank(freelancer);
        sp.acceptSplit(jobId, 0, 40 * U);
        assertEq(usdc.balanceOf(freelancer), 40 * U);
        assertEq(usdc.balanceOf(address(policy)), 60 * U);

        // and the freelancer-proposed direction through ownerAcceptSplit
        uint256 job2 = _fund(_one(100 * U));
        _submit(job2, 0);
        vm.prank(freelancer);
        sp.proposeSplit(job2, 0, 70 * U);
        policy.ownerAcceptSplit(job2, 0, 70 * U);
        assertEq(usdc.balanceOf(freelancer), 110 * U);
    }

    function test_ownerRequestRevision() public {
        uint256 jobId = _fund(_one(100 * U));
        _submit(jobId, 0);
        vm.prank(agent);
        policy.agentEscalate(jobId, 0, REASON);
        policy.ownerRequestRevision(jobId, 0, "redo");
        assertFalse(policy.escalated(jobId, 0));
        assertEq(sp.getMilestone(jobId, 0).revisions, 1);
    }

    function test_withdrawRejectsZeroTo() public {
        vm.expectRevert(ForemanPolicy.InvalidParams.selector);
        policy.withdraw(address(usdc), address(0), 1);
    }

    // ----------------------------------------------------------------- fuzz

    /// The agent can never release more than dailyCap inside one UTC day, whatever it tries.
    function testFuzz_agentNeverExceedsDailyCap(uint256 seed, uint128 daily, uint128 autoCap) public {
        daily = uint128(bound(daily, 1 * U, 1_000 * U));
        autoCap = uint128(bound(autoCap, 1 * U, 500 * U));
        policy.setLimits(autoCap, daily);

        uint256 n = 12;
        uint128[] memory amts = new uint128[](n);
        uint256 s = seed;
        for (uint256 i; i < n; ++i) {
            s = uint256(keccak256(abi.encode(s, i)));
            amts[i] = uint128(1 * U + (s % (300 * U)));
        }
        uint256 jobId = _fund(amts);
        for (uint256 i; i < n; ++i) {
            _submit(jobId, i);
        }

        // pin to early in a UTC day so the loop cannot straddle a day boundary
        vm.warp((block.timestamp / 1 days) * 1 days + 1 hours);
        uint256 day = block.timestamp / 1 days;
        uint256 released;
        for (uint256 i; i < n; ++i) {
            vm.prank(agent);
            try policy.agentApprove(jobId, i, REASON) {
                released += amts[i];
                assertLe(amts[i], autoCap);
            } catch {}
            assertLe(released, daily);
        }
        assertEq(usdc.balanceOf(freelancer), released);
        assertEq(policy.releasedOnDay(day), released);
        assertLe(policy.releasedOnDay(day), daily);
    }
}
