"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActionAvailabilityStage, Address, VaultComponentProps } from "@/src/sdk";
import {
  ZERO_ADDRESS,
  erc20Abi,
  formatTokenAmount,
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
const GOLD_PRIMARY_BUTTON =
  "boost-cta text-[#211907] [--ui20-chamfer-bg:#E8C874] [--ui20-chamfer-border:#F4D994] shadow-[0_12px_28px_-16px_rgba(232,200,116,0.8)] hover:[--ui20-chamfer-bg:#F7DFA0] hover:[--ui20-chamfer-border:#FFE7AD]";
const GOLD_SECONDARY_BUTTON =
  "text-[#F0D690] [--ui20-chamfer-bg:#1D1E1D] [--ui20-chamfer-border:#8A7346] hover:text-[#FFF2C5] hover:[--ui20-chamfer-bg:#29251B] hover:[--ui20-chamfer-border:#E2BD69]";
const GOLD_OUTLINE_BUTTON =
  "text-[#D9C38A] [--ui20-chamfer-bg:#10151A] [--ui20-chamfer-border:#665840] hover:text-[#FFF1C6] hover:[--ui20-chamfer-border:#D2AE64]";

type OutputMode = "burn" | "retain" | "distribute";
type DistributionMode = "fixed" | "random";
type BuyMode = "fixed-bnb" | "fixed-token" | "balance-percentage";
type TaskAction = "pause" | "resume" | "close";

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
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
  randomRecipientCount: number;
  retainRecipient: Address;
  recipients: Address[];
  active: boolean;
  paused: boolean;
  started: boolean;
  startFeeCharged: boolean;
  startFeeOwed: bigint;
  startFee: bigint;
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

function taskTotalBNB(task: TaskSnapshot) {
  return task.availableBNB + task.reservedBNB + task.startFeeOwed;
}

function canStartTask(task: TaskSnapshot) {
  if (!task.active || task.paused || task.started || task.callbackInProgress || task.pendingTokens > 0n) return false;
  const fee = task.startFeeCharged ? 0n : task.startFee;
  if (task.availableBNB <= fee) return false;
  const budget = task.availableBNB - fee;
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
  if (task.availableBNB === 0n || (task.buyMode === 0 && task.availableBNB < task.fixedBNBPerRound))
    return "states.needsFunding";
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

function outputRuleLabel(t: (key: string) => string, value: number) {
  const output = outputFromValue(value);
  if (output !== "distribute") return outputLabel(t, output);
  return distributionFromValue(value) === "random" ? t("outputs.randomDistribution") : t("outputs.fixedDistribution");
}

function parseRandomHolderCount(value: string, t: (key: string) => string) {
  if (!/^\d+$/.test(value.trim())) throw new Error(t("errors.randomHolders"));
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(t("errors.randomHolders"));
  return count;
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
  const [readState, setTaskReadState] = useState<"loading" | "disconnected" | "ready" | "error">("loading");
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const [selectedTaskAddress, setSelectedTaskAddress] = useState<string | null>(null);
  // Existing operations are the source of truth for the workspace. The host
  // context token is useful when creating a new operation, but it must not
  // hide a Vault that the connected wallet already owns for another token.
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxButtonState>("idle");
  const [showCreateTask, setShowCreateTask] = useState(false);
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
  const readIdentity = `${context.chainId}:${factoryAddress}:${context.userAddress?.toLowerCase() ?? ""}`;
  const tasks = useMemo(
    () => (loadedIdentity === readIdentity ? taskSnapshots : []),
    [loadedIdentity, readIdentity, taskSnapshots],
  );
  const taskReadState = !context.userAddress ? "disconnected" : loadedIdentity === readIdentity ? readState : "loading";
  const canWrite = Boolean(
    context.userAddress && factoryAddress && taskReadState === "ready" && !wrongNetwork && activeAction === null,
  );
  const canTrade = canWrite && actionsAvailable;
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
    setDistributionMode("fixed");
    setShowCreateTask(true);
    setRetainRecipient("");
    setRecipientsText("");
    if (activeTokenAddress) void loadToken(activeTokenAddress);
  }

  function selectToken(address: Address) {
    setSelectedTokenAddress(address);
    const first = tasks.find((task) => task.token.address.toLowerCase() === address.toLowerCase());
    setSelectedTaskAddress(first ? taskKey(first) : null);
    setShowCreateTask(false);
    setFundingAmount("");
    setWithdrawAmount("");
  }

  function selectTask(key: string) {
    setSelectedTaskAddress(key);
    setFundingAmount("");
    setWithdrawAmount("");
  }

  function beginNewToken() {
    setSelectedTokenAddress("");
    setSelectedTaskAddress(null);
    setShowCreateTask(true);
    setOutputMode("burn");
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

  const config = useMemo<TaskConfig | Error>(() => {
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
      if (outputMode === "retain") {
        if (!isValidAddress(retainRecipient.trim()) || retainRecipient.trim() === ZERO_ADDRESS)
          throw new Error(t("errors.retainWallet"));
        outputModeValue = 1;
        recipient = retainRecipient.trim() as Address;
      }
      if (outputMode === "distribute") {
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
        return { mode: buyMode, options, bnbPerRound: amount };
      }
      if (buyMode === "fixed-token") {
        const tokenAmount = parseAmount(tokenAmountPerRound, tokenInfo.decimals, t);
        if (tokenAmount <= 0n) throw new Error(t("errors.amount"));
        return { mode: buyMode, options, tokenAmountPerRound: tokenAmount };
      }
      const balanceBps = parsePercentageToBps(balancePercentage, t);
      const optionalMaxBNB = maxBnbPerRound.trim() ? parseAmount(maxBnbPerRound, 18, t) : 0n;
      if (optionalMaxBNB < 0n) throw new Error(t("errors.amount"));
      return { mode: buyMode, options, balanceBps, maxBNBPerRound: optionalMaxBNB };
    } catch (nextError) {
      return nextError instanceof Error ? nextError : new Error(t("errors.amount"));
    }
  }, [
    balancePercentage,
    bnbPerRound,
    buyMode,
    distributionMode,
    intervalMinutes,
    maxBnbPerRound,
    outputMode,
    recipientsText,
    randomRecipientCount,
    retainRecipient,
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
      const allVaultAddresses = await sdk.readContract<Address[]>({
        contract: "boostFactory",
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "vaultsOf",
        args: [context.userAddress],
      });
      const vaultRows = await mapInBatches([...allVaultAddresses].reverse(), VAULT_READ_BATCH_SIZE, async (address) => {
        const [
          owner,
          targetToken,
          count,
          startFeeCharged,
          startFeeOwed,
          startFee,
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
          sdk.readContract<boolean>({
            contract: "boostVault",
            address,
            abi: vaultAbi,
            functionName: "startFeeCharged",
          }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "startFeeOwed" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "START_FEE" }),
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
          startFeeCharged,
          startFeeOwed,
          startFee,
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
          randomRecipientCount: operation.randomRecipientCount,
          retainRecipient: operation.retainRecipient,
          recipients: operation.recipients,
          active: operation.active,
          paused: operation.paused,
          started: operation.started,
          startFeeCharged: vault.startFeeCharged,
          startFeeOwed: vault.startFeeOwed,
          startFee: vault.startFee,
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
  }, [context.userAddress, factoryAddress, readIdentity, sdk, t, triggerAddress]);

  useEffect(() => {
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
  }, [loadTasks, sdk.refetchNonce]);

  useEffect(() => {
    const identity = `${context.chainId}:${context.tokenAddress.toLowerCase()}`;
    if (loadedContextTokenRef.current === identity) return;
    loadedContextTokenRef.current = identity;
    setShowCreateTask(false);
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
        const message = handleTxError(nextError, { simulationFailed: t("errors.simulation"), unknown: t("errors.tx") });
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
    if (!canTrade || !factoryAddress || config instanceof Error || operationCountForInput >= 24) {
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
        const simulation =
          config.mode === "fixed-bnb"
            ? await sdk.simulateContract({
                contract: "boostFactory",
                address: factoryAddress,
                abi: factoryAbi,
                functionName: "createFixedBNBOperation",
                args: [options, config.bnbPerRound],
              })
            : config.mode === "fixed-token"
              ? await sdk.simulateContract({
                  contract: "boostFactory",
                  address: factoryAddress,
                  abi: factoryAbi,
                  functionName: "createFixedTokenAmountOperation",
                  args: [options, config.tokenAmountPerRound],
                })
              : await sdk.simulateContract({
                  contract: "boostFactory",
                  address: factoryAddress,
                  abi: factoryAbi,
                  functionName: "createBalancePercentageOperation",
                  args: [options, config.balanceBps, config.maxBNBPerRound],
                });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        await sdk.waitForTx(hash);
        setSelectedTokenAddress(config.options.targetToken);
        setSelectedTaskAddress(null);
        setShowCreateTask(false);
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
          });
          setTxState("writing");
          const hash = await sdk.writeContract(simulation.request);
          setTxState("confirming");
          await sdk.waitForTx(hash);
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
          await sdk.waitForTx(hash);
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
        await sdk.waitForTx(hash);
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
        await sdk.waitForTx(hash);
      },
      t(starting ? "messages.started" : "messages.checked"),
    );
  }

  async function updateTaskRules(task: TaskSnapshot, update: TaskRuleUpdate): Promise<boolean> {
    if (!canWrite || !selectedTaskIsOwner || !task.active) return false;
    return runAction(
      "rules:" + task.address,
      async () => {
        setTxState("simulating");
        const simulation = await sdk.simulateContract({
          contract: "boostVault",
          address: task.address,
          abi: vaultAbi,
          functionName: "updateOperation",
          args: [BigInt(task.operationId), update],
        });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        await sdk.waitForTx(hash);
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
        await sdk.waitForTx(hash);
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
        await sdk.waitForTx(hash);
      },
      t("messages.triggerRecovered"),
    );
  }

  const marketPhaseLabel =
    marketPhase === "internal-market"
      ? t("badges.marketInternal")
      : marketPhase === "dex-listed"
        ? t("badges.marketDex")
        : t("badges.marketUnknown");
  return (
    <div
      data-busy={activeAction !== null}
      data-motion-paused={motionPaused}
      className="flap-boost-app mx-auto min-h-screen w-full max-w-[1080px] px-2 pb-8 pt-2 sm:px-4 sm:pt-4"
    >
      <BoostMotionStyles />
      <OnchainProgressOverlay t={t} state={txState} visible={activeAction !== null} />
      <Card className="flap-boost-shell overflow-hidden rounded-[20px]">
        <CardHeader className="boost-header px-5 pb-7 pt-7 sm:px-8 sm:pb-9 sm:pt-9">
          <div className="boost-atmosphere" aria-hidden="true">
            <span className="boost-aura boost-aura-blue" />
            <span className="boost-aura boost-aura-gold" />
            <span className="boost-grid" />
            <span className="boost-atmosphere-beam boost-atmosphere-beam-one" />
            <span className="boost-atmosphere-beam boost-atmosphere-beam-two" />
            <span className="boost-motes">
              {Array.from({ length: 10 }, (_, index) => <span key={index} />)}
            </span>
            <span className="boost-spark boost-spark-one" />
            <span className="boost-spark boost-spark-two" />
            <span className="boost-spark boost-spark-three" />
          </div>
          <div className="boost-hero-layout">
            <div className="boost-hero-copy min-w-0">
              <div className="boost-kicker">
                <span className="boost-kicker-dot" />
                <span>FLAP BOOST</span>
                <span className="boost-kicker-divider" />
                <span>{t("badges.automation")}</span>
              </div>
              <CardTitle className="boost-hero-title mt-5 text-[30px] font-semibold leading-tight tracking-tight sm:text-[38px]">
                {t("sections.controlCenter")}
              </CardTitle>
              <p className="mt-3 max-w-xl text-sm leading-6 text-[#B4B6B2] sm:text-[15px]">{t("subtitle")}</p>
              <div className="boost-hero-steps mt-7" aria-label={t("sections.engine")}>
                <span><b>01</b>{t("workflow.create")}</span>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                <span><b>02</b>{t("workflow.fund")}</span>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                <span><b>03</b>{t("workflow.execute")}</span>
              </div>
            </div>
            <div className="boost-hero-side">
              <StatusBadge muted={!actionsAvailable}>{marketPhaseLabel}</StatusBadge>
              <div className="boost-hero-emblem" aria-hidden="true">
                <span className="boost-emblem-halo" />
                <span className="boost-emblem-sweep" />
                <span className="boost-emblem-orbit boost-emblem-orbit-outer" />
                <span className="boost-emblem-orbit boost-emblem-orbit-inner" />
                <span className="boost-emblem-ripple boost-emblem-ripple-one" />
                <span className="boost-emblem-ripple boost-emblem-ripple-two" />
                <span className="boost-emblem-core">
                  <span className="boost-wing boost-wing-upper-left" />
                  <span className="boost-wing boost-wing-upper-right" />
                  <span className="boost-wing boost-wing-lower-left" />
                  <span className="boost-wing boost-wing-lower-right" />
                  <span className="boost-wing-body" />
                </span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="boost-content space-y-4 px-3 pb-4 pt-4 sm:px-6 sm:pb-6 sm:pt-5">
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

          {context.userAddress && tasks.length > 0 ? (
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
            <div className="boost-workspace-header flex items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5">
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
                  <span className="hidden sm:inline">{t(motionPaused ? "buttons.resumeMotion" : "buttons.pauseMotion")}</span>
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
                {ownedTokens.length > 0 && !showCreateTask ? (
                  <Button
                    type="button"
                    size="sm"
                    className={GOLD_PRIMARY_BUTTON + " h-10 flex-1 rounded-lg px-4 text-xs sm:flex-none"}
                    onClick={beginNewToken}
                    disabled={activeAction !== null}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("buttons.newToken")}
                  </Button>
                ) : null}
              </div>
            </div>
            {ownedTokens.length ? (
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
                <div className="boost-vault-panel-head flex min-h-[124px] items-center justify-between gap-3 border-b border-[#67583B] px-4 py-4 sm:px-6">
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
                    <div className="boost-vault-sequence mt-3 flex items-center gap-1.5" aria-hidden="true">
                      <span /><i /><span /><i /><span />
                    </div>
                  </div>
                  <div className="boost-vault-visual hidden shrink-0 sm:block" aria-hidden="true">
                    <span className="boost-vault-visual-grid" />
                    <span className="boost-vault-ring boost-vault-ring-outer" />
                    <span className="boost-vault-ring boost-vault-ring-inner" />
                    <span className="boost-vault-visual-core"><Wallet className="h-5 w-5" strokeWidth={1.6} /></span>
                    <span className="boost-vault-beacon boost-vault-beacon-one" />
                    <span className="boost-vault-beacon boost-vault-beacon-two" />
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="relative z-10 self-start px-2 text-xs text-[#BDB9AB]" onClick={() => setShowCreateTask(false)}>
                    <X className="h-4 w-4" />
                    {t("buttons.cancel")}
                  </Button>
                </div>
                <div className="p-3 sm:p-5">
                  <TaskForm
                    t={t}
                    tokenAddress={tokenAddressInput}
                    setTokenAddress={updateTokenAddress}
                    lockedToken={Boolean(activeTokenAddress)}
                    tokenInfo={tokenInfo}
                    minTokensPerBNB={minTokensPerBNB}
                    isLoadingToken={tokenLookupLoading}
                    onLoadToken={() => void loadToken(tokenAddressInput)}
                    buyMode={buyMode}
                    setBuyMode={setBuyMode}
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
                <div className="flex flex-col gap-3 border-t border-[#474840] bg-[#091116]/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="min-w-0 text-xs leading-5 text-[#9AB6B5]">
                    <p>{t("help.createThenFund")}</p>
                    {operationCountForInput >= 24 ? (
                      <p className="mt-1 text-[#E9BC77]">{t("errors.operationLimit")}</p>
                    ) : config instanceof Error ? (
                      <p className="mt-1 text-[#E9BC77]">{config.message}</p>
                    ) : (
                      <p className="mt-1 text-[#F6F2E8]">
                        {buyModeLabel(t, buyMode === "fixed-bnb" ? 0 : buyMode === "fixed-token" ? 1 : 2)} ·{" "}
                        {intervalMinutes} {t("labels.minutes")} · {outputLabel(t, outputMode)}
                      </p>
                    )}
                    {!context.userAddress ? <p className="mt-1">{t("help.connectToCreate")}</p> : null}
                  </div>
                  <TxButton
                    className={GOLD_PRIMARY_BUTTON + " h-11 w-full rounded-lg px-6 text-sm sm:w-auto"}
                    idleLabel={t(hasExistingVaultForInput ? "buttons.createTask" : "buttons.createVault")}
                    state={buttonState("create-task")}
                    onClick={() => void createTask()}
                    disabled={!canTrade || tokenLookupLoading || config instanceof Error || operationCountForInput >= 24}
                  />
                </div>
              </div>
            ) : null}

            <div className="px-4 pb-4 sm:px-5 sm:pb-5">
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
                  <span className="boost-empty-icon flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl">
                    {taskReadState === "loading" ? (
                      <RefreshCw className="h-6 w-6 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Coins className="h-6 w-6" strokeWidth={1.5} />
                    )}
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
            </div>
          </section>

          {selectedTask && !showCreateTask ? (
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(23rem,0.72fr)]">
              <TaskFunding
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
              />
              <TaskOverview
                key={taskKey(selectedTask)}
                t={t}
                locale={i18n.locale}
                task={selectedTask}
                canWrite={canWrite}
                isOwner={selectedTaskIsOwner}
                buttonState={buttonState("rules:" + selectedTask.address)}
                onUpdate={(update) => updateTaskRules(selectedTask, update)}
              />
            </section>
          ) : null}
        </CardContent>
      </Card>
    </div>
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
    .boost-header::after { content: ""; pointer-events: none; position: absolute; inset: auto 0 0; height: 1px; background: linear-gradient(90deg, transparent, #E8C775, #FFF2B6, transparent); box-shadow: 0 0 20px #DEB96988; }
    .boost-atmosphere { position: absolute; pointer-events: none; inset: 0; overflow: hidden; z-index: 0; }
    .boost-aura { position: absolute; width: 540px; height: 330px; border-radius: 50%; filter: blur(15px); animation: boostDrift 16s ease-in-out infinite alternate; }
    .boost-aura-blue { top: -160px; left: -170px; background: radial-gradient(ellipse, #42628533, transparent 70%); }
    .boost-aura-gold { top: -130px; right: -180px; background: radial-gradient(ellipse, #C39D4F3D, transparent 68%); animation-delay: -7s; }
    .boost-grid { position: absolute; inset: 0; opacity: .45; background-image: linear-gradient(#D8C1900A 1px, transparent 1px), linear-gradient(90deg, #D8C1900A 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(#0008, transparent 86%); }
    .boost-atmosphere-beam { position: absolute; width: 56%; height: 1px; left: -56%; background: linear-gradient(90deg, transparent, #F8E6AF9C 45%, #FFF4D6 52%, transparent); box-shadow: 0 0 12px #EDCE8480; transform: rotate(-18deg); animation: boostBeam 10s ease-in-out infinite; }
    .boost-atmosphere-beam-one { top: 24%; }.boost-atmosphere-beam-two { top: 68%; animation-delay: -5s; opacity: .6; }
    .boost-motes { position: absolute; inset: 0; }
    .boost-motes span { position: absolute; left: var(--x); top: var(--y); width: var(--size, 2px); height: var(--size, 2px); border-radius: 50%; background: #FFF1BE; box-shadow: 0 0 9px 2px #E9C77A88; animation: boostMote var(--duration, 7s) ease-in-out var(--delay, 0s) infinite; }
    .boost-motes span:nth-child(1) { --x: 7%; --y: 24%; --delay: -1s; --duration: 6s; }.boost-motes span:nth-child(2) { --x: 14%; --y: 73%; --delay: -5s; --size: 3px; }.boost-motes span:nth-child(3) { --x: 29%; --y: 17%; --delay: -3s; }.boost-motes span:nth-child(4) { --x: 39%; --y: 79%; --delay: -6s; --duration: 9s; }.boost-motes span:nth-child(5) { --x: 52%; --y: 35%; --delay: -2s; --size: 3px; }.boost-motes span:nth-child(6) { --x: 61%; --y: 14%; --delay: -7s; }.boost-motes span:nth-child(7) { --x: 75%; --y: 64%; --delay: -4s; --duration: 8s; }.boost-motes span:nth-child(8) { --x: 86%; --y: 27%; --delay: -2s; --size: 3px; }.boost-motes span:nth-child(9) { --x: 92%; --y: 81%; --delay: -5s; }.boost-motes span:nth-child(10) { --x: 47%; --y: 56%; --delay: -8s; --duration: 10s; }
    .boost-spark { position: absolute; width: 2px; height: 2px; border-radius: 50%; background: #FFF3BD; box-shadow: 0 0 12px 2px #F2D78799; animation: boostSpark 9s ease-in-out infinite; }
    .boost-spark-one { top: 86px; left: 45%; }
    .boost-spark-two { top: 38px; left: 80%; animation-delay: -3s; }
    .boost-spark-three { top: 190px; left: 24%; animation-delay: -6s; }
    .boost-hero-layout { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0,1fr) 185px; gap: 18px; min-height: 196px; align-items: center; }
    .boost-hero-title { color: #FAF4E7; text-shadow: 0 2px 20px #D3B67417; }
    .boost-hero-copy > * { animation: boostReveal 720ms cubic-bezier(.2,.8,.2,1) both; }
    .boost-hero-copy > :nth-child(2) { animation-delay: 90ms; }
    .boost-hero-copy > :nth-child(3) { animation-delay: 180ms; }
    .boost-hero-copy > :nth-child(4) { animation-delay: 270ms; }
    .boost-kicker { display: flex; align-items: center; gap: 9px; color: #D8BD79; font: 700 10px/1.3 ui-monospace, monospace; letter-spacing: .18em; }
    .boost-kicker-dot { width: 6px; height: 6px; border-radius: 50%; background: #EBD28A; box-shadow: 0 0 10px #F6DA85; }
    .boost-kicker-divider { width: 18px; height: 1px; background: #8A754D; }
    .boost-hero-side { display: flex; height: 100%; flex-direction: column; align-items: flex-end; justify-content: space-between; }
    .boost-hero-emblem { position: relative; width: 164px; height: 164px; display: grid; place-items: center; overflow: clip; contain: paint; margin: -3px 8px 0 0; }
    .boost-emblem-halo { position: absolute; inset: 7px; border-radius: 50%; background: radial-gradient(circle, #ECC9773D 0%, #B9943924 30%, transparent 66%); filter: blur(10px); animation: boostBreathe 5s ease-in-out infinite; }
    .boost-emblem-sweep { position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 64%, #FFF2BB 74%, transparent 81%); -webkit-mask: radial-gradient(transparent 61%, #000 63% 66%, transparent 68%); mask: radial-gradient(transparent 61%, #000 63% 66%, transparent 68%); filter: drop-shadow(0 0 10px #FFE6A0); animation: boostOrbit 8s linear infinite; }
    .boost-emblem-orbit { position: absolute; border-radius: 50%; animation: boostOrbit 24s linear infinite; }
    .boost-emblem-orbit-outer { inset: 9px; border: 1px solid #B8955370; border-top-color: #F8E3A8; border-bottom-color: #F8E3A8; box-shadow: 0 0 18px #D5B46D30, inset 0 0 18px #D5B46D1A; }
    .boost-emblem-orbit-outer::before, .boost-emblem-orbit-outer::after { content: ""; position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #FFF1BA; box-shadow: 0 0 9px #FFF1BA; }
    .boost-emblem-orbit-outer::before { top: 14px; left: 18px; }.boost-emblem-orbit-outer::after { bottom: 14px; right: 18px; }
    .boost-emblem-orbit-inner { inset: 28px; border: 1px dashed #CFB16E66; animation-direction: reverse; animation-duration: 16s; }
    .boost-emblem-ripple { position: absolute; inset: 43px; border: 1px solid #FBE4A7A0; border-radius: 50%; box-shadow: 0 0 14px #EAC9786B; animation: boostRipple 4s ease-out infinite; }.boost-emblem-ripple-two { animation-delay: -2s; }
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
    .boost-content { background: linear-gradient(180deg, #0D1117 0%, #090C10 100%); }
    .flap-boost-workspace { border: 1px solid #353B42; background: linear-gradient(145deg, #111923, #0B1017 46%, #0A0D11); box-shadow: inset 0 1px 0 #FFFFFF0A; }
    .boost-workspace-header { position: relative; overflow: hidden; border-bottom: 1px solid #343A3E; background: linear-gradient(90deg, #17202A99, #10151B80); }
    .boost-workspace-header::after { content: ""; pointer-events: none; position: absolute; bottom: 0; left: -38%; width: 38%; height: 1px; background: linear-gradient(90deg, transparent, #FCE3A6, transparent); box-shadow: 0 0 12px #E8C570; animation: boostRail 9s ease-in-out infinite; }
    .boost-workspace-icon { border: 1px solid #8E774B88; color: #E7CC87; background: linear-gradient(145deg, #352D20, #151A1F); box-shadow: inset 0 1px 0 #F9DFA329; }
    .boost-workspace-icon { animation: boostIconBreathe 7s ease-in-out infinite; }
    .boost-motion-toggle { color: #B9B2A2; }.boost-motion-toggle:hover { color: #FFE3A0; background: #51432935; }.boost-motion-toggle[aria-pressed="true"] { color: #F0D18A; background: #54442935; }
    .boost-empty { position: relative; isolation: isolate; overflow: hidden; border: 1px solid #3D4144; background: radial-gradient(circle at 6% 50%, #C59B3520, transparent 34%), linear-gradient(110deg, #121B25, #0A1017); box-shadow: inset 0 1px 0 #FFF4D00C; }
    .boost-empty::before { content: ""; position: absolute; inset: -70% -20%; z-index: 0; background: radial-gradient(ellipse at 35% 50%, #D9B4651C, transparent 43%); animation: boostCloud 11s ease-in-out infinite alternate; }
    .boost-empty::after { content: ""; position: absolute; left: -40%; top: 0; bottom: 0; width: 25%; transform: skewX(-25deg); background: linear-gradient(90deg, transparent, #FFE9B016, transparent); animation: boostEmptyGlint 9s ease-in-out infinite; }
    .boost-empty > * { position: relative; z-index: 1; }
    .boost-empty-icon { border: 1px solid #A5885180; color: #EBCF8B; background: linear-gradient(145deg, #3B3123, #141B23); box-shadow: inset 0 1px 0 #FFF0BB40, 0 0 24px #DAB2571A; animation: boostIconBreathe 4.5s ease-in-out infinite; }
    .flap-boost-form-reveal { border: 1px solid #746142; background: linear-gradient(150deg, #15202B, #0E141B 50%, #17150F); box-shadow: inset 0 1px 0 #FCE5A42B, 0 22px 55px -42px #CFAF67A0; animation: boostEnter 420ms cubic-bezier(.16,1,.3,1) both; }
    .boost-vault-panel-head { position: relative; isolation: isolate; overflow: hidden; background: radial-gradient(ellipse at 80% 43%, #C9A64E26, transparent 38%), linear-gradient(110deg, #172631, #111B23 57%, #292214); }
    .boost-vault-panel-head::before { content: ""; pointer-events: none; position: absolute; inset: 0; opacity: .35; background-image: linear-gradient(#E4D2A20C 1px, transparent 1px), linear-gradient(90deg, #E4D2A20C 1px, transparent 1px); background-size: 19px 19px; mask-image: linear-gradient(90deg, transparent, #000 50%, #000); }
    .boost-vault-panel-head::after { content: ""; pointer-events: none; position: absolute; bottom: 0; left: -36%; width: 36%; height: 1px; background: linear-gradient(90deg, transparent, #FFF1BE, transparent); box-shadow: 0 0 12px #F1D386; animation: boostRail 6.5s ease-in-out infinite; }
    .boost-vault-eyebrow { text-shadow: 0 0 14px #E6C5766B; }
    .boost-vault-sequence span { width: 4px; height: 4px; border-radius: 50%; background: #F2D693; box-shadow: 0 0 8px #E7C673; animation: boostSequence 5.4s ease-in-out infinite; }
    .boost-vault-sequence span:nth-of-type(2) { animation-delay: .35s; }.boost-vault-sequence span:nth-of-type(3) { animation-delay: .7s; }
    .boost-vault-sequence i { width: 24px; height: 1px; background: linear-gradient(90deg, #E4C57E8C, #E4C57E32); transform-origin: left; animation: boostLink 5.4s ease-in-out infinite; }
    .boost-vault-sequence i:nth-of-type(2) { animation-delay: .35s; }
    .boost-vault-visual { position: relative; width: 118px; height: 90px; margin-right: 6px; }
    .boost-vault-visual-grid { position: absolute; inset: 3px 15px; border-radius: 50%; background: radial-gradient(circle, #ECD08330 0, #B8953A10 44%, transparent 67%); filter: blur(8px); animation: boostBreathe 4.5s ease-in-out infinite; }
    .boost-vault-ring { position: absolute; border-radius: 50%; border: 1px solid #CDB06C82; box-shadow: 0 0 16px #D6AF5266, inset 0 0 12px #D6AF5233; }
    .boost-vault-ring-outer { inset: 3px 16px; border-top-color: #FFF0BC; border-bottom-color: #FFF0BC; animation: boostOrbit 11s linear infinite; }
    .boost-vault-ring-inner { inset: 16px 29px; border-style: dashed; border-color: #E5C986A8; animation: boostOrbit 14s linear infinite reverse; }
    .boost-vault-visual-core { position: absolute; inset: 24px 37px; display: grid; place-items: center; border: 1px solid #F9DFA7D9; border-radius: 12px; color: #FFF1C5; background: linear-gradient(145deg, #806538, #1D2A2D 65%); box-shadow: inset 0 1px 0 #FFF7D88A, 0 0 21px #E9BD6273; animation: boostIconBreathe 3s ease-in-out infinite; }
    .boost-vault-beacon { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: #FFF2C9; box-shadow: 0 0 9px 3px #EEC970A8; animation: boostSignal 2.6s ease-out infinite; }
    .boost-vault-beacon-one { top: 8px; left: 39px; }.boost-vault-beacon-two { bottom: 9px; right: 39px; animation-delay: -1.3s; }
    .boost-form-step { position: relative; overflow: hidden; border-color: #3D4344 !important; background: linear-gradient(135deg, #101922, #0C1219) !important; box-shadow: inset 0 1px 0 #FFFFFF09; }
    .boost-form-step::before { content: ""; position: absolute; pointer-events: none; top: 0; left: -50%; width: 50%; height: 1px; background: linear-gradient(90deg, transparent, #F4DA9A, transparent); box-shadow: 0 0 11px #E9C87B; animation: boostStepRail 8s ease-in-out infinite; }
    .boost-form-step::after { content: ""; pointer-events: none; position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse at 0 0, #E2BF6A17, transparent 38%); transition: opacity 300ms ease; }
    .boost-form-step:nth-child(2)::before { animation-delay: -2.7s; }.boost-form-step:nth-child(3)::before { animation-delay: -5.4s; }
    .boost-form-step:focus-within { border-color: #917A4D !important; box-shadow: inset 0 1px 0 #FFE7A028, 0 0 28px -21px #E7C570; }
    .boost-form-step:focus-within::after { opacity: 1; }
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
    @keyframes boostSequence { 0%,20%,100% { opacity: .35; transform: scale(.7); } 35%,52% { opacity: 1; transform: scale(1.2); } }
    @keyframes boostLink { 0%,20%,100% { opacity: .35; transform: scaleX(.3); } 35%,60% { opacity: .9; transform: scaleX(1); } }
    @keyframes boostStepLink { from { opacity: 0; transform: scaleX(.2); } to { opacity: 1; transform: scaleX(1); } }
    @keyframes boostIndex { 0%,28%,100% { color: #BFA976; text-shadow: 0 0 0 transparent; } 35%,50% { color: #FFE4A4; text-shadow: 0 0 9px #EAC8798C; } }
    @keyframes boostOutputPulse { 0%,75%,100% { opacity: .35; transform: translateX(-45%); } 86% { opacity: .85; transform: translateX(45%); } }
    @keyframes boostBalanceDrift { from { transform: translate3d(-4%,0,0); opacity: .45; } to { transform: translate3d(7%,3%,0); opacity: .8; } }
    @keyframes boostBalanceShine { 0%,72% { opacity: 0; transform: translateX(0) skewX(-18deg); } 81% { opacity: .75; } 93%,100% { opacity: 0; transform: translateX(420%) skewX(-18deg); } }
    @keyframes boostOrbit { to { transform: rotate(360deg); } }
    @keyframes boostBreathe { 0%,100% { opacity: .66; transform: scale(.92); } 50% { opacity: 1; transform: scale(1.07); } }
    @keyframes boostBeam { 0%,12% { opacity: 0; transform: translate3d(0,0,0) rotate(-18deg); } 26% { opacity: .75; } 62% { opacity: .5; } 78%,100% { opacity: 0; transform: translate3d(300%,0,0) rotate(-18deg); } }
    @keyframes boostMote { 0%,100% { opacity: 0; transform: translate3d(0,15px,0) scale(.6); } 28%,60% { opacity: .85; } 78% { opacity: .3; transform: translate3d(18px,-24px,0) scale(1.2); } }
    @keyframes boostRipple { 0% { opacity: .55; transform: scale(.65); } 85%,100% { opacity: 0; transform: scale(2.1); } }
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
    @media (max-width: 639px) { .boost-hero-layout { position: relative; display: block; min-height: 178px; } .boost-hero-copy { position: relative; z-index: 2; } .boost-hero-title { font-size: 28px; } .boost-hero-side { position: absolute; inset: 0; z-index: 1; display: block; pointer-events: none; } .boost-hero-side > span { position: absolute; top: auto; right: 0; bottom: 0; } .boost-hero-emblem { position: absolute; right: 4px; bottom: 8px; width: 84px; height: 84px; margin: 0; opacity: .43; } .boost-emblem-core { width: 42px; height: 42px; } .boost-wing-upper-left { top: 6px; left: 4px; width: 16px; height: 19px; }.boost-wing-upper-right { top: 6px; right: 4px; width: 16px; height: 19px; }.boost-wing-lower-left { top: 22px; left: 7px; width: 13px; height: 14px; }.boost-wing-lower-right { top: 22px; right: 7px; width: 13px; height: 14px; }.boost-wing-body { top: 12px; height: 22px; width: 3px; } .boost-emblem-orbit-inner { inset: 14px; } .boost-emblem-ripple { inset: 22px; } .boost-hero-steps { --boost-flow-distance: 225px; gap: 7px; font-size: 10px; } .boost-hero-steps svg { display: none; } .boost-motes span:nth-child(n+7), .boost-atmosphere-beam-two { display: none; } .flap-boost-metrics > * { padding: .5rem .75rem; } .flap-boost-metrics > *:nth-child(3) { border-left: 0; } .boost-aura { opacity: .25; } .boost-choice { min-height: 44px; } .boost-choice > span:last-child { font-size: 11px; white-space: nowrap; } }
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
  isLoadingToken,
  onLoadToken,
  buyMode,
  setBuyMode,
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
  isLoadingToken: boolean;
  onLoadToken: () => void;
  buyMode: BuyMode;
  setBuyMode: (value: BuyMode) => void;
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
    <div className="space-y-5">
      <section className="boost-form-step rounded-xl border border-[#3D4548] bg-[#10171E]/75 p-3 sm:p-4 shadow-[inset_0_1px_0_rgba(190,246,241,0.04)]">
        <SectionHeading index="01" icon={<Target className="h-4 w-4" />} title={t("labels.targetToken")} />
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
        {tokenInfo && !lockedToken ? (
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

      <section className="boost-form-step rounded-xl border border-[#3D4548] bg-[#10171E]/75 p-3 sm:p-4">
        <SectionHeading index="02" icon={<Gauge className="h-4 w-4" />} title={t("labels.ruleSettings")} />
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {buyMode === "fixed-bnb" ? (
            <Field label={t("labels.bnbPerRound")} hint={t("help.bnbPerRound")}>
              <Input
                value={bnbPerRound}
                onChange={(event) => setBnbPerRound(event.target.value)}
                inputMode="decimal"
                placeholder={t("placeholders.bnb")}
              />
            </Field>
          ) : null}
          {buyMode === "fixed-token" ? (
            <Field label={t("labels.tokenAmountPerRound")} hint={t("help.tokenAmountPerRound")}>
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
              <Field label={t("labels.balancePercentage")} hint={t("help.balancePercentage")}>
                <Input
                  value={balancePercentage}
                  onChange={(event) => setBalancePercentage(event.target.value)}
                  inputMode="decimal"
                  placeholder={t("placeholders.percentage")}
                />
              </Field>
              <Field label={t("labels.maxBnbPerRound")} hint={t("help.maxBnbForPercentage")}>
                <Input
                  value={maxBnbPerRound}
                  onChange={(event) => setMaxBnbPerRound(event.target.value)}
                  inputMode="decimal"
                  placeholder={t("placeholders.bnbOptional")}
                />
              </Field>
            </>
          ) : null}
          <Field label={t("labels.interval")} hint={t("help.interval")}>
            <Input
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(event.target.value)}
              inputMode="numeric"
              placeholder={t("placeholders.interval")}
            />
          </Field>
        </div>
      </section>

      <section className="boost-form-step rounded-xl border border-[#3D4548] bg-[#10171E]/75 p-3 sm:p-4 shadow-[inset_0_1px_0_rgba(190,246,241,0.04)]">
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
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="boost-field block min-w-0">
      <span className="block text-sm font-medium text-[#F1EAD9]">{label}</span>
      <span className="mt-1 block text-xs leading-5 text-[#A4AAA8]">{hint}</span>
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
                  <span className="text-[#F0CB9D]">· {outputRuleLabel(t, task.outputMode)}</span>
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
  onUpdate: (update: TaskRuleUpdate) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const output = outputFromValue(task.outputMode);
  const outputDetail =
    output === "retain"
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
            <span className="font-semibold">{outputRuleLabel(t, task.outputMode)}</span>
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
            output === "burn"
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
            onSave={async (update) => {
              if (await onUpdate(update)) setEditing(false);
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
  onSave: (update: TaskRuleUpdate) => Promise<void>;
}) {
  const mode = buyModeFromValue(task.buyMode);
  const rules = task.pendingRuleUpdate ?? task;
  const [fixedBnb, setFixedBnb] = useState(formatTokenAmount(rules.fixedBNBPerRound, 18, 18));
  const [fixedTokens, setFixedTokens] = useState(
    formatTokenAmount(rules.fixedTokenAmountPerRound, task.token.decimals, 18),
  );
  const [balanceShare, setBalanceShare] = useState((rules.balanceBps / 100).toString());
  const [maxBnb, setMaxBnb] = useState(formatTokenAmount(rules.maxBNBPerRound, 18, 18));
  const [intervalMinutes, setIntervalMinutes] = useState((rules.interval / 60n).toString());
  const [output, setOutput] = useState<OutputMode>(outputFromValue(rules.outputMode));
  const [distributionMode, setDistributionMode] = useState<DistributionMode>(distributionFromValue(rules.outputMode));
  const [retainRecipient, setRetainRecipient] = useState(
    rules.retainRecipient === ZERO_ADDRESS ? "" : rules.retainRecipient,
  );
  const [recipientsText, setRecipientsText] = useState(rules.recipients.join("\n"));
  const [randomRecipientCount, setRandomRecipientCount] = useState(String(rules.randomRecipientCount || 5));
  const [formError, setFormError] = useState<string | null>(null);

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
      } else if (mode === "fixed-token") {
        fixedTokenAmountPerRound = parseAmount(fixedTokens, task.token.decimals, t);
        if (fixedTokenAmountPerRound <= 0n) throw new Error(t("errors.amount"));
      } else {
        balanceBps = parsePercentageToBps(balanceShare, t);
        maxBNBPerRound = maxBnb.trim() ? parseAmount(maxBnb, 18, t) : 0n;
        if (maxBNBPerRound < 0n) throw new Error(t("errors.amount"));
      }

      const recipients = recipientsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      let outputMode = 0;
      let randomCount = 0;
      let recipient = ZERO_ADDRESS;
      if (output === "retain") {
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
      });
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
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {mode === "fixed-bnb" ? (
          <CompactField label={t("labels.bnbPerRound")} hint={t("help.bnbPerRound")}>
            <Input value={fixedBnb} onChange={(event) => setFixedBnb(event.target.value)} inputMode="decimal" />
          </CompactField>
        ) : null}
        {mode === "fixed-token" ? (
          <CompactField label={t("labels.tokenAmountPerRound")} hint={t("help.tokenAmountPerRound")}>
            <Input value={fixedTokens} onChange={(event) => setFixedTokens(event.target.value)} inputMode="decimal" />
          </CompactField>
        ) : null}
        {mode === "balance-percentage" ? (
          <>
            <CompactField label={t("labels.balancePercentage")} hint={t("help.balancePercentage")}>
              <Input
                value={balanceShare}
                onChange={(event) => setBalanceShare(event.target.value)}
                inputMode="decimal"
              />
            </CompactField>
            <CompactField label={t("labels.maxBnbPerRound")} hint={t("help.maxBnbForPercentage")}>
              <Input
                value={maxBnb}
                onChange={(event) => setMaxBnb(event.target.value)}
                inputMode="decimal"
                placeholder={t("placeholders.bnbOptional")}
              />
            </CompactField>
          </>
        ) : null}
        <CompactField label={t("labels.interval")} hint={t("help.interval")}>
          <Input
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
            inputMode="numeric"
          />
        </CompactField>
      </div>
      <div className="mt-4 border-t border-[#424746] pt-4">
        <p className="text-sm font-medium text-[#F1EAD9]">{t("labels.output")}</p>
        <p className="mt-1 text-xs leading-5 text-[#D5C585]">{t("help.editOutputRisk")}</p>
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
      </div>
      {output === "retain" ? (
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
      {output === "distribute" ? (
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
          disabled={!canWrite}
        />
      </div>
    </div>
  );
}

function CompactField({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="block text-sm font-medium text-[#F1EAD9]">{label}</span>
      <span className="mt-1 block text-xs leading-5 text-[#A4AAA8]">{hint}</span>
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
            {!task.startFeeCharged ? (
              <p className="mt-1 text-xs text-[#E1C68A]">
                {t("help.startFee", undefined, { amount: formatTokenAmount(task.startFee, 18) })}
              </p>
            ) : null}
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
