// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {FlapBoostVaultFactory} from "../../../src/FlapBoostVaultFactory.sol";

/// @notice Deploys the BSC-mainnet Flap Boost factory.
/// @dev Set FLAP_BOOST_DEPLOYER_PRIVATE_KEY only in the local shell that runs this script.
contract DeployFlapBoost is Script {
    function run() external returns (FlapBoostVaultFactory factory) {
        require(block.chainid == 56, "BSC mainnet only");
        uint256 privateKey = vm.envUint("FLAP_BOOST_DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(privateKey);
        factory = new FlapBoostVaultFactory();
        vm.stopBroadcast();
    }
}
