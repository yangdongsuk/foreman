// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Stagepay} from "../src/vendor/Stagepay.sol";
import {Tollgate} from "../src/vendor/Tollgate.sol";
import {ForemanPolicy} from "../src/ForemanPolicy.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Stand up the whole stack on a local anvil node (scripts/local-e2e.sh). Never use on mainnet.
///
///   OWNER_KEY           deployer and policy owner (hex, with or without 0x)
///   AGENT_ADDRESS       the agent's address
///   FREELANCER_ADDRESS  the demo freelancer
///   AUTO_APPROVE_CAP    optional, default 100 USDC (units)
///   DAILY_CAP           optional, default 250 USDC (units)
///   MINT_USDC           optional, whole USDC minted to the owner and the freelancer, default 100000
///
/// Prints KEY=0x... lines (STAGEPAY, TOLLGATE, USDC, FOREMAN_POLICY) that a shell can eval.
contract LocalSetup is Script {
    function run() external {
        uint256 ownerKey = _key(vm.envString("OWNER_KEY"));
        address owner = vm.addr(ownerKey);
        address agent = vm.envAddress("AGENT_ADDRESS");
        address freelancer = vm.envAddress("FREELANCER_ADDRESS");
        uint128 autoCap = uint128(vm.envOr("AUTO_APPROVE_CAP", uint256(100e6)));
        uint128 dailyCap = uint128(vm.envOr("DAILY_CAP", uint256(250e6)));
        uint256 mint = vm.envOr("MINT_USDC", uint256(100_000)) * 1e6;

        vm.startBroadcast(ownerKey);
        MockUSDC usdc = new MockUSDC();
        Stagepay stagepay = new Stagepay();
        Tollgate tollgate = new Tollgate();
        ForemanPolicy policy = new ForemanPolicy(address(stagepay), agent, autoCap, dailyCap);
        usdc.mint(owner, mint);
        usdc.mint(freelancer, mint);
        vm.stopBroadcast();

        console.log("STAGEPAY=%s", address(stagepay));
        console.log("TOLLGATE=%s", address(tollgate));
        console.log("USDC=%s", address(usdc));
        console.log("FOREMAN_POLICY=%s", address(policy));
    }

    /// vm.envUint only parses hex that starts with 0x, but key files often omit it.
    function _key(string memory raw) internal pure returns (uint256) {
        bytes memory b = bytes(raw);
        bool prefixed = b.length > 2 && b[0] == "0" && (b[1] == "x" || b[1] == "X");
        return vm.parseUint(prefixed ? raw : string.concat("0x", raw));
    }
}
