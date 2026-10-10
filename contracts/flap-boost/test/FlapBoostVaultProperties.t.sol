// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FlapBoostVault} from "../src/FlapBoostVault.sol";
import {FlapBoostVaultFactory} from "../src/FlapBoostVaultFactory.sol";
import {VaultTestToken, VaultTestPortal, VaultTestTrigger} from "./FlapBoostVault.t.sol";

abstract contract FlapBoostPropertyFixture is Test {
    address internal constant OWNER = address(0xA11CE);
    VaultTestToken internal token;
    VaultTestTrigger internal triggerService;
    FlapBoostVaultFactory internal factory;
    FlapBoostVault internal vault;

    function setUp() public virtual {
        vm.chainId(97);
        token = new VaultTestToken();
        factory = new FlapBoostVaultFactory();
        vm.prank(OWNER);
        (address deployed,) = factory.createFixedBNBOperation(_options(address(token)), 0.01 ether);
        vault = FlapBoostVault(payable(deployed));
        vm.etch(vault.PORTAL_TESTNET(), address(new VaultTestPortal()).code);
        vm.etch(vault.TRIGGER_TESTNET(), address(new VaultTestTrigger()).code);
        triggerService = VaultTestTrigger(vault.TRIGGER_TESTNET());
        vm.deal(OWNER, 10_000 ether);
    }

    function _options(address target) internal pure returns (FlapBoostVaultFactory.OperationOptions memory) {
        return FlapBoostVaultFactory.OperationOptions({
            targetToken: target,
            minTokensPerBNB: 100 ether,
            interval: 60,
            outputMode: 0,
            randomRecipientCount: 0,
            retainRecipient: address(0),
            recipients: new address[](0)
        });
    }
}

/// @notice Property tests exercise balance conservation over varied deposits,
/// withdrawals, refunds, and hostile caller identities. Runs are pinned to 200.
contract FlapBoostVaultFuzzTest is FlapBoostPropertyFixture {
    function testFuzz_DepositWithdrawalConservation(uint256 deposited, uint256 withdrawn) public {
        deposited = bound(deposited, 1, 1_000 ether);
        withdrawn = bound(withdrawn, 0, deposited);
        uint256 beforeOwner = OWNER.balance;
        vm.startPrank(OWNER);
        vault.fund{value: deposited}();
        vault.withdraw(withdrawn);
        vm.stopPrank();
        assertEq(address(vault).balance, deposited - withdrawn);
        assertEq(vault.availableBNB(), deposited - withdrawn);
        assertEq(OWNER.balance, beforeOwner - deposited + withdrawn);
        assertEq(vault.bookingFeeOwed(), 0);
        assertEq(vault.triggerId(), 0);
    }

    function testFuzz_RefundBookingFeeAndReservationConservation(uint16 refundBps) public {
        refundBps = uint16(bound(refundBps, 0, 10_000));
        VaultTestPortal(vault.PORTAL_TESTNET()).setRefundBps(refundBps);
        uint256 feeReceiverBefore = vault.BOOKING_FEE_RECEIVER().balance;
        vm.startPrank(OWNER);
        vault.fund{value: 1 ether}();
        vault.startOperation(0);
        vm.stopPrank();
        uint256 input = 0.01 ether;
        uint256 spent = input - (input * uint256(refundBps)) / 10_000;
        assertEq(vault.getOperation(0).totalBNBSpent, spent);
        assertEq(address(vault).balance + spent + address(triggerService).balance + vault.BOOKING_FEE(), 1 ether);
        assertEq(vault.BOOKING_FEE_RECEIVER().balance - feeReceiverBefore, vault.BOOKING_FEE());
        assertEq(vault.availableBNB() + vault.reservedBNB() + vault.bookingFeeOwed(), address(vault).balance);
    }

    function testFuzz_NonOwnerCannotWithdraw(address caller, uint256 amount) public {
        vm.assume(caller != OWNER);
        vm.prank(OWNER);
        vault.fund{value: 1 ether}();
        vm.prank(caller);
        vm.expectRevert("Only owner");
        vault.withdraw(amount);
        assertEq(address(vault).balance, 1 ether);
    }
}

