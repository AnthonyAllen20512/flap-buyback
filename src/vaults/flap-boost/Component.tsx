"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ActionAvailabilityStage, Address, VaultComponentProps } from "@/src/sdk";
import {
  ZERO_ADDRESS,
  erc20Abi,
  formatTokenAmount,
  getTxErrorKind,
  handleTxError,
  isActionAvailableForPhase,
  isValidAddress,
  parseTokenAmount,
  useFlapSdk,
} from "@/src/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Metric, TxButton } from "@/src/ui";
import type { TxButtonState } from "@/src/ui";
import {
  ChevronRight,
  CircleCheck,
  CircleDollarSign,
  CirclePercent,
  Clock3,
  Coins,
  Flame,
  Gauge,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Target,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { factoryAbi, portalAbi, triggerAbi, vaultAbi } from "./VaultABI";

const TASKS_PER_PAGE = 3;
const PLAZA_PROJECTS_PER_PAGE = 6;
const PLAZA_VAULTS_PER_LOAD = 12;
const VAULT_READ_BATCH_SIZE = 4;
const OPERATION_READ_BATCH_SIZE = 8;

async function mapInBatches<T, U>(
  items: readonly T[],
  batchSize: number,
  mapItem: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    results.push(...(await Promise.all(items.slice(start, start + batchSize).map(mapItem))));
  }
  return results;
}
const PRICE_FLOOR_BPS = 7_000n;
const BPS_DENOMINATOR = 10_000n;
const ONE_BNB = 10n ** 18n;
const TOTAL_FEE_TRADE_MULTIPLIER = 10n;
const BOOKING_FEE = 100_000_000_000_000n;
// Keep wallet-submitted limits below the testnet node's per-transaction cap.
// The same limit is used for simulation, so insufficient gas fails before signing.
const CREATE_OPERATION_GAS = 4_800_000n;
const FUND_AND_START_GAS = 3_000_000n;
const FUND_GAS = 1_000_000n;
const GOLD_PRIMARY_BUTTON =
  "boost-cta text-[#211907] [--ui20-chamfer-bg:#E8C874] [--ui20-chamfer-border:#F4D994] shadow-[0_12px_28px_-16px_rgba(232,200,116,0.8)] hover:[--ui20-chamfer-bg:#F7DFA0] hover:[--ui20-chamfer-border:#FFE7AD]";
const GOLD_SECONDARY_BUTTON =
  "text-[#F0D690] [--ui20-chamfer-bg:#1D1E1D] [--ui20-chamfer-border:#8A7346] hover:text-[#FFF2C5] hover:[--ui20-chamfer-bg:#29251B] hover:[--ui20-chamfer-border:#E2BD69]";
const GOLD_OUTLINE_BUTTON =
  "text-[#D9C38A] [--ui20-chamfer-bg:#10151A] [--ui20-chamfer-border:#665840] hover:text-[#FFF1C6] hover:[--ui20-chamfer-border:#D2AE64]";

type OutputMode = "burn" | "retain" | "distribute";
type DistributionMode = "fixed" | "random";
type SplitShares = [number, number, number];
type SplitInputs = [string, string, string];
type SplitSelections = [boolean, boolean, boolean];
type BuyMode = "fixed-bnb" | "fixed-token" | "balance-percentage";
type TaskAction = "pause" | "resume" | "close";

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

interface PlazaVaultSnapshot {
  address: Address;
  owner: Address;
  token: Address;
  symbol: string;
  operationCount: number;
  runningCount: number;
  totalSpent: bigint;
  totalTokensOutput: bigint;
  decimals: number | null;
  creationIndex: number;
}

interface TaskSnapshot {
  address: Address;
  operationId: number;
  owner: Address;
  token: TokenInfo;
  buyMode: number;
  fixedBNBPerRound: bigint;
  fixedTokenAmountPerRound: bigint;
  balanceBps: number;
  maxBNBPerRound: bigint;
  minTokensPerBNB: bigint;
  interval: bigint;
  outputMode: number;
  outputSplit: SplitShares;
  pendingOutputSplit: SplitShares | null;
  randomRecipientCount: number;
  retainRecipient: Address;
  recipients: Address[];
  active: boolean;
  paused: boolean;
  started: boolean;
  bookingFeeOwed: bigint;
  bookingFee: bigint;
  triggerFee: bigint | null;
  totalFeeMultiplier: bigint | null;
  pendingRuleUpdate: TaskRuleUpdate | null;
  callbackInProgress: boolean;
  consecutiveFailures: number;
  triggerId: bigint;
  triggerFailed: boolean;
  vaultTriggerId: bigint;
  scheduledOperationId: bigint;
  pendingTokens: bigint;
  pendingOperationId: bigint;
  nextEligibleAt: bigint;
  reservedBNB: bigint;
  availableBNB: bigint;
  totalBNBSpent: bigint;
  totalTokensOutput: bigint;
  randomDistributionRounds: bigint;
  totalRandomHolders: bigint;
}

interface TaskOptions {
  targetToken: Address;
  minTokensPerBNB: bigint;
  interval: bigint;
  outputMode: number;
  randomRecipientCount: number;
  retainRecipient: Address;
  recipients: Address[];
}

interface TriggerRequestRead {
  requester: Address;
  executeAfter: bigint;
  status: number;
  feePaid: bigint;
}

interface TaskRuleUpdate {
  fixedBNBPerRound: bigint;
  fixedTokenAmountPerRound: bigint;
  balanceBps: number;
  maxBNBPerRound: bigint;
  interval: bigint;
  outputMode: number;
  randomRecipientCount: number;
  retainRecipient: Address;
  recipients: Address[];
}

interface VaultOperationRead extends TaskRuleUpdate {
  buyMode: number;
  minTokensPerBNB: bigint;
  active: boolean;
  paused: boolean;
  started: boolean;
  consecutiveFailures: number;
  nextEligibleAt: bigint;
  randomDistributionRounds: bigint;
  totalRandomHolders: bigint;
  totalBNBSpent: bigint;
  totalTokensOutput: bigint;
}

type TaskConfig =
  | { mode: "fixed-bnb"; options: TaskOptions; bnbPerRound: bigint }
  | { mode: "fixed-token"; options: TaskOptions; tokenAmountPerRound: bigint }
  | { mode: "balance-percentage"; options: TaskOptions; balanceBps: number; maxBNBPerRound: bigint };

type CreateTaskConfig = TaskConfig & { splitBps?: SplitShares };

function taskTotalBNB(task: TaskSnapshot) {
  return task.availableBNB + task.reservedBNB + task.bookingFeeOwed;
}

function triggerTradeMinimum(task: TaskSnapshot): bigint | null {
  if (task.triggerFee === null || task.totalFeeMultiplier === null) return null;
  return (task.triggerFee + task.bookingFee) * task.totalFeeMultiplier;
}

function feeGuardCause(task: TaskSnapshot): "round" | "cap" | null {
  const minimumTrade = triggerTradeMinimum(task);
  if (minimumTrade === null) return null;
  if (task.buyMode === 0 && task.fixedBNBPerRound < minimumTrade) return "round";
  if (task.buyMode === 2 && task.maxBNBPerRound > 0n && task.maxBNBPerRound < minimumTrade) return "cap";
  return null;
}

function canStartTask(task: TaskSnapshot) {
  if (!task.active || task.paused || task.started || task.callbackInProgress || task.pendingTokens > 0n) return false;
  const budget = task.availableBNB;
  if (task.buyMode === 0) return budget >= task.fixedBNBPerRound;
  if (task.buyMode === 1) return budget > 0n;
  return (budget * BigInt(task.balanceBps)) / 10_000n > 0n;
}

function taskStatusKey(task: TaskSnapshot) {
  if (!task.active) return "states.closed";
  if (task.paused) return "badges.paused";
  if (!task.started) return "states.awaitingStart";
  if (task.pendingTokens > 0n && task.pendingOperationId === BigInt(task.operationId)) return "states.pendingOutput";
  if (task.callbackInProgress) return "states.callbackRunning";
  if (task.triggerFailed) return "states.triggerFailed";
  if (task.triggerId) return task.consecutiveFailures ? "states.retryScheduled" : "states.scheduled";
  if (task.vaultTriggerId || task.pendingTokens > 0n) return "states.queued";
  if (feeGuardCause(task)) return "states.feeGuard";
  if (task.availableBNB === 0n || (task.buyMode === 0 && task.availableBNB < task.fixedBNBPerRound))
    return "states.needsFunding";
  if (task.buyMode === 0 && task.triggerFee !== null &&
      task.availableBNB < task.fixedBNBPerRound + task.triggerFee + task.bookingFee) return "states.needsFunding";
  return task.consecutiveFailures ? "states.retryNeeded" : "states.awaitingSchedule";
}

function taskKey(task: TaskSnapshot) {
  return `${task.address.toLowerCase()}:${task.operationId}`;
}

function parseAmount(value: string, decimals: number, t: (key: string) => string) {
  const amount = value.trim();
  if (!/^\d*(\.\d*)?$/.test(amount) || !/\d/.test(amount)) throw new Error(t("errors.amount"));
  if ((amount.split(".")[1]?.length ?? 0) > decimals) throw new Error(t("errors.amountPrecision"));
  try {
    return parseTokenAmount(amount, decimals);
  } catch {
    throw new Error(t("errors.amount"));
  }
}

function validBnbAmount(value: string, maximum?: bigint) {
  try {
    const amount = parseAmount(value, 18, (key) => key);
    return amount > 0n && (maximum === undefined || amount <= maximum);
  } catch {
    return false;
  }
}

function optionalBnbAmount(value: string): bigint | null {
  if (!value.trim()) return 0n;
  try {
    return parseAmount(value, 18, (key) => key);
  } catch {
    return null;
  }
}

function parseInterval(value: string, t: (key: string) => string) {
  if (!/^\d+$/.test(value.trim())) throw new Error(t("errors.interval"));
  const seconds = BigInt(value.trim()) * 60n;
  if (seconds < 60n || seconds > 2n ** 64n - 1n) throw new Error(t("errors.interval"));
  return seconds;
}

function shortAddress(address: Address) {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function outputFromValue(value: number): OutputMode {
  return value === 1 ? "retain" : value === 2 || value === 3 ? "distribute" : "burn";
}

function distributionFromValue(value: number): DistributionMode {
  return value === 3 ? "random" : "fixed";
}

function outputLabel(t: (key: string) => string, mode: OutputMode) {
  return mode === "burn" ? t("outputs.burn") : mode === "distribute" ? t("outputs.distribute") : t("outputs.retain");
}

function outputRuleLabel(t: (key: string) => string, value: number, shares?: SplitShares) {
  if (value === 4) return shares ? splitSummary(t, shares) : t("labels.outputSplit");
  const output = outputFromValue(value);
  if (output !== "distribute") return outputLabel(t, output);
  const distribution = distributionFromValue(value) === "random"
    ? t("outputs.randomDistribution")
    : t("outputs.fixedDistribution");
  return `${outputLabel(t, output)} · ${distribution}`;
}

function parseRandomHolderCount(value: string, t: (key: string) => string) {
  if (!/^\d+$/.test(value.trim())) throw new Error(t("errors.randomHolders"));
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(t("errors.randomHolders"));
  return count;
}

function validFixedRecipientsInput(value: string) {
  const recipients = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const unique = new Set(recipients.map((item) => item.toLowerCase()));
  return recipients.length >= 1 && recipients.length <= 5 && unique.size === recipients.length &&
    recipients.every((item) => isValidAddress(item) && item !== ZERO_ADDRESS);
}

function validRandomRecipientCount(value: string) {
  return /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 20;
}

function buyModeFromValue(value: number): BuyMode {
  return value === 1 ? "fixed-token" : value === 2 ? "balance-percentage" : "fixed-bnb";
}

function parsePercentageToBps(value: string, t: (key: string) => string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error(t("errors.percentage"));
  const [whole, fraction = ""] = value.trim().split(".");
  const bps = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new Error(t("errors.percentage"));
  return bps;
}

function parseOutputSplit(selected: SplitSelections, values: SplitInputs, t: (key: string) => string): SplitShares {
  const shares = values.map((value, index) => {
    if (!selected[index]) return 0;
    if (!/^\d+$/.test(value.trim())) throw new Error(t("errors.outputSplit"));
    const bps = Number(value.trim()) * 100;
    if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new Error(t("errors.outputSplit"));
    return bps;
  }) as SplitShares;
  if (shares[0] + shares[1] + shares[2] !== 10_000) throw new Error(t("errors.outputSplit"));
  return shares;
}

function validOutputSplit(selected: SplitSelections, values: SplitInputs, t: (key: string) => string) {
  try {
    parseOutputSplit(selected, values, t);
    return true;
  } catch {
    return false;
  }
}

function formatSplitShare(bps: number) {
  return String(Math.round(bps / 100));
}

function splitSummary(t: (key: string) => string, shares: SplitShares) {
  return [t("outputs.burn"), t("outputs.fixedDistribution"), t("outputs.randomDistribution")]
    .map((label, index) => shares[index] ? `${label} ${formatSplitShare(shares[index])}%` : "")
    .filter(Boolean)
    .join(" · ");
}

function percentageBpsOrNull(value: string): number | null {
  try {
    return parsePercentageToBps(value, (key) => key);
  } catch {
    return null;
  }
}

function minimumBalanceForPercentage(fee: bigint | null, minimumTrade: bigint | null, bps: number | null) {
  if (fee === null || minimumTrade === null || bps === null) return null;
  return fee + (minimumTrade * 10_000n + BigInt(bps) - 1n) / BigInt(bps);
}

function contractRevertReason(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const record = current as { reason?: unknown; shortMessage?: unknown; cause?: unknown };
    if (typeof record.reason === "string" && record.reason.trim()) return record.reason.trim();
    if (typeof record.shortMessage === "string") {
      const match = record.shortMessage.match(/reverted with the following reason:\s*([^\n]+)/i);
      if (match?.[1]) return match[1].trim();
    }
    current = record.cause;
  }
  return null;
}

function isOversizedGasError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const record = current as { message?: unknown; details?: unknown; cause?: unknown };
    if (
      [record.message, record.details].some(
        (value) => typeof value === "string" && /gas limit is too large/i.test(value),
      )
    )
      return true;
    current = record.cause;
  }
  return false;
}

class OnchainRevertError extends Error {
  constructor(readonly hash: Address) {
    super("execution reverted");
  }
}

