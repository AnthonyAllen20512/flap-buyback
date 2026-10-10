// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFlapBoostPortal, IFlapBoostTriggerReceiver, IFlapBoostTriggerService} from "./FlapBoostTypes.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";

/// @notice One owner and one token share one BNB pool and one Trigger queue.
contract FlapBoostVault is ReentrancyGuard, IFlapBoostTriggerReceiver {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint256 public constant BOOKING_FEE = 0.0001 ether;
    uint256 public constant MIN_TOTAL_FEE_TRADE_MULTIPLIER = 20;
    uint256 public constant MAX_OPERATIONS = 24;
    uint8 public constant MAX_RANDOM_RECIPIENTS = 20;
    uint64 public constant MIN_INTERVAL = 1 minutes;
    uint64 public constant RETRY_BASE_DELAY = 5 minutes;
    address public constant BOOKING_FEE_RECEIVER = 0x439CEed9DBA171857e6A0b16705e3880c4ff131e;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    address public constant PORTAL_MAINNET = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address public constant PORTAL_TESTNET = 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9;
    address public constant TRIGGER_MAINNET = 0xcf4EE25035CF883895110f367F5BA8172416a7F9;
    address public constant TRIGGER_TESTNET = 0x560E9830926C9e0EB98a59c6b9902383Fc0D9Eb2;

    enum BuyMode {
        FIXED_BNB,
        FIXED_TOKEN_AMOUNT,
        BALANCE_BPS
    }

    struct OperationConfig {
        BuyMode buyMode;
        uint256 fixedBNBPerRound;
        uint256 fixedTokenAmountPerRound;
        uint16 balanceBps;
        uint256 maxBNBPerRound;
        uint256 minTokensPerBNB;
        uint64 interval;
        uint8 outputMode;
        uint8 randomRecipientCount;
        address retainRecipient;
        address[] recipients;
    }

    struct RuleUpdate {
        uint256 fixedBNBPerRound;
        uint256 fixedTokenAmountPerRound;
        uint16 balanceBps;
        uint256 maxBNBPerRound;
        uint64 interval;
        uint8 outputMode;
        uint8 randomRecipientCount;
        address retainRecipient;
        address[] recipients;
    }

    struct Operation {
        BuyMode buyMode;
        uint256 fixedBNBPerRound;
        uint256 fixedTokenAmountPerRound;
        uint16 balanceBps;
        uint256 maxBNBPerRound;
        uint256 minTokensPerBNB;
        uint64 interval;
        uint8 outputMode;
        uint8 randomRecipientCount;
        address retainRecipient;
        address[] recipients;
        bool active;
        bool paused;
        bool started;
        uint8 consecutiveFailures;
        uint64 nextEligibleAt;
        uint64 randomDistributionRounds;
        uint64 totalRandomHolders;
        uint256 totalBNBSpent;
        uint256 totalTokensOutput;
    }

    address public immutable owner;
    address public immutable factory;
    address public immutable targetToken;
    Operation[] private _operations;
    mapping(uint256 => RuleUpdate) private _pendingRules;
    mapping(uint256 => bool) public hasPendingRules;

    uint256 public bookingFeeOwed;
    bool public callbackInProgress;
    bool private _schedulingInProgress;
    uint256 public triggerId;
    uint256 public scheduledOperationId;
    uint256 public reservedBNB;
    bool public triggerIsRecovery;
    uint256 public pendingOperationId;
    uint256 public pendingTokens;

    event OperationCreated(uint256 indexed operationId, BuyMode mode, uint8 outputMode);
    event OperationUpdated(uint256 indexed operationId);
    event OperationUpdateQueued(uint256 indexed operationId);
    event OperationState(uint256 indexed operationId, bool active, bool paused);
    event Funded(address indexed sender, uint256 amount);
    event Scheduled(
        uint256 indexed requestId, uint256 indexed operationId, uint256 fee, uint64 executeAfter, uint256 reservedBNB
    );
    event ScheduleDeferred(uint256 indexed operationId, uint64 executeAfter);
    event FailedTriggerRecovered(uint256 indexed requestId);
    event BookingFeeAccrued(uint256 indexed requestId, uint256 amount);
    event BookingFeePaid(uint256 amount);
    event BookingFeeDeferred(uint256 amount);
    event Buyback(uint256 indexed operationId, uint256 bnbSpent, uint256 tokens, uint256 minOutput);
    event OutputDeferred(uint256 indexed operationId, uint256 tokens);
    event RandomHolderDistribution(
        uint256 indexed operationId, uint64 indexed round, uint8 recipients, uint256 tokens, bytes32 seed
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address owner_, address token_) {
        require(owner_ != address(0) && token_.code.length != 0, "Invalid address");
        owner = owner_;
        factory = msg.sender;
        targetToken = token_;
        _portal();
        _trigger();
    }

    function operationCount() external view returns (uint256) {
        return _operations.length;
    }

    function getOperation(uint256 id) external view returns (Operation memory) {
        return _operations[id];
    }

    function pendingRules(uint256 id) external view returns (RuleUpdate memory) {
        require(hasPendingRules[id], "No pending rules");
        return _pendingRules[id];
    }

    function availableBNB() public view returns (uint256) {
        return address(this).balance - reservedBNB - bookingFeeOwed;
    }

    /// @dev The factory is the only creator; the token and owner never change.
    function addOperation(OperationConfig calldata config) external returns (uint256 id) {
        require(msg.sender == factory, "Only factory");
        require(_operations.length < MAX_OPERATIONS, "Too many operations");
        _validate(
            config.buyMode,
            config.fixedBNBPerRound,
            config.fixedTokenAmountPerRound,
            config.balanceBps,
            config.maxBNBPerRound,
            config.minTokensPerBNB,
            config.interval,
            config.outputMode,
            config.randomRecipientCount,
            config.retainRecipient,
            config.recipients
        );
        id = _operations.length;
        _operations.push();
        Operation storage op = _operations[id];
        op.buyMode = config.buyMode;
        op.fixedBNBPerRound = config.fixedBNBPerRound;
        op.fixedTokenAmountPerRound = config.fixedTokenAmountPerRound;
        op.balanceBps = config.balanceBps;
        op.maxBNBPerRound = config.maxBNBPerRound;
        op.minTokensPerBNB = config.minTokensPerBNB;
        op.interval = config.interval;
        op.outputMode = config.outputMode;
        op.randomRecipientCount = config.randomRecipientCount;
        op.retainRecipient = config.retainRecipient;
        op.active = true;
        for (uint256 i; i < config.recipients.length; ++i) {
            op.recipients.push(config.recipients[i]);
        }
        emit OperationCreated(id, config.buyMode, config.outputMode);
    }

    function updateOperation(uint256 id, RuleUpdate calldata update) external onlyOwner {
        Operation storage op = _operations[id];
        require(op.active && !callbackInProgress, "Unavailable");
        _validate(
            op.buyMode,
            update.fixedBNBPerRound,
            update.fixedTokenAmountPerRound,
            update.balanceBps,
            update.maxBNBPerRound,
            op.minTokensPerBNB,
            update.interval,
            update.outputMode,
            update.randomRecipientCount,
            update.retainRecipient,
            update.recipients
        );
        if ((triggerId != 0 && scheduledOperationId == id) || (pendingTokens != 0 && pendingOperationId == id)) {
            _pendingRules[id] = update;
            hasPendingRules[id] = true;
            emit OperationUpdateQueued(id);
        } else {
            _applyRules(id, update);
            _trySchedule();
        }
    }

    receive() external payable {
        if (msg.value == 0) return;
        emit Funded(msg.sender, msg.value);
        // A normal direct deposit can wake an unfunded queue. Portal refunds
        // and Trigger-service callbacks never schedule recursively.
        if (!callbackInProgress && msg.sender != _portal() && msg.sender != _trigger()) _trySchedule();
    }

    function fund() external payable {
        require(msg.value != 0, "No BNB");
        emit Funded(msg.sender, msg.value);
        _trySchedule();
    }

    /// @notice Fund and try the first round in one transaction. An insufficient
    /// budget remains safely deposited so the owner can top up later.
    function fundAndTryStart(uint256 id) external payable onlyOwner nonReentrant {
        require(msg.value != 0, "No BNB");
        emit Funded(msg.sender, msg.value);
        Operation storage op = _operations[id];
        if (!op.active || op.paused || op.started || callbackInProgress || pendingTokens != 0) {
            _trySchedule();
            return;
        }
        uint256 balance = availableBNB();
        uint256 budget = _roundReservation(op, balance);
        if (budget == 0 || budget > balance) {
            _trySchedule();
            return;
        }
        _startWithBudget(id, budget);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= availableBNB(), "Reserved BNB");
        (bool ok,) = payable(owner).call{value: amount}("");
        require(ok, "BNB transfer failed");
    }

    function pauseOperation(uint256 id) external onlyOwner {
        Operation storage op = _operations[id];
        require(op.active, "Closed");
        op.paused = true;
        emit OperationState(id, true, true);
        _trySchedule();
    }

    function resumeOperation(uint256 id) external onlyOwner {
        Operation storage op = _operations[id];
        require(op.active, "Closed");
        op.paused = false;
        _trySchedule();
        emit OperationState(id, true, false);
    }

    function closeOperation(uint256 id) external onlyOwner {
        Operation storage op = _operations[id];
        require(op.active, "Closed");
        op.active = false;
        op.paused = true;
        delete _pendingRules[id];
        hasPendingRules[id] = false;
        emit OperationState(id, false, true);
        _trySchedule();
    }

    /// @notice First round is direct, without a Trigger or booking fee.
    function startOperation(uint256 id) external onlyOwner nonReentrant {
        Operation storage op = _operations[id];
        require(op.active && !op.paused && !op.started && !callbackInProgress && pendingTokens == 0, "Unavailable");
        uint256 balance = availableBNB();
        uint256 budget = _roundReservation(op, balance);
        require(budget != 0 && budget <= balance, "No budget");
        _startWithBudget(id, budget);
    }

    function _startWithBudget(uint256 id, uint256 budget) private {
        Operation storage op = _operations[id];
        op.started = true;
        callbackInProgress = true;
        _tryExecuteRound(id, budget);
    }

    function trigger(uint256 requestId) external override nonReentrant {
        require(msg.sender == _trigger() && requestId == triggerId && requestId != 0, "Invalid trigger");
        uint256 bookedId = scheduledOperationId;
        uint256 reservation = reservedBNB;
        bool recovery = triggerIsRecovery;
        triggerId = 0;
        reservedBNB = 0;
        triggerIsRecovery = false;
        callbackInProgress = true;
        if (pendingTokens != 0) {
            uint256 pendingId = pendingOperationId;
            if (_trySettlePendingOutput()) _finishSuccess(pendingId);
            else _finishFailure(pendingId);
            return;
        }
        (bool found, uint256 id) = _earliestOperation();
        if (recovery || !found || id != bookedId) _applyPendingRules(bookedId);
        if (recovery || !found || block.timestamp < _operations[id].nextEligibleAt) {
            callbackInProgress = false;
            _trySchedule();
        } else {
            // A newly started operation may now be due before the originally
            // booked one. Spend this single paid callback on the true earliest.
            if (id != bookedId) reservation = _roundReservation(_operations[id], availableBNB());
            if (reservation == 0 || reservation > availableBNB()) {
                callbackInProgress = false;
                emit ScheduleDeferred(id, _operations[id].nextEligibleAt);
                return;
            }
            _tryExecuteRound(id, reservation);
        }
    }

    /// @dev The external self-call contains token balance checks and post-swap accounting.
    /// A revert rolls back the Portal swap, while the outer Trigger callback can still
    /// record a failure and book a later retry instead of becoming permanently FAILED.
    function executeRound(uint256 id, uint256 reservation) external {
        require(msg.sender == address(this), "Only self");
        _executeRound(id, reservation);
    }

    function _tryExecuteRound(uint256 id, uint256 reservation) private {
        try this.executeRound(id, reservation) {}
        catch {
            _finishFailure(id);
        }
    }

    function settlePendingOutput() external nonReentrant {
        require(pendingTokens != 0, "No pending output");
        callbackInProgress = true;
        uint256 id = pendingOperationId;
        if (_trySettlePendingOutput()) _finishSuccess(id);
        else callbackInProgress = false;
    }

    function executePendingOutput() external {
        require(msg.sender == address(this), "Only self");
        uint256 amount = pendingTokens;
        require(amount != 0, "No pending output");
        uint256 id = pendingOperationId;
        pendingTokens = 0;
        Operation storage op = _operations[id];
        if (op.outputMode == 0) {
            IERC20(targetToken).safeTransfer(BURN_ADDRESS, amount);
        } else if (op.outputMode == 1) {
            IERC20(targetToken).safeTransfer(op.retainRecipient, amount);
        } else if (op.outputMode == 2) {
            uint256 base = amount / op.recipients.length;
            uint256 remainder = amount % op.recipients.length;
            for (uint256 i; i < op.recipients.length; ++i) {
                IERC20(targetToken).safeTransfer(op.recipients[i], base + (i < remainder ? 1 : 0));
            }
        } else {
            _distributeToRandomHolders(id, op, amount);
        }
        op.totalTokensOutput += amount;
    }

    function poke() external {
        _trySchedule();
    }

    /// @notice Only a provably FAILED service request can be replaced. A merely
    /// late PENDING request remains booked because execution time is not guaranteed.
    function recoverFailedTrigger() external onlyOwner {
        uint256 requestId = triggerId;
        require(requestId != 0, "No trigger");
        IFlapBoostTriggerService.TriggerRequest memory request =
            IFlapBoostTriggerService(_trigger()).getRequest(requestId);
        require(request.requester == address(this) && request.status == 2, "Trigger not failed");
        triggerId = 0;
        reservedBNB = 0;
        triggerIsRecovery = false;
        emit FailedTriggerRecovered(requestId);
        _trySchedule();
    }

    function settleBookingFee() external nonReentrant {
        require(bookingFeeOwed != 0, "No fee owed");
        _payBookingFee();
    }

    function _executeRound(uint256 id, uint256 reservation) private {
        Operation storage op = _operations[id];
        (bool executable, uint256 input) = _resolveInput(op, reservation);
        if (!executable || input > availableBNB()) {
            _finishFailure(id);
            return;
        }
        uint256 minimum = Math.mulDiv(input, op.minTokensPerBNB, 1 ether, Math.Rounding.Up);
        if (op.buyMode == BuyMode.FIXED_TOKEN_AMOUNT && minimum < op.fixedTokenAmountPerRound) {
            minimum = op.fixedTokenAmountPerRound;
        }
        uint256 beforeBNB = address(this).balance;
        uint256 beforeTokens = IERC20(targetToken).balanceOf(address(this));
        try IFlapBoostPortal(_portal()).swapExactInput{value: input}(
            IFlapBoostPortal.ExactInputParams(address(0), targetToken, input, minimum, "")
        ) returns (
            uint256
        ) {
            uint256 afterTokens = IERC20(targetToken).balanceOf(address(this));
            uint256 received = afterTokens > beforeTokens ? afterTokens - beforeTokens : 0;
            // Revert the entire self-call, including the Portal swap, if the
            // actual token balance increase fails the owner's price floor.
            require(received >= minimum, "Insufficient tokens");
            uint256 spent = beforeBNB > address(this).balance ? beforeBNB - address(this).balance : 0;
            op.totalBNBSpent += spent;
            pendingOperationId = id;
            pendingTokens = received;
            emit Buyback(id, spent, received, minimum);
            if (!_trySettlePendingOutput()) _finishFailure(id);
            else _finishSuccess(id);
        } catch {
            _finishFailure(id);
        }
    }

    function _trySettlePendingOutput() private returns (bool) {
        if (pendingTokens == 0) return true;
        try this.executePendingOutput() {
            return true;
        } catch {
            emit OutputDeferred(pendingOperationId, pendingTokens);
            return false;
        }
    }

    function _finishSuccess(uint256 id) private {
        Operation storage op = _operations[id];
        op.consecutiveFailures = 0;
        _applyPendingRules(id);
        op.nextEligibleAt = uint64(block.timestamp + op.interval);
        callbackInProgress = false;
        _trySchedule();
    }

    function _finishFailure(uint256 id) private {
        Operation storage op = _operations[id];
        if (op.consecutiveFailures < type(uint8).max) ++op.consecutiveFailures;
        uint8 exponent = op.consecutiveFailures - 1;
        if (exponent > 6) exponent = 6;
        op.nextEligibleAt = uint64(block.timestamp + (RETRY_BASE_DELAY << exponent));
        callbackInProgress = false;
        _trySchedule();
    }

    function _trySchedule() private {
        if (callbackInProgress || _schedulingInProgress || triggerId != 0) return;
        (bool found, uint256 id) = pendingTokens != 0 ? (true, pendingOperationId) : _earliestOperation();
        if (!found) return;
        Operation storage op = _operations[id];
        uint64 when = op.nextEligibleAt > block.timestamp ? op.nextEligibleAt : uint64(block.timestamp);
        uint256 fee;
        try IFlapBoostTriggerService(_trigger()).getFee() returns (uint256 value) {
            fee = value;
        } catch {
            emit ScheduleDeferred(id, when);
            return;
        }
        if (fee > type(uint256).max - BOOKING_FEE) return;
        uint256 totalFee = fee + BOOKING_FEE;
        uint256 balance = availableBNB();
        if (balance < totalFee) return;
        uint256 reservation = pendingTokens != 0 ? 0 : _roundReservation(op, balance - totalFee);
        if (pendingTokens == 0 && (reservation == 0 || reservation > balance - totalFee)) return;
        if (pendingTokens == 0 &&
            (totalFee > type(uint256).max / MIN_TOTAL_FEE_TRADE_MULTIPLIER ||
             reservation < totalFee * MIN_TOTAL_FEE_TRADE_MULTIPLIER)) {
            emit ScheduleDeferred(id, when);
            return;
        }
        reservedBNB = reservation;
        _schedulingInProgress = true;
        try IFlapBoostTriggerService(_trigger()).requestTrigger{value: fee}(when) returns (uint256 requestId) {
            _schedulingInProgress = false;
            if (requestId == 0) {
                reservedBNB = 0;
                emit ScheduleDeferred(id, when);
            } else {
                triggerId = requestId;
                scheduledOperationId = id;
                triggerIsRecovery = pendingTokens != 0;
                bookingFeeOwed += BOOKING_FEE;
                emit Scheduled(requestId, id, fee, when, reservation);
                emit BookingFeeAccrued(requestId, BOOKING_FEE);
                _payBookingFee();
            }
        } catch {
            _schedulingInProgress = false;
            reservedBNB = 0;
            emit ScheduleDeferred(id, when);
        }
    }

    function _earliestOperation() private view returns (bool found, uint256 id) {
        uint64 earliest = type(uint64).max;
        for (uint256 i; i < _operations.length; ++i) {
            Operation storage op = _operations[i];
            if (op.active && op.started && !op.paused && (!found || op.nextEligibleAt < earliest)) {
                found = true;
                id = i;
                earliest = op.nextEligibleAt;
            }
        }
    }

    function _roundReservation(Operation storage op, uint256 balance) private returns (uint256) {
        if (op.buyMode == BuyMode.FIXED_BNB) return op.fixedBNBPerRound;
        if (op.buyMode == BuyMode.FIXED_TOKEN_AMOUNT) {
            (bool executable, uint256 input) = _resolveInput(op, balance);
            return executable ? input : 0;
        }
        uint256 amount = Math.mulDiv(balance, op.balanceBps, BPS);
        return op.maxBNBPerRound != 0 && amount > op.maxBNBPerRound ? op.maxBNBPerRound : amount;
    }

    function _resolveInput(Operation storage op, uint256 reservation) private returns (bool, uint256) {
        if (reservation == 0) return (false, 0);
        if (op.buyMode != BuyMode.FIXED_TOKEN_AMOUNT) return (true, reservation);
        (bool ok, uint256 maxQuote) = _quote(reservation);
        if (!ok || maxQuote < op.fixedTokenAmountPerRound) return (false, 0);
        uint256 input = Math.mulDiv(reservation, op.fixedTokenAmountPerRound, maxQuote, Math.Rounding.Up);
        if (input == 0) input = 1;
        for (uint256 i; i < 3; ++i) {
            uint256 quote;
            (ok, quote) = _quote(input);
            if (!ok || quote == 0) return (false, 0);
            if (quote >= op.fixedTokenAmountPerRound) return (true, input);
            uint256 nextInput = Math.mulDiv(input, op.fixedTokenAmountPerRound, quote, Math.Rounding.Up);
            if (nextInput <= input) nextInput = input + 1;
            input = nextInput > reservation ? reservation : nextInput;
        }
        (ok, maxQuote) = _quote(input);
        return ok && maxQuote >= op.fixedTokenAmountPerRound ? (true, input) : (false, 0);
    }

    function _quote(uint256 input) private returns (bool, uint256) {
        try IFlapBoostPortal(_portal())
            .quoteExactInput(IFlapBoostPortal.QuoteExactInputParams(address(0), targetToken, input)) returns (
            uint256 output
        ) {
            return (true, output);
        } catch {
            return (false, 0);
        }
    }

    function _payBookingFee() private {
        uint256 amount = bookingFeeOwed;
        if (amount == 0) return;
        bookingFeeOwed = 0;
        bool paid;
        address receiver = BOOKING_FEE_RECEIVER;
        assembly { paid := call(30000, receiver, amount, 0, 0, 0, 0) }
        if (paid) {
            emit BookingFeePaid(amount);
        } else {
            bookingFeeOwed = amount;
            emit BookingFeeDeferred(amount);
        }
    }

    function _applyPendingRules(uint256 id) private {
        if (!hasPendingRules[id] || (pendingTokens != 0 && pendingOperationId == id)) return;
        RuleUpdate memory update = _pendingRules[id];
        delete _pendingRules[id];
        hasPendingRules[id] = false;
        _applyRules(id, update);
    }

    function _applyRules(uint256 id, RuleUpdate memory update) private {
        Operation storage op = _operations[id];
        op.fixedBNBPerRound = update.fixedBNBPerRound;
        op.fixedTokenAmountPerRound = update.fixedTokenAmountPerRound;
        op.balanceBps = update.balanceBps;
        op.maxBNBPerRound = update.maxBNBPerRound;
        op.interval = update.interval;
        op.outputMode = update.outputMode;
        op.randomRecipientCount = update.randomRecipientCount;
        op.retainRecipient = update.retainRecipient;
        delete op.recipients;
        for (uint256 i; i < update.recipients.length; ++i) {
            op.recipients.push(update.recipients[i]);
        }
        emit OperationUpdated(id);
    }

    function _distributeToRandomHolders(uint256 id, Operation storage op, uint256 amount) private {
        uint8 recipientCount = op.randomRecipientCount;
        if (amount < recipientCount) recipientCount = uint8(amount);
        uint64 round = op.randomDistributionRounds;
        bytes32 seed = keccak256(
            abi.encodePacked(block.prevrandao, blockhash(block.number - 1), address(this), id, round, amount)
        );
        uint256 base = amount / recipientCount;
        uint256 remainder = amount % recipientCount;
        for (uint256 i; i < recipientCount; ++i) {
            IERC20(targetToken).safeTransfer(_randomHolder(seed, i), base + (i < remainder ? 1 : 0));
        }
        unchecked {
            ++op.randomDistributionRounds;
            op.totalRandomHolders += recipientCount;
        }
        emit RandomHolderDistribution(id, round, recipientCount, amount, seed);
    }

    function _randomHolder(bytes32 seed, uint256 index) private view returns (address holder) {
        holder = address(uint160(uint256(keccak256(abi.encodePacked(seed, index)))));
        if (holder == address(0) || holder == BURN_ADDRESS) {
            holder = address(uint160(uint256(keccak256(abi.encodePacked(seed, index, address(this))))));
        }
    }

    function _validate(
        BuyMode mode,
        uint256 fixedBNB,
        uint256 fixedTokens,
        uint16 balanceBps_,
        uint256 maxBNB,
        uint256 floor,
        uint64 interval_,
        uint8 output,
        uint8 randomRecipientCount,
        address retain,
        address[] memory recipients
    ) private pure {
        require(floor != 0 && interval_ >= MIN_INTERVAL, "Invalid floor or interval");
        if (mode == BuyMode.FIXED_BNB) {
            require(fixedBNB != 0 && fixedTokens == 0 && balanceBps_ == 0 && maxBNB == 0, "Invalid BNB mode");
        } else if (mode == BuyMode.FIXED_TOKEN_AMOUNT) {
            require(fixedBNB == 0 && fixedTokens != 0 && balanceBps_ == 0 && maxBNB == 0, "Invalid token mode");
        } else {
            require(fixedBNB == 0 && fixedTokens == 0 && balanceBps_ != 0 && balanceBps_ <= BPS, "Invalid BPS mode");
        }
        require(output <= 3, "Invalid output");
        if (output == 0) {
            require(retain == address(0) && recipients.length == 0 && randomRecipientCount == 0, "Invalid burn");
        } else if (output == 1) {
            require(retain != address(0) && recipients.length == 0 && randomRecipientCount == 0, "Invalid retain");
        } else if (output == 2) {
            require(
                retain == address(0) && recipients.length > 0 && recipients.length <= 5 && randomRecipientCount == 0,
                "Invalid distribute"
            );
        } else {
            require(
                retain == address(0) && recipients.length == 0 && randomRecipientCount != 0
                    && randomRecipientCount <= MAX_RANDOM_RECIPIENTS,
                "Invalid random distribute"
            );
        }
        for (uint256 i; i < recipients.length; ++i) {
            require(recipients[i] != address(0), "Zero recipient");
            for (uint256 j; j < i; ++j) {
                require(recipients[i] != recipients[j], "Duplicate recipient");
            }
        }
    }

    function _portal() private view returns (address) {
        if (block.chainid == 56) return PORTAL_MAINNET;
        if (block.chainid == 97) return PORTAL_TESTNET;
        revert("Unsupported chain");
    }

    function _trigger() private view returns (address) {
        if (block.chainid == 56) return TRIGGER_MAINNET;
        if (block.chainid == 97) return TRIGGER_TESTNET;
        revert("Unsupported chain");
    }
}