/// @dev The handler is the Vault owner. Only the explicit selectors below are
/// fuzzed; the test does not expose arbitrary cheatcodes to the invariant engine.
contract FlapBoostInvariantHandler is Test {
    FlapBoostVault public immutable vault;
    VaultTestTrigger public immutable triggerService;
    uint256 public deposited;
    uint256 public withdrawn;

    constructor(FlapBoostVaultFactory factory_, VaultTestToken token_, VaultTestTrigger trigger_) {
        triggerService = trigger_;
        FlapBoostVaultFactory.OperationOptions memory options = FlapBoostVaultFactory.OperationOptions({
            targetToken: address(token_), minTokensPerBNB: 100 ether, interval: 60,
            outputMode: 0, randomRecipientCount: 0, retainRecipient: address(0), recipients: new address[](0)
        });
        (address deployed,) = factory_.createFixedBNBOperation(options, 0.01 ether);
        vault = FlapBoostVault(payable(deployed));
        factory_.createFixedTokenAmountOperation(options, 5 ether);
        factory_.createBalancePercentageOperation(options, 2500, 0.02 ether);
        options.outputMode = 1;
        options.retainRecipient = address(this);
        factory_.createFixedBNBOperation(options, 0.015 ether);
    }

    receive() external payable {}

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1 ether);
        deposited += amount;
        vault.fund{value: amount}();
    }

    function withdraw(uint256 amount) external {
        amount = bound(amount, 0, vault.availableBNB());
        withdrawn += amount;
        vault.withdraw(amount);
    }

    function start(uint256 id) external {
        id = bound(id, 0, 3);
        FlapBoostVault.Operation memory op = vault.getOperation(id);
        if (!op.active || op.paused || op.started || vault.pendingTokens() != 0) return;
        // Insufficient budget is a valid user rejection, not an invariant failure.
        try vault.startOperation(id) {} catch {}
    }

    function executeCallback() external {
        uint256 requestId = vault.triggerId();
        if (requestId == 0) return;
        uint64 afterTime = triggerService.afterTime(requestId);
        if (block.timestamp < afterTime) vm.warp(afterTime);
        triggerService.fire(address(vault), requestId);
    }

    function togglePause(uint256 id) external {
        id = bound(id, 0, 3);
        FlapBoostVault.Operation memory op = vault.getOperation(id);
        if (!op.active) return;
        if (op.paused) vault.resumeOperation(id);
        else vault.pauseOperation(id);
    }

    function close(uint256 id) external {
        id = bound(id, 0, 3);
        if (vault.getOperation(id).active) vault.closeOperation(id);
    }

    function poke() external { vault.poke(); }
}

contract FlapBoostVaultInvariantTest is StdInvariant, Test {
    VaultTestToken private token;
    VaultTestTrigger private triggerService;
    FlapBoostInvariantHandler private handler;
    FlapBoostVault private vault;
    uint256 private initialFeeReceiverBalance;

    function setUp() public {
        vm.chainId(97);
        token = new VaultTestToken();
        FlapBoostVaultFactory factory = new FlapBoostVaultFactory();
        FlapBoostVault addressBook = new FlapBoostVault(address(this), address(token));
        vm.etch(addressBook.PORTAL_TESTNET(), address(new VaultTestPortal()).code);
        vm.etch(addressBook.TRIGGER_TESTNET(), address(new VaultTestTrigger()).code);
        triggerService = VaultTestTrigger(addressBook.TRIGGER_TESTNET());
        handler = new FlapBoostInvariantHandler(factory, token, triggerService);
        vault = handler.vault();
        initialFeeReceiverBalance = vault.BOOKING_FEE_RECEIVER().balance;
        vm.deal(address(handler), 10_000 ether);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdraw.selector;
        selectors[2] = handler.start.selector;
        selectors[3] = handler.executeCallback.selector;
        selectors[4] = handler.togglePause.selector;
        selectors[5] = handler.close.selector;
        selectors[6] = handler.poke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_BnbConservationAcrossAllOperations() public view {
        uint256 spent;
        for (uint256 i; i < vault.operationCount(); ++i) spent += vault.getOperation(i).totalBNBSpent;
        uint256 paidBookingFees = vault.BOOKING_FEE_RECEIVER().balance - initialFeeReceiverBalance;
        assertEq(
            address(vault).balance + spent + handler.withdrawn() + address(triggerService).balance + paidBookingFees,
            handler.deposited()
        );
        assertEq(vault.availableBNB() + vault.reservedBNB() + vault.bookingFeeOwed(), address(vault).balance);
        assertLe(vault.reservedBNB(), address(vault).balance);
        assertLe(vault.operationCount(), vault.MAX_OPERATIONS());
    }

    function invariant_TokensAreAccountedForOnce() public view {
        uint256 delivered;
        for (uint256 i; i < vault.operationCount(); ++i) delivered += vault.getOperation(i).totalTokensOutput;
        assertEq(delivered + token.balanceOf(address(vault)), token.totalSupply());
        assertLe(vault.pendingTokens(), token.balanceOf(address(vault)));
    }
}
