// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Stagepay: milestone escrow for freelance work, settled in stablecoins on Arc
/// @notice A client funds every milestone of a job up front. The freelancer submits each
///         milestone; the client approves it, asks for a revision, or stays silent. Silence
///         past the review window lets the freelancer claim the payment, so a client cannot
///         hold finished work hostage. A client can reclaim a milestone that was never
///         submitted once its deadline passes, and either side can settle a milestone early
///         with a split the other side accepts. No owner, no fees, no upgradeability.
contract Stagepay {
    enum Status {
        None,
        Funded,
        Submitted,
        Released,
        Refunded,
        Split
    }

    struct Milestone {
        uint128 amount;
        uint64 deadline; // freelancer must submit by this time or the client may cancel
        uint64 submittedAt; // start of the current review window
        Status status;
        uint8 revisions; // revision requests used so far
        address splitProposer; // party that proposed the pending split, if any
        uint128 splitToFreelancer; // freelancer's share under the pending split
    }

    struct Job {
        address client;
        address freelancer;
        IERC20 token;
        uint64 reviewPeriod; // seconds the client has to respond to a submission
        bytes32 termsHash; // hash of the off-chain agreement (scope, deliverables)
        uint256 total;
        uint256 settled; // amount already paid out or refunded
    }

    uint64 public constant MIN_REVIEW_PERIOD = 1 hours;
    uint64 public constant MAX_REVIEW_PERIOD = 30 days;
    uint256 public constant MAX_MILESTONES = 20;
    /// @notice After this many revision requests the client can only approve, split, or let the
    ///         review window lapse, so revisions cannot be used to stall payment forever.
    uint8 public constant MAX_REVISIONS = 3;

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Milestone[]) internal _milestones;

    uint256 private _locked = 1;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed freelancer,
        address token,
        uint256 total,
        uint256 milestoneCount,
        uint64 reviewPeriod,
        bytes32 termsHash
    );
    event MilestoneSubmitted(uint256 indexed jobId, uint256 indexed index, string note);
    event RevisionRequested(uint256 indexed jobId, uint256 indexed index, string note);
    event MilestoneReleased(uint256 indexed jobId, uint256 indexed index, uint256 amount, bool autoClaimed);
    event MilestoneRefunded(uint256 indexed jobId, uint256 indexed index, uint256 amount, address indexed by);
    event SplitProposed(uint256 indexed jobId, uint256 indexed index, address indexed by, uint256 toFreelancer);
    event SplitSettled(uint256 indexed jobId, uint256 indexed index, uint256 toFreelancer, uint256 toClient);

    error InvalidParams();
    error NotClient();
    error NotFreelancer();
    error NotParty();
    error BadStatus();
    error TooEarly();
    error NoSplitProposed();
    error RevisionLimit();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ---------------------------------------------------------------- create

    /// @notice Create a job and fund all milestones in one transaction.
    /// @dev The caller must first approve `sum(amounts)` of `token` to this contract.
    function createJob(
        address freelancer,
        IERC20 token,
        uint128[] calldata amounts,
        uint64[] calldata deadlines,
        uint64 reviewPeriod,
        bytes32 termsHash
    ) external nonReentrant returns (uint256 jobId) {
        uint256 n = amounts.length;
        if (
            freelancer == address(0) || freelancer == msg.sender || address(token) == address(0) || n == 0
                || n > MAX_MILESTONES || deadlines.length != n || reviewPeriod < MIN_REVIEW_PERIOD
                || reviewPeriod > MAX_REVIEW_PERIOD
        ) revert InvalidParams();

        jobId = ++jobCount;
        Milestone[] storage ms = _milestones[jobId];
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0 || deadlines[i] <= block.timestamp) revert InvalidParams();
            total += amounts[i];
            ms.push(
                Milestone({
                    amount: amounts[i],
                    deadline: deadlines[i],
                    submittedAt: 0,
                    status: Status.Funded,
                    revisions: 0,
                    splitProposer: address(0),
                    splitToFreelancer: 0
                })
            );
        }

        jobs[jobId] = Job({
            client: msg.sender,
            freelancer: freelancer,
            token: token,
            reviewPeriod: reviewPeriod,
            termsHash: termsHash,
            total: total,
            settled: 0
        });

        emit JobCreated(jobId, msg.sender, freelancer, address(token), total, n, reviewPeriod, termsHash);

        // Pull funds and check what actually arrived, so fee-on-transfer tokens can't
        // leave the escrow under-collateralised.
        uint256 before = token.balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), total);
        if (token.balanceOf(address(this)) - before != total) revert TransferFailed();
    }

    // ------------------------------------------------------------ freelancer

    /// @notice Mark a milestone as delivered and start the client's review window.
    function submit(uint256 jobId, uint256 index, string calldata note) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.freelancer) revert NotFreelancer();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Funded) revert BadStatus();
        m.status = Status.Submitted;
        m.submittedAt = uint64(block.timestamp);
        _clearSplit(m);
        emit MilestoneSubmitted(jobId, index, note);
    }

    /// @notice Collect a submitted milestone the client did not respond to within the review window.
    function claim(uint256 jobId, uint256 index) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.freelancer) revert NotFreelancer();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Submitted) revert BadStatus();
        if (block.timestamp < uint256(m.submittedAt) + job.reviewPeriod) revert TooEarly();
        _release(jobId, index, job, m, true);
    }

    /// @notice Voluntarily return a milestone's funds to the client (e.g. the job fell through).
    function refundByFreelancer(uint256 jobId, uint256 index) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.freelancer) revert NotFreelancer();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Funded && m.status != Status.Submitted) revert BadStatus();
        _refund(jobId, index, job, m);
    }

    // ---------------------------------------------------------------- client

    /// @notice Accept a submitted milestone and pay the freelancer.
    function approve(uint256 jobId, uint256 index) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Submitted) revert BadStatus();
        _release(jobId, index, job, m, false);
    }

    /// @notice Send a submitted milestone back for changes. Only possible inside the review window,
    ///         at most MAX_REVISIONS times per milestone, and it gives the freelancer at least one
    ///         more review period to resubmit.
    function requestRevision(uint256 jobId, uint256 index, string calldata note) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Submitted) revert BadStatus();
        if (block.timestamp >= uint256(m.submittedAt) + job.reviewPeriod) revert TooEarly();
        if (m.revisions >= MAX_REVISIONS) revert RevisionLimit();
        m.revisions += 1;
        m.status = Status.Funded;
        m.submittedAt = 0;
        uint64 minDeadline = uint64(block.timestamp) + job.reviewPeriod;
        if (m.deadline < minDeadline) m.deadline = minDeadline;
        _clearSplit(m);
        emit RevisionRequested(jobId, index, note);
    }

    /// @notice Take back a milestone the freelancer never submitted before its deadline.
    function cancelExpired(uint256 jobId, uint256 index) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Funded) revert BadStatus();
        if (block.timestamp <= m.deadline) revert TooEarly();
        _refund(jobId, index, job, m);
    }

    // ------------------------------------------------------- mutual settlement

    /// @notice Propose settling an open milestone by splitting its amount.
    function proposeSplit(uint256 jobId, uint256 index, uint128 toFreelancer) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client && msg.sender != job.freelancer) revert NotParty();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Funded && m.status != Status.Submitted) revert BadStatus();
        if (toFreelancer > m.amount) revert InvalidParams();
        m.splitProposer = msg.sender;
        m.splitToFreelancer = toFreelancer;
        emit SplitProposed(jobId, index, msg.sender, toFreelancer);
    }

    /// @notice Accept the other party's split proposal. `toFreelancer` must match the proposal,
    ///         so a proposal cannot be swapped out from under the accepting party.
    function acceptSplit(uint256 jobId, uint256 index, uint128 toFreelancer) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client && msg.sender != job.freelancer) revert NotParty();
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Funded && m.status != Status.Submitted) revert BadStatus();
        if (m.splitProposer == address(0) || m.splitProposer == msg.sender) revert NoSplitProposed();
        if (m.splitToFreelancer != toFreelancer) revert InvalidParams();

        uint256 toClient = uint256(m.amount) - toFreelancer;
        m.status = Status.Split;
        job.settled += m.amount;
        _clearSplit(m);
        emit SplitSettled(jobId, index, toFreelancer, toClient);
        if (toFreelancer > 0) _safeTransfer(job.token, job.freelancer, toFreelancer);
        if (toClient > 0) _safeTransfer(job.token, job.client, toClient);
    }

    // ------------------------------------------------------------------ views

    function milestoneCount(uint256 jobId) external view returns (uint256) {
        return _milestones[jobId].length;
    }

    function getMilestone(uint256 jobId, uint256 index) external view returns (Milestone memory) {
        return _milestone(jobId, index);
    }

    function getMilestones(uint256 jobId) external view returns (Milestone[] memory) {
        return _milestones[jobId];
    }

    /// @notice Time after which the freelancer may claim a submitted milestone (0 if not submitted).
    function claimableAt(uint256 jobId, uint256 index) external view returns (uint256) {
        Milestone storage m = _milestone(jobId, index);
        if (m.status != Status.Submitted) return 0;
        return uint256(m.submittedAt) + jobs[jobId].reviewPeriod;
    }

    // --------------------------------------------------------------- internal

    function _milestone(uint256 jobId, uint256 index) internal view returns (Milestone storage) {
        Milestone[] storage ms = _milestones[jobId];
        if (index >= ms.length) revert InvalidParams();
        return ms[index];
    }

    function _release(uint256 jobId, uint256 index, Job storage job, Milestone storage m, bool auto_) internal {
        m.status = Status.Released;
        job.settled += m.amount;
        _clearSplit(m);
        emit MilestoneReleased(jobId, index, m.amount, auto_);
        _safeTransfer(job.token, job.freelancer, m.amount);
    }

    function _refund(uint256 jobId, uint256 index, Job storage job, Milestone storage m) internal {
        m.status = Status.Refunded;
        job.settled += m.amount;
        _clearSplit(m);
        emit MilestoneRefunded(jobId, index, m.amount, msg.sender);
        _safeTransfer(job.token, job.client, m.amount);
    }

    function _clearSplit(Milestone storage m) internal {
        m.splitProposer = address(0);
        m.splitToFreelancer = 0;
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
