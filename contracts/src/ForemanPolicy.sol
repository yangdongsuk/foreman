// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev The slice of Stagepay (milestone escrow) that the policy talks to.
interface IStagepay {
    struct Milestone {
        uint128 amount;
        uint64 deadline;
        uint64 submittedAt;
        uint8 status; // 0 None, 1 Funded, 2 Submitted, 3 Released, 4 Refunded, 5 Split
        uint8 revisions;
        address splitProposer;
        uint128 splitToFreelancer;
    }

    function createJob(
        address freelancer,
        IERC20 token,
        uint128[] calldata amounts,
        uint64[] calldata deadlines,
        uint64 reviewPeriod,
        bytes32 termsHash
    ) external returns (uint256 jobId);
    function approve(uint256 jobId, uint256 index) external;
    function requestRevision(uint256 jobId, uint256 index, string calldata note) external;
    function cancelExpired(uint256 jobId, uint256 index) external;
    function proposeSplit(uint256 jobId, uint256 index, uint128 toFreelancer) external;
    function acceptSplit(uint256 jobId, uint256 index, uint128 toFreelancer) external;
    function getMilestone(uint256 jobId, uint256 index) external view returns (Milestone memory);
}

/// @title ForemanPolicy: the on-chain mandate of the Foreman agent
/// @notice The business owner funds freelance jobs through this contract, which becomes the Stagepay
///         *client*. An AI agent may approve, send back, or escalate submitted milestones, but only
///         inside limits that this contract enforces: a per-milestone auto-approve cap, a daily release
///         cap, and an owner kill switch. Anything bigger needs the owner's co-signature. The agent
///         never holds job money (escrow does) and has no function that moves funds to an arbitrary
///         address.
contract ForemanPolicy {
    // Stagepay.Status.Submitted
    uint8 private constant SUBMITTED = 2;

    // AgentDecision.action values
    uint8 private constant ACTION_APPROVE = 0;
    uint8 private constant ACTION_REVISION = 1;
    uint8 private constant ACTION_ESCALATE = 2;

    address public owner;
    address public agent;
    IStagepay public immutable stagepay;
    uint128 public autoApproveCap;
    uint128 public dailyCap;
    bool public paused;

    mapping(uint256 jobId => bool) public managed;
    mapping(uint256 jobId => mapping(uint256 index => bool)) public escalated;
    mapping(uint256 day => uint256) public releasedOnDay;
    uint256[] private _jobs;

    uint256 private _locked = 1;

    event JobFunded(uint256 indexed jobId, address indexed freelancer, address token, uint256 total, bytes32 termsHash);
    event AgentDecision(uint256 indexed jobId, uint256 indexed index, uint8 action, uint256 amount, bytes32 reasonHash);
    event Escalated(uint256 indexed jobId, uint256 indexed index, uint256 amount, bytes32 reasonHash);
    event OwnerCosigned(uint256 indexed jobId, uint256 indexed index, uint256 amount);
    event LimitsSet(uint128 autoApproveCap, uint128 dailyCap);
    event AgentSet(address agent);
    event PausedSet(bool paused);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error NotManaged();
    error NotSubmitted();
    error OverAutoApproveCap();
    error OverDailyCap();
    error NotEscalated();
    error InvalidParams();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        _;
    }

    modifier onlyManaged(uint256 jobId) {
        if (!managed[jobId]) revert NotManaged();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert InvalidParams();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address stagepay_, address agent_, uint128 autoApproveCap_, uint128 dailyCap_) {
        if (stagepay_ == address(0) || agent_ == address(0)) revert InvalidParams();
        owner = msg.sender;
        agent = agent_;
        stagepay = IStagepay(stagepay_);
        autoApproveCap = autoApproveCap_;
        dailyCap = dailyCap_;
        emit AgentSet(agent_);
        emit LimitsSet(autoApproveCap_, dailyCap_);
    }

    // ------------------------------------------------------------------ funding

    /// @notice Fund a new job. The policy pulls the money from the owner and becomes the Stagepay
    ///         client, so only this contract (and therefore only its rules) can release the escrow.
    /// @dev Owner must first approve `sum(amounts)` of `token` to this contract.
    function fundJob(
        address freelancer,
        address token,
        uint128[] calldata amounts,
        uint64[] calldata deadlines,
        uint64 reviewPeriod,
        bytes32 termsHash
    ) external nonReentrant onlyOwner returns (uint256 jobId) {
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }

        // Check what actually arrived so fee-on-transfer tokens can't under-collateralise the job.
        uint256 before = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), total)));
        if (IERC20(token).balanceOf(address(this)) - before != total) revert InvalidParams();

        _call(token, abi.encodeCall(IERC20.approve, (address(stagepay), total)));
        jobId = stagepay.createJob(freelancer, IERC20(token), amounts, deadlines, reviewPeriod, termsHash);

        managed[jobId] = true;
        _jobs.push(jobId);
        emit JobFunded(jobId, freelancer, token, total, termsHash);
    }

    // -------------------------------------------------------------------- agent

    /// @notice Approve a submitted milestone and pay the freelancer, if it fits inside the limits.
    function agentApprove(uint256 jobId, uint256 index, bytes32 reasonHash)
        external
        nonReentrant
        onlyAgent
        onlyManaged(jobId)
    {
        uint256 amount = _submittedAmount(jobId, index);
        if (amount > autoApproveCap) revert OverAutoApproveCap();
        uint256 day = block.timestamp / 1 days;
        uint256 released = releasedOnDay[day] + amount;
        if (released > dailyCap) revert OverDailyCap();

        releasedOnDay[day] = released;
        escalated[jobId][index] = false;
        stagepay.approve(jobId, index);
        emit AgentDecision(jobId, index, ACTION_APPROVE, amount, reasonHash);
    }

    /// @notice Send a submitted milestone back to the freelancer with concrete feedback.
    function agentRequestRevision(uint256 jobId, uint256 index, string calldata note, bytes32 reasonHash)
        external
        nonReentrant
        onlyAgent
        onlyManaged(jobId)
    {
        uint256 amount = _submittedAmount(jobId, index);
        escalated[jobId][index] = false;
        stagepay.requestRevision(jobId, index, note);
        emit AgentDecision(jobId, index, ACTION_REVISION, amount, reasonHash);
    }

    /// @notice Flag a submitted milestone for the owner, who settles it with ownerCosign.
    function agentEscalate(uint256 jobId, uint256 index, bytes32 reasonHash)
        external
        onlyAgent
        onlyManaged(jobId)
    {
        uint256 amount = _submittedAmount(jobId, index);
        escalated[jobId][index] = true;
        emit Escalated(jobId, index, amount, reasonHash);
        emit AgentDecision(jobId, index, ACTION_ESCALATE, amount, reasonHash);
    }

    // -------------------------------------------------------------------- owner
    // Owner functions keep working while paused: the kill switch only stops the agent.

    /// @notice Approve a milestone the agent escalated. Not counted against the agent's daily cap.
    function ownerCosign(uint256 jobId, uint256 index) external nonReentrant onlyOwner onlyManaged(jobId) {
        if (!escalated[jobId][index]) revert NotEscalated();
        escalated[jobId][index] = false;
        uint256 amount = _submittedAmount(jobId, index);
        stagepay.approve(jobId, index);
        emit OwnerCosigned(jobId, index, amount);
    }

    function ownerApprove(uint256 jobId, uint256 index) external nonReentrant onlyOwner onlyManaged(jobId) {
        escalated[jobId][index] = false;
        stagepay.approve(jobId, index);
    }

    function ownerRequestRevision(uint256 jobId, uint256 index, string calldata note)
        external
        nonReentrant
        onlyOwner
        onlyManaged(jobId)
    {
        escalated[jobId][index] = false;
        stagepay.requestRevision(jobId, index, note);
    }

    /// @notice Reclaim a milestone the freelancer never submitted. The refund lands in this contract.
    function ownerCancelExpired(uint256 jobId, uint256 index) external nonReentrant onlyOwner onlyManaged(jobId) {
        stagepay.cancelExpired(jobId, index);
    }

    function ownerProposeSplit(uint256 jobId, uint256 index, uint128 toFreelancer)
        external
        onlyOwner
        onlyManaged(jobId)
    {
        stagepay.proposeSplit(jobId, index, toFreelancer);
    }

    function ownerAcceptSplit(uint256 jobId, uint256 index, uint128 toFreelancer)
        external
        nonReentrant
        onlyOwner
        onlyManaged(jobId)
    {
        escalated[jobId][index] = false;
        stagepay.acceptSplit(jobId, index, toFreelancer);
    }

    /// @notice Move refunded funds out of the policy (it is the Stagepay client, so refunds land here).
    function withdraw(address token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert InvalidParams();
        _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function setLimits(uint128 autoApproveCap_, uint128 dailyCap_) external onlyOwner {
        autoApproveCap = autoApproveCap_;
        dailyCap = dailyCap_;
        emit LimitsSet(autoApproveCap_, dailyCap_);
    }

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert InvalidParams();
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // -------------------------------------------------------------------- views

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function jobAt(uint256 i) external view returns (uint256) {
        return _jobs[i];
    }

    function spentToday() public view returns (uint256) {
        return releasedOnDay[block.timestamp / 1 days];
    }

    function remainingToday() external view returns (uint256) {
        uint256 spent = spentToday();
        return spent >= dailyCap ? 0 : dailyCap - spent;
    }

    // ----------------------------------------------------------------- internal

    function _submittedAmount(uint256 jobId, uint256 index) internal view returns (uint256) {
        IStagepay.Milestone memory m = stagepay.getMilestone(jobId, index);
        if (m.status != SUBMITTED) revert NotSubmitted();
        return m.amount;
    }

    /// @dev Low-level ERC-20 call that accepts tokens returning no data and reverts on `false`.
    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InvalidParams();
    }
}
