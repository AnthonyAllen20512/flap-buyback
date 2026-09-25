import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "function personalVaultOf(address owner) view returns (address vault)",
  "function createPersonalVault() returns (address vault)",
]);

export const vaultAbi = parseAbi([
  "function planOwner() view returns (address)",
  "function availableBNB() view returns (uint256)",
  "function taskCount() view returns (uint256)",
  "function activeTaskCount() view returns (uint256)",
  "function executionCount() view returns (uint256)",
  "function getTask(uint256 taskId) view returns ((uint64 createdAt, uint64 closedAt, address targetToken, uint8 mode, uint8 tokenOutput, uint64 interval, uint256 amount, uint256 bnbAvailable, uint256 bnbSpent, uint256 executions, uint256 triggerId, uint64 scheduledFor, uint256 pendingExecution, bool active, bool paused))",
  "function getFixedRecipients(uint256 taskId) view returns (address[] recipients)",
  "function getExecution(uint256 executionId) view returns (uint256 taskId, uint64 executedAt, uint256 bnbSpent, uint256 tokensBought, uint32 recipientCount, uint8 tokenOutput, bool distributionComplete)",
  "function getTotals() view returns (uint256 bnbSpent, uint256 automationFees, uint256 burned, uint256 retained, uint256 distributed, uint256 holdersAdded, uint256 completedExecutions)",
  "function getTokenPreview(address token, address account) view returns (string symbol, uint8 decimals, uint256 balance)",
  "function createTask((uint8 buybackMode, uint256 amountPerRound, uint64 intervalSeconds, uint16 maxSlippageBps, uint8 outputMode, address retainRecipient, uint8 distributionMode, uint32 randomHolderCount, address[] fixedRecipients, address targetToken) config) returns (uint256 taskId)",
  "function fundBNB() payable",
  "function sync()",
  "function withdrawBNB(address recipient, uint256 amount)",
  "function updateTask(uint256 taskId, (uint8 buybackMode, uint256 amountPerRound, uint64 intervalSeconds, uint16 maxSlippageBps, uint8 outputMode, address retainRecipient, uint8 distributionMode, uint32 randomHolderCount, address[] fixedRecipients, address targetToken) config)",
  "function fundTask(uint256 taskId) payable",
  "function pauseTask(uint256 taskId)",
  "function resumeTask(uint256 taskId)",
  "function closeTask(uint256 taskId)",
  "function withdrawTaskBNB(uint256 taskId, address recipient, uint256 amount)",
  "function fundToken(address token, uint256 amount)",
  "function withdrawToken(address token, address recipient, uint256 amount)",
]);