function formatPercentage(bps: number) {
  return (bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%";
}

function buyModeLabel(t: (key: string) => string, mode: number) {
  const value = buyModeFromValue(mode);
  return value === "fixed-token"
    ? t("modes.tokenAmount")
    : value === "balance-percentage"
      ? t("modes.balanceShare")
      : t("modes.fixedBnb");
}

function taskRuleDetail(t: (key: string) => string, task: TaskSnapshot) {
  if (buyModeFromValue(task.buyMode) === "fixed-token") {
    return `${formatTokenAmount(task.fixedTokenAmountPerRound, task.token.decimals)} ${task.token.symbol}`;
  }
  if (buyModeFromValue(task.buyMode) === "balance-percentage") {
    return `${formatPercentage(task.balanceBps)} · ${task.maxBNBPerRound ? `${t("labels.bnbCeiling")} ${formatTokenAmount(task.maxBNBPerRound, 18)} BNB` : t("labels.noBnbCeiling")}`;
  }
  return `${formatTokenAmount(task.fixedBNBPerRound, 18)} BNB`;
}

function StatusBadge({
  children,
  muted = false,
  live = false,
}: {
  children: ReactNode;
  muted?: boolean;
  live?: boolean;
}) {
  return (
    <span
      data-live={live && !muted}
      className={
        "boost-status inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-semibold uppercase leading-none " +
        (muted
          ? "rounded-md border-[#41464A] bg-[#151B20] text-[#ACB4B4]"
          : "rounded-md border-[#806E48] bg-[#27251B] text-[#E8CE89]")
      }
    >
      {live && !muted ? <span aria-hidden="true" className="boost-signal" /> : null}
      {children}
    </span>
  );
}

function ErrorDialog({
  t,
  message,
  onDismiss,
}: {
  t: (key: string) => string;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-[#784343] bg-[#241416] px-4 py-3 text-sm text-[#F2C9C7]"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words leading-6">{message}</p>
      <button
        type="button"
        aria-label={t("buttons.dismiss")}
        className="rounded-md p-1 text-[#D9A4A1] hover:bg-[#432023]"
        onClick={onDismiss}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function OnchainProgressOverlay({
  t,
  state,
  visible,
}: {
  t: (key: string) => string;
  state: TxButtonState;
  visible: boolean;
}) {
  if (!visible || state === "idle" || state === "failed") return null;
  const title = t(
    state === "simulating"
      ? "states.simulatingOnchain"
      : state === "writing"
        ? "states.submittingOnchain"
        : "states.waitingCallback",
  );
  return (
    <div
      role="status"
      aria-live="polite"
      className="boost-progress-toast fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center gap-3 overflow-hidden rounded-xl border border-[#8B6919] bg-[#17160E]/95 p-4 shadow-[0_12px_48px_rgba(0,0,0,0.45)] backdrop-blur-lg"
    >
      <RefreshCw className="h-5 w-5 shrink-0 animate-spin text-[#F0B90B] motion-reduce:animate-none" />
      <div>
        <p className="text-sm font-semibold text-[#FFF0BC]">{title}</p>
        <p className="mt-0.5 text-xs text-[#B7AF91]">{t("states.waitingCallbackHint")}</p>
      </div>
    </div>
  );
}

export default function FlapBoostMiniApp(_props: VaultComponentProps) {
  const sdk = useFlapSdk();
  const { context, i18n } = sdk;
  const t = i18n.t;
  const [taskSnapshots, setTasks] = useState<TaskSnapshot[]>([]);
  const [triggerFeeSnapshot, setTriggerFeeSnapshot] = useState<{ chainId: number; fee: bigint | null } | null>(null);
  const [readState, setTaskReadState] = useState<"loading" | "disconnected" | "ready" | "error">("loading");
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const [activeView, setActiveView] = useState<"plaza" | "mine" | "create">("plaza");
  const [selectedTaskAddress, setSelectedTaskAddress] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"funds" | "rules">("funds");
  // Existing operations are the source of truth for the workspace. The host
  // context token is useful when creating a new operation, but it must not
  // hide a Vault that the connected wallet already owns for another token.
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxButtonState>("idle");
  const showCreateTask = activeView === "create";
  const [tokenAddressInput, setTokenAddressInput] = useState<string>(context.tokenAddress);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [minTokensPerBNB, setMinTokensPerBNB] = useState<bigint | null>(null);
  const [tokenLookupLoading, setTokenLookupLoading] = useState(false);
  const [buyMode, setBuyMode] = useState<BuyMode>("fixed-bnb");
  const [bnbPerRound, setBnbPerRound] = useState("0.01");
  const [tokenAmountPerRound, setTokenAmountPerRound] = useState("100000");
  const [balancePercentage, setBalancePercentage] = useState("25");
  const [maxBnbPerRound, setMaxBnbPerRound] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [outputMode, setOutputMode] = useState<OutputMode>("burn");
  const [splitSelected, setSplitSelected] = useState<SplitSelections>([true, false, false]);
  const [splitValues, setSplitValues] = useState<SplitInputs>(["100", "0", "0"]);
  const [distributionMode, setDistributionMode] = useState<DistributionMode>("fixed");
  const [retainRecipient, setRetainRecipient] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [randomRecipientCount, setRandomRecipientCount] = useState("5");
  const [fundingAmount, setFundingAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const requestRef = useRef(0);
  const actionLockRef = useRef(false);
  const loadedIdentityRef = useRef("");
  const tokenRequestRef = useRef(0);
  const loadedContextTokenRef = useRef("");

  const factoryAddress = useMemo(() => {
    const binding = context.manifest.match.bindings.find(
      (item) => item.chainId === context.chainId && item.factoryAddress && isValidAddress(item.factoryAddress),
    );
    if (binding?.factoryAddress) return binding.factoryAddress;
    if (context.chainId === 56 && context.factoryAddress !== ZERO_ADDRESS && isValidAddress(context.factoryAddress)) {
      return context.factoryAddress;
    }
    return null;
  }, [context.chainId, context.factoryAddress, context.manifest.match.bindings]);
  const portalAddress = useMemo(() => {
    const binding = context.manifest.match.bindings.find((item) => item.chainId === context.chainId);
    return binding?.externalContracts?.find((contract) => contract.label === "Flap Portal")?.address ?? null;
  }, [context.chainId, context.manifest.match.bindings]);
  const triggerAddress = useMemo(() => {
    const binding = context.manifest.match.bindings.find((item) => item.chainId === context.chainId);
    return binding?.externalContracts?.find((contract) => contract.label === "Flap Trigger")?.address ?? null;
  }, [context.chainId, context.manifest.match.bindings]);
  const actionStage: ActionAvailabilityStage = "both";
  const marketPhase = context.host?.marketPhase ?? "unknown";
  const actionsAvailable = isActionAvailableForPhase(actionStage, marketPhase);
  const wrongNetwork = sdk.wallet.isWrongNetwork;
  const splitOutputEnabled = context.chainId === 97;
  const readIdentity = `${context.chainId}:${factoryAddress}:${context.userAddress?.toLowerCase() ?? ""}`;
  const tasks = useMemo(
    () => (loadedIdentity === readIdentity ? taskSnapshots : []),
    [loadedIdentity, readIdentity, taskSnapshots],
  );
  const currentTriggerFee = triggerFeeSnapshot?.chainId === context.chainId ? triggerFeeSnapshot.fee : null;
  const creationFeeMultiplier = tasks.find((task) => task.totalFeeMultiplier !== null)?.totalFeeMultiplier
    ?? TOTAL_FEE_TRADE_MULTIPLIER;
  const creationTotalFee = currentTriggerFee === null ? null : currentTriggerFee + BOOKING_FEE;
  const creationMinimumTrade = creationTotalFee === null ? null : creationTotalFee * creationFeeMultiplier;
  const taskReadState = !context.userAddress ? "disconnected" : loadedIdentity === readIdentity ? readState : "loading";
  const canWrite = Boolean(
    context.userAddress && factoryAddress && taskReadState === "ready" && !wrongNetwork && activeAction === null,
  );
  const canTrade = canWrite && actionsAvailable;
  const tokenReady = Boolean(
    tokenInfo &&
      tokenInfo.address.toLowerCase() === tokenAddressInput.trim().toLowerCase() &&
      minTokensPerBNB !== null &&
      minTokensPerBNB > 0n &&
      !tokenLookupLoading,
  );
  const ownedTokens = useMemo(() => {
    const unique = new Map<string, TokenInfo>();
    for (const task of tasks) unique.set(task.token.address.toLowerCase(), task.token);
    return [...unique.values()];
  }, [tasks]);
  const activeTokenAddress =
    selectedTokenAddress === "" ? null : (selectedTokenAddress ?? ownedTokens[0]?.address ?? null);
  const tokenTasks = tasks.filter(
    (task) => activeTokenAddress && task.token.address.toLowerCase() === activeTokenAddress.toLowerCase(),
  );
  const hasExistingVaultForInput = ownedTokens.some(
    (token) => token.address.toLowerCase() === tokenAddressInput.trim().toLowerCase(),
  );
  const operationCountForInput = tasks.filter(
    (task) => task.token.address.toLowerCase() === tokenAddressInput.trim().toLowerCase(),
  ).length;
  const selectedTask = tokenTasks.find((task) => taskKey(task) === selectedTaskAddress) ?? tokenTasks[0] ?? null;
  const selectedTaskIsOwner = Boolean(
    selectedTask && context.userAddress && selectedTask.owner.toLowerCase() === context.userAddress.toLowerCase(),
  );
  const activeTaskCount = tasks.filter((task) => task.active && task.started && !task.paused).length;
  const visibleBNB = [
    ...new Map(tasks.map((task) => [task.address.toLowerCase(), taskTotalBNB(task)])).values(),
  ].reduce((sum, value) => sum + value, 0n);
  const visibleSpent = tasks.reduce((sum, task) => sum + task.totalBNBSpent, 0n);

  function beginCreateTask(mode: OutputMode) {
    setOutputMode(mode);
    setSplitSelected([true, false, false]);
    setSplitValues(["100", "0", "0"]);
    setDistributionMode("fixed");
    setActiveView("create");
    setRetainRecipient("");
    setRecipientsText("");
    if (activeTokenAddress) void loadToken(activeTokenAddress);
  }

  function selectToken(address: Address) {
    setSelectedTokenAddress(address);
    const first = tasks.find((task) => task.token.address.toLowerCase() === address.toLowerCase());
    setSelectedTaskAddress(first ? taskKey(first) : null);
    setDetailTab("funds");
    setActiveView("mine");
    setFundingAmount("");
    setWithdrawAmount("");
  }

  function selectTask(key: string) {
    setSelectedTaskAddress(key);
    setDetailTab("funds");
    setFundingAmount("");
    setWithdrawAmount("");
  }

  function beginNewToken() {
    setSelectedTokenAddress("");
    setSelectedTaskAddress(null);
    setActiveView("create");
    setOutputMode("burn");
    setSplitSelected([true, false, false]);
    setSplitValues(["100", "0", "0"]);
    setDistributionMode("fixed");
    setRetainRecipient("");
    setRecipientsText("");
    setRandomRecipientCount("5");
    setFundingAmount("");
    setWithdrawAmount("");
    const initialToken =
      !ownedTokens.length && context.tokenAddress !== ZERO_ADDRESS && isValidAddress(context.tokenAddress)
        ? context.tokenAddress
        : "";
    updateTokenAddress(initialToken);
    if (initialToken) void loadToken(initialToken);
  }

  function openMine() {
    if (selectedTokenAddress === "") setSelectedTokenAddress(null);
    setActiveView("mine");
  }

  const config = useMemo<CreateTaskConfig | Error>(() => {
    try {
      if (!isValidAddress(tokenAddressInput) || tokenAddressInput === ZERO_ADDRESS)
        throw new Error(t("errors.targetToken"));
      if (!tokenInfo || tokenInfo.address.toLowerCase() !== tokenAddressInput.toLowerCase())
        throw new Error(t("errors.loadTokenFirst"));
      if (!minTokensPerBNB) throw new Error(t("errors.priceFloor"));
      const interval = parseInterval(intervalMinutes, t);

      const recipients = recipientsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      let outputModeValue = 0;
      let randomCount = 0;
      let recipient = ZERO_ADDRESS;
      const splitBps = splitOutputEnabled ? parseOutputSplit(splitSelected, splitValues, t) : undefined;
      if (splitBps) {
        outputModeValue = 4;
        if (splitBps[1] > 0) {
          if (!validFixedRecipientsInput(recipientsText)) throw new Error(t("errors.fixedRecipients"));
        } else recipients.length = 0;
        if (splitBps[2] > 0) randomCount = parseRandomHolderCount(randomRecipientCount, t);
      } else if (outputMode === "retain") {
        if (!isValidAddress(retainRecipient.trim()) || retainRecipient.trim() === ZERO_ADDRESS)
          throw new Error(t("errors.retainWallet"));
        outputModeValue = 1;
        recipient = retainRecipient.trim() as Address;
      }
      if (!splitBps && outputMode === "distribute") {
        if (distributionMode === "random") {
          randomCount = parseRandomHolderCount(randomRecipientCount, t);
          recipients.length = 0;
          outputModeValue = 3;
        } else {
          const unique = new Set(recipients.map((value) => value.toLowerCase()));
          if (
            recipients.length < 1 ||
            recipients.length > 5 ||
            unique.size !== recipients.length ||
            recipients.some((value) => !isValidAddress(value) || value === ZERO_ADDRESS)
          ) {
            throw new Error(t("errors.fixedRecipients"));
          }
          outputModeValue = 2;
        }
      }
      const options: TaskOptions = {
        targetToken: tokenAddressInput as Address,
        minTokensPerBNB,
        interval,
        outputMode: outputModeValue,
        randomRecipientCount: randomCount,
        retainRecipient: recipient,
        recipients: recipients as Address[],
      };
      if (buyMode === "fixed-bnb") {
        const amount = parseAmount(bnbPerRound, 18, t);
        if (amount <= 0n) throw new Error(t("errors.amount"));
        if (creationMinimumTrade === null) throw new Error(t("errors.triggerFeeUnavailable"));
        if (amount < creationMinimumTrade) {
          throw new Error(t("errors.roundBelowTriggerMinimum", undefined, {
            amount: formatTokenAmount(creationMinimumTrade, 18, 18),
          }));
        }
        return { mode: buyMode, options, bnbPerRound: amount, splitBps };
      }
      if (buyMode === "fixed-token") {
        const tokenAmount = parseAmount(tokenAmountPerRound, tokenInfo.decimals, t);
        if (tokenAmount <= 0n) throw new Error(t("errors.amount"));
        return { mode: buyMode, options, tokenAmountPerRound: tokenAmount, splitBps };
      }
      const balanceBps = parsePercentageToBps(balancePercentage, t);
      const optionalMaxBNB = maxBnbPerRound.trim() ? parseAmount(maxBnbPerRound, 18, t) : 0n;
      if (optionalMaxBNB < 0n) throw new Error(t("errors.amount"));
      if (optionalMaxBNB > 0n) {
        if (creationMinimumTrade === null) throw new Error(t("errors.triggerFeeUnavailable"));
        if (optionalMaxBNB < creationMinimumTrade) {
          throw new Error(t("errors.capBelowTriggerMinimum", undefined, {
            amount: formatTokenAmount(creationMinimumTrade, 18, 18),
          }));
        }
      }
      return { mode: buyMode, options, balanceBps, maxBNBPerRound: optionalMaxBNB, splitBps };
    } catch (nextError) {
      return nextError instanceof Error ? nextError : new Error(t("errors.amount"));
    }
  }, [
    balancePercentage,
    bnbPerRound,
    buyMode,
    creationMinimumTrade,
    distributionMode,
    intervalMinutes,
    maxBnbPerRound,
    outputMode,
    recipientsText,
    randomRecipientCount,
    retainRecipient,
    splitOutputEnabled,
    splitSelected,
    splitValues,
    t,
    tokenAddressInput,
    tokenInfo,
    minTokensPerBNB,
    tokenAmountPerRound,
  ]);

  const updateTokenAddress = useCallback((value: string) => {
    tokenRequestRef.current += 1;
    setTokenAddressInput(value.trim());
    setTokenInfo(null);
    setMinTokensPerBNB(null);
    setTokenLookupLoading(false);
  }, []);

  const readPriceFloor = useCallback(
    async (targetToken: Address) => {
      if (!portalAddress) throw new Error(t("errors.priceFloor"));
      const quote = await sdk.readContract<bigint>({
        contract: "flapPortal",
        address: portalAddress,
        abi: portalAbi,
        functionName: "quoteExactInput",
        args: [{ inputToken: ZERO_ADDRESS, outputToken: targetToken, inputAmount: ONE_BNB }],
      });
      const priceFloor = (quote * PRICE_FLOOR_BPS) / BPS_DENOMINATOR;
      if (priceFloor <= 0n) throw new Error(t("errors.priceFloor"));
      return priceFloor;
    },
    [portalAddress, sdk, t],
  );

  const loadToken = useCallback(
    async (value: string) => {
      const token = value.trim();
      if (!isValidAddress(token)) {
        setError(t("errors.targetToken"));
        return;
      }
      const requestId = ++tokenRequestRef.current;
      setTokenAddressInput(token);
      setError(null);
      setTokenInfo(null);
      setMinTokensPerBNB(null);
      setTokenLookupLoading(true);
      try {
        const [symbol, decimals] = await Promise.all([
          sdk
            .readContract<string>({
              contract: "token",
              address: token as Address,
              abi: erc20Abi,
              functionName: "symbol",
            })
            .catch(() => "TOKEN"),
          sdk.readContract<number>({
            contract: "token",
            address: token as Address,
            abi: erc20Abi,
            functionName: "decimals",
          }),
        ]);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(t("errors.tokenMetadata"));
        const priceFloor = await readPriceFloor(token as Address);
        if (requestId !== tokenRequestRef.current) return;
        setTokenInfo({ address: token as Address, symbol: symbol || "TOKEN", decimals });
        setMinTokensPerBNB(priceFloor);
      } catch (nextError) {
        if (requestId !== tokenRequestRef.current) return;
        setTokenInfo(null);
        setMinTokensPerBNB(null);
        setError(handleTxError(nextError, { unknown: t("errors.priceFloor") }));
      } finally {
        if (requestId === tokenRequestRef.current) setTokenLookupLoading(false);
      }
    },
    [readPriceFloor, sdk, t],
  );

  const loadTasks = useCallback(async () => {
    const requestId = ++requestRef.current;
    setRefreshing(true);
    if (loadedIdentityRef.current !== readIdentity) setTaskReadState(context.userAddress ? "loading" : "disconnected");
    if (!factoryAddress || !context.userAddress) {
      setTasks([]);
      setSelectedTaskAddress(null);
      setTaskReadState(context.userAddress ? "error" : "disconnected");
      setLoadedIdentity(readIdentity);
      setRefreshing(false);
      return;
    }
    try {
      const [triggerFee, allVaultAddresses] = await Promise.all([
        triggerAddress
          ? sdk.readContract<bigint>({
              contract: "boostTrigger",
              address: triggerAddress,
              abi: triggerAbi,
              functionName: "getFee",
            }).catch(() => null)
          : Promise.resolve(null),
        sdk.readContract<Address[]>({
          contract: "boostFactory",
          address: factoryAddress,
          abi: factoryAbi,
          functionName: "vaultsOf",
          args: [context.userAddress],
        }),
      ]);
      if (requestId === requestRef.current) setTriggerFeeSnapshot({ chainId: context.chainId, fee: triggerFee });
      const vaultRows = await mapInBatches([...allVaultAddresses].reverse(), VAULT_READ_BATCH_SIZE, async (address) => {
        const [
          owner,
          targetToken,
          count,
          bookingFeeOwed,
          bookingFee,
          totalFeeMultiplier,
          callbackInProgress,
          triggerId,
          scheduledId,
          reservedBNB,
          availableBNB,
          pendingTokens,
          pendingOperationId,
        ] = await Promise.all([
          sdk.readContract<Address>({ contract: "boostVault", address, abi: vaultAbi, functionName: "owner" }),
          sdk.readContract<Address>({ contract: "boostVault", address, abi: vaultAbi, functionName: "targetToken" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "operationCount" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "bookingFeeOwed" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "BOOKING_FEE" }),
          sdk.readContract<bigint>({
            contract: "boostVault",
            address,
            abi: vaultAbi,
            functionName: "MIN_TOTAL_FEE_TRADE_MULTIPLIER",
          }).catch(() => null),
          sdk.readContract<boolean>({
            contract: "boostVault",
            address,
            abi: vaultAbi,
            functionName: "callbackInProgress",
          }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "triggerId" }),
          sdk.readContract<bigint>({
            contract: "boostVault",
            address,
            abi: vaultAbi,
            functionName: "scheduledOperationId",
          }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "reservedBNB" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "availableBNB" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "pendingTokens" }),
          sdk.readContract<bigint>({
            contract: "boostVault",
            address,
            abi: vaultAbi,
            functionName: "pendingOperationId",
          }),
        ]);
        const [symbol, decimals] = await Promise.all([
          sdk
            .readContract<string>({ contract: "token", address: targetToken, abi: erc20Abi, functionName: "symbol" })
            .catch(() => "TOKEN"),
          sdk.readContract<number>({
            contract: "token",
            address: targetToken,
            abi: erc20Abi,
            functionName: "decimals",
          }),
        ]);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(t("errors.tokenMetadata"));
        const triggerFailed = triggerId !== 0n && triggerAddress
          ? await sdk.readContract<TriggerRequestRead>({
              contract: "boostTrigger",
              address: triggerAddress,
              abi: triggerAbi,
              functionName: "getRequest",
              args: [triggerId],
            }).then((request) => request.requester.toLowerCase() === address.toLowerCase() && Number(request.status) === 2)
              .catch(() => false)
          : false;
        return {
          address,
          owner,
          token: { address: targetToken, symbol: symbol || "TOKEN", decimals },
          count: Number(count),
          bookingFeeOwed,
          bookingFee,
          totalFeeMultiplier,
          callbackInProgress,
          triggerId,
          triggerFailed,
          scheduledId,
          reservedBNB,
          availableBNB,
          pendingTokens,
          pendingOperationId,
        };
      });
      const positions = vaultRows.flatMap((vault) =>
        Array.from({ length: vault.count }, (_, id) => ({ vault, id })).reverse(),
      );
      const loaded = await mapInBatches(positions, OPERATION_READ_BATCH_SIZE, async ({ vault, id }) => {
        const operation = await sdk.readContract<VaultOperationRead>({
          contract: "boostVault",
          address: vault.address,
          abi: vaultAbi,
          functionName: "getOperation",
          args: [BigInt(id)],
        });
        const hasPending = await sdk.readContract<boolean>({
          contract: "boostVault",
          address: vault.address,
          abi: vaultAbi,
          functionName: "hasPendingRules",
          args: [BigInt(id)],
        });
        const pendingRuleUpdate = hasPending
          ? await sdk.readContract<TaskRuleUpdate>({
              contract: "boostVault",
              address: vault.address,
              abi: vaultAbi,
              functionName: "pendingRules",
              args: [BigInt(id)],
            })
          : null;
        const outputSplit: SplitShares = operation.outputMode === 4
          ? [...await sdk.readContract<SplitShares>({
              contract: "boostVault",
              address: vault.address,
              abi: vaultAbi,
              functionName: "outputSplit",
              args: [BigInt(id)],
            })] as SplitShares
          : [0, 0, 0];
        const pendingOutputSplit: SplitShares | null = pendingRuleUpdate?.outputMode === 4
          ? [...await sdk.readContract<SplitShares>({
              contract: "boostVault",
              address: vault.address,
              abi: vaultAbi,
              functionName: "pendingOutputSplit",
              args: [BigInt(id)],
            })] as SplitShares
          : null;
        return {
          address: vault.address,
          operationId: id,
          owner: vault.owner,
          token: vault.token,
          buyMode: operation.buyMode,
          fixedBNBPerRound: operation.fixedBNBPerRound,
          fixedTokenAmountPerRound: operation.fixedTokenAmountPerRound,
          balanceBps: operation.balanceBps,
          maxBNBPerRound: operation.maxBNBPerRound,
          minTokensPerBNB: operation.minTokensPerBNB,
          interval: operation.interval,
          outputMode: operation.outputMode,
          outputSplit,
          pendingOutputSplit,
          randomRecipientCount: operation.randomRecipientCount,
          retainRecipient: operation.retainRecipient,
          recipients: operation.recipients,
          active: operation.active,
          paused: operation.paused,
          started: operation.started,
          bookingFeeOwed: vault.bookingFeeOwed,
          bookingFee: vault.bookingFee,
          triggerFee,
          totalFeeMultiplier: vault.totalFeeMultiplier,
          pendingRuleUpdate,
          callbackInProgress: vault.callbackInProgress,
          consecutiveFailures: operation.consecutiveFailures,
          triggerId: vault.scheduledId === BigInt(id) ? vault.triggerId : 0n,
          triggerFailed: vault.scheduledId === BigInt(id) && vault.triggerFailed,
          vaultTriggerId: vault.triggerId,
          scheduledOperationId: vault.scheduledId,
          pendingTokens: vault.pendingTokens,
          pendingOperationId: vault.pendingOperationId,
          nextEligibleAt: operation.nextEligibleAt,
          reservedBNB: vault.reservedBNB,
          availableBNB: vault.availableBNB,
          totalBNBSpent: operation.totalBNBSpent,
          totalTokensOutput: operation.totalTokensOutput,
          randomDistributionRounds: operation.randomDistributionRounds,
          totalRandomHolders: operation.totalRandomHolders,
        } satisfies TaskSnapshot;
      });
      if (requestId !== requestRef.current) return;
      setTasks(loaded);
      loadedIdentityRef.current = readIdentity;
      setLoadedIdentity(readIdentity);
      setSelectedTokenAddress((current) => {
        // An empty selection is the deliberate “add another token” state.
        if (current === "") return current;
        if (current && loaded.some((task) => task.token.address.toLowerCase() === current.toLowerCase())) {
          return current;
        }
        // Do not keep a CA supplied by the host if it has no owned Vault.
        // Default to the first token reconstructed from on-chain operations.
        return loaded[0]?.token.address ?? null;
      });
      setSelectedTaskAddress((current) => {
        if (current && loaded.some((task) => taskKey(task) === current)) return current;
        return null;
      });
      setTaskReadState("ready");
    } catch {
      if (requestId === requestRef.current) {
        setTaskReadState("error");
        setLoadedIdentity(readIdentity);
        if (loadedIdentityRef.current !== readIdentity) {
          setTasks([]);
          setSelectedTaskAddress(null);
        }
      }
    } finally {
      if (requestId === requestRef.current) setRefreshing(false);
    }
  }, [context.chainId, context.userAddress, factoryAddress, readIdentity, sdk, t, triggerAddress]);

  useEffect(() => {
    if (activeView === "plaza") return;
    let stopped = false;
    let timer: number | undefined;
    const refresh = async () => {
      await loadTasks();
      if (!stopped) timer = window.setTimeout(() => void refresh(), 15_000);
    };
    void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [activeView, loadTasks, sdk.refetchNonce]);

  useEffect(() => {
    const identity = `${context.chainId}:${context.tokenAddress.toLowerCase()}`;
    if (loadedContextTokenRef.current === identity) return;
    loadedContextTokenRef.current = identity;
    setActiveView("plaza");
    setSelectedTokenAddress(null);
    setSelectedTaskAddress(null);
    updateTokenAddress(context.tokenAddress);
    if (context.tokenAddress !== ZERO_ADDRESS && isValidAddress(context.tokenAddress))
      void loadToken(context.tokenAddress);
  }, [context.chainId, context.tokenAddress, loadToken, updateTokenAddress]);

  const buttonState = (key: string): TxButtonState => (activeAction === key ? txState : "idle");
  const runAction = useCallback(
    async (key: string, operation: () => Promise<void>, message: string): Promise<boolean> => {
      if (actionLockRef.current) return false;
      actionLockRef.current = true;
      setError(null);
      setActiveAction(key);
      try {
        await operation();
        sdk.notify.success(message);
        await loadTasks();
        return true;
      } catch (nextError) {
        const kind = getTxErrorKind(nextError);
        const revertedHash = nextError instanceof OnchainRevertError ? nextError.hash : undefined;
        const oversizedGas = isOversizedGasError(nextError);
        const summary = oversizedGas
          ? t("errors.gasLimitTooLarge")
          : handleTxError(nextError, {
              userRejected: t("errors.walletRejected", t("errors.tx")),
              walletDisconnected: t("errors.walletDisconnected", t("errors.tx")),
              wrongNetwork: t("errors.wrongNetwork", t("errors.tx")),
              insufficientFunds: t("errors.insufficientWalletBalance", t("errors.tx")),
              simulationFailed: t("errors.simulation"),
              reverted: t(revertedHash ? "errors.reverted" : "errors.contractRejected", t("errors.tx")),
              unknown: t("errors.tx"),
            });
        const rawDetail = nextError instanceof Error ? nextError.message.split("\n")[0].trim() : "";
        const revertReason =
          (kind === "reverted" || kind === "simulationFailed") && !revertedHash
            ? contractRevertReason(nextError)
            : null;
        const localizedReason =
          revertReason === "Only owner"
            ? t("errors.onlyOwner")
            : revertReason === "Unavailable"
              ? t("errors.taskUnavailable")
              : revertReason === "No budget"
                ? t("errors.startFunds")
                : revertReason;
        let message = summary;
        if (oversizedGas) message = summary;
        else if (revertedHash) message = `${summary} ${revertedHash}`;
        else if (localizedReason) message = `${summary} · ${localizedReason.slice(0, 120)}`;
        else if ((kind === "unknown" || kind === "simulationFailed") && rawDetail)
          message = `${summary} · ${rawDetail.slice(0, 160)}`;
        setError(message);
        sdk.notify.error(message);
        setTxState("failed");
        return false;
      } finally {
        actionLockRef.current = false;
        setActiveAction(null);
        setTxState("idle");
      }
    },
    [loadTasks, sdk, t],
  );

  async function createTask() {
    if (!canTrade || !factoryAddress || !tokenReady || config instanceof Error || operationCountForInput >= 24) {
      if (config instanceof Error) setError(config.message);
      return;
    }
    await runAction(
      "create-task",
      async () => {
        setTxState("simulating");
        const freshFloor = await readPriceFloor(config.options.targetToken);
        const options = { ...config.options, minTokensPerBNB: freshFloor };
        setMinTokensPerBNB(freshFloor);
        const simulation = config.splitBps
          ? await sdk.simulateContract({
              contract: "boostFactory",
              address: factoryAddress,
              abi: factoryAbi,
              functionName: "createSplitOperation",
              args: [
                options,
                config.mode === "fixed-bnb" ? 0 : config.mode === "fixed-token" ? 1 : 2,
                config.mode === "fixed-bnb" ? config.bnbPerRound
                  : config.mode === "fixed-token" ? config.tokenAmountPerRound : 0n,
                config.mode === "balance-percentage" ? config.balanceBps : 0,
                config.mode === "balance-percentage" ? config.maxBNBPerRound : 0n,
                config.splitBps,
              ],
              gas: CREATE_OPERATION_GAS,
            })
          : config.mode === "fixed-bnb"
            ? await sdk.simulateContract({
                contract: "boostFactory",
                address: factoryAddress,
                abi: factoryAbi,
                functionName: "createFixedBNBOperation",
                args: [options, config.bnbPerRound],
                gas: CREATE_OPERATION_GAS,
              })
            : config.mode === "fixed-token"
              ? await sdk.simulateContract({
                  contract: "boostFactory",
                  address: factoryAddress,
                  abi: factoryAbi,
                  functionName: "createFixedTokenAmountOperation",
                  args: [options, config.tokenAmountPerRound],
                  gas: CREATE_OPERATION_GAS,
                })
              : await sdk.simulateContract({
                  contract: "boostFactory",
                  address: factoryAddress,
                  abi: factoryAbi,
                  functionName: "createBalancePercentageOperation",
                  args: [options, config.balanceBps, config.maxBNBPerRound],
                  gas: CREATE_OPERATION_GAS,
                });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
        setSelectedTokenAddress(config.options.targetToken);
        setSelectedTaskAddress(null);
        setDetailTab("funds");
        setActiveView("mine");
      },
      t(hasExistingVaultForInput ? "messages.taskCreated" : "messages.vaultCreated"),
    );
  }

  async function fundTask() {
    if (!canWrite || !selectedTask) return;
    try {
      const amount = parseAmount(fundingAmount, 18, t);
      if (amount <= 0n) throw new Error(t("errors.funding"));
      const startWithFunding = selectedTaskIsOwner && selectedTask.active && !selectedTask.paused && !selectedTask.started;
      await runAction(
        "fund:" + selectedTask.address,
        async () => {
          setTxState("simulating");
          const simulation = await sdk.simulateContract({
            contract: "boostVault",
            address: selectedTask.address,
            abi: vaultAbi,
            functionName: startWithFunding ? "fundAndTryStart" : "fund",
            args: startWithFunding ? [BigInt(selectedTask.operationId)] : [],
            value: amount,
            gas: startWithFunding ? FUND_AND_START_GAS : FUND_GAS,
          });
          setTxState("writing");
          const hash = await sdk.writeContract(simulation.request);
          setTxState("confirming");
          if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
          setFundingAmount("");
        },
        t(startWithFunding ? "messages.taskFundedAndMaybeStarted" : "messages.taskFunded"),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("errors.funding"));
    }
  }

  async function withdrawTask() {
    if (!canWrite || !selectedTask || !selectedTaskIsOwner) return;
    try {
      const amount = parseAmount(withdrawAmount, 18, t);
      if (amount <= 0n || amount > selectedTask.availableBNB) throw new Error(t("errors.withdraw"));
      await runAction(
        "withdraw:" + selectedTask.address,
        async () => {
          setTxState("simulating");
          const simulation = await sdk.simulateContract({
            contract: "boostVault",
            address: selectedTask.address,
            abi: vaultAbi,
            functionName: "withdraw",
            args: [amount],
          });
          setTxState("writing");
          const hash = await sdk.writeContract(simulation.request);
          setTxState("confirming");
          if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
          setWithdrawAmount("");
        },
        t("messages.withdrawn"),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("errors.withdraw"));
    }
  }

  async function controlTask(action: TaskAction) {
    if (!canWrite || !selectedTask || !selectedTaskIsOwner) return;
    const message =
      action === "pause"
        ? t("messages.paused")
        : action === "resume"
          ? t("messages.resumed")
          : t("messages.taskClosed");
    await runAction(
      action + ":" + selectedTask.address,
      async () => {
        setTxState("simulating");
        const simulation = await sdk.simulateContract({
          contract: "boostVault",
          address: selectedTask.address,
          abi: vaultAbi,
          functionName:
            action === "pause" ? "pauseOperation" : action === "resume" ? "resumeOperation" : "closeOperation",
          args: [BigInt(selectedTask.operationId)],
        });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
      },
      message,
    );
  }

  async function checkAndSchedule() {
    if (!canWrite || !selectedTask) return;
    const starting = !selectedTask.started;
    if (starting && !canTrade) return;
    if (starting && (!selectedTaskIsOwner || !canStartTask(selectedTask))) {
      setError(t("errors.startFunds"));
      return;
    }
    await runAction(
      (starting ? "start:" : "poke:") + selectedTask.address,
      async () => {
        setTxState("simulating");
        const simulation = await sdk.simulateContract({
          contract: "boostVault",
          address: selectedTask.address,
          abi: vaultAbi,
          functionName: starting ? "startOperation" : "poke",
          args: starting ? [BigInt(selectedTask.operationId)] : [],
        });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
      },
      t(starting ? "messages.started" : "messages.checked"),
    );
  }

  async function updateTaskRules(task: TaskSnapshot, update: TaskRuleUpdate, splitBps?: SplitShares): Promise<boolean> {
    if (!canWrite || !selectedTaskIsOwner || !task.active) return false;
    return runAction(
      "rules:" + task.address,
      async () => {
        setTxState("simulating");
        const simulation = await sdk.simulateContract({
          contract: "boostVault",
          address: task.address,
          abi: vaultAbi,
          functionName: splitBps ? "updateSplitOperation" : "updateOperation",
          args: splitBps ? [BigInt(task.operationId), update, splitBps] : [BigInt(task.operationId), update],
        });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
      },
      t("messages.rulesUpdated"),
    );
  }

  async function settleOutput() {
    if (!canWrite || !selectedTask || selectedTask.pendingTokens === 0n) return;
    await runAction(
      "settle:" + selectedTask.address,
      async () => {
        setTxState("simulating");
        const simulation = await sdk.simulateContract({
          contract: "boostVault",
          address: selectedTask.address,
          abi: vaultAbi,
          functionName: "settlePendingOutput",
        });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
      },
      t("messages.outputRetried"),
    );
  }

  async function recoverTrigger() {
    if (!canWrite || !selectedTask || !selectedTaskIsOwner || !selectedTask.triggerFailed) return;
    await runAction(
      "recover:" + selectedTask.address,
      async () => {
        setTxState("simulating");
        const simulation = await sdk.simulateContract({
          contract: "boostVault",
          address: selectedTask.address,
          abi: vaultAbi,
          functionName: "recoverFailedTrigger",
        });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        if ((await sdk.waitForTx(hash)).status !== "success") throw new OnchainRevertError(hash);
      },
      t("messages.triggerRecovered"),
    );
  }

  const previewHasToken = tokenReady;
  const previewTokenSymbol = previewHasToken && tokenInfo ? tokenInfo.symbol : t("labels.tokenPending");
  const previewRule =
    buyMode === "fixed-bnb"
      ? `${bnbPerRound || "—"} BNB`
      : buyMode === "fixed-token"
        ? `${tokenAmountPerRound || "—"} ${previewHasToken ? previewTokenSymbol : ""}`.trim()
        : `${balancePercentage || "—"}%`;
  return (
    <div
      data-busy={activeAction !== null}
      data-motion-paused={motionPaused}
      className="flap-boost-app mx-auto min-h-screen w-full max-w-[1080px] px-2 pb-8 pt-2 sm:px-4 sm:pt-4"
    >
      <BoostMotionStyles />
      <OnchainProgressOverlay t={t} state={txState} visible={activeAction !== null} />
      <Card className="flap-boost-shell overflow-hidden rounded-[20px]">
        <CardHeader className="boost-header px-5 pb-5 pt-6 sm:px-8 sm:pb-6 sm:pt-7">
          <div className="boost-atmosphere" aria-hidden="true">
            <span className="boost-aura boost-aura-blue" />
            <span className="boost-aura boost-aura-gold" />
            <span className="boost-grid" />
            <span className="boost-atmosphere-beam boost-atmosphere-beam-one" />
            <span className="boost-atmosphere-beam boost-atmosphere-beam-two" />
            <span className="boost-atmosphere-current" />
            <span className="boost-hero-corner boost-hero-corner-tl" />
            <span className="boost-hero-corner boost-hero-corner-tr" />
            <span className="boost-hero-corner boost-hero-corner-bl" />
            <span className="boost-hero-corner boost-hero-corner-br" />
            <span className="boost-motes">
              {Array.from({ length: 10 }, (_, index) => <span key={index} />)}
            </span>
            <span className="boost-spark boost-spark-one" />
            <span className="boost-spark boost-spark-two" />
            <span className="boost-spark boost-spark-three" />
          </div>
          <div className="boost-hero-layout">
            <div key={activeView} className="boost-hero-copy min-w-0">
              <div className="boost-kicker">
                <span className="boost-kicker-dot" />
                <span>FLAP BOOST</span>
              </div>
              <CardTitle className="boost-hero-title mt-4 text-[30px] font-semibold leading-tight tracking-tight sm:text-[40px]">
                {t(activeView === "plaza" ? "plaza.heroTitle" : activeView === "create" ? "sections.createVault" : "sections.tokenWorkspace")}
              </CardTitle>
              <p className="boost-hero-description mt-3 max-w-xl text-sm leading-6 text-[#C4C6C2]">
                {t(activeView === "plaza" ? "plaza.heroSubtitle" : activeView === "create" ? "nav.createHint" : "nav.mineHint")}
              </p>
              {activeView === "create" ? <div className="boost-hero-steps mt-4" aria-label={t("sections.engine")}>
                <span><b>01</b>{t("workflow.create")}</span>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                <span><b>02</b>{t("workflow.fund")}</span>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                <span><b>03</b>{t("workflow.execute")}</span>
              </div> : null}
            </div>
            <div className="boost-hero-side" aria-hidden="true">
              <div className="boost-cycle">
                <span className="boost-cycle-track boost-cycle-track-outer" />
                <span className="boost-cycle-track boost-cycle-track-inner" />
                <span className="boost-cycle-sweep" />
                <span className="boost-cycle-packet boost-cycle-packet-one" />
                <span className="boost-cycle-packet boost-cycle-packet-two" />
                <span className="boost-cycle-packet boost-cycle-packet-three" />
                <span className="boost-cycle-trace boost-cycle-trace-one" />
                <span className="boost-cycle-trace boost-cycle-trace-two" />
                <span className="boost-cycle-node boost-cycle-node-bnb"><CircleDollarSign className="h-5 w-5" /></span>
                <span className="boost-cycle-node boost-cycle-node-token"><Coins className="h-5 w-5" /></span>
                <span className="boost-cycle-node boost-cycle-node-output"><Flame className="h-5 w-5" /></span>
                <span className="boost-cycle-center">
                  <span className="boost-emblem-core">
                    <span className="boost-wing boost-wing-upper-left" />
                    <span className="boost-wing boost-wing-upper-right" />
                    <span className="boost-wing boost-wing-lower-left" />
                    <span className="boost-wing boost-wing-lower-right" />
                    <span className="boost-wing-body" />
                  </span>
                </span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="boost-content space-y-4 px-3 pb-4 pt-4 sm:px-6 sm:pb-6 sm:pt-5">
          <nav className="boost-view-tabs grid grid-cols-2 gap-2" aria-label={t("plaza.viewLabel")}>
            <button type="button" aria-pressed={activeView === "plaza"} className="boost-view-tab" onClick={() => setActiveView("plaza")}>
              <span className="boost-view-tab-index">01</span>
              <span className="boost-view-tab-copy"><strong>{t("plaza.tab")}</strong></span>
              <ChevronRight className="boost-view-tab-arrow h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" aria-pressed={activeView !== "plaza"} className="boost-view-tab" onClick={openMine}>
              <span className="boost-view-tab-index">02</span>
              <span className="boost-view-tab-copy"><strong>{t("nav.mine")}</strong></span>
              <ChevronRight className="boost-view-tab-arrow h-4 w-4" aria-hidden="true" />
            </button>
          </nav>
          {activeView === "plaza" ? (
            <BuybackPlaza
              factoryAddress={factoryAddress}
              onCreate={beginNewToken}
            />
          ) : (
          <>
          {wrongNetwork ? (
            <Alert tone="warning">
              {t("states.wrongNetwork", undefined, { chain: sdk.wallet.requiredChainLabel })}
              {sdk.wallet.canSwitchChain ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={GOLD_OUTLINE_BUTTON + " ml-3 h-9 px-3 text-xs"}
                  disabled={sdk.wallet.isSwitchingChain || activeAction !== null}
                  onClick={() => void sdk.wallet.switchChain().catch((nextError) => setError(handleTxError(nextError)))}
                >
                  {t("buttons.switchNetwork")}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {!actionsAvailable ? <Alert tone="warning">{t("states.actionsUnavailable")}</Alert> : null}
          {error ? <ErrorDialog t={t} message={error} onDismiss={() => setError(null)} /> : null}
          {taskReadState === "error" && tasks.length > 0 ? <Alert tone="warning">{t("states.staleRead")}</Alert> : null}

          {activeView === "mine" && context.userAddress && tasks.length > 0 ? (
            <section
              aria-label={t("sections.vaultOverview")}
              className="rounded-xl border border-[#394148] bg-[#0E141A]/70 py-2"
            >
              <div className="flap-boost-metrics grid grid-cols-2 gap-y-2 sm:grid-cols-4">
                <Metric label={t("labels.totalBnbBalance")} value={formatTokenAmount(visibleBNB, 18)} hint="BNB" />
                <Metric label={t("labels.bnbConsumed")} value={formatTokenAmount(visibleSpent, 18)} hint="BNB" />
                <Metric label={t("labels.activeTasks")} value={String(activeTaskCount)} hint={t("labels.tasks")} />
                <Metric
                  label={t("labels.createdCas")}
                  value={String(ownedTokens.length)}
                  hint={t("labels.distinctTokens")}
                />
              </div>
            </section>
          ) : null}

          <section className="flap-boost-workspace relative overflow-hidden rounded-2xl">
            {activeView === "mine" ? <div className="boost-workspace-header flex items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5">
              <div className="flex items-center gap-3 text-base font-semibold text-[#F6F1E8]">
                <span className="boost-workspace-icon flex h-9 w-9 items-center justify-center rounded-xl">
                  <Settings2 className="h-4 w-4" />
                </span>
                {t("sections.tokenWorkspace")}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={motionPaused}
                  aria-label={t(motionPaused ? "buttons.resumeMotion" : "buttons.pauseMotion")}
                  title={t(motionPaused ? "buttons.resumeMotion" : "buttons.pauseMotion")}
                  className="boost-motion-toggle h-9 rounded-lg px-2.5 text-xs"
                  onClick={() => setMotionPaused((value) => !value)}
                >
                  {motionPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 rounded-lg px-3 text-xs text-[#ABCAC8] hover:bg-[#13262A] hover:text-[#DDFEFB]"
                  onClick={() => void loadTasks()}
                  disabled={refreshing || activeAction !== null || !context.userAddress}
                >
                  <RefreshCw
                    className={"h-3.5 w-3.5 " + (refreshing ? "animate-spin motion-reduce:animate-none" : "")}
                  />
                  {t("buttons.refresh")}
                </Button>
                {activeTokenAddress ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={GOLD_SECONDARY_BUTTON + " h-10 flex-1 rounded-lg px-4 text-xs sm:flex-none"}
                    onClick={() => beginCreateTask("burn")}
                    disabled={activeAction !== null || tokenTasks.length >= 24}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("buttons.addOperation")}
                  </Button>
                ) : null}
                {ownedTokens.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    className={GOLD_PRIMARY_BUTTON + " h-10 rounded-lg px-4 text-xs"}
                    onClick={beginNewToken}
                    disabled={activeAction !== null}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("nav.create")}
                  </Button>
                ) : null}
              </div>
            </div> : null}
            {activeView === "mine" && ownedTokens.length ? (
              <div className="space-y-4 px-4 pb-4 pt-4 sm:px-5">
                <div className="flex flex-wrap gap-2" role="group" aria-label={t("labels.selectToken")}>
                  {ownedTokens.map((token) => {
                    const count = tasks.filter(
                      (task) => task.token.address.toLowerCase() === token.address.toLowerCase(),
                    ).length;
                    const selected = activeTokenAddress?.toLowerCase() === token.address.toLowerCase();
                    return (
                      <button
                        key={token.address}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => selectToken(token.address)}
                        className={
                          "boost-token rounded-lg border px-3 py-2 text-left text-sm transition " +
                          (selected
                            ? "border-[#64C7C2] bg-[#38342A] text-[#F7F0DE]"
                            : "border-[#30484E] bg-[#0A151A] text-[#A8C2C1] hover:border-[#5C9291]")
                        }
                      >
                        <span className="font-semibold">{token.symbol}</span>
                        <span className="ml-2 text-xs opacity-75">
                          {t("labels.operationCount", undefined, { count })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {showCreateTask ? (
              <div className="flap-boost-form-reveal mx-4 mb-5 mt-4 overflow-hidden rounded-2xl sm:mx-6">
                <div className="boost-vault-panel-head flex items-center justify-between gap-3 border-b border-[#67583B] px-4 py-4 sm:px-6">
                  <div className="relative z-10 min-w-0 flex-1">
                    <p className="boost-vault-eyebrow text-[10px] font-bold tracking-[0.2em] text-[#E7CC87]">
                      {t(hasExistingVaultForInput ? "labels.existingVault" : "labels.newVault")}
                    </p>
                    <h2 className="mt-2 text-lg font-semibold tracking-tight text-[#FFF3D9] sm:text-[22px]">
                      {t(hasExistingVaultForInput ? "sections.newOperation" : "sections.createVault")}
                    </h2>
                    <p className="mt-1 max-w-lg text-xs leading-5 text-[#B8B9AE] sm:text-[13px]">
                      {t(hasExistingVaultForInput ? "help.existingTokenCreate" : "help.newVaultCreate")}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="relative z-10 self-start px-2 text-xs text-[#BDB9AB]" onClick={openMine}>
                    <X className="h-4 w-4" />
                    {t("buttons.cancel")}
                  </Button>
                </div>
                <div className="px-4 sm:px-6">
                  <TaskForm
                    t={t}
                    tokenAddress={tokenAddressInput}
                    setTokenAddress={updateTokenAddress}
                    lockedToken={Boolean(activeTokenAddress)}
                    tokenInfo={tokenInfo}
                    minTokensPerBNB={minTokensPerBNB}
                    tokenReady={tokenReady}
                    isLoadingToken={tokenLookupLoading}
                    onLoadToken={() => void loadToken(tokenAddressInput)}
                    buyMode={buyMode}
                    setBuyMode={setBuyMode}
                    minimumTrade={creationMinimumTrade}
                    totalFee={creationTotalFee}
                    feeMultiplier={creationFeeMultiplier}
                    bnbPerRound={bnbPerRound}
                    setBnbPerRound={setBnbPerRound}
                    tokenAmountPerRound={tokenAmountPerRound}
                    setTokenAmountPerRound={setTokenAmountPerRound}
                    balancePercentage={balancePercentage}
                    setBalancePercentage={setBalancePercentage}
                    maxBnbPerRound={maxBnbPerRound}
                    setMaxBnbPerRound={setMaxBnbPerRound}
                    intervalMinutes={intervalMinutes}
                    setIntervalMinutes={setIntervalMinutes}
                    outputMode={outputMode}
                    setOutputMode={setOutputMode}
                    splitOutputEnabled={splitOutputEnabled}
                    splitSelected={splitSelected}
                    setSplitSelected={setSplitSelected}
                    splitValues={splitValues}
                    setSplitValues={setSplitValues}
                    distributionMode={distributionMode}
                    setDistributionMode={setDistributionMode}
                    retainRecipient={retainRecipient}
                    setRetainRecipient={setRetainRecipient}
                    recipientsText={recipientsText}
                    setRecipientsText={setRecipientsText}
                    randomRecipientCount={randomRecipientCount}
                    setRandomRecipientCount={setRandomRecipientCount}
                  />
                </div>
                {tokenReady ? <div className="boost-route-preview mx-4 mb-4 overflow-hidden py-4 sm:mx-6">
                  <div className="relative z-10 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="text-xs font-semibold tracking-[0.08em] text-[#F3D99A]">{t("sections.rulePreview")}</p>
                    <p className="text-[11px] text-[#9BA5A4]">{t("help.rulePreview")}</p>
                  </div>
                  <div className="boost-route-grid relative z-10 mt-3 grid grid-cols-[minmax(0,1fr)_18px_minmax(0,1fr)_18px_minmax(0,1fr)] items-center gap-1 sm:grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)_36px_minmax(0,1fr)] sm:gap-2">
                    <div className="boost-route-node min-w-0">
                      <span className="boost-route-icon"><Gauge className="h-4 w-4" /></span>
                      <span className="boost-route-caption">{t("labels.roundRule")}</span>
                      <strong className="boost-route-value" title={previewRule}>{previewRule}</strong>
                    </div>
                    <span className="boost-route-link" aria-hidden="true"><i /></span>
                    <div className="boost-route-node min-w-0">
                      <span className="boost-route-icon"><Coins className="h-4 w-4" /></span>
                      <span className="boost-route-caption">{t("labels.targetToken")}</span>
                      <strong className="boost-route-value" title={previewTokenSymbol}>{previewTokenSymbol}</strong>
                    </div>
                    <span className="boost-route-link boost-route-link-late" aria-hidden="true"><i /></span>
                    <div className="boost-route-node min-w-0">
                      <span className="boost-route-icon">{splitOutputEnabled ? <Coins className="h-4 w-4" /> : outputMode === "burn" ? <Flame className="h-4 w-4" /> : outputMode === "retain" ? <Wallet className="h-4 w-4" /> : <Coins className="h-4 w-4" />}</span>
                      <span className="boost-route-caption">{t("labels.output")}</span>
                      <strong className="boost-route-value" title={splitOutputEnabled ? t("labels.outputSplit") : outputLabel(t, outputMode)}>{splitOutputEnabled ? t("labels.outputSplit") : outputLabel(t, outputMode)}</strong>
                    </div>
                  </div>
                  <p className="relative z-10 mt-3 text-[11px] text-[#A8A89F]">
                    {t("labels.interval")} · {intervalMinutes || "—"} {t("labels.minutes")}
                    {splitOutputEnabled && !(config instanceof Error) && config.splitBps
                      ? ` · ${splitSummary(t, config.splitBps)}` : ""}
                  </p>
                </div> : null}
                <div className="flex flex-col gap-3 border-t border-[#39484A] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <div className="min-w-0 text-xs leading-5 text-[#9AB6B5]">
                    <p>{t("help.createThenFund")}</p>
                    {operationCountForInput >= 24 ? (
                      <p className="mt-1 text-[#E9BC77]">{t("errors.operationLimit")}</p>
                    ) : tokenReady && config instanceof Error ? (
                      <p className="mt-1 text-[#E9BC77]">{config.message}</p>
                    ) : null}
                    {!context.userAddress ? <p className="mt-1">{t("help.connectToCreate")}</p> : null}
                  </div>
                  <TxButton
                    className={GOLD_PRIMARY_BUTTON + " h-11 w-full rounded-lg px-6 text-sm sm:w-auto"}
                    idleLabel={t(hasExistingVaultForInput ? "buttons.createTask" : "buttons.createVault")}
                    state={buttonState("create-task")}
                    onClick={() => void createTask()}
                    disabled={!canTrade || !tokenReady || config instanceof Error || operationCountForInput >= 24}
                  />
                </div>
              </div>
            ) : null}

            {activeView === "mine" ? <div className="px-4 pb-4 sm:px-5 sm:pb-5">
              {tokenTasks.length ? (
                <p className="mb-3 text-sm font-semibold text-[#F5F0E5]">{t("sections.tokenOperations")}</p>
              ) : null}
              <TaskList
                key={activeTokenAddress ?? "no-token"}
                t={t}
                tasks={tokenTasks}
                selectedTaskAddress={selectedTask ? taskKey(selectedTask) : null}
                onSelect={selectTask}
              />
              {!tokenTasks.length && !showCreateTask ? (
                <div className="boost-empty flex flex-col items-center gap-4 rounded-2xl px-5 py-10 text-center sm:flex-row sm:px-7 sm:py-9 sm:text-left">
                  <span className="boost-empty-seal shrink-0" aria-hidden="true">
                    <span className="boost-empty-seal-ring boost-empty-seal-ring-outer" />
                    <span className="boost-empty-seal-ring boost-empty-seal-ring-inner" />
                    <span className="boost-empty-seal-ray boost-empty-seal-ray-one" />
                    <span className="boost-empty-seal-ray boost-empty-seal-ray-two" />
                    <span className="boost-empty-icon flex h-14 w-14 items-center justify-center rounded-2xl">
                      {taskReadState === "loading" ? (
                        <RefreshCw className="h-6 w-6 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Coins className="h-6 w-6" strokeWidth={1.5} />
                      )}
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-semibold text-[#F6F1E8]">
                      {t(taskReadState === "loading" ? "states.loadingTasks" : taskReadState === "error" ? "states.taskReadFailed" : "states.emptyTitle")}
                    </p>
                    <p className="mt-1 max-w-xl text-xs leading-6 text-[#A9AAA8]">
                      {t(taskReadState === "loading" || taskReadState === "error" ? "states.readStateHint" : "help.emptyIntro")}
                    </p>
                    {!context.userAddress && taskReadState !== "loading" ? (
                      <p className="mt-2 text-xs text-[#D9BD79]">{t("states.connectWalletToRead")}</p>
                    ) : null}
                  </div>
                  {taskReadState === "error" ? (
                    <Button type="button" variant="outline" size="sm" className={GOLD_OUTLINE_BUTTON + " h-10 px-4 text-xs"} disabled={refreshing} onClick={() => void loadTasks()}>{t("buttons.retry")}</Button>
                  ) : taskReadState !== "loading" ? (
                    <Button type="button" size="sm" className={GOLD_PRIMARY_BUTTON + " h-11 shrink-0 px-5 text-sm"} onClick={beginNewToken} disabled={activeAction !== null}>
                      {t("buttons.setupBuyback")}<ChevronRight className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div> : null}
          </section>

          {selectedTask && !showCreateTask ? (
            <section className="boost-management mx-4 space-y-3 sm:mx-5" aria-label={t("nav.detailLabel")}>
              <div className="boost-detail-tabs flex items-center gap-1 rounded-xl border border-[#514832] bg-[#090D12] p-1" role="group" aria-label={t("nav.detailLabel")}>
                <button type="button" aria-pressed={detailTab === "funds"} className="boost-view-tab flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold" onClick={() => setDetailTab("funds")}>{t("nav.funds")}</button>
                <button type="button" aria-pressed={detailTab === "rules"} className="boost-view-tab flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold" onClick={() => setDetailTab("rules")}>{t("nav.rules")}</button>
              </div>
              {detailTab === "funds" ? <TaskFunding
                key={taskKey(selectedTask)}
                t={t}
                task={selectedTask}
                canWrite={canWrite}
                canTrade={canTrade}
                hasActiveOperations={tokenTasks.some((task) => task.active)}
                isOwner={selectedTaskIsOwner}
                fundingAmount={fundingAmount}
                setFundingAmount={setFundingAmount}
                withdrawAmount={withdrawAmount}
                setWithdrawAmount={setWithdrawAmount}
                buttonState={buttonState}
                onFund={() => void fundTask()}
                onWithdraw={() => void withdrawTask()}
                onSetWithdrawMax={() => setWithdrawAmount(formatTokenAmount(selectedTask.availableBNB, 18, 18))}
                onPause={() => void controlTask("pause")}
                onResume={() => void controlTask("resume")}
                onClose={() => void controlTask("close")}
                onCheck={() => void checkAndSchedule()}
                onSettle={() => void settleOutput()}
                onRecover={() => void recoverTrigger()}
              /> : <TaskOverview
                key={taskKey(selectedTask)}
                t={t}
                locale={i18n.locale}
                task={selectedTask}
                canWrite={canWrite}
                isOwner={selectedTaskIsOwner}
                buttonState={buttonState("rules:" + selectedTask.address)}
                onUpdate={(update, splitBps) => updateTaskRules(selectedTask, update, splitBps)}
              />}
            </section>
          ) : null}
          </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BuybackPlaza({ factoryAddress, onCreate }: { factoryAddress: Address | null; onCreate: () => void }) {
  const sdk = useFlapSdk();
  const t = sdk.i18n.t;
  const [vaults, setVaults] = useState<PlazaVaultSnapshot[]>([]);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [totalVaultCount, setTotalVaultCount] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const nextOffsetRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  const projects = useMemo(() => [...vaults].sort((a, b) =>
    a.runningCount !== b.runningCount ? b.runningCount - a.runningCount : b.creationIndex - a.creationIndex,
  ), [vaults]);
  const searchTerm = searchQuery.trim().toLowerCase();
  const visibleProjects = projects.filter((project) =>
    (showAll || project.runningCount > 0) &&
    (!searchTerm || [project.symbol, project.token, project.address, project.owner].some((value) =>
      value.toLowerCase().includes(searchTerm),
    )),
  );
  const totalPages = Math.max(1, Math.ceil(visibleProjects.length / PLAZA_PROJECTS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pagedProjects = visibleProjects.slice(
    (currentPage - 1) * PLAZA_PROJECTS_PER_PAGE,
    currentPage * PLAZA_PROJECTS_PER_PAGE,
  );

  const loadProjects = useCallback(async (reset: boolean) => {
    const requestId = ++requestRef.current;
    if (reset) {
      setVaults([]);
      setTotalVaultCount(null);
      setReadState("loading");
      setHasOlder(false);
      setPage(1);
      nextOffsetRef.current = null;
    } else {
      setLoadingOlder(true);
    }
    if (!factoryAddress) {
      setTotalVaultCount(null);
      setReadState("ready");
      setLoadingOlder(false);
      return;
    }
    try {
      const count = await sdk.readContract<bigint>({
        contract: "boostFactory",
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "vaultCount",
      });
      if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Vault count exceeds safe pagination.");
      if (requestId !== requestRef.current) return;
      setTotalVaultCount(Number(count));
      const cursor = reset ? Number(count) : nextOffsetRef.current;
      if (cursor === null || cursor <= 0) {
        nextOffsetRef.current = null;
        setHasOlder(false);
        setReadState("ready");
        return;
      }
      const offset = Math.max(0, cursor - PLAZA_VAULTS_PER_LOAD);
      const addresses = await sdk.readContract<Address[]>({
        contract: "boostFactory",
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "vaultsRange",
        args: [BigInt(offset), BigInt(cursor - offset)],
      });
      if (requestId !== requestRef.current) return;
      if (addresses.length !== cursor - offset) throw new Error("Incomplete Factory page.");
      const indexed = addresses.map((address, index) => ({ address, creationIndex: offset + index })).reverse();
      const loaded = await mapInBatches(indexed, VAULT_READ_BATCH_SIZE, async ({ address, creationIndex }): Promise<PlazaVaultSnapshot | null> => {
        try {
          const [owner, token, operationCount, availableBNB, reservedBNB] = await Promise.all([
            sdk.readContract<Address>({ contract: "boostVault", address, abi: vaultAbi, functionName: "owner" }),
            sdk.readContract<Address>({ contract: "boostVault", address, abi: vaultAbi, functionName: "targetToken" }),
            sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "operationCount" }),
            sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "availableBNB" }),
            sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "reservedBNB" }),
          ]);
          const [symbol, decimals] = await Promise.all([
            sdk.readContract<string>({
              contract: "token", address: token, abi: erc20Abi, functionName: "symbol",
            }).catch(() => shortAddress(token)),
            sdk.readContract<number>({
              contract: "token", address: token, abi: erc20Abi, functionName: "decimals",
            }).catch(() => null),
          ]);
          const safeDecimals = decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
          const operations = await mapInBatches(
            Array.from({ length: Number(operationCount) }, (_, id) => id),
            OPERATION_READ_BATCH_SIZE,
            (id) => sdk.readContract<VaultOperationRead>({
              contract: "boostVault", address, abi: vaultAbi, functionName: "getOperation", args: [BigInt(id)],
            }),
          );
          return {
            address,
            owner,
            token,
            symbol: symbol || shortAddress(token),
            operationCount: operations.length,
            runningCount: availableBNB + reservedBNB > 0n
              ? operations.filter((operation) => operation.active && operation.started && !operation.paused).length
              : 0,
            totalSpent: operations.reduce((sum, operation) => sum + operation.totalBNBSpent, 0n),
            totalTokensOutput: operations.reduce((sum, operation) => sum + operation.totalTokensOutput, 0n),
            decimals: safeDecimals,
            creationIndex,
          };
        } catch {
          return null;
        }
      });
      if (requestId !== requestRef.current) return;
      if (addresses.length > 0 && loaded.every((vault) => vault === null)) throw new Error("Vault reads failed.");
      setVaults((current) => {
        const byAddress = new Map<string, PlazaVaultSnapshot>(current.map(
          (vault): [string, PlazaVaultSnapshot] => [vault.address.toLowerCase(), vault],
        ));
        for (const vault of loaded) if (vault) byAddress.set(vault.address.toLowerCase(), vault);
        return [...byAddress.values()];
      });
      nextOffsetRef.current = offset > 0 ? offset : null;
      setHasOlder(nextOffsetRef.current !== null);
      setReadState("ready");
    } catch {
      if (requestId === requestRef.current) setReadState("error");
    } finally {
      if (requestId === requestRef.current) setLoadingOlder(false);
    }
  }, [factoryAddress, sdk]);

  useEffect(() => {
    void loadProjects(true);
    return () => { requestRef.current += 1; };
  }, [loadProjects, sdk.refetchNonce]);

  const networkLabel = t(sdk.context.chainId === 97 ? "plaza.testnet" : sdk.context.chainId === 56 ? "plaza.mainnet" : "plaza.otherNetwork");

  return (
    <section className="boost-plaza rounded-2xl border p-4 sm:p-6" aria-label={t("plaza.tab")}>
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="boost-plaza-network rounded-full px-3 py-1 text-xs font-semibold">{networkLabel}</span>
        </div>
        <div className="flex items-center gap-3">
          {totalVaultCount !== null ? <span className="font-mono text-sm font-semibold text-[#E7CC87]">{t("plaza.totalCount", undefined, { count: totalVaultCount })}</span> : null}
          <Button type="button" variant="outline" size="sm" className={GOLD_OUTLINE_BUTTON + " h-9 px-3 text-xs"} disabled={readState === "loading" || loadingOlder} onClick={() => void loadProjects(true)}>
            <RefreshCw className="h-3.5 w-3.5" />{t("buttons.refresh")}
          </Button>
        </div>
      </div>
      {readState === "ready" && totalVaultCount !== null && totalVaultCount > 0 ? <>
      <Input
        aria-label={t("plaza.search")}
        value={searchQuery}
        onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }}
        placeholder={t("plaza.search")}
        className="relative z-10 mt-5 h-11 w-full rounded-lg border-[#5B5548] bg-[#080D11] px-4 font-mono text-sm text-[#F8F2E8] placeholder:font-sans placeholder:text-[#82918E] focus:border-[#DABF79]"
      />
      <div className="relative z-10 mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={t("plaza.filterLabel")}>
        <button type="button" className="boost-plaza-filter rounded-full px-3 py-1.5 text-xs" aria-pressed={!showAll} onClick={() => { setShowAll(false); setPage(1); }}>{t("plaza.runningFilter")}</button>
        <button type="button" className="boost-plaza-filter rounded-full px-3 py-1.5 text-xs" aria-pressed={showAll} onClick={() => { setShowAll(true); setPage(1); }}>{t("plaza.allFilter")}</button>
        <span className="ml-auto text-xs text-[#A3AAA6]">{t("plaza.projectCount", undefined, { count: visibleProjects.length })}</span>
      </div>
      </> : null}
      {!factoryAddress ? <Alert tone="warning">{t("plaza.factoryUnavailable")}</Alert> : null}
      {readState === "loading" ? <p className="relative z-10 mt-5 flex items-center gap-2 text-sm text-[#C8C0A9]"><RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("plaza.loading")}</p> : null}
      {readState === "error" ? <Alert tone="warning">{t("plaza.readFailed")}</Alert> : null}
      {pagedProjects.length ? (
        <div className="relative z-10 mt-4 space-y-2">
          {pagedProjects.map((project, index) => (
            <article key={project.address} className="boost-plaza-card boost-plaza-row rounded-xl border px-4 py-3.5" style={{ animationDelay: `${index * 75}ms` }}>
              <div className="boost-plaza-project min-w-0">
                <p className="truncate text-base font-semibold text-[#FFF2D2]">{project.symbol}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-[#A6B5B1]" title={project.token}>{project.token}</p>
                <p className="mt-1.5 truncate text-[11px] text-[#8E9693]">{t("plaza.owner")}: {shortAddress(project.owner)} · Vault {shortAddress(project.address)}</p>
              </div>
              <div className="boost-plaza-fact"><p>{t("plaza.operations")}</p><strong>{project.runningCount}/{project.operationCount}</strong></div>
              <div className="boost-plaza-fact"><p>{t("plaza.spent")}</p><strong>{formatTokenAmount(project.totalSpent, 18)} BNB</strong></div>
              <div className="boost-plaza-fact"><p>{t("labels.totalTokensOut")}</p><strong title={project.decimals === null ? undefined : `${formatTokenAmount(project.totalTokensOutput, project.decimals)} ${project.symbol}`}>{project.decimals === null ? "—" : `${formatTokenAmount(project.totalTokensOutput, project.decimals)} ${project.symbol}`}</strong></div>
              <div className="boost-plaza-row-status">
                <span className={"boost-plaza-status shrink-0 rounded-full px-2.5 py-1 text-[11px] " + (project.runningCount ? "boost-plaza-status-live" : "")}>
                  {t(project.runningCount ? "plaza.running" : "plaza.notRunning")}
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : readState === "ready" && factoryAddress && totalVaultCount === 0 ? (
        <div className="boost-plaza-empty relative z-10 mt-4 flex flex-col items-center gap-4 rounded-xl border px-5 py-5 text-center sm:flex-row sm:text-left">
          <span className="boost-plaza-empty-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"><Coins className="h-6 w-6" strokeWidth={1.5} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-[#F4E9CF]">{t("plaza.noProjects")}</p>
            <p className="mt-1 text-xs leading-5 text-[#9FAAA7]">{t("plaza.emptyFactoryHint")}</p>
          </div>
          <Button type="button" size="sm" className={GOLD_PRIMARY_BUTTON + " h-10 shrink-0 px-4 text-xs"} onClick={onCreate}><Plus className="h-3.5 w-3.5" />{t("plaza.create")}</Button>
        </div>
      ) : readState === "ready" && factoryAddress && totalVaultCount !== null && totalVaultCount > 0 ? (
        <div className="relative z-10 mt-4 rounded-lg border border-[#3B4747] bg-[#0D151A] px-4 py-5 text-center">
          <p className="text-sm font-semibold text-[#F4E9CF]">{t(searchTerm ? "plaza.noMatch" : "plaza.noRunning")}</p>
          <p className="mt-1 text-xs text-[#9FAAA7]">{t(searchTerm ? "plaza.noMatchHint" : "plaza.emptyHint")}</p>
        </div>
      ) : null}
      {totalVaultCount !== null && totalVaultCount > 0 && (totalPages > 1 || hasOlder) ? <div className="relative z-10 mt-4 flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          {totalPages > 1 ? (
            <>
              <Button type="button" variant="outline" size="sm" className={GOLD_OUTLINE_BUTTON + " h-8 px-2 text-xs"} disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t("buttons.previousPage")}</Button>
              <span className="text-xs text-[#C7BFA9]">{t("labels.pageOf", undefined, { page: currentPage, total: totalPages })}</span>
              <Button type="button" variant="outline" size="sm" className={GOLD_OUTLINE_BUTTON + " h-8 px-2 text-xs"} disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>{t("buttons.nextPage")}</Button>
            </>
          ) : null}
          {hasOlder ? <Button type="button" variant="outline" size="sm" className={GOLD_OUTLINE_BUTTON + " h-8 px-3 text-xs"} disabled={loadingOlder} onClick={() => void loadProjects(false)}>{loadingOlder ? t("plaza.loading") : t("plaza.loadOlder")}</Button> : null}
        </div>
      </div> : null}
    </section>
  );
}

function BoostMotionStyles() {
  return (
    <style>{`
    .flap-boost-app { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #F5F1E9; }
    .flap-boost-shell { position: relative; isolation: isolate; border: 1px solid #3D3B36; background: #0A0C10; box-shadow: inset 0 1px 0 #FFF2D118, 0 28px 80px -45px #000; }
    .flap-boost-shell::before { content: ""; position: absolute; z-index: 3; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, transparent 0%, #8A7444 16%, #F4DC99 45%, #9E824B 78%, transparent); opacity: .9; }
    .boost-content, .boost-header { position: relative; z-index: 1; }
    .boost-header { overflow: hidden; border-bottom: 1px solid #4B4435; background: radial-gradient(circle at 76% 45%, #9E78312B 0%, transparent 31%), radial-gradient(circle at 12% 10%, #25374688 0%, transparent 52%), linear-gradient(115deg, #101925, #0B1018 56%, #15140F); }
    .boost-header::before { content: ""; pointer-events: none; position: absolute; inset: 11px; z-index: 0; border: 1px solid #E6C88121; border-radius: 11px; box-shadow: inset 0 0 0 5px #E6C88106; }
    .boost-header::after { content: ""; pointer-events: none; position: absolute; inset: auto 0 0; height: 1px; background: linear-gradient(90deg, transparent, #E8C775, #FFF2B6, transparent); box-shadow: 0 0 20px #DEB96988; }
    .boost-atmosphere { position: absolute; pointer-events: none; inset: 0; overflow: hidden; z-index: 0; }
    .boost-aura { position: absolute; width: 540px; height: 330px; border-radius: 50%; filter: blur(15px); animation: boostDrift 16s ease-in-out infinite alternate; }
    .boost-aura-blue { top: -160px; left: -170px; background: radial-gradient(ellipse, #42628533, transparent 70%); }
    .boost-aura-gold { top: -130px; right: -180px; background: radial-gradient(ellipse, #C39D4F3D, transparent 68%); animation-delay: -7s; }
    .boost-grid { position: absolute; inset: 0; opacity: .45; background-image: linear-gradient(#D8C1900A 1px, transparent 1px), linear-gradient(90deg, #D8C1900A 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(#0008, transparent 86%); }
    .boost-atmosphere-beam { position: absolute; width: 56%; height: 1px; left: -56%; background: linear-gradient(90deg, transparent, #F8E6AF9C 45%, #FFF4D6 52%, transparent); box-shadow: 0 0 12px #EDCE8480; transform: rotate(-18deg); animation: boostBeam 10s ease-in-out infinite; }
    .boost-atmosphere-beam-one { top: 24%; }.boost-atmosphere-beam-two { top: 68%; animation-delay: -5s; opacity: .6; }
    .boost-atmosphere-current { position: absolute; top: 70%; left: 3%; width: 69%; height: 1px; transform: rotate(-18deg); transform-origin: left center; background: linear-gradient(90deg, transparent, #C9AE6B48 18%, #E6CF9166 70%, transparent); }
    .boost-atmosphere-current::after { content: ""; position: absolute; top: -2px; left: 0; width: 15%; height: 5px; border-radius: 50%; background: linear-gradient(90deg, transparent, #FFE7AA99 50%, transparent); filter: blur(2px); animation: boostCurrentFlow 8.4s cubic-bezier(.32,.04,.68,.96) infinite; }
    .boost-motes { position: absolute; inset: 0; clip-path: inset(0 0 0 56%); }
    .boost-motes span { position: absolute; left: var(--x); top: var(--y); width: var(--size, 2px); height: var(--size, 2px); border-radius: 50%; background: #FFF1BE; box-shadow: 0 0 9px 2px #E9C77A88; animation: boostMote var(--duration, 7s) ease-in-out var(--delay, 0s) infinite; }
    .boost-motes span:nth-child(1) { --x: 7%; --y: 24%; --delay: -1s; --duration: 6s; }.boost-motes span:nth-child(2) { --x: 14%; --y: 73%; --delay: -5s; --size: 3px; }.boost-motes span:nth-child(3) { --x: 29%; --y: 17%; --delay: -3s; }.boost-motes span:nth-child(4) { --x: 39%; --y: 79%; --delay: -6s; --duration: 9s; }.boost-motes span:nth-child(5) { --x: 52%; --y: 35%; --delay: -2s; --size: 3px; }.boost-motes span:nth-child(6) { --x: 61%; --y: 14%; --delay: -7s; }.boost-motes span:nth-child(7) { --x: 75%; --y: 64%; --delay: -4s; --duration: 8s; }.boost-motes span:nth-child(8) { --x: 86%; --y: 27%; --delay: -2s; --size: 3px; }.boost-motes span:nth-child(9) { --x: 92%; --y: 81%; --delay: -5s; }.boost-motes span:nth-child(10) { --x: 47%; --y: 56%; --delay: -8s; --duration: 10s; }
    .boost-spark { position: absolute; width: 2px; height: 2px; border-radius: 50%; background: #FFF3BD; box-shadow: 0 0 12px 2px #F2D78799; animation: boostSpark 9s ease-in-out infinite; }
    .boost-spark-one { top: 86px; left: 72%; }
    .boost-spark-two { top: 38px; left: 80%; animation-delay: -3s; }
    .boost-spark-three { top: 190px; left: 84%; animation-delay: -6s; }
    .boost-hero-corner { position: absolute; width: 39px; height: 39px; border-color: #E9CF8E7A; border-style: solid; filter: drop-shadow(0 0 6px #DFB86252); }
    .boost-hero-corner::after { content: ""; position: absolute; width: 4px; height: 4px; border: 1px solid #FFF1BD; background: #8B6D35; transform: rotate(45deg); box-shadow: 0 0 8px #F5D783; }
    .boost-hero-corner-tl { display: none; }
    .boost-hero-corner-tr { top: 18px; right: 18px; border-width: 1px 1px 0 0; }.boost-hero-corner-tr::after { top: -3px; right: -3px; }
    .boost-hero-corner-bl { display: none; }
    .boost-hero-corner-br { bottom: 18px; right: 18px; border-width: 0 1px 1px 0; }.boost-hero-corner-br::after { bottom: -3px; right: -3px; }
    .boost-hero-layout { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0,1fr) 280px; gap: 28px; min-height: 236px; align-items: center; }
    .boost-hero-copy { position: relative; }
    .boost-hero-title { max-width: 680px; color: #FAF4E7; font-weight: 700; letter-spacing: -.025em; background: linear-gradient(105deg, #FAF4E7 0%, #FAF4E7 37%, #F5DBA0 50%, #FAF4E7 63%, #FAF4E7 100%); background-size: 240% 100%; background-position: 100% center; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .boost-hero-copy > * { animation: boostReveal 720ms cubic-bezier(.2,.8,.2,1) both; }
    .boost-hero-copy > :nth-child(2) { animation-delay: 90ms; }
    .boost-hero-copy > :nth-child(3) { animation-delay: 180ms; }
    .boost-hero-copy > :nth-child(4) { animation-delay: 270ms; }
    .boost-hero-copy > .boost-hero-title { animation: boostReveal 720ms cubic-bezier(.2,.8,.2,1) 90ms both, boostTitleGlint 11s ease-in-out infinite; }
    .boost-kicker { display: flex; align-items: center; gap: 9px; color: #D8BD79; font: 700 10px/1.3 ui-monospace, monospace; letter-spacing: .18em; }
    .boost-kicker-dot { width: 5px; height: 5px; border-radius: 50%; background: #D8BD79; }
    .boost-hero-side { position: relative; display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }
    .boost-cycle { --boost-packet-radius: -66px; position: relative; display: grid; width: 222px; height: 222px; flex: none; place-items: center; border-radius: 50%; background: radial-gradient(circle, #BD9B5038 0%, #1828314D 30%, transparent 68%); box-shadow: 0 0 75px -40px #D7B86C99; }
    .boost-cycle::before { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: conic-gradient(from 18deg, transparent 0 22%, #D8B66C87 24%, transparent 27% 56%, #E6D09661 59%, transparent 62% 100%); -webkit-mask: radial-gradient(transparent 70%, #000 72% 73%, transparent 75%); mask: radial-gradient(transparent 70%, #000 72% 73%, transparent 75%); animation: boostOrbit 22s linear infinite; }
    .boost-cycle-track { position: absolute; border-radius: 50%; }
    .boost-cycle-track-outer { inset: 11px; border: 1px dashed #CDB06E63; animation: boostOrbit 32s linear infinite reverse; }
    .boost-cycle-track-inner { inset: 42px; border: 1px solid #B5975D66; box-shadow: 0 0 30px #E9C77829, inset 0 0 24px #E9C77812; }
    .boost-cycle-sweep { position: absolute; inset: 16px; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 72%, #FFE9AF 79%, transparent 86%); -webkit-mask: radial-gradient(transparent 86%, #000 88% 89%, transparent 91%); mask: radial-gradient(transparent 86%, #000 88% 89%, transparent 91%); filter: drop-shadow(0 0 7px #FFE9AF); animation: boostOrbit 8s linear infinite; }
    .boost-cycle-packet { position: absolute; z-index: 2; top: calc(50% - 3px); left: calc(50% - 3px); width: 6px; height: 6px; border-radius: 50%; background: #FFF0BE; box-shadow: 0 0 9px 2px #F2D17EA6, 0 0 24px #F2D17E80; animation: boostPacketTravel 5.4s linear infinite; }
    .boost-cycle-packet-two { animation-delay: -1.8s; }
    .boost-cycle-packet-three { animation-delay: -3.6s; }
    .boost-cycle-trace { position: absolute; z-index: 2; top: 15px; left: calc(50% - 3px); width: 6px; height: 6px; border-radius: 50%; background: #FFF3C7; box-shadow: 0 0 13px 3px #EFCB79; transform-origin: 3px 96px; animation: boostOrbit 8s linear infinite; }
    .boost-cycle-trace-two { animation-delay: -4s; opacity: .7; }
    .boost-cycle-node { position: absolute; z-index: 3; display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid #D6B876; border-radius: 11px; color: #FFE8AA; background: linear-gradient(145deg, #4B3D28, #172027); box-shadow: inset 0 1px 0 #FFF2C178, 0 0 19px #D8B16266; animation: boostNode 5.4s ease-in-out infinite; }
    .boost-cycle-node::after { content: ""; position: absolute; inset: -6px; border: 1px solid #EACD8299; border-radius: 16px; animation: boostNodeWave 5.4s ease-out infinite; }
    .boost-cycle-node-bnb { top: 12px; left: 17px; }
    .boost-cycle-node-token { top: 82px; right: -6px; animation-delay: -1.8s; }.boost-cycle-node-token::after { animation-delay: -1.8s; }
    .boost-cycle-node-output { bottom: 10px; left: 42px; animation-delay: -3.6s; }.boost-cycle-node-output::after { animation-delay: -3.6s; }
    .boost-cycle-center { position: relative; z-index: 2; display: grid; width: 96px; height: 96px; place-items: center; border: 1px solid #DCC27D8C; border-radius: 50%; background: radial-gradient(circle at 40% 32%, #B78D4A64, #131E26 67%); box-shadow: inset 0 1px 0 #FFF2C16E, 0 0 37px #E3BC6B5C; animation: boostBreathe 5.4s ease-in-out infinite; }
    .boost-cycle-center::before { content: ""; position: absolute; inset: -10px; border: 1px solid #E9C77B75; border-radius: 50%; box-shadow: 0 0 17px #EAC67466; animation: boostCoreWave 5.4s ease-out infinite; }
    .boost-emblem-core { position: relative; z-index: 2; display: block; width: 74px; height: 74px; border: 1px solid #E2C275A8; border-radius: 50%; color: #FFE5A0; background: radial-gradient(circle at 35% 28%, #725B3699, #121A22 66%); box-shadow: inset 0 1px 0 #FFF4C280, 0 0 32px #DDBB6750; }
    .boost-wing { position: absolute; background: linear-gradient(145deg, #FFF4C9DD, #D6A953C9 45%, #7A602F69); border: 1px solid #FFE6A5B8; box-shadow: inset 0 1px 0 #FFFFFF83, 0 0 11px #E8C57471; }
    .boost-wing-upper-left { top: 14px; left: 13px; width: 24px; height: 29px; border-radius: 85% 13% 75% 13%; transform-origin: right bottom; animation: boostWingLeft 3.4s ease-in-out infinite; }
    .boost-wing-upper-right { top: 14px; right: 13px; width: 24px; height: 29px; border-radius: 13% 85% 13% 75%; transform-origin: left bottom; animation: boostWingRight 3.4s ease-in-out infinite; }
    .boost-wing-lower-left { top: 37px; left: 17px; width: 19px; height: 21px; border-radius: 70% 15% 82% 17%; transform-origin: right top; animation: boostWingLowerLeft 3.4s ease-in-out -1.7s infinite; }
    .boost-wing-lower-right { top: 37px; right: 17px; width: 19px; height: 21px; border-radius: 15% 70% 17% 82%; transform-origin: left top; animation: boostWingLowerRight 3.4s ease-in-out -1.7s infinite; }
    .boost-wing-body { position: absolute; z-index: 1; top: 25px; left: 50%; width: 5px; height: 31px; transform: translateX(-50%); border-radius: 50%; background: #FFF2C2; box-shadow: 0 0 9px 2px #FFE8A5AA; }
    .boost-hero-steps { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 11px; padding-bottom: 10px; color: #8F969A; font-size: 11px; }
    .boost-hero-steps span { display: inline-flex; align-items: center; gap: 7px; color: #D6D4CC; white-space: nowrap; }
    .boost-hero-steps b { font: 700 10px/1 ui-monospace, monospace; color: #E2C678; }
    .boost-hero-steps::before { content: ""; position: absolute; bottom: 0; left: 0; width: min(100%, 330px); height: 1px; background: linear-gradient(90deg, #D9BD6D8C, #665B47 70%, transparent); }
    .boost-hero-steps::after { content: ""; position: absolute; bottom: -2px; left: 0; width: 5px; height: 5px; border-radius: 50%; background: #FFF2C2; box-shadow: 0 0 9px 3px #F5D884A3; animation: boostFlow 4.8s cubic-bezier(.3,0,.7,1) infinite; }
    .boost-hero-steps svg { color: #D7B964; animation: boostChevron 2.4s ease-in-out infinite; }.boost-hero-steps svg:nth-of-type(2) { animation-delay: .8s; }
    .boost-content { background: radial-gradient(ellipse at 3% 0, #B8954220, transparent 33%), linear-gradient(180deg, #0D1117 0%, #090C10 100%); }
    .boost-view-tabs { background: transparent; }
    .boost-view-tab { position: relative; display: flex; min-width: 0; min-height: 78px; align-items: center; gap: 16px; overflow: hidden; border: 1px solid #435153; border-radius: 14px 4px 14px 4px; padding: 14px 18px; color: #C5CECB; background: linear-gradient(112deg, #14232B, #0B1219 70%); text-align: left; transition: color 220ms ease, border-color 220ms ease, background 220ms ease, box-shadow 220ms ease, transform 220ms ease; }
    .boost-view-tab::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; opacity: 0; background: linear-gradient(#FFF0BB, #B38A40); box-shadow: 0 0 15px #E5C16A; transition: opacity 220ms ease; }
    .boost-view-tab::after { content: ""; position: absolute; right: 100%; bottom: 0; width: 38%; height: 2px; opacity: 0; background: linear-gradient(90deg, transparent, #FFE7A7, transparent); box-shadow: 0 0 12px #E8C474; pointer-events: none; }
    .boost-view-tab:hover { color: #FFE6AE; border-color: #A68D5A; transform: translateY(-2px); }
    .boost-view-tab[aria-pressed="true"] { color: #FFF0CB; border-color: #A48B59; background: linear-gradient(112deg, #3C3526, #1D2A2E 65%, #111B22); box-shadow: inset 0 1px 0 #F5D89445, 0 15px 29px -26px #E1BE6D; }
    .boost-view-tab[aria-pressed="true"]::before { opacity: 1; }
    .boost-view-tab[aria-pressed="true"]::after { animation: boostTabRail 7s ease-in-out infinite; }
    .boost-view-tab-index { flex: none; color: #728284; font: 700 25px/1 ui-monospace, monospace; letter-spacing: -.08em; transition: color 220ms ease; }
    .boost-view-tab[aria-pressed="true"] .boost-view-tab-index { color: #F0D28B; text-shadow: 0 0 17px #E8C47670; }
    .boost-view-tab-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
    .boost-view-tab-copy strong { overflow: hidden; font-size: 16px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    .boost-view-tab-copy small { color: #889C9D; font-size: 11px; line-height: 1.2; }
    .boost-view-tab[aria-pressed="true"] .boost-view-tab-copy small { color: #C1BAA3; }
    .boost-view-tab-arrow { flex: none; color: #7E9291; transition: color 220ms ease, transform 220ms ease; }
    .boost-view-tab:hover .boost-view-tab-arrow, .boost-view-tab[aria-pressed="true"] .boost-view-tab-arrow { color: #EED28F; transform: translateX(3px); }
    .boost-detail-tabs .boost-view-tab { min-height: 44px; justify-content: center; border: 0; border-radius: 8px; padding: 10px; background: transparent; text-align: center; }
    .boost-detail-tabs .boost-view-tab::before { display: none; }
    .boost-detail-tabs .boost-view-tab:hover { transform: none; }
    .boost-detail-tabs .boost-view-tab[aria-pressed="true"] { background: linear-gradient(125deg, #433722, #21252A); box-shadow: inset 0 1px 0 #F5D89455; }
    .boost-management { min-width: 0; }
    .boost-plaza-filter, .boost-token { min-height: 40px; }
    .boost-view-tab:focus-visible, .boost-plaza-filter:focus-visible, .boost-token:focus-visible, .boost-task:focus-visible { outline: 2px solid #E7CC87; outline-offset: 2px; }
    .boost-plaza { position: relative; isolation: isolate; overflow: hidden; border-color: #4B514D; background: radial-gradient(circle at 96% -18%, #C6A15A24, transparent 42%), linear-gradient(150deg, #111A20, #0B1117 72%); box-shadow: inset 0 1px 0 #F7DC9D22, 0 24px 55px -44px #D0A95465; }
    .boost-plaza::before { content: ""; position: absolute; pointer-events: none; top: -138px; right: -112px; width: 260px; height: 260px; border: 1px solid #D8BC7224; border-radius: 50%; box-shadow: 0 0 0 30px #D8BC7205; }
    .boost-plaza::after { content: ""; position: absolute; pointer-events: none; top: 0; left: -35%; width: 35%; height: 1px; background: linear-gradient(90deg, transparent, #FFE4A899, transparent); box-shadow: 0 0 14px #E9C77477; animation: boostPlazaRail 13s ease-in-out infinite; }
    .boost-plaza-network { border: 1px solid #8B7650; color: #F4DEA9; background: #2B281F; }
    .boost-plaza-filter { border: 1px solid #66573C; color: #B9B6AA; background: #111820; transition: border-color 200ms ease, color 200ms ease, background 200ms ease; }
    .boost-plaza-filter:hover { color: #F4DAA2; border-color: #B69A5B; }.boost-plaza-filter[aria-pressed="true"] { border-color: #E3C781; color: #201B12; background: #DCC27E; }
    .boost-plaza-card { position: relative; isolation: isolate; overflow: hidden; border-color: #39494B; background: linear-gradient(110deg, #142027, #0E171D 72%); transition: border-color 220ms ease, background 220ms ease, transform 300ms cubic-bezier(.2,.8,.2,1), box-shadow 300ms ease; animation: boostRowArrive 620ms cubic-bezier(.18,.85,.24,1) backwards; }
    .boost-plaza-card::after { content: ""; position: absolute; pointer-events: none; z-index: 0; top: -30%; bottom: -30%; left: -45%; width: 30%; transform: skewX(-16deg); background: linear-gradient(90deg, transparent, #EDD69A14, transparent); }
    .boost-plaza-card > * { position: relative; z-index: 1; }
    .boost-plaza-row { display: grid; grid-template-columns: minmax(210px, 1.6fr) repeat(3, minmax(112px, .75fr)) auto; align-items: center; gap: 20px; }
    .boost-plaza-project { border-left: 2px solid #D6B76E; padding-left: 13px; }
    .boost-plaza-fact { min-width: 0; }
    .boost-plaza-fact p { color: #9FA9A5; font-size: 11px; line-height: 1.35; }
    .boost-plaza-fact strong { display: block; overflow: hidden; margin-top: 5px; color: #F5E8CA; font: 600 13px/1.35 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .boost-plaza-row-status { display: flex; justify-content: flex-end; }
    @media (max-width: 1023px) { .boost-plaza-row { grid-template-columns: minmax(0, 1.4fr) repeat(3, minmax(0, .7fr)); gap: 14px; } .boost-plaza-row-status { grid-column: 1 / -1; justify-content: flex-start; } }
    @media (max-width: 639px) { .boost-plaza-row { grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; } .boost-plaza-project { grid-column: 1 / -1; } .boost-plaza-fact strong { font-size: 11px; } .boost-plaza-row-status { grid-column: 1 / -1; } }
    .boost-plaza-status { border: 1px solid #645A4A; color: #BDB6A7; background: #191B1D; }
    .boost-plaza-status-live { position: relative; border-color: #7EB7A6; color: #BBF1DC; background: #16332F; box-shadow: 0 0 18px -11px #8FE4BE; }
    .boost-plaza-status-live::before { content: ""; display: inline-block; width: 5px; height: 5px; margin-right: 6px; border-radius: 50%; vertical-align: 2px; background: #A5F3CB; box-shadow: 0 0 8px #A5F3CB; animation: boostStatusBreathe 3s ease-in-out infinite; }
    .boost-plaza-status-live::after { content: ""; position: absolute; inset: -3px; border: 1px solid #9BD8BF6B; border-radius: inherit; animation: boostLiveRing 4.5s ease-out infinite; }
    .boost-plaza-empty { border-color: #4B574F; background: linear-gradient(120deg, #142128, #10191E); }
    .boost-plaza-empty-icon { border: 1px solid #796849; color: #E4CB8D; background: #2B2A22; }
    @media (hover: hover) { .boost-plaza-card:hover { border-color: #B69A5D; background: linear-gradient(110deg, #19282D, #121C21 72%); transform: translateY(-2px); box-shadow: 0 14px 28px -22px #D8B46B75; } .boost-plaza-card:hover::after { animation: boostCardWash 850ms ease-out both; } }
    .flap-boost-workspace { border: 1px solid #3F4A49; background: linear-gradient(155deg, #111A21, #0B1117 70%); box-shadow: inset 0 1px 0 #FCE8AA16, 0 20px 48px -38px #CAA65F58; }
    .flap-boost-workspace > * { position: relative; z-index: 1; }
    .boost-workspace-header { position: relative; overflow: hidden; border-bottom: 1px solid #5D523E; background: linear-gradient(90deg, #17202A99, #10151B80); }
    .boost-workspace-header::before { content: ""; pointer-events: none; position: absolute; inset: 0; opacity: .46; background: repeating-linear-gradient(115deg, transparent 0 30px, #E7D29808 31px 32px, transparent 33px 62px), radial-gradient(circle at 14% 50%, #E5BC5D24, transparent 26%); }
    .boost-workspace-header::after { content: ""; pointer-events: none; position: absolute; bottom: 0; left: -38%; width: 38%; height: 1px; background: linear-gradient(90deg, transparent, #FCE3A6, transparent); box-shadow: 0 0 12px #E8C570; animation: boostRail 9s ease-in-out infinite; }
    .boost-workspace-icon { border: 1px solid #8E774B88; color: #E7CC87; background: linear-gradient(145deg, #352D20, #151A1F); box-shadow: inset 0 1px 0 #F9DFA329; }
    .boost-workspace-icon { animation: boostIconBreathe 7s ease-in-out infinite; }
    .boost-motion-toggle { color: #B9B2A2; }.boost-motion-toggle:hover { color: #FFE3A0; background: #51432935; }.boost-motion-toggle[aria-pressed="true"] { color: #F0D18A; background: #54442935; }
    .boost-empty { position: relative; isolation: isolate; overflow: hidden; border: 1px solid #756244; background: radial-gradient(circle at 6% 50%, #C59B3530, transparent 34%), repeating-linear-gradient(135deg, transparent 0 31px, #E5C57608 32px 33px, transparent 34px 64px), linear-gradient(110deg, #121B25, #0A1017); box-shadow: inset 0 1px 0 #FFF4D029, inset 0 0 0 5px #CFAF6907; }
    .boost-empty::before { content: ""; position: absolute; inset: -70% -20%; z-index: 0; background: radial-gradient(ellipse at 35% 50%, #D9B4651C, transparent 43%); animation: boostCloud 11s ease-in-out infinite alternate; }
    .boost-empty::after { content: ""; position: absolute; left: -40%; top: 0; bottom: 0; width: 25%; transform: skewX(-25deg); background: linear-gradient(90deg, transparent, #FFE9B016, transparent); animation: boostEmptyGlint 9s ease-in-out infinite; }
    .boost-empty > * { position: relative; z-index: 1; }
    .boost-empty-seal { position: relative; display: grid; place-items: center; width: 102px; height: 102px; border-radius: 50%; background: radial-gradient(circle, #DAAF4730, transparent 68%); }
    .boost-empty-seal-ring { position: absolute; border-radius: 50%; border: 1px solid #DBBC7275; }
    .boost-empty-seal-ring-outer { inset: 3px; border-style: dashed; animation: boostOrbit 24s linear infinite; }
    .boost-empty-seal-ring-inner { inset: 14px; border-color: #E5C77D9C; border-top-color: #FFF1BE; border-bottom-color: #FFF1BE; box-shadow: 0 0 18px #E6C5754D, inset 0 0 16px #E6C57533; animation: boostOrbit 13s linear infinite reverse; }
    .boost-empty-seal-ray { position: absolute; top: 50%; left: -13px; width: 128px; height: 1px; background: linear-gradient(90deg, transparent, #E9CF8A95 15%, transparent 29% 71%, #E9CF8A95 85%, transparent); }
    .boost-empty-seal-ray-two { transform: rotate(90deg); }
    .boost-empty-icon { position: relative; z-index: 1; border: 1px solid #C4A668; color: #F4DB99; background: linear-gradient(145deg, #6C5430, #1B2228 65%); box-shadow: inset 0 1px 0 #FFF0BB85, 0 0 24px #DAB25769; animation: boostIconBreathe 4.5s ease-in-out infinite; }
    .flap-boost-form-reveal { background: transparent; animation: boostEnter 420ms cubic-bezier(.16,1,.3,1) both; }
    .boost-vault-panel-head { position: relative; background: transparent; }
    .boost-vault-eyebrow { text-shadow: 0 0 14px #E6C5766B; }
    .boost-route-preview { position: relative; isolation: isolate; border-top: 1px solid #39484A; }
    .boost-route-node { display: grid; grid-template-columns: 27px minmax(0,1fr); grid-template-rows: auto auto; align-items: center; column-gap: 7px; min-height: 52px; padding: 6px 0; }
    .boost-route-icon { display: grid; grid-row: 1 / span 2; place-items: center; width: 26px; height: 26px; border: 1px solid #9A80506B; border-radius: 7px; color: #EBD393; background: #3B322346; }
    .boost-route-caption { overflow: hidden; color: #9FABA9; font-size: 10px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    .boost-route-value { min-width: 0; overflow: hidden; color: #F6F0E3; font: 600 12px/1.3 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .boost-route-link { position: relative; height: 1px; background: linear-gradient(90deg, #806D4A, #DFC983); }
    .boost-route-link i { position: absolute; top: -2px; left: 0; width: 5px; height: 5px; border-radius: 50%; background: #FFE7A7; box-shadow: 0 0 8px 2px #E1C17472; animation: boostRouteTravel 4.8s ease-in-out infinite; }
    .boost-route-link-late i { animation-delay: -2.4s; }
    .boost-form-step { position: relative; border-bottom: 1px solid #34464A; }
    .boost-form-step:last-child { border-bottom: 0; }
    .boost-form-step::before { content: ""; position: absolute; pointer-events: none; left: 0; bottom: -1px; width: 0; height: 1px; background: linear-gradient(90deg, #E8D08C, transparent); transition: width 320ms ease; }
    .boost-form-step:focus-within::before { width: 45%; }
    .boost-split-ring { position: relative; isolation: isolate; box-shadow: 0 0 28px #E8C87418; transition: transform 220ms cubic-bezier(.2,.8,.2,1), box-shadow 220ms ease; }
    .boost-split-ring > div { position: relative; z-index: 1; }
    .boost-split-ring::after { content: ""; position: absolute; inset: -5px; pointer-events: none; border-radius: 50%; opacity: .35; background: conic-gradient(transparent 0 65%, #FFF3CD 74%, transparent 84%); -webkit-mask: radial-gradient(transparent 62%, #000 68% 75%, transparent 82%); mask: radial-gradient(transparent 62%, #000 68% 75%, transparent 82%); animation: boostOrbit 12s linear infinite; transition: opacity 200ms ease; }
    .boost-split-ring[data-adjusting="true"] { transform: scale(1.035); box-shadow: 0 0 40px #E8C87444; }
    .boost-split-ring[data-adjusting="true"]::after { opacity: .9; animation-duration: 2s; }
    .boost-split-slider { -webkit-appearance: none; appearance: none; height: 32px; border-radius: 999px; background: linear-gradient(90deg, var(--split-color) 0 var(--split-progress), #354147 var(--split-progress) 100%) center / 100% 8px no-repeat; transition: filter 180ms ease; }
    .boost-split-slider:hover, .boost-split-slider:active { filter: drop-shadow(0 0 8px var(--split-color)); }
    .boost-split-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 19px; height: 19px; border: 2px solid #0D171D; border-radius: 50%; background: var(--split-color); box-shadow: 0 0 0 1px var(--split-color), 0 0 12px var(--split-color); transition: transform 180ms ease, box-shadow 180ms ease; }
    .boost-split-slider::-moz-range-thumb { width: 15px; height: 15px; border: 2px solid #0D171D; border-radius: 50%; background: var(--split-color); box-shadow: 0 0 0 1px var(--split-color), 0 0 12px var(--split-color); transition: transform 180ms ease, box-shadow 180ms ease; }
    .boost-split-slider:not(:disabled):active::-webkit-slider-thumb { transform: scale(1.24); box-shadow: 0 0 0 5px #E8C8742B, 0 0 22px var(--split-color); }
    .boost-split-slider:not(:disabled):active::-moz-range-thumb { transform: scale(1.24); box-shadow: 0 0 0 5px #E8C8742B, 0 0 22px var(--split-color); }
    .boost-split-slider:focus-visible { outline: 2px solid #FFF0BB; outline-offset: 7px; }
    .boost-step-heading { position: relative; z-index: 1; }
    .boost-step-heading > span:nth-child(2) { transform-origin: left; animation: boostStepLink 700ms cubic-bezier(.2,.8,.2,1) both; }
    .boost-step-index { animation: boostIndex 7.2s ease-in-out infinite; }
    .boost-form-step:nth-child(2) .boost-step-index { animation-delay: -2.4s; }.boost-form-step:nth-child(3) .boost-step-index { animation-delay: -4.8s; }
    .boost-choice[aria-pressed="true"] { border-color: #D8B86B !important; background: linear-gradient(145deg, #463A25, #1B2227) !important; box-shadow: inset 0 1px 0 #FFF0BF4D, 0 12px 25px -20px #E9BE5D !important; }
    .boost-choice[aria-pressed="true"]::before { content: ""; position: absolute; pointer-events: none; inset: -50%; background: radial-gradient(circle, #F4D88C1D, transparent 50%); animation: boostChoiceGlow 4.5s ease-in-out infinite; }
    .boost-choice[aria-pressed="true"] { animation: boostSelect 380ms cubic-bezier(.18,.9,.2,1) both; }
    .boost-choice[aria-pressed="true"] > span:nth-child(2) { transition: transform 250ms ease, box-shadow 250ms ease; box-shadow: 0 0 14px #E7C47149; }
    .boost-choice, .boost-token, .boost-task { position: relative; isolation: isolate; overflow: hidden; }
    .boost-choice[aria-pressed="true"]::after, .boost-task[aria-pressed="true"]::after { content: ""; pointer-events: none; position: absolute; bottom: 0; left: 0; width: 45%; height: 1px; background: linear-gradient(90deg, transparent, #F0D58B, transparent); animation: boostScan 7s ease-in-out infinite; }
    .boost-token[aria-pressed="true"] { border-color: #D4B66C !important; background: #3A3223 !important; color: #F8EFD8 !important; box-shadow: 0 0 24px -16px #EAC973; }
    .boost-output-choice { position: relative; isolation: isolate; overflow: hidden; }
    .boost-output-choice[aria-pressed="true"] { animation: boostSelect 380ms cubic-bezier(.18,.9,.2,1) both; }
    .boost-output-choice[aria-pressed="true"]::before { content: ""; pointer-events: none; position: absolute; inset: auto 0 0; height: 2px; background: linear-gradient(90deg, transparent, #FFF1C5 50%, transparent); animation: boostOutputPulse 5.5s ease-in-out infinite; }
    .boost-token-confirmation { position: relative; overflow: hidden; animation: boostConfirmIn 430ms cubic-bezier(.18,.9,.2,1) both; }
    .boost-token-confirmation::after { content: ""; pointer-events: none; position: absolute; inset: 0 auto 0 -35%; width: 35%; background: linear-gradient(90deg, transparent, #F4D99012, transparent); transform: skewX(-20deg); animation: boostConfirmSweep 1.1s ease-out 200ms both; }
    .boost-task[aria-pressed="true"] { border-color: #B79A63 !important; background: linear-gradient(100deg, #202D35, #111B23 64%, #231F17) !important; box-shadow: inset 3px 0 0 #E3C272, 0 16px 35px -28px #D8B867 !important; }
    .boost-detail { position: relative; isolation: isolate; border-color: #555044 !important; background: linear-gradient(155deg, #111B24, #0B1118 62%, #16150F) !important; box-shadow: inset 0 1px 0 #FFEFC619; }
    .boost-detail::after { content: ""; position: absolute; pointer-events: none; top: 0; left: -45%; width: 45%; height: 1px; background: linear-gradient(90deg, transparent, #F9DB91, transparent); box-shadow: 0 0 10px #F0CE78; animation: boostStepRail 12s ease-in-out infinite; }
    .boost-detail:nth-child(2)::after { animation-delay: -6s; }
    .boost-detail dl > div { transition: background-color 220ms ease, padding-inline 220ms ease; }
    .boost-detail dl > div:hover { background-color: #D8BD7610; }
    .boost-fund-balance { position: relative; isolation: isolate; overflow: hidden; }
    .boost-fund-balance::before { content: ""; pointer-events: none; position: absolute; inset: -60%; z-index: -1; background: radial-gradient(circle at 30% 35%, #D8BC7321, transparent 42%); animation: boostBalanceDrift 14s ease-in-out infinite alternate; }
    .boost-fund-balance::after { content: ""; pointer-events: none; position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; background: linear-gradient(90deg, transparent, #FFF2C510, transparent); transform: skewX(-18deg); animation: boostBalanceShine 12s ease-in-out infinite; }
    .boost-fund-balance > * { position: relative; z-index: 1; }
    .boost-status[data-live="true"] { animation: boostStatusBreathe 3s ease-in-out infinite; }
    .boost-signal { position: relative; width: 5px; height: 5px; border-radius: 50%; background: #E5D284; flex: 0 0 5px; }
    .boost-signal::after { content: ""; position: absolute; inset: -3px; border: 1px solid #E5D284; border-radius: 50%; animation: boostSignal 2.4s ease-out infinite; }
    .boost-progress-toast { animation: boostConfirmIn 360ms cubic-bezier(.18,.9,.2,1) both; }
    .boost-progress-toast::before { content: ""; pointer-events: none; position: absolute; inset: 0 auto auto -45%; width: 45%; height: 1px; background: linear-gradient(90deg, transparent, #FFF0B3, transparent); box-shadow: 0 0 11px #E4BF67; animation: boostStepRail 4.5s ease-in-out infinite; }
    .flap-boost-app button { transition: transform 180ms ease, border-color 180ms ease, color 180ms ease, box-shadow 180ms ease; }
    .flap-boost-app button:not(:disabled):active { transform: translateY(1px); }
    .boost-cta::after { content: ""; position: absolute; pointer-events: none; z-index: 0; top: -35%; bottom: -35%; left: -60%; width: 30%; background: linear-gradient(90deg, transparent, #FFFFFF6B, transparent); transform: skewX(-20deg); }
    .boost-cta:not(:disabled)::after { animation: boostShine 6.5s ease-in-out infinite; }
    .boost-field input { transition: box-shadow 200ms ease, border-color 200ms ease, background 200ms ease; }
    .boost-field:focus-within input { box-shadow: 0 0 0 2px #DCC37C1A, 0 0 20px -12px #E5C675; }
    .flap-boost-metrics > * { border: 0; background: transparent; padding: 0.5rem 1rem; box-shadow: none; min-width: 0; }
    .flap-boost-metrics > * + * { border-left: 1px solid #43433E; }
    .flap-boost-metrics > * > div { font-size: 0.75rem; }
    .flap-boost-metrics > * > div:nth-child(2) { font-size: 1.25rem; font-family: ui-monospace, monospace; }
    .flap-boost-form-reveal > div > div > section, .boost-task, .boost-detail { animation: boostEnter 400ms cubic-bezier(.16,1,.3,1) both; }
    .flap-boost-form-reveal > div > div > section:nth-child(2), .boost-task:nth-child(2), .boost-detail:nth-child(2) { animation-delay: 65ms; }
    .flap-boost-form-reveal > div > div > section:nth-child(3), .boost-task:nth-child(3) { animation-delay: 130ms; }
    .flap-boost-app summary::-webkit-details-marker { display: none; }
    .flap-boost-app button:focus-visible, .flap-boost-app summary:focus-visible { outline: 2px solid #E7CA82; outline-offset: 3px; }
    .flap-boost-app button:disabled { cursor: not-allowed; }
    @keyframes boostEnter { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes boostReveal { from { opacity: .8; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes boostSelect { from { transform: translateY(2px) scale(.985); } to { transform: translateY(0) scale(1); } }
    @keyframes boostConfirmIn { from { opacity: 0; transform: translateY(6px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes boostConfirmSweep { from { opacity: 0; transform: translateX(0) skewX(-20deg); } 30% { opacity: 1; } to { opacity: 0; transform: translateX(400%) skewX(-20deg); } }
    @keyframes boostRouteTravel { 0%,12%,100% { opacity: 0; transform: translateX(0) scale(.6); } 20% { opacity: .85; } 68% { opacity: .85; transform: translateX(var(--boost-route-distance, 14px)) scale(1); } 76% { opacity: 0; transform: translateX(var(--boost-route-distance, 14px)) scale(.6); } }
    @keyframes boostStepLink { from { opacity: 0; transform: scaleX(.2); } to { opacity: 1; transform: scaleX(1); } }
    @keyframes boostIndex { 0%,28%,100% { color: #BFA976; text-shadow: 0 0 0 transparent; } 35%,50% { color: #FFE4A4; text-shadow: 0 0 9px #EAC8798C; } }
    @keyframes boostOutputPulse { 0%,75%,100% { opacity: .35; transform: translateX(-45%); } 86% { opacity: .85; transform: translateX(45%); } }
    @keyframes boostBalanceDrift { from { transform: translate3d(-4%,0,0); opacity: .45; } to { transform: translate3d(7%,3%,0); opacity: .8; } }
    @keyframes boostBalanceShine { 0%,72% { opacity: 0; transform: translateX(0) skewX(-18deg); } 81% { opacity: .75; } 93%,100% { opacity: 0; transform: translateX(420%) skewX(-18deg); } }
    @media (min-width: 640px) { .boost-route-link { --boost-route-distance: 32px; } }
    @media (max-width: 639px) { .boost-route-node { grid-template-columns: 18px minmax(0,1fr); grid-template-rows: 18px auto; column-gap: 3px; padding: 5px; } .boost-route-icon { grid-row: 1; width: 18px; height: 18px; border-radius: 5px; } .boost-route-icon svg { width: 11px; height: 11px; } .boost-route-caption { font-size: 9px; } .boost-route-value { grid-column: 1 / -1; font-size: 10px; overflow: visible; overflow-wrap: anywhere; text-overflow: clip; white-space: normal; } }
    @keyframes boostOrbit { to { transform: rotate(360deg); } }
    @keyframes boostBreathe { 0%,100% { opacity: .66; transform: scale(.92); } 50% { opacity: 1; transform: scale(1.07); } }
    @keyframes boostPacketTravel { 0% { opacity: 0; transform: rotate(0deg) translateY(var(--boost-packet-radius)) scale(.5); } 10%,78% { opacity: .9; } 92%,100% { opacity: 0; transform: rotate(360deg) translateY(var(--boost-packet-radius)) scale(1); } }
    @keyframes boostCoreWave { 0%,12% { opacity: 0; transform: scale(.82); } 22% { opacity: .7; } 52%,100% { opacity: 0; transform: scale(1.55); } }
    @keyframes boostNode { 0%,13%,42%,100% { transform: scale(1); box-shadow: inset 0 1px 0 #FFF2C178, 0 0 14px #D8B1624D; } 22% { transform: scale(1.11); box-shadow: inset 0 1px 0 #FFF2C1A0, 0 0 28px #E5C177B3; } }
    @keyframes boostNodeWave { 0%,14% { opacity: 0; transform: scale(.75); } 22% { opacity: .7; } 45%,100% { opacity: 0; transform: scale(1.45); } }
    @keyframes boostTitleGlint { 0%,62% { background-position: 100% center; } 86%,100% { background-position: -100% center; } }
    @keyframes boostCurrentFlow { 0%,13% { opacity: 0; transform: translateX(-110%); } 25%,71% { opacity: .85; } 88%,100% { opacity: 0; transform: translateX(680%); } }
    @keyframes boostTabRail { 0%,48% { opacity: 0; transform: translateX(0); } 57% { opacity: .95; } 80%,100% { opacity: 0; transform: translateX(360%); } }
    @keyframes boostPlazaRail { 0%,56% { opacity: 0; transform: translateX(0); } 64% { opacity: .8; } 91%,100% { opacity: 0; transform: translateX(390%); } }
    @keyframes boostRowArrive { from { opacity: 0; transform: translateY(12px) scale(.992); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes boostCardWash { from { opacity: 0; transform: translateX(0) skewX(-16deg); } 30% { opacity: 1; } to { opacity: 0; transform: translateX(480%) skewX(-16deg); } }
    @keyframes boostLiveRing { 0%,60%,100% { opacity: 0; transform: scale(.92); } 68% { opacity: .65; } 86% { opacity: 0; transform: scale(1.2); } }
    @keyframes boostBeam { 0%,12% { opacity: 0; transform: translate3d(0,0,0) rotate(-18deg); } 26% { opacity: .75; } 62% { opacity: .5; } 78%,100% { opacity: 0; transform: translate3d(300%,0,0) rotate(-18deg); } }
    @keyframes boostMote { 0%,100% { opacity: 0; transform: translate3d(0,15px,0) scale(.6); } 28%,60% { opacity: .85; } 78% { opacity: .3; transform: translate3d(18px,-24px,0) scale(1.2); } }
    @keyframes boostWingLeft { 0%,100% { transform: rotate(-32deg) scaleX(.95); } 50% { transform: rotate(-14deg) scaleX(.7); } }
    @keyframes boostWingRight { 0%,100% { transform: rotate(32deg) scaleX(.95); } 50% { transform: rotate(14deg) scaleX(.7); } }
    @keyframes boostWingLowerLeft { 0%,100% { transform: rotate(22deg) scaleX(.95); } 50% { transform: rotate(8deg) scaleX(.7); } }
    @keyframes boostWingLowerRight { 0%,100% { transform: rotate(-22deg) scaleX(.95); } 50% { transform: rotate(-8deg) scaleX(.7); } }
    @keyframes boostFlow { 0% { opacity: 0; transform: translateX(0) scale(.5); } 12% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; transform: translateX(var(--boost-flow-distance, 320px)) scale(1.25); } }
    @keyframes boostChevron { 0%,100% { opacity: .4; transform: translateX(0); } 50% { opacity: 1; transform: translateX(3px); } }
    @keyframes boostRail { 0%,15% { opacity: 0; transform: translateX(0); } 30%,75% { opacity: .95; } 95%,100% { opacity: 0; transform: translateX(350%); } }
    @keyframes boostCloud { from { opacity: .45; transform: translateX(-8%); } to { opacity: .9; transform: translateX(12%); } }
    @keyframes boostEmptyGlint { 0%,65% { opacity: 0; transform: translateX(0) skewX(-25deg); } 70% { opacity: .8; } 100% { opacity: 0; transform: translateX(600%) skewX(-25deg); } }
    @keyframes boostIconBreathe { 0%,100% { transform: scale(1); box-shadow: inset 0 1px 0 #FFF0BB40, 0 0 20px #DAB25712; } 50% { transform: scale(1.045); box-shadow: inset 0 1px 0 #FFF0BB65, 0 0 32px #DAB25750; } }
    @keyframes boostStepRail { 0%,12% { opacity: 0; transform: translateX(0); } 25%,70% { opacity: .8; } 90%,100% { opacity: 0; transform: translateX(300%); } }
    @keyframes boostChoiceGlow { 0%,100% { opacity: .3; transform: translateX(-15%); } 50% { opacity: .95; transform: translateX(15%); } }
    @keyframes boostStatusBreathe { 0%,100% { box-shadow: 0 0 0 #E9CD7500; } 50% { box-shadow: 0 0 16px #E9CD7570; } }
    @keyframes boostDrift { from { transform: translate3d(0,0,0); opacity: .24; } to { transform: translate3d(75px,28px,0); opacity: .4; } }
    @keyframes boostSpark { 0%,100% { opacity: 0; transform: translate3d(-12px,15px,0); } 40% { opacity: .8; } 90% { opacity: 0; transform: translate3d(38px,-30px,0); } }
    @keyframes boostSignal { from { opacity: .65; transform: scale(.5); } to { opacity: 0; transform: scale(1.6); } }
    @keyframes boostScan { 0%, 15% { opacity: 0; transform: translateX(-110%); } 25%,75% { opacity: .8; } 90%,100% { opacity: 0; transform: translateX(450%); } }
    @keyframes boostShine { 0%,65% { transform: translateX(0) skewX(-20deg); } 88%,100% { transform: translateX(650%) skewX(-20deg); } }
    @media (hover: hover) { .boost-cta:not(:disabled):hover, .boost-token:hover { transform: translateY(-2px); } .boost-choice:hover, .boost-task:hover { border-color: #A58D60; box-shadow: 0 0 28px -22px #E2C575; } }
    @media (max-width: 639px) {
      .boost-hero-layout { grid-template-columns: minmax(0,1fr) 104px; gap: 7px; min-height: 160px; }
      .boost-hero-title { font-size: 27px; }
      .boost-hero-description { font-size: 12px; line-height: 1.45; }
      .boost-hero-steps { --boost-flow-distance: 225px; gap: 7px; font-size: 10px; }
      .boost-hero-steps svg { display: none; }
      .boost-hero-side { height: auto; pointer-events: none; }
      .boost-cycle { --boost-packet-radius: -31px; width: 104px; height: 104px; }
      .boost-atmosphere-current { opacity: .3; }
      .boost-cycle-track-outer { inset: 4px; }
      .boost-cycle-track-inner { inset: 22px; }
      .boost-cycle-sweep { inset: 7px; }
      .boost-cycle-trace { top: 5px; width: 4px; height: 4px; transform-origin: 2px 47px; }
      .boost-cycle-center { width: 47px; height: 47px; }
      .boost-emblem-core { width: 42px; height: 42px; }
      .boost-wing-upper-left { top: 6px; left: 4px; width: 16px; height: 19px; }
      .boost-wing-upper-right { top: 6px; right: 4px; width: 16px; height: 19px; }
      .boost-wing-lower-left { top: 22px; left: 7px; width: 13px; height: 14px; }
      .boost-wing-lower-right { top: 22px; right: 7px; width: 13px; height: 14px; }
      .boost-wing-body { top: 12px; width: 3px; height: 22px; }
      .boost-cycle-node { width: 22px; height: 22px; border-radius: 6px; }
      .boost-cycle-node svg { width: 12px; height: 12px; }
      .boost-cycle-node-bnb { top: 1px; left: 1px; }
      .boost-cycle-node-token { top: 40px; right: -6px; }
      .boost-cycle-node-output { bottom: 1px; left: 14px; }
      .boost-view-tab { min-height: 62px; gap: 8px; padding: 9px 10px; }
      .boost-view-tab-index { font-size: 20px; }
      .boost-view-tab-copy strong { font-size: 13px; }
      .boost-view-tab-copy small { display: none; }
      .boost-view-tab-arrow { width: 13px; height: 13px; }
      .boost-hero-corner { width: 20px; height: 20px; opacity: .5; }
      .boost-hero-corner-tl { display: none; }
      .boost-hero-corner-tr { top: 16px; right: 16px; }
      .boost-hero-corner-bl { bottom: 16px; left: 16px; }
      .boost-hero-corner-br { bottom: 16px; right: 16px; }
      .boost-empty-seal { width: 92px; height: 92px; }
      .boost-empty-seal-ray { left: -13px; width: 118px; }
      .boost-motes span:nth-child(n+7), .boost-atmosphere-beam-two { display: none; }
      .flap-boost-metrics > * { padding: .5rem .75rem; }
      .flap-boost-metrics > *:nth-child(3) { border-left: 0; }
      .boost-aura { opacity: .25; }
      .boost-choice { min-height: 44px; }
      .boost-choice > span:last-child { font-size: 11px; white-space: nowrap; }
    }
    .flap-boost-app[data-motion-paused="true"] *, .flap-boost-app[data-motion-paused="true"] *::before, .flap-boost-app[data-motion-paused="true"] *::after { animation-play-state: paused !important; }
    @media (prefers-reduced-motion: reduce) { .flap-boost-app *, .flap-boost-app *::before, .flap-boost-app *::after { animation: none !important; transition: none !important; } .boost-spark, .boost-motes { display: none; } }
  `}</style>
  );
}

function TaskForm({
  t,
  tokenAddress,
  setTokenAddress,
  lockedToken,
  tokenInfo,
  minTokensPerBNB,
  tokenReady,
  isLoadingToken,
  onLoadToken,
  buyMode,
  setBuyMode,
  minimumTrade,
  totalFee,
  feeMultiplier,
  bnbPerRound,
  setBnbPerRound,
  tokenAmountPerRound,
  setTokenAmountPerRound,
  balancePercentage,
  setBalancePercentage,
  maxBnbPerRound,
  setMaxBnbPerRound,
  intervalMinutes,
  setIntervalMinutes,
  outputMode,
  setOutputMode,
  splitOutputEnabled,
  splitSelected,
  setSplitSelected,
  splitValues,
  setSplitValues,
  distributionMode,
  setDistributionMode,
  retainRecipient,
  setRetainRecipient,
  recipientsText,
  setRecipientsText,
  randomRecipientCount,
  setRandomRecipientCount,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  tokenAddress: string;
  setTokenAddress: (value: string) => void;
  lockedToken: boolean;
  tokenInfo: TokenInfo | null;
  minTokensPerBNB: bigint | null;
  tokenReady: boolean;
  isLoadingToken: boolean;
  onLoadToken: () => void;
  buyMode: BuyMode;
  setBuyMode: (value: BuyMode) => void;
  minimumTrade: bigint | null;
  totalFee: bigint | null;
  feeMultiplier: bigint;
  bnbPerRound: string;
  setBnbPerRound: (value: string) => void;
  tokenAmountPerRound: string;
  setTokenAmountPerRound: (value: string) => void;
  balancePercentage: string;
  setBalancePercentage: (value: string) => void;
  maxBnbPerRound: string;
  setMaxBnbPerRound: (value: string) => void;
  intervalMinutes: string;
  setIntervalMinutes: (value: string) => void;
  outputMode: OutputMode;
  setOutputMode: (value: OutputMode) => void;
  splitOutputEnabled: boolean;
  splitSelected: SplitSelections;
  setSplitSelected: (value: SplitSelections) => void;
  splitValues: SplitInputs;
  setSplitValues: (value: SplitInputs) => void;
  distributionMode: DistributionMode;
  setDistributionMode: (value: DistributionMode) => void;
  retainRecipient: string;
  setRetainRecipient: (value: string) => void;
  recipientsText: string;
  setRecipientsText: (value: string) => void;
  randomRecipientCount: string;
  setRandomRecipientCount: (value: string) => void;
}) {
  const { context } = useFlapSdk();
  const fixedBnbValue = validBnbAmount(bnbPerRound) ? parseTokenAmount(bnbPerRound.trim(), 18) : null;
  const fixedBnbInvalid = buyMode === "fixed-bnb" &&
    (fixedBnbValue === null || (minimumTrade !== null && fixedBnbValue < minimumTrade));
  const maxBnbValue = optionalBnbAmount(maxBnbPerRound);
  const maxBnbInvalid = buyMode === "balance-percentage" &&
    (maxBnbValue === null || (minimumTrade !== null && maxBnbValue > 0n && maxBnbValue < minimumTrade));
  const balanceBps = percentageBpsOrNull(balancePercentage);
  const balancePercentageInvalid = buyMode === "balance-percentage" && balanceBps === null;
  const requiredBalance = minimumBalanceForPercentage(totalFee, minimumTrade, balanceBps);
  const splitFixedInvalid = splitOutputEnabled && splitSelected[1] && !validFixedRecipientsInput(recipientsText);
  const splitRandomInvalid = splitOutputEnabled && splitSelected[2] && !validRandomRecipientCount(randomRecipientCount);
  const outputOptions: Array<{ value: OutputMode; label: string }> = [
    { value: "burn", label: t("outputs.burn") },
    { value: "retain", label: t("outputs.retain") },
    { value: "distribute", label: t("outputs.distribute") },
  ];
  const buybackModes: Array<{ value: BuyMode; label: string; detail: string; icon: typeof CircleDollarSign }> = [
    {
      value: "fixed-bnb",
      label: t("modes.fixedBnb"),
      detail: t("modes.fixedBnbDetail"),
      icon: CircleDollarSign,
    },
    {
      value: "fixed-token",
      label: t("modes.tokenAmount"),
      detail: t("modes.tokenAmountDetail"),
      icon: Coins,
    },
    {
      value: "balance-percentage",
      label: t("modes.balanceShare"),
      detail: t("modes.balanceShareDetail"),
      icon: CirclePercent,
    },
  ];
  return (
    <div>
      {splitOutputEnabled ? (
        <section className="boost-form-step py-5">
          <SectionHeading index="01" icon={<Flame className="h-4 w-4" />} title={t("labels.outputType")} />
          <SplitOutputSelector
            t={t}
            selected={splitSelected}
            onSelected={setSplitSelected}
            values={splitValues}
            onValues={setSplitValues}
          />
        </section>
      ) : null}
      <section className="boost-form-step py-5">
        <SectionHeading index={splitOutputEnabled ? "02" : "01"} icon={<Target className="h-4 w-4" />} title={t("labels.targetToken")} />
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          {lockedToken ? (
            <div className="min-w-0 rounded-lg bg-[#071015] px-4 py-3 text-xs text-[#C2C2BB]">
              {tokenInfo ? <span className="mb-1 block font-semibold text-[#F6F2E8]">{tokenInfo.symbol}</span> : null}
              <p className="break-all font-mono">{tokenAddress}</p>
            </div>
          ) : (
            <Input
              aria-label={t("labels.targetToken")}
              className="h-11 rounded-lg border-[#50534F] bg-[#071015] px-4 font-mono text-sm text-[#F8F2E8] placeholder:text-[#6D8587] focus:border-[#DABF79]"
              value={tokenAddress}
              readOnly={lockedToken}
              onChange={(event) => {
                setTokenAddress(event.target.value);
              }}
              placeholder={t("placeholders.targetToken")}
            />
          )}
          {!lockedToken || !tokenInfo ? (
            <Button
              type="button"
              size="sm"
              className={GOLD_SECONDARY_BUTTON + " h-11 rounded-lg px-4 text-xs"}
              onClick={onLoadToken}
              disabled={isLoadingToken || !isValidAddress(tokenAddress.trim())}
            >
              {isLoadingToken ? t("buttons.loading") : t("buttons.loadToken")}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {tokenReady && tokenInfo && !lockedToken ? (
          <div className="boost-token-confirmation mt-3 grid gap-2 rounded-lg border border-[#5B5342] bg-[#151E24] px-3 py-2.5 text-xs text-[#C2C2BB] sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#DABF79]/15 text-[#E8D186]">
                <CircleCheck className="h-3.5 w-3.5" />
              </span>
              <span>{t("labels.loadedToken")}</span>
              <span className="font-semibold text-[#F6F2E8]">{tokenInfo.symbol}</span>
              <span className="font-mono text-[#85A4A6]">{shortAddress(tokenInfo.address)}</span>
            </div>
          </div>
        ) : null}
      </section>

      {!tokenReady ? (
        <p role="status" className="rounded-xl border border-[#6A5B3C] bg-[#1B1B17] px-4 py-3 text-sm text-[#E7CC87]">
          {t("help.loadCaBeforeRules")}
        </p>
      ) : null}
      <fieldset disabled={!tokenReady} className={"m-0 min-w-0 border-0 p-0 " + (!tokenReady ? "opacity-45" : "")}>
      <section className="boost-form-step py-5">
        <SectionHeading index={splitOutputEnabled ? "03" : "02"} icon={<Gauge className="h-4 w-4" />} title={t("labels.ruleSettings")} />
        <div className="mt-3 grid grid-cols-3 gap-2">
          {buybackModes.map((mode) => {
            const Icon = mode.icon;
            const selected = buyMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setBuyMode(mode.value)}
                className={
                  "boost-choice group relative flex items-center justify-center gap-2.5 overflow-hidden rounded-lg border p-2 text-center transition sm:justify-start sm:p-3 sm:text-left " +
                  (selected
                    ? "border-[#B99757] bg-[linear-gradient(145deg,#2F3029,#181D20)] shadow-[0_18px_34px_-28px_rgba(77,204,198,0.9)]"
                    : "border-[#3D454A] bg-[#0D1319] hover:border-[#766D55] hover:bg-[#172029]")
                }
              >
                {selected ? <span className="absolute inset-y-0 left-0 w-1 bg-[#DABF79]" /> : null}
                <span
                  className={
                    "hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg border sm:flex " +
                    (selected
                      ? "border-[#DABF79]/70 bg-[#DABF79] text-[#061417]"
                      : "border-[#645F50] bg-[#13242A] text-[#D4CBB4]")
                  }
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span
                  className={
                    "block text-xs font-semibold sm:text-sm " + (selected ? "text-[#F7F0DE]" : "text-[#CFD0CB]")
                  }
                >
                  {mode.label}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">
          {buybackModes.find((mode) => mode.value === buyMode)?.detail}
        </p>
        <div className={"mt-4 grid gap-3 sm:grid-cols-2 " + (buyMode === "balance-percentage" ? "lg:grid-cols-3" : "")}>
          {buyMode === "fixed-bnb" ? (
            <Field label={t("labels.bnbPerRound")}>
              <Input
                value={bnbPerRound}
                onChange={(event) => setBnbPerRound(event.target.value)}
                inputMode="decimal"
                placeholder={t("placeholders.bnb")}
                aria-invalid={fixedBnbInvalid}
                className={fixedBnbInvalid
                  ? "!border-[#D46A64] !text-[#FFBDB6] focus:!border-[#F18B82] focus:!ring-[#D46A64]/25"
                  : undefined}
              />
            </Field>
          ) : null}
          {buyMode === "fixed-token" ? (
            <Field label={t("labels.tokenAmountPerRound")}>
              <Input
                value={tokenAmountPerRound}
                onChange={(event) => setTokenAmountPerRound(event.target.value)}
                inputMode="decimal"
                placeholder={t("placeholders.tokens")}
              />
            </Field>
          ) : null}
          {buyMode === "balance-percentage" ? (
            <>
              <Field label={t("labels.balancePercentage")}>
                <Input
                  value={balancePercentage}
                  onChange={(event) => setBalancePercentage(event.target.value)}
                  inputMode="decimal"
                  placeholder={t("placeholders.percentage")}
                  aria-invalid={balancePercentageInvalid}
                  className={balancePercentageInvalid
                    ? "!border-[#D46A64] !text-[#FFBDB6] focus:!border-[#F18B82] focus:!ring-[#D46A64]/25"
                    : undefined}
                />
              </Field>
              <Field label={t("labels.maxBnbPerRound")}>
                <Input
                  value={maxBnbPerRound}
                  onChange={(event) => setMaxBnbPerRound(event.target.value)}
                  inputMode="decimal"
                  placeholder={t("placeholders.bnbOptional")}
                  aria-invalid={maxBnbInvalid}
                  className={maxBnbInvalid
                    ? "!border-[#D46A64] !text-[#FFBDB6] focus:!border-[#F18B82] focus:!ring-[#D46A64]/25"
                    : undefined}
                />
              </Field>
            </>
          ) : null}
          <Field label={t("labels.intervalMinutes")}>
            <Input
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(event.target.value)}
              inputMode="numeric"
              placeholder={t("placeholders.interval")}
            />
          </Field>
        </div>
        {buyMode === "balance-percentage" && requiredBalance !== null ? (
          <p className="mt-3 text-xs leading-5 text-[#A4AAA8]">
            {t("help.percentageSchedulingBalance", undefined, {
              amount: formatTokenAmount(requiredBalance, 18, 18),
            })}
          </p>
        ) : null}
        {balancePercentageInvalid ? (
          <p className="mt-3 text-xs leading-5 text-[#FFB5AF]">{t("errors.percentage")}</p>
        ) : null}
        {minimumTrade !== null && fixedBnbInvalid && fixedBnbValue !== null ? (
          <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs leading-5 text-[#FFB5AF]">
            {t("help.triggerFeeMinimumWarning", undefined, {
              amount: formatTokenAmount(minimumTrade, 18, 18),
              multiplier: feeMultiplier.toString(),
            })}
          </p>
        ) : null}
        {minimumTrade !== null && maxBnbInvalid && maxBnbValue !== null ? (
          <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs leading-5 text-[#FFB5AF]">
            {t("errors.capBelowTriggerMinimum", undefined, {
              amount: formatTokenAmount(minimumTrade, 18, 18),
            })}
          </p>
        ) : null}
      </section>

      {splitOutputEnabled && (splitSelected[1] || splitSelected[2]) ? (
        <section className="boost-form-step py-5">
          <SectionHeading index="04" icon={<Target className="h-4 w-4" />} title={t("labels.outputDetails")} />
          <div className={"mt-3 grid gap-4 " + (splitSelected[1] && splitSelected[2] ? "sm:grid-cols-2" : "")}>
            {splitSelected[1] ? (
              <Field label={t("labels.fixedRecipients")} hint={t("help.recipientsShort")}>
                <textarea
                  value={recipientsText}
                  onChange={(event) => setRecipientsText(event.target.value)}
                  placeholder={t("placeholders.fixedRecipients")}
                  rows={1}
                  aria-invalid={Boolean(recipientsText.trim()) && splitFixedInvalid}
                  className={"w-full min-h-11 resize-y rounded-lg border bg-[#071015] px-3 py-2.5 font-mono text-xs text-[#F6F2E8] outline-none " +
                    (recipientsText.trim() && splitFixedInvalid ? "border-[#D46A64] focus:border-[#F18B82]" : "border-[#50534F] focus:border-[#DABF79]")}
                />
              </Field>
            ) : null}
            {splitSelected[2] ? (
              <Field label={t("labels.randomHolderCount")} hint={t("help.randomHoldersShort")}>
                <Input
                  value={randomRecipientCount}
                  onChange={(event) => setRandomRecipientCount(event.target.value)}
                  inputMode="numeric"
                  placeholder={t("placeholders.randomHolders")}
                  aria-invalid={splitRandomInvalid}
                  className={splitRandomInvalid ? "!border-[#D46A64] !text-[#FFBDB6]" : undefined}
                />
              </Field>
            ) : null}
          </div>
        </section>
      ) : null}

      {!splitOutputEnabled ? <section className="boost-form-step py-5">
        <SectionHeading index="03" icon={<Flame className="h-4 w-4" />} title={t("labels.output")} />
        <div className="mt-4 grid grid-cols-3 gap-2">
          {outputOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              aria-pressed={outputMode === option.value}
              variant={outputMode === option.value ? "default" : "outline"}
              className={
                (outputMode === option.value ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) +
                " boost-output-choice h-11 rounded-lg justify-center px-2 text-xs sm:px-3 sm:text-sm"
              }
              onClick={() => setOutputMode(option.value)}
            >
              {option.value === "burn" ? <Flame className="h-3.5 w-3.5" /> : null}
              {option.label}
            </Button>
          ))}
        </div>
        {outputMode === "retain" ? (
          <div className="mt-4">
            <Field label={t("labels.retainWallet")} hint={t("help.retain")}>
              <Input
                value={retainRecipient}
                onChange={(event) => setRetainRecipient(event.target.value)}
                placeholder={t("placeholders.wallet")}
                className="font-mono text-xs"
              />
            </Field>
            {context.userAddress ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="mt-1 h-8 px-0 text-xs text-[#E1C978]"
                onClick={() => setRetainRecipient(context.userAddress!)}
              >
                {t("buttons.useMyWallet")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {outputMode === "distribute" ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm font-semibold text-[#F7E3A1]">{t("labels.distributionMode")}</p>
            <p className="mt-1 text-xs leading-5 text-[#BCA66A]">{t("help.distributionMode")}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(["fixed", "random"] as DistributionMode[]).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  variant={distributionMode === mode ? "default" : "outline"}
                  className={
                    (distributionMode === mode ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) +
                    " h-11 justify-center rounded-lg px-3 text-sm"
                  }
                  onClick={() => setDistributionMode(mode)}
                >
                  {mode === "fixed" ? t("outputs.fixedDistribution") : t("outputs.randomDistribution")}
                </Button>
              ))}
            </div>
            {distributionMode === "fixed" ? (
              <Field label={t("labels.fixedRecipients")} hint={t("help.recipients")}>
                <textarea
                  value={recipientsText}
                  onChange={(event) => setRecipientsText(event.target.value)}
                  placeholder={t("placeholders.fixedRecipients")}
                  rows={4}
                  className="w-full resize-y border border-[#5C4B1D] bg-[#080806] px-3 py-2.5 font-mono text-xs text-[#FFF2C4] outline-none transition placeholder:text-[#8B7A4D] focus:border-[#F0B90B]"
                />
              </Field>
            ) : (
              <Field label={t("labels.randomHolderCount")} hint={t("help.randomHolders")}>
                <Input
                  value={randomRecipientCount}
                  onChange={(event) => setRandomRecipientCount(event.target.value)}
                  inputMode="numeric"
                  placeholder={t("placeholders.randomHolders")}
                />
              </Field>
            )}
          </div>
        ) : null}
      </section> : null}
      </fieldset>
    </div>
  );
}

function SplitOutputSelector({
  t,
  selected,
  onSelected,
  values,
  onValues,
}: {
  t: (key: string) => string;
  selected: SplitSelections;
  onSelected: (value: SplitSelections) => void;
  values: SplitInputs;
  onValues: (value: SplitInputs) => void;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const labels = [t("outputs.burn"), t("outputs.fixedDistribution"), t("outputs.randomDistribution")];
  const colors = ["#E8C874", "#65C5C4", "#E99878"];
  const total = selected.reduce((sum, isSelected, index) => sum + (isSelected ? Number(values[index]) || 0 : 0), 0);
  let ringEnd = 0;
  const ringStops = selected.flatMap((isSelected, index) => {
    if (!isSelected) return [];
    const start = ringEnd;
    ringEnd = Math.min(100, ringEnd + Math.max(0, Number(values[index]) || 0));
    return ringEnd > start ? [`${colors[index]} ${start}% ${ringEnd}%`] : [];
  });
  if (ringEnd < 100) ringStops.push(`#263138 ${ringEnd}% 100%`);
  const ringBackground = `conic-gradient(${ringStops.join(", ")})`;
  let valid = false;
  try {
    parseOutputSplit(selected, values, t);
    valid = true;
  } catch { /* The inline error and disabled submit explain the invalid sum. */ }
  const incomplete = !valid && total < 100 && total > 0 && selected.every((isSelected, index) =>
    !isSelected || /^\d+$/.test(values[index]) && Number(values[index]) >= 1 && Number(values[index]) <= 100);
  const invalid = !valid && !incomplete;

  function updateShare(index: number, raw: string) {
    if (!/^\d*$/.test(raw)) return;
    const next = [...values] as SplitInputs;
    if (raw === "" || Number(raw) > 100) {
      next[index] = raw;
      onSelected(next.map((value) => Number(value) > 0) as SplitSelections);
      onValues(next);
      return;
    }
    const amount = Number(raw);
    const previous = Number(values[index]) || 0;
    next[index] = String(amount);
    let excess = Math.max(0, amount - previous - Math.max(0, 100 - total));
    for (let item = 0; item < next.length && excess > 0; item += 1) {
      if (item === index) continue;
      const available = Number(next[item]) || 0;
      const deducted = Math.min(excess, available);
      next[item] = String(available - deducted);
      excess -= deducted;
    }
    onSelected(next.map((value) => Number(value) > 0) as SplitSelections);
    onValues(next);
  }

  return (
    <div className="mt-4">
      <div className="flex min-h-12 items-center justify-between gap-4 border-b border-[#3D454A] pb-3">
        <p className={"text-sm " + (!invalid ? "text-[#D8D2C5]" : "text-[#FFB5AF]")}>
          {t("labels.splitTotal")} <strong className="font-mono text-[#F6E6BC]">{Number.isInteger(total) ? total : "—"}%</strong>
          {total < 100 ? <span className="ml-3 text-[#A5AFAD]">{t("labels.splitRemaining")} {100 - total}%</span> : null}
        </p>
        <button type="button" onClick={() => { onSelected([true, false, false]); onValues(["100", "0", "0"]); }}
          className="h-9 w-24 shrink-0 rounded-md border border-[#596062] px-3 text-xs text-[#E9DFCB] transition hover:border-[#E8C874] hover:text-[#E8C874]">
          {t("buttons.resetSplit")}
        </button>
      </div>
      <div className="grid gap-6 pt-4 lg:grid-cols-[210px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <div className="flex flex-col items-center lg:items-stretch">
        <div className="boost-split-ring mx-auto grid size-40 place-items-center rounded-full p-4" data-adjusting={draggingIndex !== null} style={{ background: ringBackground }}>
          <div className="grid size-full place-items-center rounded-full bg-[#0B141A] font-mono text-2xl font-semibold text-[#F7E9C6]">
            {Number.isInteger(total) ? total : "—"}%
          </div>
        </div>
        <div className="mx-auto mt-4 w-full max-w-[190px] space-y-1.5">
          {labels.map((label, index) => (
            <div key={label} className={"flex items-center gap-2 text-xs " + (selected[index] ? "text-[#BFC9C8]" : "text-[#718082]")}>
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: selected[index] ? colors[index] : "#46535A" }} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className={"font-mono " + (selected[index] ? "text-[#F3E7CC]" : "text-[#718082]")}>{values[index]}%</span>
            </div>
          ))}
          {total < 100 ? (
            <div className="flex items-center gap-2 text-xs text-[#BFC9C8]">
              <span className="size-2 shrink-0 rounded-full bg-[#46535A]" />
              <span className="min-w-0 flex-1 truncate">{t("labels.splitRemaining")}</span>
              <span className="font-mono text-[#BFC9C8]">{100 - total}%</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="min-w-0">
        <div>
          {labels.map((label, index) => (
            <div key={label} className="grid min-h-[100px] grid-rows-[36px_32px] content-center gap-2 border-b border-[#2E3A40] last:border-b-0">
              <div className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-[#F2E9D7]">
                  <span className="size-3 shrink-0 rounded-full transition-shadow duration-200"
                    style={{ backgroundColor: selected[index] ? colors[index] : "#46535A", boxShadow: selected[index] ? `0 0 12px ${colors[index]}88` : "none" }} />
                  <span className="truncate">{label}</span>
                </div>
                <label className="flex items-center justify-end gap-1 text-sm text-[#C5B88F]">
                  <Input aria-label={`${label} ${t("labels.splitPercent")}`} aria-invalid={invalid}
                    inputMode="numeric"
                    value={values[index]}
                    onChange={(event) => updateShare(index, event.target.value)}
                    className={"!h-9 !w-[72px] rounded-md bg-[#071015] text-right font-mono text-sm " +
                      (invalid ? "!border-[#D46A64] !text-[#FFBDB6]" : "border-[#50534F]")}
                  />%
                </label>
              </div>
              <input type="range" min={0} max={100} step={1}
                aria-label={`${label} ${t("labels.splitPercent")}`}
                value={Math.max(0, Math.min(100, Number(values[index]) || 0))}
                onChange={(event) => updateShare(index, event.target.value)}
                onPointerDown={() => setDraggingIndex(index)}
                onPointerUp={() => setDraggingIndex(null)}
                onPointerCancel={() => setDraggingIndex(null)}
                onBlur={() => setDraggingIndex(null)}
                className="boost-split-slider ml-5 block w-[calc(100%-1.25rem)] cursor-pointer"
                style={{ "--split-color": selected[index] ? colors[index] : "#56636A", "--split-progress": `${Math.max(0, Math.min(100, Number(values[index]) || 0))}%` } as CSSProperties} />
            </div>
          ))}
        </div>
      </div>
      </div>
      {invalid ? <p className="mt-2 text-xs text-[#FFB5AF]" role="alert">{t("errors.outputSplit")}</p> : null}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="boost-field block min-w-0">
      <span className="block text-sm font-medium text-[#F1EAD9]">{label}</span>
      {hint ? <span className="mt-1 block text-xs leading-5 text-[#A4AAA8]">{hint}</span> : null}
      <span className="mt-2 block [&_input]:h-11 [&_input]:rounded-lg [&_input]:border-[#50534F] [&_input]:bg-[#071015] [&_input]:px-3.5 [&_input]:font-mono [&_input]:text-sm [&_input]:text-[#F6F2E8] [&_input]:placeholder:text-[#668183] [&_input]:focus:border-[#DABF79]">
        {children}
      </span>
    </label>
  );
}

function SectionHeading({ index, icon, title }: { index: string; icon: ReactNode; title: string }) {
  return (
    <div className="boost-step-heading flex items-center gap-2.5">
      <span className="boost-step-index font-mono text-[11px] font-semibold tracking-[0.12em] text-[#D8BC76]">{index}</span>
      <span className="h-px w-5 bg-[#756647]" />
      <span className="text-[#E6CC86]">{icon}</span>
      <h3 className="text-sm font-semibold text-[#F6F2E8]">{title}</h3>
    </div>
  );
}

function TaskList({
  t,
  tasks,
  selectedTaskAddress,
  onSelect,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  tasks: TaskSnapshot[];
  selectedTaskAddress: string | null;
  onSelect: (key: string) => void;
}) {
  const [page, setPage] = useState(0);
  const selectedIndex = tasks.findIndex((task) => taskKey(task) === selectedTaskAddress);
  useEffect(() => {
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / TASKS_PER_PAGE));
  }, [selectedTaskAddress, selectedIndex]);
  if (!tasks.length) return null;
  const pageCount = Math.ceil(tasks.length / TASKS_PER_PAGE);
  const currentPage = Math.min(page, pageCount - 1);
  const pageTasks = tasks.slice(currentPage * TASKS_PER_PAGE, (currentPage + 1) * TASKS_PER_PAGE);
  const goToPage = (nextPage: number) => {
    setPage(nextPage);
    onSelect(taskKey(tasks[nextPage * TASKS_PER_PAGE]));
  };
  return (
    <div className="grid gap-3">
      {pageTasks.map((task) => {
        const selected = taskKey(task) === selectedTaskAddress;
        const status = t(taskStatusKey(task));
        return (
          <button
            key={taskKey(task)}
            type="button"
            aria-pressed={selected}
            className={
              "boost-task group w-full rounded-xl border p-4 text-left transition duration-200 " +
              (selected
                ? "border-[#B99757] bg-[linear-gradient(100deg,#20292C,#151B21_60%,#16110E)] shadow-[inset_3px_0_0_#DABF79,0_16px_30px_-28px_rgba(82,213,206,0.92)]"
                : "border-[#394148] bg-[#091015] hover:border-[#426970] hover:bg-[#0D171C]")
            }
            onClick={() => onSelect(taskKey(task))}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-semibold">
                  <span className="text-[#F4FAF9]">{task.token.symbol}</span>
                  <span className="text-[#F0CB9D]">· {task.outputMode === 4 ? t("labels.outputSplit") : outputRuleLabel(t, task.outputMode)}</span>
                  <span className="font-mono text-xs font-medium text-[#959993]">#{task.operationId + 1}</span>
                </div>
                <p className="mt-2 text-base text-[#CDD0C8]">
                  <span className="text-[#829E9F]">{t("labels.roundRule")} </span>
                  <span className="font-mono font-semibold text-[#F8F2E7]">{taskRuleDetail(t, task)}</span>
                  <span className="mx-2.5 text-[#6F7470]">·</span>
                  <span className="text-[#829E9F]">{t("labels.interval")} </span>
                  <span className="font-semibold text-[#F8F2E7]">
                    {formatTokenAmount(task.interval / 60n, 0)} {t("labels.minutes")}
                  </span>
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-[#29434A] pt-3 sm:justify-end sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
                <div className="text-left sm:text-right">
                  <span className="text-xs text-[#A5AAA5]">{t("labels.totalSpent")}</span>
                  <p className="mt-1 font-mono text-lg font-semibold text-[#F4CE82]">
                    {formatTokenAmount(task.totalBNBSpent, 18)} BNB
                  </p>
                </div>
                <StatusBadge
                  muted={!task.active || task.paused}
                  live={task.active && !task.paused && Boolean(task.triggerId || task.callbackInProgress)}
                >
                  {status}
                </StatusBadge>
              </div>
            </div>
          </button>
        );
      })}
      {pageCount > 1 ? (
        <nav className="flex flex-wrap items-center justify-between gap-3 pt-1" aria-label={t("labels.taskPages")}>
          <span className="text-xs text-[#A4AAA8]">
            {t("labels.pageOf", undefined, { page: currentPage + 1, total: pageCount })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={GOLD_OUTLINE_BUTTON + " h-9 rounded-lg px-3 text-xs"}
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 0}
            >
              {t("buttons.previousPage")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={GOLD_OUTLINE_BUTTON + " h-9 rounded-lg px-3 text-xs"}
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage === pageCount - 1}
            >
              {t("buttons.nextPage")}
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function TaskOverview({
  t,
  locale,
  task,
  canWrite,
  isOwner,
  buttonState,
  onUpdate,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  locale: string;
  task: TaskSnapshot;
  canWrite: boolean;
  isOwner: boolean;
  buttonState: TxButtonState;
  onUpdate: (update: TaskRuleUpdate, splitBps?: SplitShares) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const output = outputFromValue(task.outputMode);
  const isSplit = task.outputMode === 4;
  const outputDetail =
    isSplit
      ? [
          task.outputSplit[1] ? t("labels.recipientCount", undefined, { count: task.recipients.length }) : "",
          task.outputSplit[2] ? t("labels.randomHoldersPerRound", undefined, { count: task.randomRecipientCount }) : "",
        ].filter(Boolean).join(" · ")
      : output === "retain"
      ? shortAddress(task.retainRecipient)
      : output === "distribute"
        ? distributionFromValue(task.outputMode) === "random"
          ? `${t("labels.randomHoldersPerRound", undefined, { count: task.randomRecipientCount })} · ${t("labels.randomHoldersTotal", undefined, { count: task.totalRandomHolders.toString() })}`
          : t("labels.recipientCount", undefined, { count: task.recipients.length })
        : "";
  return (
    <section className="boost-detail overflow-hidden rounded-2xl border border-[#394148] bg-[#0B1014] shadow-[inset_0_1px_0_rgba(190,246,241,0.035)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2.5 text-base font-semibold text-[#F8F2E8]">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#846F49] bg-[#11282C] text-[#E6CB88]">
            <Flame className="h-4 w-4" />
          </span>
          {t("sections.taskOverview")}
        </div>
        {isOwner && task.active ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={GOLD_OUTLINE_BUTTON + " h-9 rounded-lg px-3 text-xs"}
            onClick={() => setEditing((value) => !value)}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {editing ? t("buttons.cancel") : t("buttons.editRules")}
          </Button>
        ) : null}
      </div>
      <dl className="divide-y divide-[#394148] border-t border-[#394148] px-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
          <dt className="text-xs text-[#9DA5A5]">{t("labels.buybackMode")}</dt>
          <dd className="text-right text-sm text-[#F6F2E8]">
            <span className="font-semibold">{buyModeLabel(t, task.buyMode)}</span>
            <span className="ml-2 font-mono text-[#C4C2B8]">{taskRuleDetail(t, task)}</span>
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
          <dt className="text-xs text-[#9DA5A5]">{t("labels.interval")}</dt>
          <dd className="font-mono text-sm font-semibold text-[#F6F2E8]">
            {formatTokenAmount(task.interval / 60n, 0)} {t("labels.minutes")}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
          <dt className="text-xs text-[#9DA5A5]">{t("labels.output")}</dt>
          <dd className="text-right text-sm text-[#F6F2E8]">
            <span className="font-semibold">{outputRuleLabel(t, task.outputMode, task.outputSplit)}</span>
            <span className="ml-2 text-[#C4C2B8]">{outputDetail}</span>
          </dd>
        </div>
        {task.started && task.active && !task.paused && task.nextEligibleAt > 0n ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
            <dt className="text-xs text-[#9DA5A5]">{t("labels.nextEligible")}</dt>
            <dd className="text-xs text-[#F6F2E8]">
              {new Date(Number(task.nextEligibleAt) * 1000).toLocaleString(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-[#394148] bg-[#0D171B] px-4 py-3 sm:px-5">
        <span className="text-xs text-[#9DA5A5]">
          {t(
            isSplit ? "labels.totalTokensOut" : output === "burn"
              ? "labels.totalBurned"
              : output === "retain"
                ? "labels.totalRetained"
                : "labels.totalDistributed",
          )}
        </span>
        <span className="font-mono text-base font-semibold text-[#F6F2E8]">
          {formatTokenAmount(task.totalTokensOutput, task.token.decimals)} {task.token.symbol}
        </span>
      </div>
      <details className="group border-t border-[#394148] px-4 py-3 sm:px-5">
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs text-[#A4AAA8]">
          {t("labels.priceProtection")}
          <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" />
        </summary>
        <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("help.priceProtection")}</p>
        <p className="mt-1 font-mono text-xs text-[#BDD2CF]">
          {formatTokenAmount(task.minTokensPerBNB, task.token.decimals)} {task.token.symbol} / BNB
        </p>
      </details>
      {task.pendingRuleUpdate ? (
        <p className="mx-4 mb-4 mt-3 rounded-lg border border-[#555033] bg-[#1A1710] px-3 py-2 text-xs leading-5 text-[#D5C585] sm:mx-5">
          {t("states.rulesQueued")}
        </p>
      ) : null}
      {isOwner && task.active && editing ? (
        <div className="border-t border-[#394148] p-4 sm:p-5">
          <TaskRuleEditor
            t={t}
            task={task}
            canWrite={canWrite}
            buttonState={buttonState}
            onCancel={() => setEditing(false)}
            onSave={async (update, splitBps) => {
              if (await onUpdate(update, splitBps)) setEditing(false);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function TaskRuleEditor({
  t,
  task,
  canWrite,
  buttonState,
  onCancel,
  onSave,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  task: TaskSnapshot;
  canWrite: boolean;
  buttonState: TxButtonState;
  onCancel: () => void;
  onSave: (update: TaskRuleUpdate, splitBps?: SplitShares) => Promise<void>;
}) {
  const mode = buyModeFromValue(task.buyMode);
  const rules = task.pendingRuleUpdate ?? task;
  const [fixedBnb, setFixedBnb] = useState(formatTokenAmount(rules.fixedBNBPerRound, 18, 18));
  const [fixedTokens, setFixedTokens] = useState(
    formatTokenAmount(rules.fixedTokenAmountPerRound, task.token.decimals, 18),
  );
  const [balanceShare, setBalanceShare] = useState((rules.balanceBps / 100).toString());
  const [maxBnb, setMaxBnb] = useState(
    rules.maxBNBPerRound === 0n ? "" : formatTokenAmount(rules.maxBNBPerRound, 18, 18),
  );
  const [intervalMinutes, setIntervalMinutes] = useState((rules.interval / 60n).toString());
  const [output, setOutput] = useState<OutputMode>(outputFromValue(rules.outputMode));
  const isSplit = rules.outputMode === 4;
  const initialSplit = task.pendingOutputSplit ?? task.outputSplit;
  const [splitSelected, setSplitSelected] = useState<SplitSelections>(initialSplit.map((share) => share > 0) as SplitSelections);
  const [splitValues, setSplitValues] = useState<SplitInputs>(initialSplit.map(formatSplitShare) as SplitInputs);
  const [distributionMode, setDistributionMode] = useState<DistributionMode>(distributionFromValue(rules.outputMode));
  const [retainRecipient, setRetainRecipient] = useState(
    rules.retainRecipient === ZERO_ADDRESS ? "" : rules.retainRecipient,
  );
  const [recipientsText, setRecipientsText] = useState(rules.recipients.join("\n"));
  const [randomRecipientCount, setRandomRecipientCount] = useState(String(rules.randomRecipientCount || 5));
  const [formError, setFormError] = useState<string | null>(null);
  const minimumTrade = triggerTradeMinimum(task);
  const enteredFixedBnb = mode === "fixed-bnb" && validBnbAmount(fixedBnb)
    ? parseTokenAmount(fixedBnb.trim(), 18)
    : null;
  const fixedBnbInvalid = mode === "fixed-bnb" &&
    (enteredFixedBnb === null || (minimumTrade !== null && enteredFixedBnb < minimumTrade));
  const enteredMaxBnb = optionalBnbAmount(maxBnb);
  const maxBnbInvalid = mode === "balance-percentage" &&
    (enteredMaxBnb === null || (minimumTrade !== null && enteredMaxBnb > 0n && enteredMaxBnb < minimumTrade));
  const balanceBps = percentageBpsOrNull(balanceShare);
  const balancePercentageInvalid = mode === "balance-percentage" && balanceBps === null;
  const requiredBalance = minimumBalanceForPercentage(
    task.triggerFee === null ? null : task.triggerFee + task.bookingFee, minimumTrade, balanceBps,
  );
  const splitFixedInvalid = isSplit && splitSelected[1] && !validFixedRecipientsInput(recipientsText);
  const splitRandomInvalid = isSplit && splitSelected[2] && !validRandomRecipientCount(randomRecipientCount);

  function submitRules() {
    try {
      const interval = parseInterval(intervalMinutes, t);

      let fixedBNBPerRound = 0n;
      let fixedTokenAmountPerRound = 0n;
      let balanceBps = 0;
      let maxBNBPerRound = 0n;
      if (mode === "fixed-bnb") {
        fixedBNBPerRound = parseAmount(fixedBnb, 18, t);
        if (fixedBNBPerRound <= 0n) throw new Error(t("errors.amount"));
        if (minimumTrade !== null && fixedBNBPerRound < minimumTrade) {
          throw new Error(t("errors.roundBelowTriggerMinimum", undefined, {
            amount: formatTokenAmount(minimumTrade, 18, 18),
          }));
        }
      } else if (mode === "fixed-token") {
        fixedTokenAmountPerRound = parseAmount(fixedTokens, task.token.decimals, t);
        if (fixedTokenAmountPerRound <= 0n) throw new Error(t("errors.amount"));
      } else {
        balanceBps = parsePercentageToBps(balanceShare, t);
        maxBNBPerRound = maxBnb.trim() ? parseAmount(maxBnb, 18, t) : 0n;
        if (maxBNBPerRound < 0n) throw new Error(t("errors.amount"));
        if (minimumTrade !== null && maxBNBPerRound > 0n && maxBNBPerRound < minimumTrade) {
          throw new Error(t("errors.capBelowTriggerMinimum", undefined, {
            amount: formatTokenAmount(minimumTrade, 18, 18),
          }));
        }
      }

      const recipients = recipientsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      let outputMode = 0;
      let randomCount = 0;
      let recipient = ZERO_ADDRESS;
      const splitBps = isSplit ? parseOutputSplit(splitSelected, splitValues, t) : undefined;
      if (splitBps) {
        outputMode = 4;
        if (splitBps[1] > 0) {
          if (!validFixedRecipientsInput(recipientsText)) throw new Error(t("errors.fixedRecipients"));
        } else recipients.length = 0;
        if (splitBps[2] > 0) randomCount = parseRandomHolderCount(randomRecipientCount, t);
      } else if (output === "retain") {
        if (!isValidAddress(retainRecipient.trim()) || retainRecipient.trim() === ZERO_ADDRESS)
          throw new Error(t("errors.retainWallet"));
        outputMode = 1;
        recipient = retainRecipient.trim() as Address;
      } else if (output === "distribute") {
        if (distributionMode === "random") {
          randomCount = parseRandomHolderCount(randomRecipientCount, t);
          recipients.length = 0;
          outputMode = 3;
        } else {
          const unique = new Set(recipients.map((value) => value.toLowerCase()));
          if (
            recipients.length < 1 ||
            recipients.length > 5 ||
            unique.size !== recipients.length ||
            recipients.some((value) => !isValidAddress(value) || value === ZERO_ADDRESS)
          ) {
            throw new Error(t("errors.fixedRecipients"));
          }
          outputMode = 2;
        }
      }

      setFormError(null);
      onSave({
        fixedBNBPerRound,
        fixedTokenAmountPerRound,
        balanceBps,
        maxBNBPerRound,
        interval,
        outputMode,
        randomRecipientCount: randomCount,
        retainRecipient: recipient,
        recipients: recipients as Address[],
      }, splitBps);
    } catch (nextError) {
      setFormError(nextError instanceof Error ? nextError.message : t("errors.amount"));
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-[#5B5342] bg-[#0A151A] p-3.5 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#424746] pb-3">
        <span className="text-xs font-semibold tracking-[0.08em] text-[#84D9D3]">{buyModeLabel(t, task.buyMode)}</span>
        <span className="text-xs text-[#9AB3B3]">{t("help.editModeFixed")}</span>
      </div>
      <div className={"mt-3 grid gap-3 sm:grid-cols-2 " + (mode === "balance-percentage" ? "lg:grid-cols-3" : "")}>
        {mode === "fixed-bnb" ? (
          <CompactField label={t("labels.bnbPerRound")}>
            <Input
              value={fixedBnb}
              onChange={(event) => setFixedBnb(event.target.value)}
              inputMode="decimal"
              aria-invalid={fixedBnbInvalid}
              className={fixedBnbInvalid
                ? "!border-[#D46A64] !text-[#FFBDB6] focus:!border-[#F18B82] focus:!ring-[#D46A64]/25"
                : undefined}
            />
          </CompactField>
        ) : null}
        {mode === "fixed-token" ? (
          <CompactField label={t("labels.tokenAmountPerRound")}>
            <Input value={fixedTokens} onChange={(event) => setFixedTokens(event.target.value)} inputMode="decimal" />
          </CompactField>
        ) : null}
        {mode === "balance-percentage" ? (
          <>
            <CompactField label={t("labels.balancePercentage")}>
              <Input
                value={balanceShare}
                onChange={(event) => setBalanceShare(event.target.value)}
                inputMode="decimal"
                aria-invalid={balancePercentageInvalid}
                className={balancePercentageInvalid
                  ? "!border-[#D46A64] !text-[#FFBDB6] focus:!border-[#F18B82] focus:!ring-[#D46A64]/25"
                  : undefined}
              />
            </CompactField>
            <CompactField label={t("labels.maxBnbPerRound")}>
              <Input
                value={maxBnb}
                onChange={(event) => setMaxBnb(event.target.value)}
                inputMode="decimal"
                placeholder={t("placeholders.bnbOptional")}
                aria-invalid={maxBnbInvalid}
                className={maxBnbInvalid
                  ? "!border-[#D46A64] !text-[#FFBDB6] focus:!border-[#F18B82] focus:!ring-[#D46A64]/25"
                  : undefined}
              />
            </CompactField>
          </>
        ) : null}
        <CompactField label={t("labels.intervalMinutes")}>
          <Input
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
            inputMode="numeric"
          />
        </CompactField>
      </div>
      {mode === "balance-percentage" && requiredBalance !== null ? (
        <p className="mt-3 text-xs leading-5 text-[#A4AAA8]">
          {t("help.percentageSchedulingBalance", undefined, {
            amount: formatTokenAmount(requiredBalance, 18, 18),
          })}
        </p>
      ) : null}
      {balancePercentageInvalid ? (
        <p className="mt-3 text-xs leading-5 text-[#FFB5AF]">{t("errors.percentage")}</p>
      ) : null}
      {mode === "fixed-bnb" && enteredFixedBnb === null ? (
        <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs leading-5 text-[#FFB5AF]">
          {t("errors.amount")}
        </p>
      ) : null}
      {mode === "fixed-bnb" && minimumTrade !== null && enteredFixedBnb !== null ? (
        <p className={
          "mt-3 rounded-lg border px-3 py-2 text-xs leading-5 " +
          (fixedBnbInvalid
            ? "border-[#874A4A] bg-[#2A1518] text-[#FFB5AF]"
            : "border-[#29474D] bg-[#0D1B20] text-[#A9C7C6]")
        }>
          {t(fixedBnbInvalid
            ? "help.triggerFeeMinimumWarning"
            : "help.triggerFeeMinimum", undefined, {
            amount: formatTokenAmount(minimumTrade, 18, 18),
            multiplier: task.totalFeeMultiplier?.toString() ?? "",
          })}
        </p>
      ) : null}
      {mode === "balance-percentage" && enteredMaxBnb === null ? (
        <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs leading-5 text-[#FFB5AF]">
          {t("errors.amount")}
        </p>
      ) : null}
      {mode === "balance-percentage" && minimumTrade !== null && maxBnbInvalid && enteredMaxBnb !== null ? (
        <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs leading-5 text-[#FFB5AF]">
          {t("errors.capBelowTriggerMinimum", undefined, {
            amount: formatTokenAmount(minimumTrade, 18, 18),
          })}
        </p>
      ) : null}
      <div className="mt-4 border-t border-[#424746] pt-4">
        <p className="text-sm font-medium text-[#F1EAD9]">{t("labels.output")}</p>
        <p className="mt-1 text-xs leading-5 text-[#D5C585]">{t("help.editOutputRisk")}</p>
        {isSplit ? <SplitOutputSelector
          t={t}
          selected={splitSelected}
          onSelected={setSplitSelected}
          values={splitValues}
          onValues={setSplitValues}
        /> : (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {(["burn", "retain", "distribute"] as OutputMode[]).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={output === option ? "default" : "outline"}
              className={
                (output === option ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) +
                " h-10 justify-center rounded-lg px-3 text-xs"
              }
              onClick={() => setOutput(option)}
            >
              {outputLabel(t, option)}
            </Button>
          ))}
        </div>
        )}
      </div>
      {isSplit && splitSelected[1] ? (
        <div className="mt-3">
          <CompactField label={t("labels.fixedRecipients")} hint={t("help.recipientsShort")}>
            <textarea
              value={recipientsText}
              onChange={(event) => setRecipientsText(event.target.value)}
              rows={1}
              aria-invalid={Boolean(recipientsText.trim()) && splitFixedInvalid}
              className={"w-full min-h-11 resize-y rounded-lg border bg-[#071015] px-3 py-2 font-mono text-xs text-[#F6F2E8] outline-none " +
                (recipientsText.trim() && splitFixedInvalid ? "border-[#D46A64] focus:border-[#F18B82]" : "border-[#50534F] focus:border-[#DABF79]")}
            />
          </CompactField>
        </div>
      ) : null}
      {isSplit && splitSelected[2] ? (
        <div className="mt-3">
          <CompactField label={t("labels.randomHolderCount")} hint={t("help.randomHoldersShort")}>
            <Input
              value={randomRecipientCount}
              onChange={(event) => setRandomRecipientCount(event.target.value)}
              inputMode="numeric"
              aria-invalid={splitRandomInvalid}
              className={splitRandomInvalid ? "!border-[#D46A64] !text-[#FFBDB6]" : undefined}
            />
          </CompactField>
        </div>
      ) : null}
      {!isSplit && output === "retain" ? (
        <div className="mt-3">
          <CompactField label={t("labels.retainWallet")} hint={t("help.retain")}>
            <Input
              value={retainRecipient}
              onChange={(event) => setRetainRecipient(event.target.value)}
              className="font-mono text-xs"
            />
          </CompactField>
        </div>
      ) : null}
      {!isSplit && output === "distribute" ? (
        <div className="mt-3 rounded-lg border border-[#5A481C] bg-[#100E09] p-3">
          <p className="text-sm font-medium text-[#F7E3A1]">{t("labels.distributionMode")}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(["fixed", "random"] as DistributionMode[]).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={distributionMode === mode ? "default" : "outline"}
                className={
                  (distributionMode === mode ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) +
                  " h-10 justify-center rounded-lg px-3 text-xs"
                }
                onClick={() => setDistributionMode(mode)}
              >
                {mode === "fixed" ? t("outputs.fixedDistribution") : t("outputs.randomDistribution")}
              </Button>
            ))}
          </div>
          {distributionMode === "fixed" ? (
            <label className="mt-3 block">
              <span className="text-sm font-medium text-[#F7E3A1]">{t("labels.fixedRecipients")}</span>
              <span className="mt-1 block text-xs leading-5 text-[#BCA66A]">{t("help.recipients")}</span>
              <textarea
                value={recipientsText}
                onChange={(event) => setRecipientsText(event.target.value)}
                rows={3}
                className="mt-3 w-full resize-y rounded-md border border-[#5C4B1D] bg-[#080806] px-3 py-2 font-mono text-xs text-[#FFF2C4] outline-none focus:border-[#F0B90B]"
              />
            </label>
          ) : (
            <div className="mt-3">
              <CompactField label={t("labels.randomHolderCount")} hint={t("help.randomHolders")}>
                <Input
                  value={randomRecipientCount}
                  onChange={(event) => setRandomRecipientCount(event.target.value)}
                  inputMode="numeric"
                  placeholder={t("placeholders.randomHolders")}
                />
              </CompactField>
            </div>
          )}
        </div>
      ) : null}
      {formError ? (
        <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs text-[#FFB5AF]">
          {formError}
        </p>
      ) : null}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={GOLD_OUTLINE_BUTTON + " h-10 rounded-lg px-4 text-xs"}
          onClick={onCancel}
        >
          {t("buttons.cancel")}
        </Button>
        <TxButton
          className={GOLD_PRIMARY_BUTTON + " h-10 rounded-lg px-4 text-xs"}
          idleLabel={t("buttons.saveRules")}
          state={buttonState}
          onClick={submitRules}
          disabled={!canWrite || fixedBnbInvalid || maxBnbInvalid || balancePercentageInvalid ||
            (isSplit && (!validOutputSplit(splitSelected, splitValues, t) || splitFixedInvalid || splitRandomInvalid))}
        />
      </div>
    </div>
  );
}

function CompactField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="block text-sm font-medium text-[#F1EAD9]">{label}</span>
      {hint ? <span className="mt-1 block text-xs leading-5 text-[#A4AAA8]">{hint}</span> : null}
      <span className="mt-2 block [&_input]:h-10 [&_input]:rounded-md [&_input]:border-[#50534F] [&_input]:bg-[#071015] [&_input]:px-3 [&_input]:font-mono [&_input]:text-sm [&_input]:text-[#F6F2E8] [&_input]:focus:border-[#DABF79]">
        {children}
      </span>
    </label>
  );
}

function TaskFunding({
  t,
  task,
  canWrite,
  canTrade,
  hasActiveOperations,
  isOwner,
  fundingAmount,
  setFundingAmount,
  withdrawAmount,
  setWithdrawAmount,
  buttonState,
  onFund,
  onWithdraw,
  onSetWithdrawMax,
  onPause,
  onResume,
  onClose,
  onCheck,
  onSettle,
  onRecover,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  task: TaskSnapshot;
  canWrite: boolean;
  canTrade: boolean;
  hasActiveOperations: boolean;
  isOwner: boolean;
  fundingAmount: string;
  setFundingAmount: (value: string) => void;
  withdrawAmount: string;
  setWithdrawAmount: (value: string) => void;
  buttonState: (key: string) => TxButtonState;
  onFund: () => void;
  onWithdraw: () => void;
  onSetWithdrawMax: () => void;
  onPause: () => void;
  onResume: () => void;
  onClose: () => void;
  onCheck: () => void;
  onSettle: () => void;
  onRecover: () => void;
}) {
  const [fundsTab, setFundsTab] = useState<"fund" | "withdraw">(hasActiveOperations ? "fund" : "withdraw");
  const [confirmClose, setConfirmClose] = useState(false);
  const status = t(taskStatusKey(task));
  const minimumTrade = triggerTradeMinimum(task);
  const tab = !hasActiveOperations && isOwner ? "withdraw" : fundsTab;
  const startWithFunding = tab === "fund" && isOwner && task.active && !task.paused && !task.started;
  return (
    <section className="boost-detail rounded-2xl border border-[#394148] bg-[#0B1014] p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2.5 text-base font-semibold text-[#F8F2E8]">
          <Wallet className="h-4 w-4 text-[#E6CB88]" />
          {t("sections.taskFunds")}
        </h3>
        <span className="text-xs text-[#A4AAA8]">{task.token.symbol}</span>
      </div>
      <div className="boost-fund-balance rounded-xl border border-[#29474D] bg-[#0D1B20] px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-2">
          <div>
            <p className="text-xs text-[#9DA5A5]">{t("labels.totalBnb")}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-tight text-[#F6F2E8]">
              {formatTokenAmount(taskTotalBNB(task), 18)}{" "}
              <span className="text-sm font-normal text-[#C4C2B8]">BNB</span>
            </p>
          </div>
          <p className="text-xs text-[#9DA5A5]">
            {t("labels.availableBnb")}{" "}
            <span className="ml-1 font-mono font-semibold text-[#E1C978]">
              {formatTokenAmount(task.availableBNB, 18)} BNB
            </span>
          </p>
        </div>
        {task.reservedBNB > 0n ? (
          <p className="mt-2 border-t border-[#29474D] pt-2 text-xs text-[#9DA5A5]">
            {t("labels.reservedBnb")} <span className="font-mono">{formatTokenAmount(task.reservedBNB, 18)} BNB</span>
          </p>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-5 text-[#989F9E]">{t("help.sharedFunds")}</p>
      <div className="mt-4">
        <div className="mb-3 flex gap-5 border-b border-[#394148]" role="group" aria-label={t("labels.fundsActions")}>
          {hasActiveOperations ? (
            <button
              type="button"
              aria-pressed={tab === "fund"}
              onClick={() => setFundsTab("fund")}
              className={
                "border-b-2 pb-2 text-sm font-medium transition " +
                (tab === "fund"
                  ? "border-[#DABF79] text-[#EEDCAC]"
                  : "border-transparent text-[#989F9E] hover:text-[#EEDCAC]")
              }
            >
              {t("buttons.fund")}
            </button>
          ) : null}
          {isOwner ? (
            <button
              type="button"
              aria-pressed={tab === "withdraw"}
              onClick={() => setFundsTab("withdraw")}
              className={
                "border-b-2 pb-2 text-sm font-medium transition " +
                (tab === "withdraw"
                  ? "border-[#DABF79] text-[#EEDCAC]"
                  : "border-transparent text-[#989F9E] hover:text-[#EEDCAC]")
              }
            >
              {t("buttons.withdraw")}
            </button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              aria-label={t(tab === "fund" ? "labels.funding" : "labels.withdraw")}
              className="h-11 rounded-lg border-[#50534F] bg-[#071015] pl-3 pr-14 font-mono text-sm text-[#F6F2E8] placeholder:text-[#668183]"
              value={tab === "fund" ? fundingAmount : withdrawAmount}
              onChange={(event) =>
                tab === "fund" ? setFundingAmount(event.target.value) : setWithdrawAmount(event.target.value)
              }
              inputMode="decimal"
              placeholder={t("placeholders.bnb")}
            />
            {tab === "withdraw" ? (
              <button
                type="button"
                className="absolute inset-y-1 right-1 rounded-md px-2 text-xs font-medium text-[#83D9D3] hover:bg-[#142B30] disabled:opacity-40"
                onClick={onSetWithdrawMax}
                disabled={!task.availableBNB || !canWrite}
              >
                {t("buttons.max")}
              </button>
            ) : (
              <span className="pointer-events-none absolute right-3 top-3 text-xs text-[#989F9E]">BNB</span>
            )}
          </div>
          <TxButton
            className={GOLD_PRIMARY_BUTTON + " h-11 shrink-0 rounded-lg px-4 text-xs"}
            idleLabel={t(tab === "fund" ? (startWithFunding ? "buttons.fundAndStart" : "buttons.fund") : "buttons.withdraw")}
            state={buttonState((tab === "fund" ? "fund:" : "withdraw:") + task.address)}
            onClick={tab === "fund" ? onFund : onWithdraw}
            disabled={
              !canWrite ||
              (tab === "fund" ? !validBnbAmount(fundingAmount) : !validBnbAmount(withdrawAmount, task.availableBNB))
            }
          />
        </div>
        {tab === "withdraw" && task.reservedBNB > 0n ? (
          <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("help.reservedFunds")}</p>
        ) : null}
      </div>
      <div className="mt-5 border-t border-[#394148] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-[#F1EAD9]">
            {t("labels.operationNumber", undefined, { id: task.operationId + 1 })}
          </p>
          <StatusBadge
            muted={!task.active || task.paused || !task.started}
            live={task.active && !task.paused && Boolean(task.triggerId || task.callbackInProgress)}
          >
            {status}
          </StatusBadge>
        </div>
        {task.pendingTokens > 0n ? (
          <div className="mt-3 rounded-lg border border-[#695734] bg-[#19170E] p-3">
            <p className="text-xs leading-5 text-[#E2CEA1]">
              {t("help.pendingOutput", undefined, {
                id: Number(task.pendingOperationId) + 1,
                amount: formatTokenAmount(task.pendingTokens, task.token.decimals),
                symbol: task.token.symbol,
              })}
            </p>
            <TxButton
              className={GOLD_SECONDARY_BUTTON + " mt-3 h-10 w-full rounded-lg px-3 text-xs"}
              idleLabel={t("buttons.settleOutput")}
              state={buttonState("settle:" + task.address)}
              onClick={onSettle}
              disabled={!canWrite || task.callbackInProgress}
              variant="secondary"
            />
          </div>
        ) : null}
        {!task.active ? (
          <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("states.closedHint")}</p>
        ) : task.paused ? (
          <>
            <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("states.pausedHint")}</p>
            <TxButton
              className={GOLD_PRIMARY_BUTTON + " mt-3 h-11 w-full rounded-lg px-4 text-sm"}
              idleLabel={t("buttons.resume")}
              state={buttonState("resume:" + task.address)}
              onClick={onResume}
              disabled={!canWrite || !isOwner}
            />
          </>
        ) : !task.started ? (
          <>
            <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("help.firstDirect")}</p>
            {isOwner && canStartTask(task) ? (
              <TxButton
                className={GOLD_SECONDARY_BUTTON + " mt-3 h-10 w-full rounded-lg px-3 text-xs"}
                idleLabel={t("buttons.checkAndStart")}
                state={buttonState("start:" + task.address)}
                onClick={onCheck}
                disabled={!canTrade}
                variant="secondary"
              />
            ) : null}
          </>
        ) : task.vaultTriggerId ? (
          task.triggerFailed ? (
            <div className="mt-3 rounded-lg border border-[#695734] bg-[#19170E] p-3">
              <p className="text-xs leading-5 text-[#E2CEA1]">{t("states.triggerFailedHint")}</p>
              {isOwner ? (
                <TxButton
                  className={GOLD_SECONDARY_BUTTON + " mt-3 h-10 w-full rounded-lg px-3 text-xs"}
                  idleLabel={t("buttons.recoverTrigger")}
                  state={buttonState("recover:" + task.address)}
                  onClick={onRecover}
                  disabled={!canWrite}
                  variant="secondary"
                />
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">
              {t(task.triggerId ? "states.scheduledHint" : "states.queuedHint", undefined, {
                id: Number(task.scheduledOperationId) + 1,
              })}
            </p>
          )
        ) : task.pendingTokens === 0n ? (
          <>
            {taskStatusKey(task) === "states.feeGuard" && minimumTrade !== null ? (
              <p className="mt-2 rounded-lg border border-[#695734] bg-[#19170E] px-3 py-2 text-xs leading-5 text-[#E2CEA1]">
                {t(feeGuardCause(task) === "cap" ? "states.feeGuardCapHint" : "states.feeGuardHint", undefined, {
                  amount: formatTokenAmount(minimumTrade, 18, 18),
                  multiplier: task.totalFeeMultiplier?.toString() ?? "",
                })}
              </p>
            ) : taskStatusKey(task) === "states.needsFunding" ? (
              <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("states.needsFundingHint")}</p>
            ) : (
              <>
                <p className="mt-2 text-xs leading-5 text-[#A4AAA8]">{t("states.readyToSchedule")}</p>
                <TxButton
                  className={GOLD_SECONDARY_BUTTON + " mt-3 h-10 w-full rounded-lg px-3 text-xs"}
                  idleLabel={t("buttons.checkFunds")}
                  state={buttonState("poke:" + task.address)}
                  onClick={onCheck}
                  disabled={!canWrite || task.callbackInProgress}
                  variant="secondary"
                />
              </>
            )}
          </>
        ) : null}
        {task.consecutiveFailures > 0 ? (
          <p className="mt-3 rounded-lg border border-[#695734] bg-[#19170E] px-3 py-2 text-xs leading-5 text-[#E2CEA1]">
            {t("help.retryStatus", undefined, { count: task.consecutiveFailures })}
          </p>
        ) : null}
      </div>
      {isOwner && task.active ? (
        <details className="group mt-4 border-t border-[#394148] pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs text-[#A4AAA8]">
            {t("labels.operationManagement")}
            <ChevronRight className="h-4 w-4 transition group-open:rotate-90" />
          </summary>
          <div className="mt-3">
            {confirmClose ? (
              <div className="rounded-lg border border-[#784A3C] bg-[#21160F] p-3">
                <p className="text-xs leading-5 text-[#EBC8A8]">{t("help.closeOperation")}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <TxButton
                    className={GOLD_OUTLINE_BUTTON + " h-10 px-3 text-xs"}
                    idleLabel={t("buttons.confirmClose")}
                    state={buttonState("close:" + task.address)}
                    onClick={onClose}
                    disabled={!canWrite}
                    variant="outline"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-10 px-3 text-xs"
                    onClick={() => setConfirmClose(false)}
                    disabled={!canWrite}
                  >
                    {t("buttons.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {!task.paused ? (
                  <TxButton
                    className={GOLD_OUTLINE_BUTTON + " h-10 rounded-lg px-3 text-xs"}
                    idleLabel={t("buttons.pause")}
                    state={buttonState("pause:" + task.address)}
                    onClick={onPause}
                    disabled={!canWrite}
                    variant="outline"
                  />
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-10 px-3 text-xs text-[#C7998C] hover:text-[#F1B6A5]"
                  onClick={() => setConfirmClose(true)}
                  disabled={!canWrite}
                >
                  {t("buttons.closeTask")}
                </Button>
              </div>
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}
