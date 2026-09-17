import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "function pendingQuote() view returns (uint256)",
  "function minProcessAmount() view returns (uint256)",
  "function maxProcessAmount() view returns (uint256)",
  "function totalLpMinted() view returns (uint256)",
  "function totalRewardsForwarded() view returns (uint256)",
  "function hasPendingTrigger() view returns (bool)",
  "function pendingTriggerId() view returns (uint256)",
  "function quoteToken() view returns (address)",
  "function gasBalance() view returns (uint256)",
  "function pendingReward(address user) view returns (uint256)",
  "function poolId() view returns (bytes32)",
  "function claimReward()",
  "function ensurePoolDeployed()",
]);
