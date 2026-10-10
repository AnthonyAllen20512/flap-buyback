// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";
import {FlapBoostVault} from "../src/FlapBoostVault.sol";
import {FlapBoostVaultFactory} from "../src/FlapBoostVaultFactory.sol";
import {IFlapBoostPortal, IFlapBoostTriggerReceiver, IFlapBoostTriggerService} from "../src/FlapBoostTypes.sol";

contract VaultTestToken is ERC20 {
    constructor() ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract VaultTestPortal {
    uint256 public refundBps;
    uint256 public deliveryBps = 10_000;
    bool public failSwap;

    function setDeliveryBps(uint256 value) external {
        deliveryBps = value;
    }

    function setRefundBps(uint256 value) external {
        refundBps = value;
    }

    function setFailSwap(bool value) external {
        failSwap = value;
    }

    function quoteExactInput(IFlapBoostPortal.QuoteExactInputParams calldata params) external pure returns (uint256) {
        return params.inputAmount * 1000;
    }

    function swapExactInput(IFlapBoostPortal.ExactInputParams calldata params)
        external
        payable
        returns (uint256 bought)
    {
        require(!failSwap, "Portal unavailable");
        require(msg.value == params.inputAmount, "Wrong value");
        bought = params.inputAmount * 1000;
        require(bought >= params.minOutputAmount, "Price floor");
        // Model a token whose net balance increase is below the Portal output.
        uint256 delivered = deliveryBps == 0 ? bought : (bought * deliveryBps) / 10_000;
        VaultTestToken(params.outputToken).mint(msg.sender, delivered);
        uint256 refund = (msg.value * refundBps) / 10_000;
        if (refund != 0) {
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            require(ok, "Refund failed");
        }
    }
}

contract VaultTestTrigger {
    uint256 public lastId;
    mapping(uint256 => uint64) public afterTime;
    mapping(uint256 => address) public requester;
    mapping(uint256 => uint8) public status;

    function getFee() external pure returns (uint256) {
        return 0.0002 ether;
    }

    function requestTrigger(uint64 executeAfter) external payable returns (uint256 id) {
        require(msg.value == 0.0002 ether, "Wrong fee");
        id = ++lastId;
        afterTime[id] = executeAfter;
        requester[id] = msg.sender;
    }

    function fire(address vault, uint256 id) external {
        require(block.timestamp >= afterTime[id], "Too early");
        IFlapBoostTriggerReceiver(vault).trigger(id);
        status[id] = 1;
    }

    function markFailed(uint256 id) external {
        require(id != 0 && requester[id] != address(0), "No request");
        status[id] = 2;
    }

    function getRequest(uint256 id) external view returns (IFlapBoostTriggerService.TriggerRequest memory) {
        return IFlapBoostTriggerService.TriggerRequest(requester[id], afterTime[id], status[id], 0.0002 ether);
    }
}

contract FlapBoostVaultTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant BURN = 0x000000000000000000000000000000000000dEaD;
    VaultTestToken private token;
    FlapBoostVaultFactory private factory;
    VaultTestTrigger private triggerService;

    function setUp() public {
        vm.chainId(97);
        token = new VaultTestToken();
        factory = new FlapBoostVaultFactory();
        VaultTestPortal portalImplementation = new VaultTestPortal();
        FlapBoostVault addressBook = new FlapBoostVault(OWNER, address(token));
        triggerService = VaultTestTrigger(addressBook.TRIGGER_TESTNET());
        vm.etch(addressBook.PORTAL_TESTNET(), address(portalImplementation).code);
        vm.etch(address(triggerService), address(new VaultTestTrigger()).code);
        vm.deal(OWNER, 10 ether);
    }

    function _options(uint64 interval, uint8 outputMode, address retain)
        private
        view
        returns (FlapBoostVaultFactory.OperationOptions memory)
    {
        return FlapBoostVaultFactory.OperationOptions({
            targetToken: address(token),
            minTokensPerBNB: 100 ether,
            interval: interval,
            outputMode: outputMode,
            randomRecipientCount: 0,
            retainRecipient: retain,
            recipients: new address[](0)
        });
    }

    function _create(uint256 amount, uint64 interval) private returns (FlapBoostVault vault, uint256 id) {
        vm.prank(OWNER);
        (address address_, uint256 operationId) =
            factory.createFixedBNBOperation(_options(interval, 0, address(0)), amount);
        return (FlapBoostVault(payable(address_)), operationId);
    }

    function testOneTokenOneVaultAndOneStartFee() public {
        (FlapBoostVault vault, uint256 firstId) = _create(0.01 ether, 60);
        (FlapBoostVault sameVault, uint256 secondId) = _create(0.02 ether, 120);
        assertEq(address(vault), address(sameVault));
        assertEq(factory.vaultsOf(OWNER).length, 1);
        assertEq(vault.operationCount(), 2);
        assertEq(firstId, 0);
        assertEq(secondId, 1);

        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        assertEq(triggerService.lastId(), 0);
        uint256 receiverBefore = vault.START_FEE_RECEIVER().balance;
        vm.prank(OWNER);
        vault.startOperation(firstId);
        assertEq(vault.START_FEE_RECEIVER().balance - receiverBefore, 0.0001 ether);
        assertEq(triggerService.lastId(), 1);
        assertEq(token.balanceOf(BURN), 10 ether);

        vm.prank(OWNER);
        vault.startOperation(secondId);
        assertEq(vault.START_FEE_RECEIVER().balance - receiverBefore, 0.0001 ether);
        assertEq(triggerService.lastId(), 1);
        assertEq(token.balanceOf(BURN), 30 ether);
    }

    function testPublicVaultPagesContainEachCreatedVaultOnce() public {
        (FlapBoostVault first,) = _create(0.01 ether, 60);
        _create(0.02 ether, 120);
        assertEq(factory.vaultCount(), 1);

        VaultTestToken secondToken = new VaultTestToken();
        FlapBoostVaultFactory.OperationOptions memory secondOptions = _options(60, 0, address(0));
        secondOptions.targetToken = address(secondToken);
        vm.prank(OWNER);
        (address second,) = factory.createFixedBNBOperation(secondOptions, 0.01 ether);
        vm.prank(address(0xB0B));
        (address third,) = factory.createFixedBNBOperation(_options(60, 0, address(0)), 0.01 ether);

        assertEq(factory.vaultCount(), 3);
        address[] memory firstPage = factory.vaultsRange(0, 2);
        assertEq(firstPage.length, 2);
        assertEq(firstPage[0], address(first));
        assertEq(firstPage[1], second);
        address[] memory lastPage = factory.vaultsRange(2, 2);
        assertEq(lastPage.length, 1);
        assertEq(lastPage[0], third);
        assertEq(factory.vaultsRange(3, 2).length, 0);
        assertEq(factory.vaultsRange(0, 0).length, 0);
    }

    function testFundingStartsFirstRoundWithoutSecondWalletAction() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        uint256 receiverBefore = vault.START_FEE_RECEIVER().balance;
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.1 ether}(0);
        assertTrue(vault.getOperation(0).started);
        assertEq(vault.getOperation(0).totalBNBSpent, 0.01 ether);
        assertEq(vault.START_FEE_RECEIVER().balance - receiverBefore, vault.START_FEE());
        assertGt(vault.triggerId(), 0);
        assertEq(vault.reservedBNB(), 0.01 ether);
    }

    function testSmallTopUpStaysDepositedUntilFirstRoundIsAffordable() public {
        (FlapBoostVault vault,) = _create(0.02 ether, 60);
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.005 ether}(0);
        assertFalse(vault.getOperation(0).started);
        assertEq(vault.availableBNB(), 0.005 ether);
        assertFalse(vault.startFeeCharged());
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.03 ether}(0);
        assertTrue(vault.getOperation(0).started);
        assertEq(vault.getOperation(0).totalBNBSpent, 0.02 ether);
    }

    function testTinyRoundCannotConsumeDisproportionateTriggerFees() public {
        (FlapBoostVault vault,) = _create(0.001 ether, 60);
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.1 ether}(0);
        assertEq(vault.getOperation(0).totalBNBSpent, 0.001 ether);
        assertEq(vault.triggerId(), 0);
        assertEq(triggerService.lastId(), 0);
    }

    function testOnlyOwnerCanRecoverProvablyFailedTrigger() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        vm.prank(OWNER);
        vault.fundAndTryStart{value: 0.1 ether}(0);
        uint256 firstRequest = vault.triggerId();
        vm.prank(address(0xB0B));
        vm.expectRevert("Only owner");
        vault.recoverFailedTrigger();
        vm.prank(OWNER);
        vm.expectRevert("Trigger not failed");
        vault.recoverFailedTrigger();
        triggerService.markFailed(firstRequest);
        vm.prank(OWNER);
        vault.recoverFailedTrigger();
        assertEq(vault.triggerId(), firstRequest + 1);
        assertEq(vault.reservedBNB(), 0.01 ether);
        vm.warp(triggerService.afterTime(firstRequest));
        vm.expectRevert("Invalid trigger");
        triggerService.fire(address(vault), firstRequest);
    }

    function testDueOrderAndInsufficientPoolWaitsForFunding() public {
        (FlapBoostVault vault,) = _create(0.05 ether, 60);
        (, uint256 secondId) = _create(0.01 ether, 60);
        vm.prank(OWNER);
        vault.fund{value: 0.0611 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        vm.prank(OWNER);
        vault.startOperation(secondId);
        vm.prank(OWNER);
        vault.fund{value: 0.059 ether}();
        assertEq(triggerService.lastId(), 1);
        uint256 firstRequest = vault.triggerId();
        assertEq(vault.scheduledOperationId(), 0);
        vm.warp(triggerService.afterTime(firstRequest));
        triggerService.fire(address(vault), firstRequest);
        assertEq(vault.getOperation(0).totalBNBSpent, 0.1 ether);
        assertEq(vault.triggerId(), 0);
        vm.prank(OWNER);
        vault.fund{value: 0.02 ether}();
        assertEq(vault.scheduledOperationId(), secondId);
        assertEq(triggerService.lastId(), 2);
    }

    function testRefundDoesNotBookEarlyTrigger() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 3600);
        VaultTestPortal(vault.PORTAL_TESTNET()).setRefundBps(5000);
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        assertEq(triggerService.lastId(), 1);
        assertEq(triggerService.afterTime(1), block.timestamp + 3600);
        assertEq(vault.getOperation(0).totalBNBSpent, 0.005 ether);
    }

    function _blockedQueue() private returns (FlapBoostVault vault, uint256 secondId) {
        (vault,) = _create(0.05 ether, 60);
        (, secondId) = _create(0.01 ether, 60);
        vm.startPrank(OWNER);
        vault.fund{value: 0.0611 ether}();
        vault.startOperation(0);
        vault.startOperation(secondId);
        vault.fund{value: 0.012 ether}();
        vm.stopPrank();
        assertEq(vault.triggerId(), 0);
    }

    function testPausingUnfundedHeadSchedulesNextOperation() public {
        (FlapBoostVault vault, uint256 secondId) = _blockedQueue();
        vm.prank(OWNER);
        vault.pauseOperation(0);
        assertGt(vault.triggerId(), 0);
        assertEq(vault.scheduledOperationId(), secondId);
    }

    function testClosingUnfundedHeadSchedulesNextOperation() public {
        (FlapBoostVault vault, uint256 secondId) = _blockedQueue();
        vm.prank(OWNER);
        vault.closeOperation(0);
        assertGt(vault.triggerId(), 0);
        assertEq(vault.scheduledOperationId(), secondId);
    }

    function testInsufficientNetTokensRollsBackSwapBeforeRetry() public {
        vm.prank(OWNER);
        (address vaultAddress, uint256 id) = factory.createFixedTokenAmountOperation(_options(60, 0, address(0)), 5 ether);
        FlapBoostVault vault = FlapBoostVault(payable(vaultAddress));
        VaultTestPortal portal = VaultTestPortal(vault.PORTAL_TESTNET());
        portal.setDeliveryBps(5000);
        vm.startPrank(OWNER);
        vault.fund{value: 0.1 ether}();
        vault.startOperation(id);
        vm.stopPrank();

        assertEq(vault.getOperation(id).totalBNBSpent, 0);
        assertEq(vault.pendingTokens(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(BURN), 0);
        assertEq(vault.getOperation(id).consecutiveFailures, 1);

        portal.setDeliveryBps(10_000);
        uint256 booked = vault.triggerId();
        vm.warp(triggerService.afterTime(booked));
        triggerService.fire(address(vault), booked);
        assertEq(vault.getOperation(id).totalBNBSpent, 0.005 ether);
        assertEq(token.balanceOf(BURN), 5 ether);
    }

    function testNewOperationWithEarlierDueTimeRunsFirst() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 3600);
        vm.prank(OWNER);
        vault.fund{value: 0.2 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        uint256 booked = vault.triggerId();
        uint64 bookedTime = triggerService.afterTime(booked);
        vm.warp(bookedTime - 100);
        (, uint256 newerId) = _create(0.01 ether, 60);
        vm.prank(OWNER);
        vault.startOperation(newerId);
        vm.warp(bookedTime);
        triggerService.fire(address(vault), booked);
        assertEq(vault.getOperation(0).totalBNBSpent, 0.01 ether);
        assertEq(vault.getOperation(newerId).totalBNBSpent, 0.02 ether);
    }

    function testFixedTokenAndBalancePercentageAreRealModes() public {
        FlapBoostVaultFactory.OperationOptions memory options = _options(60, 0, address(0));
        vm.prank(OWNER);
        (address address_, uint256 id) = factory.createFixedTokenAmountOperation(options, 5 ether);
        FlapBoostVault vault = FlapBoostVault(payable(address_));
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.startOperation(id);
        assertEq(vault.getOperation(id).totalBNBSpent, 0.005 ether);
        assertEq(token.balanceOf(BURN), 5 ether);
        assertEq(vault.reservedBNB(), 0.005 ether);

        vm.prank(OWNER);
        (, uint256 percentageId) = factory.createBalancePercentageOperation(options, 5000, 0);
        uint256 balanceBefore = vault.availableBNB();
        vm.prank(OWNER);
        vault.startOperation(percentageId);
        assertEq(vault.getOperation(percentageId).totalBNBSpent, balanceBefore / 2);
    }

    function testFixedTokenWaitsForEnoughBnb() public {
        vm.prank(OWNER);
        (address vaultAddress, uint256 id) = factory.createFixedTokenAmountOperation(_options(60, 0, address(0)), 5 ether);
        FlapBoostVault vault = FlapBoostVault(payable(vaultAddress));

        vm.prank(OWNER);
        vault.fund{value: 0.004 ether}();
        vm.prank(OWNER);
        vm.expectRevert("No budget");
        vault.startOperation(id);

        vm.prank(OWNER);
        vault.fund{value: 0.01 ether}();
        vm.prank(OWNER);
        vault.startOperation(id);
        assertEq(vault.getOperation(id).totalBNBSpent, 0.005 ether);
        assertEq(token.balanceOf(BURN), 5 ether);
    }

    function testBurnAndDistributionSharePoolButKeepSeparateOutputRules() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        FlapBoostVaultFactory.OperationOptions memory options = _options(60, 2, address(0));
        address bob = address(0xB0B);
        address carol = address(0xCA401);
        options.recipients = new address[](2);
        options.recipients[0] = bob;
        options.recipients[1] = carol;
        vm.prank(OWNER);
        (address sameAddress, uint256 distributionId) = factory.createFixedBNBOperation(options, 0.01 ether);
        assertEq(sameAddress, address(vault));
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        vm.prank(OWNER);
        vault.startOperation(distributionId);
        assertEq(token.balanceOf(BURN), 10 ether);
        assertEq(token.balanceOf(bob), 5 ether);
        assertEq(token.balanceOf(carol), 5 ether);
    }

    function testRandomDistributionCreatesDistinctSyntheticHolders() public {
        FlapBoostVaultFactory.OperationOptions memory options = _options(60, 3, address(0));
        options.randomRecipientCount = 3;
        vm.prank(OWNER);
        (address address_, uint256 id) = factory.createFixedBNBOperation(options, 0.01 ether);
        FlapBoostVault vault = FlapBoostVault(payable(address_));
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();

        vm.recordLogs();
        vm.prank(OWNER);
        vault.startOperation(id);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 transferEvent = keccak256("Transfer(address,address,uint256)");
        address[3] memory holders;
        uint256 holderCount;
        uint256 distributed;
        for (uint256 i; i < entries.length; ++i) {
            if (
                entries[i].emitter != address(token) || entries[i].topics.length != 3
                    || entries[i].topics[0] != transferEvent
            ) continue;
            address recipient = address(uint160(uint256(entries[i].topics[2])));
            if (recipient == address(vault)) continue; // The Portal mint.
            assertTrue(recipient != address(0) && recipient != BURN);
            for (uint256 j; j < holderCount; ++j) {
                assertTrue(recipient != holders[j]);
            }
            holders[holderCount] = recipient;
            ++holderCount;
            distributed += token.balanceOf(recipient);
        }
        assertEq(holderCount, 3);
        assertEq(distributed, 10 ether);
        FlapBoostVault.Operation memory operation = vault.getOperation(id);
        assertEq(operation.randomDistributionRounds, 1);
        assertEq(operation.totalRandomHolders, 3);
        assertEq(operation.totalTokensOutput, 10 ether);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function testDirectDepositWakesUnfundedQueue() public {
        (FlapBoostVault vault,) = _create(0.02 ether, 60);
        vm.prank(OWNER);
        vault.fund{value: 0.021 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        assertEq(vault.triggerId(), 0);
        vm.prank(OWNER);
        (bool ok,) = payable(address(vault)).call{value: 0.03 ether}("");
        assertTrue(ok);
        assertEq(triggerService.lastId(), 1);
        assertEq(triggerService.afterTime(1), block.timestamp + 60);
    }

    function testBookedRoundKeepsOldOutputRuleUntilItCompletes() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        address bob = address(0xB0B);
        FlapBoostVault.RuleUpdate memory update = FlapBoostVault.RuleUpdate({
            fixedBNBPerRound: 0.01 ether,
            fixedTokenAmountPerRound: 0,
            balanceBps: 0,
            maxBNBPerRound: 0,
            interval: 60,
            outputMode: 1,
            randomRecipientCount: 0,
            retainRecipient: bob,
            recipients: new address[](0)
        });
        vm.prank(OWNER);
        vault.updateOperation(0, update);
        assertTrue(vault.hasPendingRules(0));
        uint256 first = vault.triggerId();
        vm.warp(triggerService.afterTime(first));
        triggerService.fire(address(vault), first);
        assertEq(token.balanceOf(BURN), 20 ether);
        assertEq(token.balanceOf(bob), 0);
        assertFalse(vault.hasPendingRules(0));
        uint256 second = vault.triggerId();
        vm.warp(triggerService.afterTime(second));
        triggerService.fire(address(vault), second);
        assertEq(token.balanceOf(bob), 10 ether);
    }

    function testCallbackFitsTriggerGasCapWithMaximumOperations() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        for (uint256 i = 1; i < vault.MAX_OPERATIONS(); ++i) {
            _create(0.01 ether, 60);
        }
        vm.prank(OWNER);
        vault.fund{value: 1 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        uint256 id = vault.triggerId();
        vm.warp(triggerService.afterTime(id));
        uint256 beforeGas = gasleft();
        triggerService.fire(address(vault), id);
        uint256 used = beforeGas - gasleft();
        assertLt(used, 2_000_000);
    }

    function testRandomDistributionCallbackFitsTriggerGasCap() public {
        FlapBoostVaultFactory.OperationOptions memory options = _options(60, 3, address(0));
        options.randomRecipientCount = 20;
        vm.prank(OWNER);
        (address address_, uint256 id) = factory.createFixedBNBOperation(options, 0.01 ether);
        FlapBoostVault vault = FlapBoostVault(payable(address_));
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.startOperation(id);
        uint256 requestId = vault.triggerId();
        vm.warp(triggerService.afterTime(requestId));
        uint256 beforeGas = gasleft();
        triggerService.fire(address(vault), requestId);
        assertLt(beforeGas - gasleft(), 2_000_000);
        assertEq(vault.getOperation(id).totalRandomHolders, 40);
    }

    function testCloseKeepsSharedMoneyAndOwnerCanWithdraw() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        _create(0.01 ether, 60);
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.closeOperation(0);
        assertEq(vault.availableBNB(), 0.1 ether);
        assertTrue(vault.getOperation(1).active);
        vm.prank(OWNER);
        vault.withdraw(0.04 ether);
        assertEq(vault.availableBNB(), 0.06 ether);
    }

    function testReservedRoundCannotBeSpentByStartingAnotherOperation() public {
        (FlapBoostVault vault,) = _create(0.05 ether, 60);
        (, uint256 secondId) = _create(0.06 ether, 60);
        vm.prank(OWNER);
        vault.fund{value: 0.15 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        assertEq(vault.reservedBNB(), 0.05 ether);
        vm.prank(OWNER);
        vm.expectRevert("No budget");
        vault.startOperation(secondId);
        assertFalse(vault.getOperation(secondId).started);
    }

    function testSwapFailureRetriesWithoutFailingTrigger() public {
        (FlapBoostVault vault,) = _create(0.01 ether, 60);
        VaultTestPortal(vault.PORTAL_TESTNET()).setFailSwap(true);
        vm.prank(OWNER);
        vault.fund{value: 0.1 ether}();
        vm.prank(OWNER);
        vault.startOperation(0);
        uint256 first = vault.triggerId();
        assertEq(vault.getOperation(0).consecutiveFailures, 1);
        vm.warp(triggerService.afterTime(first));
        triggerService.fire(address(vault), first);
        assertEq(vault.getOperation(0).consecutiveFailures, 2);
        assertEq(vault.triggerId(), first + 1);
        assertEq(triggerService.afterTime(first + 1), block.timestamp + 600);
    }
}
