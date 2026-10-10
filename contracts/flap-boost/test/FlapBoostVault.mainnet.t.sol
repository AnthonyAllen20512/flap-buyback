// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {FlapBoostVault} from "../src/FlapBoostVault.sol";
import {FlapBoostVaultFactory} from "../src/FlapBoostVaultFactory.sol";
import {IFlapBoostPortal} from "../src/FlapBoostTypes.sol";

/// @dev Test-only subset of the official Flap Portal ABI. enum fields are uint8.
/// Source: flap-sh/FlapVaultExample/src/flap/IPortal.sol, NewTokenV4Params.
interface IMainnetLaunchPortal is IFlapBoostPortal {
    struct TokenStateV2 {
        uint8 status; uint256 reserve; uint256 circulatingSupply; uint256 price;
        uint8 tokenVersion; uint256 r; uint256 dexSupplyThresh;
    }
    struct NewTokenV4Params {
        string name; string symbol; string meta; uint8 dexThresh; bytes32 salt;
        uint16 taxRate; uint8 migratorType; address quoteToken; uint256 quoteAmt;
        address beneficiary; bytes permitData; bytes32 extensionID; bytes extensionData;
        uint8 dexId; uint8 lpFeeProfile;
    }
    function newTokenV4(NewTokenV4Params calldata params) external payable returns (address token);
    function getTokenV2(address token) external view returns (TokenStateV2 memory);
}

interface IMainnetTrigger {
    struct TriggerRequest { address requester; uint64 executeAfter; uint8 status; uint128 feePaid; }
    function getFee() external view returns (uint256);
    function getMaxCallbackGas() external view returns (uint256);
    function getRequest(uint256 id) external view returns (TriggerRequest memory);
    function trigger(uint256 id) external;
}

/// @notice Opt-in integration tests. All transactions execute inside a local
/// Foundry fork; no private key, broadcast, or real BNB is required.
contract FlapBoostMainnetForkTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address private constant TRIGGER = 0xcf4EE25035CF883895110f367F5BA8172416a7F9;
    address private constant TRIGGER_OPERATOR = 0x80c83995FA87B20671B436aaA3a5211C02c1152e;
    address private constant TOKEN_IMPLEMENTATION_V2 = 0x8B4329947e34B6d56D71A3385caC122BaDe7d78D;
    IMainnetLaunchPortal private portal = IMainnetLaunchPortal(PORTAL);
    IMainnetTrigger private triggerService = IMainnetTrigger(TRIGGER);
    FlapBoostVaultFactory private factory;

    function setUp() public {
        if (!vm.envOr("RUN_BSC_FORK", false)) { vm.skip(true); return; }
        string memory rpc = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org"));
        uint256 height = vm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (height == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, height);
        assertEq(block.chainid, 56);
        factory = new FlapBoostVaultFactory();
        vm.deal(OWNER, 1_000 ether);
    }

    function _launch() private returns (address token) {
        bytes32 salt;
        // Bounded search for a non-tax token ending in 8888. No external calls
        // are made in the loop except a code-presence check after a suffix hit.
        for (uint256 i = 1; i <= 1_000_000; ++i) {
            salt = keccak256(abi.encode(block.number, "FlapBoostAudit", i));
            address predicted = Clones.predictDeterministicAddress(TOKEN_IMPLEMENTATION_V2, salt, PORTAL);
            if (uint16(uint160(predicted)) == 0x8888 && predicted.code.length == 0) break;
            if (i == 1_000_000) revert("Vanity salt not found");
        }
        IMainnetLaunchPortal.NewTokenV4Params memory params = IMainnetLaunchPortal.NewTokenV4Params({
            name: "Local Flap Boost Fork", symbol: "FBF", meta: "", dexThresh: 1, salt: salt,
            taxRate: 0, migratorType: 1, quoteToken: address(0), quoteAmt: 0.01 ether,
            beneficiary: OWNER, permitData: "", extensionID: bytes32(0), extensionData: "",
            dexId: 0, lpFeeProfile: 0
        });
        vm.startPrank(OWNER);
        token = portal.newTokenV4{value: params.quoteAmt}(params);
        vm.stopPrank();
        assertGt(token.code.length, 0);
        assertEq(uint16(uint160(token)), 0x8888);
    }

    function _create(address token) private returns (FlapBoostVault vault) {
        uint256 input = 0.01 ether;
        uint256 quoted = portal.quoteExactInput(IFlapBoostPortal.QuoteExactInputParams(address(0), token, input));
        assertGt(quoted, 0);
        FlapBoostVaultFactory.OperationOptions memory options = FlapBoostVaultFactory.OperationOptions({
            targetToken: token, minTokensPerBNB: quoted * 1 ether / input / 2, interval: 60,
            outputMode: 0, randomRecipientCount: 0, retainRecipient: address(0), recipients: new address[](0)
        });
        vm.prank(OWNER);
        (address deployed,) = factory.createFixedBNBOperation(options, input);
        vault = FlapBoostVault(payable(deployed));
    }

    function _execute(FlapBoostVault vault) private {
        uint256 id = vault.triggerId();
        assertGt(id, 0, "real Trigger was not booked");
        IMainnetTrigger.TriggerRequest memory request = triggerService.getRequest(id);
        assertEq(request.requester, address(vault));
        assertEq(uint256(request.status), 0);
        assertEq(uint256(request.feePaid), triggerService.getFee());
        if (block.timestamp < request.executeAfter) vm.warp(request.executeAfter);
        vm.prank(TRIGGER_OPERATOR);
        triggerService.trigger(id);
        assertEq(uint256(triggerService.getRequest(id).status), 1, "real callback failed");
    }

    function testFork_OfficialDependenciesAndDynamicFee() public view {
        assertGt(PORTAL.code.length, 0);
        assertGt(TRIGGER.code.length, 0);
        assertGt(triggerService.getFee(), 0);
        assertGt(triggerService.getMaxCallbackGas(), 0);
    }

    function testFork_BondingCurveFirstRoundAndTriggerCallback() public {
        address token = _launch();
        assertEq(uint256(portal.getTokenV2(token).status), 1, "token must be on the bonding curve");
        FlapBoostVault vault = _create(token);
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.1 ether}(0);
        assertGt(vault.getOperation(0).totalTokensOutput, 0, "first buyback failed");
        uint256 beforeOutput = vault.getOperation(0).totalTokensOutput;
        _execute(vault);
        assertGt(vault.getOperation(0).totalTokensOutput, beforeOutput, "callback did not buy on BC");
        assertEq(vault.pendingTokens(), 0);
        assertEq(IERC20(token).balanceOf(vault.BURN_ADDRESS()), vault.getOperation(0).totalTokensOutput);
        assertGt(vault.triggerId(), 0, "next round was not booked");
    }

    function testFork_GraduatedDexFirstRoundAndTriggerCallback() public {
        address token = _launch();
        vm.startPrank(OWNER);
        portal.swapExactInput{value: 500 ether}(
            IFlapBoostPortal.ExactInputParams(address(0), token, 500 ether, 0, "")
        );
        vm.stopPrank();
        assertEq(uint256(portal.getTokenV2(token).status), 4, "token must graduate to DEX");
        FlapBoostVault vault = _create(token);
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.1 ether}(0);
        assertGt(vault.getOperation(0).totalTokensOutput, 0, "first DEX buyback failed");
        uint256 beforeOutput = vault.getOperation(0).totalTokensOutput;
        _execute(vault);
        assertGt(vault.getOperation(0).totalTokensOutput, beforeOutput, "DEX callback failed");
        assertGt(vault.triggerId(), 0);
    }
}
