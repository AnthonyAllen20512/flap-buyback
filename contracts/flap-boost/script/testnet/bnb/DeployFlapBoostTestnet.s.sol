// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {FlapBoostVaultFactory} from "../../../src/FlapBoostVaultFactory.sol";

/// @notice Deploys the shared Flap Boost factory on BSC Testnet.
/// @dev The private key is read only from the local process environment and is never stored in this repository.
contract DeployFlapBoostTestnet is Script {
    function run() external returns (FlapBoostVaultFactory factory) {
        require(block.chainid == 97, "BSC testnet only");
        uint256 privateKey = vm.envUint("FLAP_BOOST_DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(privateKey);
        factory = new FlapBoostVaultFactory();
        vm.stopBroadcast();
    }
}
