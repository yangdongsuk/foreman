// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "./IERC165.sol";

/// @title IReceiver - receives Chainlink CRE (Keystone) reports
/// @notice Hand-written minimal copy of the interface from the CRE consumer-contract guide.
///         Implementations must advertise it through ERC-165.
interface IReceiver is IERC165 {
    /// @param metadata Report metadata (workflow id, name, owner) as packed by the forwarder.
    /// @param report   ABI-encoded workflow report payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
