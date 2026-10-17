// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReceiver} from "./IReceiver.sol";
import {IERC165} from "./IERC165.sol";

/// @title ForemanReviewReceiver
/// @notice On-chain sink for the Foreman CRE workflow. After the workflow reviews a freelance
///         milestone delivery (LLM or deterministic checks), the DON-signed report is delivered
///         here through the Chainlink KeystoneForwarder, giving every review verdict a
///         cryptographically verified, hash-committed attestation on Arc.
/// @dev Report layout: abi.encode(uint256 jobId, uint256 index, uint8 verdict,
///      bytes32 reasonHash, bytes32 evidenceHash). Verdict: 0 approve, 1 revision, 2 escalate.
///      Only the forwarder may call onReport; the forwarder has already verified the DON
///      signatures. Metadata is accepted but not enforced (add workflow-id/owner checks here
///      when moving to production).
contract ForemanReviewReceiver is IReceiver {
    struct Attestation {
        uint8 verdict;
        bytes32 reasonHash;
        bytes32 evidenceHash;
        uint64 timestamp; // 0 means "never attested"
    }

    uint8 public constant APPROVE = 0;
    uint8 public constant REVISION = 1;
    uint8 public constant ESCALATE = 2;

    address public immutable forwarder;

    /// @dev jobId => milestone index => latest attestation.
    mapping(uint256 => mapping(uint256 => Attestation)) private _attestations;
    uint256 public attestationCount;

    event ReviewAttested(
        uint256 indexed jobId,
        uint256 indexed index,
        uint8 verdict,
        bytes32 reasonHash,
        bytes32 evidenceHash,
        uint256 timestamp
    );

    error NotForwarder(address sender, address expected);
    error InvalidVerdict(uint8 verdict);

    constructor(address forwarder_) {
        require(forwarder_ != address(0), "forwarder=0");
        forwarder = forwarder_;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender, forwarder);

        (uint256 jobId, uint256 index, uint8 verdict, bytes32 reasonHash, bytes32 evidenceHash) =
            abi.decode(report, (uint256, uint256, uint8, bytes32, bytes32));
        if (verdict > ESCALATE) revert InvalidVerdict(verdict);

        _attestations[jobId][index] = Attestation({
            verdict: verdict,
            reasonHash: reasonHash,
            evidenceHash: evidenceHash,
            timestamp: uint64(block.timestamp)
        });
        unchecked {
            attestationCount++;
        }

        emit ReviewAttested(jobId, index, verdict, reasonHash, evidenceHash, block.timestamp);
    }

    /// @notice Latest attestation for a milestone; timestamp == 0 if none was recorded.
    function attestation(uint256 jobId, uint256 index)
        external
        view
        returns (uint8 verdict, bytes32 reasonHash, bytes32 evidenceHash, uint64 timestamp)
    {
        Attestation storage a = _attestations[jobId][index];
        return (a.verdict, a.reasonHash, a.evidenceHash, a.timestamp);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
