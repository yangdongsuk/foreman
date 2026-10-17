// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ForemanPolicy} from "../src/ForemanPolicy.sol";

/// @notice Deploy ForemanPolicy. The broadcaster becomes the policy owner.
///
///   AGENT_ADDRESS     address the agent signs with (holds only gas)
///   AUTO_APPROVE_CAP  max a single milestone the agent may approve alone, in token units (6 decimals)
///   DAILY_CAP         max the agent may release per UTC day, in token units
///   STAGEPAY          optional, defaults to the Stagepay deployment on Arc mainnet
///
///   forge script contracts/script/Deploy.s.sol --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast
contract Deploy is Script {
    address constant ARC_STAGEPAY = 0x0A87039a127b600cF9B85d4C33d97c08054e15E6;

    function run() external returns (ForemanPolicy policy) {
        address agent = vm.envAddress("AGENT_ADDRESS");
        uint256 autoCap = vm.envUint("AUTO_APPROVE_CAP");
        uint256 dailyCap = vm.envUint("DAILY_CAP");
        address stagepay = vm.envOr("STAGEPAY", ARC_STAGEPAY);
        require(autoCap <= type(uint128).max && dailyCap <= type(uint128).max, "cap too large");

        vm.startBroadcast();
        policy = new ForemanPolicy(stagepay, agent, uint128(autoCap), uint128(dailyCap));
        vm.stopBroadcast();

        console.log("ForemanPolicy deployed at", address(policy));
        console.log("  owner          ", policy.owner());
        console.log("  agent          ", agent);
        console.log("  stagepay       ", stagepay);
        console.log("  autoApproveCap ", autoCap);
        console.log("  dailyCap       ", dailyCap);
        console.log("FOREMAN_POLICY=%s", address(policy));
    }
}
