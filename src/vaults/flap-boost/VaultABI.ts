import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "function vaultsOf(address owner) view returns (address[] vaults)",
  "function vaultOf(address owner, address token) view returns (address vault)",
  "function createFixedBNBOperation((address targetToken, uint256 minTokensPerBNB, uint64 interval, uint8 outputMode, uint8 randomRecipientCount, address retainRecipient, address[] recipients) options, uint256 bnbPerRound) returns (address vault, uint256 operationId)",
  "function createFixedTokenAmountOperation((address targetToken, uint256 minTokensPerBNB, uint64 interval, uint8 outputMode, uint8 randomRecipientCount, address retainRecipient, address[] recipients) options, uint256 tokenAmountPerRound) returns (address vault, uint256 operationId)",
  "function createBalancePercentageOperation((address targetToken, uint256 minTokensPerBNB, uint64 interval, uint8 outputMode, uint8 randomRecipientCount, address retainRecipient, address[] recipients) options, uint16 balanceBps, uint256 maxBNBPerRound) returns (address vault, uint256 operationId)",
]);

export const portalAbi = parseAbi([
  "function quoteExactInput((address inputToken, address outputToken, uint256 inputAmount) params) returns (uint256 outputAmount)",
]);

export const triggerAbi = parseAbi([
  "function getRequest(uint256 requestId) view returns ((address requester, uint64 executeAfter, uint8 status, uint128 feePaid))",
]);

export const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function targetToken() view returns (address)",
  "function operationCount() view returns (uint256)",
  "function getOperation(uint256 id) view returns ((uint8 buyMode, uint256 fixedBNBPerRound, uint256 fixedTokenAmountPerRound, uint16 balanceBps, uint256 maxBNBPerRound, uint256 minTokensPerBNB, uint64 interval, uint8 outputMode, uint8 randomRecipientCount, address retainRecipient, address[] recipients, bool active, bool paused, bool started, uint8 consecutiveFailures, uint64 nextEligibleAt, uint64 randomDistributionRounds, uint64 totalRandomHolders, uint256 totalBNBSpent, uint256 totalTokensOutput))",
  "function startFeeCharged() view returns (bool)",
  "function startFeeOwed() view returns (uint256)",
  "function START_FEE() view returns (uint256)",
  "function hasPendingRules(uint256 id) view returns (bool)",
  "function pendingRules(uint256 id) view returns ((uint256 fixedBNBPerRound, uint256 fixedTokenAmountPerRound, uint16 balanceBps, uint256 maxBNBPerRound, uint64 interval, uint8 outputMode, uint8 randomRecipientCount, address retainRecipient, address[] recipients))",
  "function callbackInProgress() view returns (bool)",
  "function triggerId() view returns (uint256)",
  "function scheduledOperationId() view returns (uint256)",
  "function pendingTokens() view returns (uint256)",
  "function pendingOperationId() view returns (uint256)",
  "function settlePendingOutput()",
  "function reservedBNB() view returns (uint256)",
  "function availableBNB() view returns (uint256)",
  "function fund() payable",
  "function fundAndTryStart(uint256 id) payable",
  "function recoverFailedTrigger()",
  "function startOperation(uint256 id)",
  "function pauseOperation(uint256 id)",
  "function resumeOperation(uint256 id)",
  "function closeOperation(uint256 id)",
  "function withdraw(uint256 amount)",
  "function poke()",
  "function updateOperation(uint256 id, (uint256 fixedBNBPerRound, uint256 fixedTokenAmountPerRound, uint16 balanceBps, uint256 maxBNBPerRound, uint64 interval, uint8 outputMode, uint8 randomRecipientCount, address retainRecipient, address[] recipients) update)",
]);
