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
  Plus,
  RefreshCw,
  Settings2,
  Target,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { factoryAbi, portalAbi, vaultAbi } from "./VaultABI";

const DISPLAY_LIMIT = 25;
const PRICE_FLOOR_BPS = 7_000n;
const BPS_DENOMINATOR = 10_000n;
const ONE_BNB = 10n ** 18n;
const GOLD_PRIMARY_BUTTON =
  "text-[#171108] [--ui20-chamfer-bg:#F0B90B] [--ui20-chamfer-border:#F0B90B] shadow-[0_10px_26px_-12px_rgba(240,185,11,0.7)] hover:[--ui20-chamfer-bg:#FFD45A] hover:[--ui20-chamfer-border:#FFD45A]";
const GOLD_SECONDARY_BUTTON =
  "text-[#F4D784] [--ui20-chamfer-bg:#19150C] [--ui20-chamfer-border:#68531A] hover:text-[#FFF1C6] hover:[--ui20-chamfer-bg:#241D0C] hover:[--ui20-chamfer-border:#D9A827]";
const GOLD_OUTLINE_BUTTON =
  "text-[#DCC27A] [--ui20-chamfer-bg:#100F0B] [--ui20-chamfer-border:#55461D] hover:text-[#FFF1C6] hover:[--ui20-chamfer-border:#D9A827]";

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
  | { mode: "fixed-token"; options: TaskOptions; tokenAmountPerRound: bigint; maxBNBPerRound: bigint }
  | { mode: "balance-percentage"; options: TaskOptions; balanceBps: number; maxBNBPerRound: bigint };

function taskTotalBNB(task: TaskSnapshot) {
  return task.availableBNB + task.reservedBNB + task.startFeeOwed;
}

function canStartTask(task: TaskSnapshot) {
  if (!task.active || task.paused || task.started) return false;
  const fee = task.startFeeCharged ? 0n : task.startFee;
  if (task.availableBNB <= fee) return false;
  const budget = task.availableBNB - fee;
  if (task.buyMode === 0) return budget >= task.fixedBNBPerRound;
  if (task.buyMode === 1) return budget >= task.maxBNBPerRound;
  return (budget * BigInt(task.balanceBps)) / 10_000n > 0n;
}

function taskKey(task: TaskSnapshot) {
  return `${task.address.toLowerCase()}:${task.operationId}`;
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

function outputDescription(t: (key: string) => string, mode: OutputMode) {
  return mode === "burn" ? t("help.operation.burn") : mode === "distribute" ? t("help.operation.distribute") : t("help.operation.retain");
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

function parsePercentageToBps(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Invalid percentage");
  const [whole, fraction = ""] = value.split(".");
  const bps = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new Error("Invalid percentage");
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
    return `${formatTokenAmount(task.fixedTokenAmountPerRound, task.token.decimals)} ${task.token.symbol} · ${t("labels.bnbCeiling")} ${formatTokenAmount(task.maxBNBPerRound, 18)} BNB`;
  }
  if (buyModeFromValue(task.buyMode) === "balance-percentage") {
    return `${formatPercentage(task.balanceBps)} · ${task.maxBNBPerRound ? `${t("labels.bnbCeiling")} ${formatTokenAmount(task.maxBNBPerRound, 18)} BNB` : t("labels.noBnbCeiling")}`;
  }
  return `${formatTokenAmount(task.fixedBNBPerRound, 18)} BNB`;
}

function StatusBadge({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center border px-2.5 py-1 text-xs font-semibold uppercase leading-none " +
        (muted
          ? "rounded-md border-[#33414C] bg-[#111920] text-[#96A8B4]"
          : "rounded-md border-[#357B7B] bg-[#0D2225] text-[#83E2DC]")
      }
    >
      {children}
    </span>
  );
}

function ErrorDialog({
  t,
  message,
  onDismiss,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="boost-error-title">
      <button type="button" aria-label={t("buttons.dismiss")} className="absolute inset-0 bg-[#02090C]/80 backdrop-blur-sm" onClick={onDismiss} />
      <section className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[#9B4C4C] bg-[linear-gradient(145deg,#211012,#12171B)] shadow-[0_28px_80px_-30px_rgba(239,83,80,0.48)]">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#FF7570,#E0AA72,#FF7570,transparent)]" />
        <div className="flex items-start gap-3 p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#B45A58] bg-[#35171A] text-[#FF8A85] shadow-[0_0_22px_-8px_rgba(255,108,102,0.95)]">
            <TriangleAlert className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 id="boost-error-title" className="text-base font-semibold text-[#FFF2F1]">
                {t("dialogs.errorTitle")}
              </h2>
              <button type="button" aria-label={t("buttons.dismiss")} className="-mr-1 -mt-1 rounded-lg p-2 text-[#D9A4A1] transition hover:bg-[#432023] hover:text-[#FFF2F1]" onClick={onDismiss}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 break-words text-sm leading-6 text-[#E7B6B4]">{message}</p>
            <button type="button" className="mt-5 h-10 rounded-lg bg-[#FF827C] px-4 text-sm font-semibold text-[#1A090A] shadow-[0_8px_18px_-10px_rgba(255,122,116,0.9)] transition hover:bg-[#FFA09A]" onClick={onDismiss}>
              {t("buttons.dismiss")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function OnchainProgressOverlay({
  t,
  state,
  visible,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  state: TxButtonState;
  visible: boolean;
}) {
  if (!visible || state === "idle" || state === "failed") return null;
  const title = state === "simulating"
    ? t("states.simulatingOnchain")
    : state === "writing"
      ? t("states.submittingOnchain")
      : t("states.waitingCallback");
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#050402]/70 p-4 backdrop-blur-[3px]" role="status" aria-live="polite">
      <div className="flap-boost-onchain-loader relative w-full max-w-sm overflow-hidden rounded-2xl border border-[#8B6919] bg-[linear-gradient(145deg,#191407,#0B0A06_58%,#1B1507)] p-6 text-center shadow-[0_28px_70px_-24px_rgba(240,185,11,0.58)]">
        <div aria-hidden="true" className="flap-boost-onchain-sweep absolute -inset-y-12 -left-1/3 w-1/3 -skew-x-12 bg-[linear-gradient(90deg,transparent,rgba(255,224,125,0.48),transparent)]" />
        <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
          <span aria-hidden="true" className="flap-boost-onchain-orbit absolute inset-0 rounded-full border border-dashed border-[#F0B90B]/80" />
          <span aria-hidden="true" className="flap-boost-onchain-orbit absolute inset-2 rounded-full border border-[#FFE08A]/65" style={{ animationDirection: "reverse", animationDuration: "4.3s" }} />
          <span className="relative flex h-11 w-11 items-center justify-center rounded-xl border border-[#FFD45A] bg-[#2A2108] text-[#F7D66B] shadow-[0_0_28px_-4px_rgba(240,185,11,1)]">
            <RefreshCw className="h-5 w-5 animate-spin" />
          </span>
        </div>
        <p className="relative mt-5 text-lg font-semibold text-[#FFF0BC]">{title}</p>
        <p className="relative mt-2 text-sm leading-6 text-[#D9C27D]">{t("states.waitingCallbackHint")}</p>
      </div>
    </div>
  );
}

export default function FlapBoostMiniApp(_props: VaultComponentProps) {
  const sdk = useFlapSdk();
  const { context, i18n } = sdk;
  const t = i18n.t;
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [taskReadState, setTaskReadState] = useState<"loading" | "disconnected" | "ready" | "error">("loading");
  const [factoryUnavailable, setFactoryUnavailable] = useState(false);
  const [selectedTaskAddress, setSelectedTaskAddress] = useState<string | null>(null);
  // Existing operations are the source of truth for the workspace. The host
  // context token is useful when creating a new operation, but it must not
  // hide a Vault that the connected wallet already owns for another token.
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxButtonState>("idle");
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showOperationPicker, setShowOperationPicker] = useState(false);
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
  const tokenRequestRef = useRef(0);
  const loadedContextTokenRef = useRef<Address | null>(null);

  const factoryAddress = useMemo(() => {
    const binding = context.manifest.match.bindings.find(
      (item) => item.chainId === context.chainId && item.factoryAddress && isValidAddress(item.factoryAddress),
    );
    if (binding?.factoryAddress) return binding.factoryAddress;
    return context.factoryAddress !== ZERO_ADDRESS && isValidAddress(context.factoryAddress)
      ? context.factoryAddress
      : null;
  }, [context.chainId, context.factoryAddress, context.manifest.match.bindings]);
  const portalAddress = useMemo(() => {
    const binding = context.manifest.match.bindings.find((item) => item.chainId === context.chainId);
    return binding?.externalContracts?.find((contract) => contract.label === "Flap Portal")?.address ?? null;
  }, [context.chainId, context.manifest.match.bindings]);
  const actionStage: ActionAvailabilityStage = "both";
  const marketPhase = context.host?.marketPhase ?? "unknown";
  const actionsAvailable = isActionAvailableForPhase(actionStage, marketPhase);
  const wrongNetwork = sdk.wallet.isWrongNetwork;
  const canWrite = Boolean(
    context.userAddress && factoryAddress && !factoryUnavailable && !wrongNetwork && actionsAvailable,
  );
  const ownedTokens = useMemo(() => {
    const unique = new Map<string, TokenInfo>();
    for (const task of tasks) unique.set(task.token.address.toLowerCase(), task.token);
    return [...unique.values()];
  }, [tasks]);
  const activeTokenAddress = selectedTokenAddress === ""
    ? null
    : selectedTokenAddress ?? ownedTokens[0]?.address ?? null;
  const tokenTasks = tasks.filter(
    (task) => activeTokenAddress && task.token.address.toLowerCase() === activeTokenAddress.toLowerCase(),
  );
  const selectedTask = tokenTasks.find((task) => taskKey(task) === selectedTaskAddress) ?? tokenTasks[0] ?? null;
  const selectedTaskIsOwner = Boolean(
    selectedTask && context.userAddress && selectedTask.owner.toLowerCase() === context.userAddress.toLowerCase(),
  );
  const activeTaskCount = tasks.filter((task) => task.active && !task.paused).length;
  const visibleBNB = [...new Map(tasks.map((task) => [task.address.toLowerCase(), taskTotalBNB(task)])).values()].reduce((sum, value) => sum + value, 0n);
  const visibleSpent = tasks.reduce((sum, task) => sum + task.totalBNBSpent, 0n);

  function beginCreateTask(mode: OutputMode) {
    setOutputMode(mode);
    setDistributionMode("fixed");
    setShowOperationPicker(false);
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
    setShowOperationPicker(false);
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
    setShowOperationPicker(false);
    setOutputMode("burn");
    setDistributionMode("fixed");
    setRetainRecipient("");
    setRecipientsText("");
    setRandomRecipientCount("5");
    setFundingAmount("");
    setWithdrawAmount("");
    updateTokenAddress("");
  }

  const config = useMemo<TaskConfig | Error>(() => {
    try {
      if (!isValidAddress(tokenAddressInput)) throw new Error(t("errors.targetToken"));
      if (!tokenInfo) throw new Error(t("errors.loadTokenFirst"));
      if (!minTokensPerBNB) throw new Error(t("errors.priceFloor"));
      const interval = Number(intervalMinutes);
      if (!Number.isInteger(interval) || interval < 1) throw new Error(t("errors.interval"));

      const recipients = recipientsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      let outputModeValue = 0;
      let randomCount = 0;
      let recipient = ZERO_ADDRESS;
      if (outputMode === "retain") {
        if (!isValidAddress(retainRecipient)) throw new Error(t("errors.retainWallet"));
        outputModeValue = 1;
        recipient = retainRecipient as Address;
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
            recipients.some((value) => !isValidAddress(value))
          ) {
            throw new Error(t("errors.fixedRecipients"));
          }
          outputModeValue = 2;
        }
      }
      const options: TaskOptions = {
        targetToken: tokenAddressInput as Address,
        minTokensPerBNB,
        interval: BigInt(interval * 60),
        outputMode: outputModeValue,
        randomRecipientCount: randomCount,
        retainRecipient: recipient,
        recipients: recipients as Address[],
      };
      if (buyMode === "fixed-bnb") {
        const amount = parseTokenAmount(bnbPerRound, 18);
        if (amount <= 0n) throw new Error(t("errors.amount"));
        return { mode: buyMode, options, bnbPerRound: amount };
      }
      if (buyMode === "fixed-token") {
        const tokenAmount = parseTokenAmount(tokenAmountPerRound, tokenInfo.decimals);
        const maxBNB = parseTokenAmount(maxBnbPerRound, 18);
        if (tokenAmount <= 0n || maxBNB <= 0n) throw new Error(t("errors.amount"));
        return { mode: buyMode, options, tokenAmountPerRound: tokenAmount, maxBNBPerRound: maxBNB };
      }
      const balanceBps = parsePercentageToBps(balancePercentage);
      const optionalMaxBNB = maxBnbPerRound.trim() ? parseTokenAmount(maxBnbPerRound, 18) : 0n;
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
    setTokenAddressInput(value);
    setTokenInfo(null);
    setMinTokensPerBNB(null);
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
          sdk
            .readContract<number>({
              contract: "token",
              address: token as Address,
              abi: erc20Abi,
              functionName: "decimals",
            })
            .catch(() => 18),
        ]);
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
    setTaskReadState(context.userAddress ? "loading" : "disconnected");
    if (!factoryAddress || !context.userAddress) {
      if (requestId === requestRef.current) setTasks([]);
      setFactoryUnavailable(!factoryAddress);
      if (requestId === requestRef.current && factoryAddress) setTaskReadState("disconnected");
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
      const vaultRows = await Promise.all(allVaultAddresses.slice(-DISPLAY_LIMIT).reverse().map(async (address) => {
        const [owner, targetToken, count, startFeeCharged, startFeeOwed, startFee, callbackInProgress, triggerId, scheduledId, reservedBNB, availableBNB] = await Promise.all([
          sdk.readContract<Address>({ contract: "boostVault", address, abi: vaultAbi, functionName: "owner" }),
          sdk.readContract<Address>({ contract: "boostVault", address, abi: vaultAbi, functionName: "targetToken" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "operationCount" }),
          sdk.readContract<boolean>({ contract: "boostVault", address, abi: vaultAbi, functionName: "startFeeCharged" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "startFeeOwed" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "START_FEE" }),
          sdk.readContract<boolean>({ contract: "boostVault", address, abi: vaultAbi, functionName: "callbackInProgress" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "triggerId" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "scheduledOperationId" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "reservedBNB" }),
          sdk.readContract<bigint>({ contract: "boostVault", address, abi: vaultAbi, functionName: "availableBNB" }),
        ]);
        const [symbol, decimals] = await Promise.all([
          sdk.readContract<string>({ contract: "token", address: targetToken, abi: erc20Abi, functionName: "symbol" }).catch(() => "TOKEN"),
          sdk.readContract<number>({ contract: "token", address: targetToken, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
        ]);
        return { address, owner, token: { address: targetToken, symbol: symbol || "TOKEN", decimals }, count: Number(count), startFeeCharged, startFeeOwed, startFee, callbackInProgress, triggerId, scheduledId, reservedBNB, availableBNB };
      }));
      const positions = vaultRows.flatMap((vault) => Array.from({ length: vault.count }, (_, id) => ({ vault, id })).reverse()).slice(0, DISPLAY_LIMIT);
      const loaded = await Promise.all(positions.map(async ({ vault, id }) => {
        const operation = await sdk.readContract<VaultOperationRead>({ contract: "boostVault", address: vault.address, abi: vaultAbi, functionName: "getOperation", args: [BigInt(id)] });
        const hasPending = await sdk.readContract<boolean>({ contract: "boostVault", address: vault.address, abi: vaultAbi, functionName: "hasPendingRules", args: [BigInt(id)] });
        const pendingRuleUpdate = hasPending
          ? await sdk.readContract<TaskRuleUpdate>({ contract: "boostVault", address: vault.address, abi: vaultAbi, functionName: "pendingRules", args: [BigInt(id)] }).catch(() => null)
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
          reservedBNB: vault.reservedBNB,
          availableBNB: vault.availableBNB,
          totalBNBSpent: operation.totalBNBSpent,
          totalTokensOutput: operation.totalTokensOutput,
          randomDistributionRounds: operation.randomDistributionRounds,
          totalRandomHolders: operation.totalRandomHolders,
        } satisfies TaskSnapshot;
      }));
      if (requestId !== requestRef.current) return;
      setTasks(loaded);
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
        return loaded[0] ? taskKey(loaded[0]) : null;
      });
      setFactoryUnavailable(false);
      setTaskReadState("ready");
    } catch (nextError) {
      if (requestId === requestRef.current) {
        setFactoryUnavailable(true);
        setTaskReadState("error");
        setTasks([]);
        setSelectedTaskAddress(null);
        // A stale Factory binding must not be presented as an empty operation list.
        void nextError;
      }
    }
  }, [context.userAddress, factoryAddress, sdk]);

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => void loadTasks(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadTasks, sdk.refetchNonce]);

  useEffect(() => {
    if (context.tokenAddress === ZERO_ADDRESS || !isValidAddress(context.tokenAddress)) return;
    if (loadedContextTokenRef.current?.toLowerCase() === context.tokenAddress.toLowerCase()) return;
    loadedContextTokenRef.current = context.tokenAddress;
    setTokenAddressInput(context.tokenAddress);
    void loadToken(context.tokenAddress);
  }, [context.tokenAddress, loadToken]);

  const buttonState = (key: string): TxButtonState => (activeAction === key ? txState : "idle");
  const runAction = useCallback(
    async (key: string, operation: () => Promise<void>, message: string): Promise<boolean> => {
      setError(null);
      setActiveAction(key);
      try {
        await operation();
        sdk.notify.success(message);
        await loadTasks();
        return true;
      } catch (nextError) {
        setError(handleTxError(nextError, { simulationFailed: t("errors.simulation"), unknown: t("errors.tx") }));
        setTxState("failed");
        return false;
      } finally {
        setActiveAction(null);
        setTxState("idle");
      }
    },
    [loadTasks, sdk, t],
  );

  async function createTask() {
    if (!canWrite || !factoryAddress || config instanceof Error) {
      if (config instanceof Error) setError(config.message);
      return;
    }
    await runAction(
      "create-task",
      async () => {
        setTxState("simulating");
        const simulation =
          config.mode === "fixed-bnb"
            ? await sdk.simulateContract({ contract: "boostFactory", address: factoryAddress, abi: factoryAbi, functionName: "createFixedBNBOperation", args: [config.options, config.bnbPerRound] })
            : config.mode === "fixed-token"
              ? await sdk.simulateContract({ contract: "boostFactory", address: factoryAddress, abi: factoryAbi, functionName: "createFixedTokenAmountOperation", args: [config.options, config.tokenAmountPerRound, config.maxBNBPerRound] })
              : await sdk.simulateContract({ contract: "boostFactory", address: factoryAddress, abi: factoryAbi, functionName: "createBalancePercentageOperation", args: [config.options, config.balanceBps, config.maxBNBPerRound] });
        setTxState("writing");
        const hash = await sdk.writeContract(simulation.request);
        setTxState("confirming");
        await sdk.waitForTx(hash);
        setSelectedTokenAddress(config.options.targetToken);
        setSelectedTaskAddress(null);
        setShowCreateTask(false);
      },
      t("messages.taskCreated"),
    );
  }

  async function fundTask() {
    if (!canWrite || !selectedTask) return;
    try {
      const amount = parseTokenAmount(fundingAmount, 18);
      if (amount <= 0n) throw new Error(t("errors.funding"));
      await runAction(
        "fund:" + selectedTask.address,
        async () => {
          setTxState("simulating");
          const simulation = await sdk.simulateContract({
            contract: "boostVault",
            address: selectedTask.address,
            abi: vaultAbi,
            functionName: "fund",
            value: amount,
          });
          setTxState("writing");
          const hash = await sdk.writeContract(simulation.request);
          setTxState("confirming");
          await sdk.waitForTx(hash);
          setFundingAmount("");
        },
        t("messages.taskFunded"),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("errors.funding"));
    }
  }

  async function withdrawTask() {
    if (!canWrite || !selectedTask || !selectedTaskIsOwner) return;
    try {
      const amount = parseTokenAmount(withdrawAmount, 18);
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
          functionName: action === "pause" ? "pauseOperation" : action === "resume" ? "resumeOperation" : "closeOperation",
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

  const marketPhaseLabel =
    marketPhase === "internal-market"
      ? t("badges.marketInternal")
      : marketPhase === "dex-listed"
        ? t("badges.marketDex")
        : t("badges.marketUnknown");
  return (
    <div className="relative isolate mx-auto min-h-screen w-full max-w-[1160px] space-y-5 overflow-hidden px-3 pb-10 sm:px-5 lg:px-6">
      <BoostMotionStyles />
      <OnchainProgressOverlay t={t} state={txState} visible={activeAction !== null} />
      <div aria-hidden="true" className="flap-boost-aurora pointer-events-none absolute -inset-x-24 -top-36 -z-20 h-[48rem]" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(ellipse_at_12%_0%,rgba(65,170,174,0.2),transparent_38%),radial-gradient(ellipse_at_86%_9%,rgba(219,159,94,0.14),transparent_32%)]"
      />
      <Card className="flap-boost-shell relative overflow-hidden rounded-2xl border-[#263C43] bg-[#0B1014] shadow-[0_28px_78px_-58px_rgba(43,180,176,0.72)]">
        <CardHeader className="flap-boost-hero relative overflow-hidden border-b border-[#263C43] bg-[linear-gradient(118deg,#101B20,#0D151A_54%,#15110E)] p-5 sm:p-6">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#61D6D0_18%,#D4A369_50%,#61D6D0_82%,transparent)]" />
          <div aria-hidden="true" className="flap-boost-hero-sweep absolute -inset-y-8 -left-1/3 w-1/3 -skew-x-12 bg-[linear-gradient(90deg,transparent,rgba(140,235,228,0.13),transparent)]" />
          <div aria-hidden="true" className="flap-boost-hero-ring absolute -right-20 -top-24 h-64 w-64 rounded-full border border-[#5AA7A4]/20 bg-[#2D8E8B]/[0.04] shadow-[0_0_80px_12px_rgba(62,185,181,0.08)]" />
          <div aria-hidden="true" className="flap-boost-hero-ring flap-boost-hero-ring-inner absolute -right-8 -top-12 h-40 w-40 rounded-full border border-dashed border-[#D4A369]/30" />
          <div className="relative flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#78D5CF]">
                <span className="flap-boost-status-dot h-1.5 w-1.5 rounded-full bg-[#78D5CF] shadow-[0_0_10px_rgba(120,213,207,0.9)]" />
                {t("badges.automation")}
              </div>
              <CardTitle className="text-2xl tracking-[-0.035em] text-[#F1FAF9] sm:text-3xl">{t("title")}</CardTitle>
              <p className="max-w-2xl text-sm leading-6 text-[#AABABA]">{t("subtitle")}</p>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2 pt-1">
              <StatusBadge muted={!actionsAvailable}>{marketPhaseLabel}</StatusBadge>
              <StatusBadge muted={!activeTaskCount}>
                {taskReadState !== "ready" ? t("labels.onchainReading") : activeTaskCount ? t("badges.active") : t("badges.unconfigured")}
              </StatusBadge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 p-4 sm:p-6">

          {wrongNetwork ? (
            <Alert tone="warning">
              {t("states.wrongNetwork", undefined, { chain: sdk.wallet.requiredChainLabel })}
            </Alert>
          ) : null}
          {factoryUnavailable ? <Alert tone="warning">{t("states.factoryUnavailable")}</Alert> : null}
          {!actionsAvailable ? <Alert tone="warning">{t("states.actionsUnavailable")}</Alert> : null}
          {error ? <ErrorDialog t={t} message={error} onDismiss={() => setError(null)} /> : null}

          <section>
            <div className="flap-boost-panel relative overflow-hidden rounded-2xl border border-[#2C494E] bg-[#0D171B] p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-[#EFFAF8]">{t("sections.vaultOverview")}</h2>
                <StatusBadge muted={taskReadState !== "ready"}>{taskReadState === "ready" ? t("labels.live") : t("labels.onchainReading")}</StatusBadge>
              </div>
              <div className="flap-boost-metrics grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label={t("labels.totalBnbBalance")} value={taskReadState === "ready" ? formatTokenAmount(visibleBNB, 18) : "—"} hint="BNB" />
                <Metric label={t("labels.bnbConsumed")} value={taskReadState === "ready" ? formatTokenAmount(visibleSpent, 18) : "—"} hint="BNB" />
                <Metric label={t("labels.activeTasks")} value={taskReadState === "ready" ? String(activeTaskCount) : "—"} hint={t("labels.tasks")} />
                <Metric label={t("labels.createdCas")} value={taskReadState === "ready" ? String(ownedTokens.length) : "—"} hint={t("labels.distinctTokens")} />
              </div>
              <p className="mt-3 break-all text-xs leading-5 text-[#91AAA9]">
                {taskReadState === "disconnected" ? t("states.connectWalletToRead") : taskReadState === "loading" ? t("states.loadingTasks") : taskReadState === "error" ? t("states.taskReadFailed") : tasks.length === 0 ? t("states.noTasksAtFactory") : t("labels.recentTasks")}
                {factoryAddress ? ` · ${t("labels.factoryAddress")}: ${shortAddress(factoryAddress)}` : ""}
              </p>
            </div>
          </section>

          <section className="flap-boost-workspace relative overflow-hidden rounded-2xl border border-[#263C43] bg-[#0B1014] shadow-[inset_0_1px_0_rgba(190,246,241,0.035)]">
            <div className="flex flex-col gap-3 border-b border-[#263C43] bg-[#0E171C] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex items-center gap-2.5 text-base font-semibold text-[#F0FAF9]">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#3E7778] bg-[#11282C] text-[#87E1DC]">
                  <Settings2 className="h-4 w-4" />
                </span>
                {t("sections.tokenWorkspace")}
              </div>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 rounded-lg px-3 text-xs text-[#ABCAC8] hover:bg-[#13262A] hover:text-[#DDFEFB]"
                  onClick={() => void loadTasks()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("buttons.refresh")}
                </Button>
                {activeTokenAddress ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={GOLD_SECONDARY_BUTTON + " h-10 flex-1 rounded-lg px-4 text-xs sm:flex-none"}
                    onClick={() => {
                      setShowCreateTask(false);
                      setShowOperationPicker((value) => !value);
                    }}
                    disabled={!canWrite}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("buttons.addOperation")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  className={GOLD_PRIMARY_BUTTON + " h-10 flex-1 rounded-lg px-4 text-xs sm:flex-none"}
                  onClick={beginNewToken}
                  disabled={!canWrite}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("buttons.newToken")}
                </Button>
              </div>
            </div>
            <div className="space-y-4 px-4 pb-4 pt-4 sm:px-5">
              {ownedTokens.length ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t("labels.selectToken")}>
                  {ownedTokens.map((token) => {
                    const count = tasks.filter((task) => task.token.address.toLowerCase() === token.address.toLowerCase()).length;
                    const selected = activeTokenAddress?.toLowerCase() === token.address.toLowerCase();
                    return (
                      <button
                        key={token.address}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => selectToken(token.address)}
                        className={"rounded-lg border px-3 py-2 text-left text-sm transition " + (selected
                          ? "border-[#64C7C2] bg-[#123034] text-[#F0FCFA]"
                          : "border-[#30484E] bg-[#0A151A] text-[#A8C2C1] hover:border-[#5C9291]")}
                      >
                        <span className="font-semibold">{token.symbol}</span>
                        <span className="ml-2 text-xs opacity-75">{t("labels.operationCount", undefined, { count })}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {activeTokenAddress && showOperationPicker ? (
                <div className="rounded-xl border border-[#6A551C] bg-[linear-gradient(145deg,#171306,#0D0C08)] p-3.5 shadow-[inset_0_1px_0_rgba(255,224,130,0.06)]">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-[#F5DF9B]">{t("sections.addOperation")}</p>
                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setShowOperationPicker(false)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(["burn", "distribute", "retain"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => beginCreateTask(mode)}
                        disabled={!canWrite}
                        className={"flap-boost-operation-card relative overflow-hidden rounded-xl border p-3 text-left transition hover:border-[#67C8C1] " + (showCreateTask && outputMode === mode
                          ? "border-[#67C8C1] bg-[#123035]"
                          : "border-[#315056] bg-[#0A171C]") + (!canWrite ? " cursor-not-allowed opacity-50" : "")}
                      >
                        <span className="block text-sm font-semibold text-[#F0FAF9]">{outputLabel(t, mode)}</span>
                        <span className="mt-1 block text-xs leading-5 text-[#9CB9B7]">{outputDescription(t, mode)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {showCreateTask ? (
              <div className="mx-4 mb-5 overflow-hidden rounded-xl border border-[#2F6567] bg-[linear-gradient(145deg,#102026,#0B1116_55%,#14110E)] shadow-[0_18px_44px_-34px_rgba(65,184,179,0.78)] sm:mx-5">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2E5257] px-4 py-4 sm:px-5">
                  <div className="flex items-center gap-3 text-base font-semibold text-[#F0FAF9]">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#74DED8] text-[#061417] shadow-[0_8px_22px_-10px_rgba(91,217,210,0.88)]">
                      <Plus className="h-4 w-4" />
                    </span>
                    <div>
                      <p>{t("sections.newOperation")}</p>
                      <p className="mt-0.5 text-xs font-normal text-[#9AB6B5]">{activeTokenAddress ? t("help.existingTokenCreate") : t("workflow.createDetail")}</p>
                    </div>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => {
                    setShowCreateTask(false);
                    setShowOperationPicker(false);
                  }}>
                    <X className="h-4 w-4" />{t("buttons.cancel")}
                  </Button>
                </div>
                <div className="p-4 sm:p-5">
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
                <div className="flex border-t border-[#2E5257] bg-[#091116]/70 p-4 sm:justify-end sm:px-5">
                  <TxButton
                    className={GOLD_PRIMARY_BUTTON + " h-11 w-full rounded-lg px-6 text-sm sm:w-auto"}
                    idleLabel={t("buttons.createTask")}
                    state={buttonState("create-task")}
                    onClick={() => void createTask()}
                    disabled={!canWrite || tokenLookupLoading}
                  />
                </div>
              </div>
            ) : null}

            <div className="px-4 pb-4 sm:px-5 sm:pb-5">
              {tokenTasks.length ? <p className="mb-3 text-sm font-semibold text-[#EAF8F6]">{t("sections.tokenOperations")}</p> : null}
              <TaskList
                t={t}
                tasks={tokenTasks}
                selectedTaskAddress={selectedTask ? taskKey(selectedTask) : null}
                onSelect={selectTask}
              />
            </div>
          </section>

          {selectedTask ? (
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(23rem,0.72fr)]">
              <TaskFunding
                t={t}
                task={selectedTask}
                canWrite={canWrite}
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
              />
              <TaskOverview
                key={taskKey(selectedTask)}
                t={t}
                task={selectedTask}
                canWrite={canWrite}
                isOwner={selectedTaskIsOwner}
                buttonState={buttonState("rules:" + selectedTask.address)}
                onUpdate={(update) => updateTaskRules(selectedTask, update)}
              />
            </section>
          ) : (
            <section className="flap-boost-empty relative overflow-hidden rounded-2xl border border-dashed border-[#335E64] bg-[#0B1419] p-8 text-center">
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
                <span aria-hidden="true" className="flap-boost-idle-pulse absolute inset-0 rounded-full border border-[#4CC3BD]/50 bg-[#46BDB7]/10" />
                <span aria-hidden="true" className="flap-boost-idle-orbit absolute inset-1 rounded-full border border-dashed border-[#87E6E0]/70" />
                <span aria-hidden="true" className="flap-boost-idle-orbit absolute inset-3 rounded-full border border-[#DDA56C]/65" style={{ animationDirection: "reverse", animationDuration: "4.5s" }} />
                <span className="relative flex h-11 w-11 items-center justify-center rounded-xl border border-[#3E7778] bg-[#10262B] text-[#86DED8] shadow-[0_0_26px_-7px_rgba(107,226,218,0.9)]">
                  <Target className="h-5 w-5" />
                </span>
              </div>
              <p className="mt-3 text-base font-semibold text-[#F0FAF9]">{taskReadState === "ready" ? (activeTokenAddress ? t("states.noTokenOperations") : t("states.noTasks")) : taskReadState === "disconnected" ? t("states.connectWalletToRead") : taskReadState === "loading" ? t("states.loadingTasks") : t("states.taskReadFailed")}</p>
              <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-[#9FB6B6]">{taskReadState === "ready" ? (activeTokenAddress ? t("help.noTokenOperations") : t("help.noTasks")) : t("states.readStateHint")}</p>
            </section>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BoostMotionStyles() {
  return (
    <style>{`
      @keyframes flapBoostSweep {
        0%, 18% { transform: translateX(-18%) skewX(-12deg); opacity: 0; }
        28% { opacity: 0.78; }
        58%, 100% { transform: translateX(480%) skewX(-12deg); opacity: 0; }
      }
      @keyframes flapBoostRing {
        from { transform: rotate(0deg) scale(1); }
        50% { transform: rotate(180deg) scale(1.045); }
        to { transform: rotate(360deg) scale(1); }
      }
      @keyframes flapBoostRingReverse {
        from { transform: rotate(360deg) scale(0.96); }
        50% { transform: rotate(180deg) scale(1.06); }
        to { transform: rotate(0deg) scale(0.96); }
      }
      @keyframes flapBoostStatusPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(240,185,11,0.5), 0 0 10px rgba(240,185,11,0.9); }
        50% { box-shadow: 0 0 0 6px rgba(240,185,11,0), 0 0 17px rgba(255,207,61,1); }
      }
      @keyframes flapBoostIdleOrbit {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes flapBoostIdlePulse {
        0%, 100% { opacity: 0.32; transform: scale(0.82); }
        50% { opacity: 0.9; transform: scale(1.08); }
      }
      @keyframes flapBoostOnchainOrbit {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes flapBoostOnchainSweep {
        0%, 14% { transform: translateX(-30%) skewX(-12deg); opacity: 0; }
        26% { opacity: 0.9; }
        62%, 100% { transform: translateX(490%) skewX(-12deg); opacity: 0; }
      }
      .flap-boost-idle-orbit { animation: flapBoostIdleOrbit 7s linear infinite; }
      .flap-boost-idle-pulse { animation: flapBoostIdlePulse 2.4s ease-in-out infinite; }
      .flap-boost-aurora {
        background:
          radial-gradient(circle at 19% 32%, rgba(240, 185, 11, 0.21), transparent 30%),
          radial-gradient(circle at 82% 16%, rgba(255, 213, 90, 0.16), transparent 28%),
          radial-gradient(circle at 58% 78%, rgba(151, 102, 6, 0.13), transparent 34%);
        filter: blur(18px);
        opacity: 0.58;
      }
      .flap-boost-shell::before,
      .flap-boost-shell::after {
        content: "";
        pointer-events: none;
        position: absolute;
        z-index: 0;
      }
      .flap-boost-shell::before {
        inset: 0;
        background: linear-gradient(135deg, rgba(255, 220, 106, 0.055), transparent 24%, transparent 72%, rgba(240, 185, 11, 0.07));
      }
      .flap-boost-shell::after {
        right: -6rem;
        bottom: -9rem;
        height: 19rem;
        width: 19rem;
        border: 1px solid rgba(240, 185, 11, 0.16);
        border-radius: 9999px;
        box-shadow: 0 0 80px 24px rgba(240, 185, 11, 0.07);
        animation: flapBoostRing 24s linear infinite;
      }
      .flap-boost-shell > * { position: relative; z-index: 1; }
      .flap-boost-shell {
        border-color: #634c14 !important;
        background: radial-gradient(ellipse at 90% 6%, rgba(240,185,11,0.11), transparent 34%), linear-gradient(145deg, #100f0b, #070706 62%, #151107) !important;
        box-shadow: 0 28px 78px -58px rgba(240,185,11,0.9) !important;
      }
      /* The host shell can be rendered at a compact width. Lift the body scale
         inside this Vault so labels and actions stay readable without browser zoom. */
      .flap-boost-shell .text-xs { font-size: 1rem; line-height: 1.5rem; }
      .flap-boost-shell .text-sm { font-size: 1.0625rem; line-height: 1.55rem; }
      .flap-boost-shell .text-\\[10px\\] { font-size: 0.875rem; line-height: 1.3rem; }
      .flap-boost-shell .text-\\[11px\\] { font-size: 0.9375rem; line-height: 1.4rem; }
      .flap-boost-shell input,
      .flap-boost-shell textarea { font-size: 1.0625rem !important; line-height: 1.55rem; }
      .flap-boost-hero {
        border-color: #5a4514 !important;
        background: linear-gradient(118deg, #161307, #0b0a07 54%, #1a1407) !important;
      }
      .flap-boost-hero::after {
        content: "";
        position: absolute;
        inset: auto 0 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(240,185,11,0.7), rgba(255,220,112,0.85), rgba(240,185,11,0.7), transparent);
        opacity: 0.72;
      }
      .flap-boost-hero-sweep { animation: flapBoostSweep 10s ease-in-out infinite; }
      .flap-boost-hero-ring { animation: flapBoostRing 21s linear infinite; }
      .flap-boost-hero-ring-inner { animation: flapBoostRingReverse 15s linear infinite; }
      .flap-boost-status-dot { animation: flapBoostStatusPulse 2.7s ease-out infinite; }
      .flap-boost-status-dot { background: #f0b90b !important; }
      .flap-boost-panel {
        border-color: #57451b !important;
        background: linear-gradient(145deg, #111008, #0b0a07) !important;
      }
      .flap-boost-panel::before {
        content: "";
        pointer-events: none;
        position: absolute;
        inset: 0;
        background: linear-gradient(120deg, rgba(255,219,102,0.055), transparent 34%, transparent 74%, rgba(240,185,11,0.055));
      }
      .flap-boost-panel > * { position: relative; }
      .flap-boost-metrics > * {
        border-color: rgba(103, 80, 23, 0.84);
        background: linear-gradient(145deg, rgba(21,18,8,0.96), rgba(8,7,5,0.98));
        box-shadow: inset 0 1px 0 rgba(255,222,126,0.055);
      .flap-boost-workspace::before {
        content: "";
        pointer-events: none;
        position: absolute;
        inset: 0;
        background: radial-gradient(ellipse at 92% 5%, rgba(240,185,11,0.1), transparent 28%);
      }
      .flap-boost-workspace > * { position: relative; }
      .flap-boost-operation-card::before {
        content: "";
        pointer-events: none;
        position: absolute;
        inset: 0;
        opacity: 0;
        background: linear-gradient(115deg, rgba(240,185,11,0.15), transparent 48%, rgba(255,218,96,0.1));
        transition: opacity 220ms ease;
      }
      .flap-boost-operation-card:hover::before { opacity: 1; }
      .flap-boost-operation-card > * { position: relative; }
      .flap-boost-empty::before {
        content: "";
        pointer-events: none;
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 50% 34%, rgba(240,185,11,0.12), transparent 28%);
      }
      .flap-boost-empty > * { position: relative; }
      .flap-boost-workspace,
      .flap-boost-empty {
        border-color: #57451b !important;
        background: linear-gradient(145deg, #0e0d08, #090806) !important;
      }
      .flap-boost-onchain-loader::before {
        content: "";
        pointer-events: none;
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 50% -5%, rgba(240,185,11,0.22), transparent 42%);
      }
      .flap-boost-onchain-orbit { animation: flapBoostOnchainOrbit 5.8s linear infinite; }
      .flap-boost-onchain-sweep { animation: flapBoostOnchainSweep 2.8s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .flap-boost-aurora,
        .flap-boost-shell::after,
        .flap-boost-hero-sweep,
        .flap-boost-hero-ring,
        .flap-boost-hero-ring-inner,
        .flap-boost-status-dot,
        .flap-boost-idle-orbit,
        .flap-boost-idle-pulse,
        .flap-boost-onchain-orbit,
        .flap-boost-onchain-sweep { animation: none !important; }
        .flap-boost-onchain-loader .animate-spin { animation: none !important; }
      }
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
      <section className="rounded-xl border border-[#294A50] bg-[#0B1419]/75 p-4 shadow-[inset_0_1px_0_rgba(190,246,241,0.04)]">
        <SectionHeading index="01" icon={<Target className="h-4 w-4" />} title={t("labels.targetToken")} />
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            className="h-12 rounded-lg border-[#35565B] bg-[#071015] px-4 font-mono text-sm text-[#F0FAF9] placeholder:text-[#6D8587] focus:border-[#74DED8]"
            value={tokenAddress}
            readOnly={lockedToken}
            onChange={(event) => {
              setTokenAddress(event.target.value);
            }}
            placeholder={t("placeholders.targetToken")}
          />
          <Button
            type="button"
            size="sm"
            className={GOLD_SECONDARY_BUTTON + " h-12 rounded-lg px-5 text-xs"}
            onClick={onLoadToken}
            disabled={isLoadingToken}
          >
            {isLoadingToken ? t("buttons.loading") : t("buttons.loadToken")}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        {tokenInfo ? (
          <div className="mt-3 grid gap-2 rounded-lg border border-[#2E5A5D] bg-[#0D1C20] px-3 py-2.5 text-xs text-[#ACCDCB] sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#74DED8]/15 text-[#91EAE5]">
                <CircleCheck className="h-3.5 w-3.5" />
              </span>
              <span>{t("labels.loadedToken")}</span>
              <span className="font-semibold text-[#EAF9F7]">{tokenInfo.symbol}</span>
              <span className="font-mono text-[#85A4A6]">{shortAddress(tokenInfo.address)}</span>
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <SectionHeading index="02" icon={<Gauge className="h-4 w-4" />} title={t("labels.buybackMode")} />
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
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
                  "group relative min-h-36 overflow-hidden rounded-xl border p-4 text-left transition " +
                  (selected
                    ? "border-[#58B9B4] bg-[linear-gradient(145deg,#112D31,#0C1A20)] shadow-[0_18px_34px_-28px_rgba(77,204,198,0.9)]"
                    : "border-[#2D4A51] bg-[#0A1318] hover:border-[#4E7C7D] hover:bg-[#0E1D22]")
                }
              >
                {selected ? <span className="absolute inset-y-0 left-0 w-1 bg-[#74DED8]" /> : null}
                <span
                  className={
                    "flex h-9 w-9 items-center justify-center rounded-lg border " +
                    (selected
                      ? "border-[#74DED8]/70 bg-[#74DED8] text-[#061417]"
                      : "border-[#3E6167] bg-[#13242A] text-[#A9D1CE]")
                  }
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span
                  className={
                    "mt-4 block text-sm font-semibold " + (selected ? "text-[#F0FCFA]" : "text-[#C5D7D8]")
                  }
                >
                  {mode.label}
                </span>
                <span className="mt-1 block max-w-xs text-xs leading-5 text-[#91A9AA]">{mode.detail}</span>
                {selected ? <span className="absolute right-3 top-3 text-[10px] font-semibold tracking-[0.08em] text-[#8DE5DF]">{t("labels.modeFixedOnchain")}</span> : null}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-5 text-[#968A70]">{t("help.buybackMode")}</p>
      </section>

      <section className="rounded-xl border border-[#294A50] bg-[#0B1419]/75 p-4 shadow-[inset_0_1px_0_rgba(190,246,241,0.04)]">
        <SectionHeading index="03" icon={<Clock3 className="h-4 w-4" />} title={t("labels.ruleSettings")} />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {buyMode === "fixed-bnb" ? (
            <Field label={t("labels.bnbPerRound")} hint={t("help.bnbPerRound")}>
              <Input value={bnbPerRound} onChange={(event) => setBnbPerRound(event.target.value)} inputMode="decimal" placeholder={t("placeholders.bnb")} />
            </Field>
          ) : null}
          {buyMode === "fixed-token" ? (
            <>
              <Field label={t("labels.tokenAmountPerRound")} hint={t("help.tokenAmountPerRound")}>
                <Input value={tokenAmountPerRound} onChange={(event) => setTokenAmountPerRound(event.target.value)} inputMode="decimal" placeholder={t("placeholders.tokens")} />
              </Field>
              <Field label={t("labels.maxBnbPerRound")} hint={t("help.maxBnbForToken")}>
                <Input value={maxBnbPerRound} onChange={(event) => setMaxBnbPerRound(event.target.value)} inputMode="decimal" placeholder={t("placeholders.bnb")} />
              </Field>
            </>
          ) : null}
          {buyMode === "balance-percentage" ? (
            <>
              <Field label={t("labels.balancePercentage")} hint={t("help.balancePercentage")}>
                <Input value={balancePercentage} onChange={(event) => setBalancePercentage(event.target.value)} inputMode="decimal" placeholder={t("placeholders.percentage")} />
              </Field>
              <Field label={t("labels.maxBnbPerRound")} hint={t("help.maxBnbForPercentage")}>
                <Input value={maxBnbPerRound} onChange={(event) => setMaxBnbPerRound(event.target.value)} inputMode="decimal" placeholder={t("placeholders.bnbOptional")} />
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

      <section className="rounded-xl border border-[#294A50] bg-[#0B1419]/75 p-4 shadow-[inset_0_1px_0_rgba(190,246,241,0.04)]">
        <SectionHeading index="04" icon={<Flame className="h-4 w-4" />} title={t("labels.output")} />
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {outputOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={outputMode === option.value ? "default" : "outline"}
              className={
                (outputMode === option.value ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) +
                " h-11 rounded-lg justify-center px-3 text-sm"
              }
              onClick={() => setOutputMode(option.value)}
            >
              {option.value === "burn" ? <Flame className="h-3.5 w-3.5" /> : null}
              {option.label}
            </Button>
          ))}
        </div>
      </section>

      {outputMode === "retain" ? (
        <Field label={t("labels.retainWallet")} hint={t("help.retain")}>
          <Input
            value={retainRecipient}
            onChange={(event) => setRetainRecipient(event.target.value)}
            placeholder={t("placeholders.wallet")}
            className="font-mono text-xs"
          />
        </Field>
      ) : null}
      {outputMode === "distribute" ? (
        <section className="rounded-xl border border-[#5A481C] bg-[linear-gradient(135deg,#131109,#0D0C09)] p-4 shadow-[inset_0_1px_0_rgba(255,224,130,0.07)]">
          <p className="text-sm font-semibold text-[#F7E3A1]">{t("labels.distributionMode")}</p>
          <p className="mt-1 text-xs leading-5 text-[#BCA66A]">{t("help.distributionMode")}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(["fixed", "random"] as DistributionMode[]).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={distributionMode === mode ? "default" : "outline"}
                className={(distributionMode === mode ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) + " h-11 justify-center rounded-lg px-3 text-sm"}
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
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block rounded-lg border border-[#2B4D53] bg-[#091217] p-3.5 transition focus-within:border-[#5CBEB9] focus-within:shadow-[0_0_0_3px_rgba(93,211,204,0.08)]">
      <span className="block text-sm font-medium text-[#DDF1F0]">{label}</span>
      <span className="mt-1 block min-h-10 text-xs leading-5 text-[#91ABAB]">{hint}</span>
      <span className="mt-3 block [&_input]:h-11 [&_input]:rounded-lg [&_input]:border-[#35565B] [&_input]:bg-[#071015] [&_input]:px-3.5 [&_input]:font-mono [&_input]:text-sm [&_input]:text-[#EAF9F7] [&_input]:placeholder:text-[#668183] [&_input]:focus:border-[#74DED8]">
        {children}
      </span>
    </label>
  );
}

function SectionHeading({ index, icon, title }: { index: string; icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-mono text-[11px] font-semibold tracking-[0.12em] text-[#75D5CF]">{index}</span>
      <span className="h-px w-5 bg-[#3E7575]" />
      <span className="text-[#86DED8]">{icon}</span>
      <h3 className="text-sm font-semibold text-[#EAF9F7]">{title}</h3>
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
  if (!tasks.length) return null;
  return (
    <div className="grid gap-3">
      {tasks.map((task) => {
        const selected = taskKey(task) === selectedTaskAddress;
        const output = outputFromValue(task.outputMode);
        const outputDetail =
          output === "distribute"
            ? distributionFromValue(task.outputMode) === "random"
              ? t("labels.randomHoldersPerRound", undefined, { count: task.randomRecipientCount })
              : t("labels.recipientCount", undefined, { count: task.recipients.length })
            : output === "retain"
              ? t("labels.retainWallet")
              : t("outputs.burn");
        const status = !task.active
          ? t("states.closed")
          : task.paused
            ? t("badges.paused")
            : !task.started
              ? t("states.awaitingStart")
            : task.triggerId
              ? t("states.scheduled")
              : t("states.needsFunding");
        return (
          <button
            key={taskKey(task)}
            type="button"
            className={
              "group w-full rounded-xl border p-4 text-left transition duration-200 " +
              (selected
                ? "border-[#4AB6B2] bg-[linear-gradient(100deg,#10292D,#0D171D_60%,#16110E)] shadow-[inset_3px_0_0_#74DED8,0_16px_30px_-28px_rgba(82,213,206,0.92)]"
                : "border-[#263C43] bg-[#091015] hover:border-[#426970] hover:bg-[#0D171C]")
            }
            onClick={() => onSelect(taskKey(task))}
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_0.8fr_0.8fr_auto] sm:items-center">
              <div className="min-w-0">
                <span className="font-semibold text-[#F0FAF9]">
                  {outputRuleLabel(t, task.outputMode)} · {task.token.symbol}
                </span>
                <p className="mt-1 font-mono text-xs text-[#8FA9AA]">{shortAddress(task.address)} · #{task.operationId + 1} · {t("labels.selectToManage")}</p>
              </div>
              <div className="border-l border-[#29434A] pl-3 text-sm text-[#C7D9D8] sm:pl-4">
                <span className="text-xs text-[#87A2A3]">{t("labels.totalBnb")}</span>
                <p className="mt-1 font-mono font-semibold text-[#D7F5F2]">
                  {formatTokenAmount(taskTotalBNB(task), 18)} BNB
                </p>
              </div>
              <div className="border-l border-[#29434A] pl-3 text-sm text-[#C7D9D8] sm:pl-4">
                <span className="text-xs text-[#87A2A3]">{t("labels.totalSpent")}</span>
                <p className="mt-1 font-mono font-semibold text-[#F0CB9D]">{formatTokenAmount(task.totalBNBSpent, 18)} BNB</p>
              </div>
              <div className="flex sm:justify-end">
                <StatusBadge muted={!task.active || task.paused}>{status}</StatusBadge>
              </div>
            </div>

            <div className="mt-4 grid gap-3 border-t border-[#29434A] pt-3 sm:grid-cols-3">
              <div className="min-w-0">
                <span className="text-xs text-[#87A2A3]">{t("labels.roundRule")}</span>
                <p className="mt-1 text-sm font-semibold text-[#E9F6F5]">{buyModeLabel(t, task.buyMode)}</p>
                <p className="mt-1 truncate font-mono text-xs text-[#A8C0C0]">{taskRuleDetail(t, task)}</p>
              </div>
              <div className="border-l border-[#29434A] pl-3 sm:pl-4">
                <span className="text-xs text-[#87A2A3]">{t("labels.interval")}</span>
                <p className="mt-1 text-sm font-semibold text-[#E9F6F5]">
                  {formatTokenAmount(task.interval / 60n, 0)} {t("labels.minutes")}
                </p>
              </div>
              <div className="border-l border-[#29434A] pl-3 sm:pl-4">
                <span className="text-xs text-[#87A2A3]">{t("labels.output")}</span>
                <p className="mt-1 text-sm font-semibold text-[#E9F6F5]">{outputRuleLabel(t, task.outputMode)}</p>
                <p className="mt-1 text-xs text-[#A8C0C0]">{outputDetail}</p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TaskOverview({
  t,
  task,
  canWrite,
  isOwner,
  buttonState,
  onUpdate,
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
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
        : t("outputs.burn");
  const healthDetail = task.callbackInProgress
    ? t("states.callbackRunning")
    : task.consecutiveFailures
      ? `${task.consecutiveFailures} ${t("labels.failedRetries")}`
      : t("states.healthy");
  return (
    <details open className="group overflow-hidden rounded-2xl border border-[#263C43] bg-[#0B1014] shadow-[inset_0_1px_0_rgba(190,246,241,0.035)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div>
          <div className="flex items-center gap-2.5 text-base font-semibold text-[#F0FAF9]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#3E7778] bg-[#11282C] text-[#87E1DC]">
              <Flame className="h-4 w-4" />
            </span>
            {t("sections.taskOverview")}
          </div>
          <p className="mt-1 text-xs leading-5 text-[#9FB6B6]">{t("help.taskOverview")}</p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#86DED8] transition group-open:rotate-90" />
      </summary>
      <div className="grid gap-3 border-t border-[#263C43] p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
        <InfoTile label={t("labels.targetToken")} value={task.token.symbol} detail={shortAddress(task.token.address)} />
        <InfoTile
          label={t("labels.buybackMode")}
          value={buyModeLabel(t, task.buyMode)}
          detail={taskRuleDetail(t, task)}
        />
        <InfoTile
          label={t("labels.interval")}
          value={(task.interval / 60n).toString() + " min"}
          detail={t("labels.automatic")}
        />
        <InfoTile
          label={t("labels.output")}
          value={outputRuleLabel(t, task.outputMode)}
          detail={outputDetail}
        />
        <InfoTile
          label={t("labels.totalTokensOut")}
          value={formatTokenAmount(task.totalTokensOutput, task.token.decimals)}
          detail={t("labels.onchainResult")}
        />
        <InfoTile
          label={t("labels.executionHealth")}
          value={healthDetail}
          detail={task.triggerId ? `${t("labels.triggerId")} #${task.triggerId.toString()}` : t("states.callbackIdle")}
        />
      </div>
      {isOwner && task.active ? (
        <div className="border-t border-[#263C43] bg-[#091217]/70 p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[#DDF1F0]">{t("labels.editableRules")}</p>
              <p className="mt-1 text-xs leading-5 text-[#8FA9AA]">{t("help.editRules")}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={GOLD_OUTLINE_BUTTON + " h-10 rounded-lg px-4 text-xs"}
              onClick={() => setEditing((value) => !value)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {editing ? t("buttons.cancel") : t("buttons.editRules")}
            </Button>
          </div>
          {task.pendingRuleUpdate ? (
            <p className="mt-3 rounded-lg border border-[#555033] bg-[#1A1710] px-3 py-2 text-xs leading-5 text-[#D5C585]">
              {t("states.rulesQueued")}
            </p>
          ) : null}
          {editing ? (
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
          ) : null}
        </div>
      ) : null}
    </details>
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
  const [fixedTokens, setFixedTokens] = useState(formatTokenAmount(rules.fixedTokenAmountPerRound, task.token.decimals, 18));
  const [balanceShare, setBalanceShare] = useState((rules.balanceBps / 100).toString());
  const [maxBnb, setMaxBnb] = useState(formatTokenAmount(rules.maxBNBPerRound, 18, 18));
  const [intervalMinutes, setIntervalMinutes] = useState((rules.interval / 60n).toString());
  const [output, setOutput] = useState<OutputMode>(outputFromValue(rules.outputMode));
  const [distributionMode, setDistributionMode] = useState<DistributionMode>(distributionFromValue(rules.outputMode));
  const [retainRecipient, setRetainRecipient] = useState(rules.retainRecipient === ZERO_ADDRESS ? "" : rules.retainRecipient);
  const [recipientsText, setRecipientsText] = useState(rules.recipients.join("\n"));
  const [randomRecipientCount, setRandomRecipientCount] = useState(String(rules.randomRecipientCount || 5));
  const [formError, setFormError] = useState<string | null>(null);

  function submitRules() {
    try {
      const interval = Number(intervalMinutes);
      if (!Number.isInteger(interval) || interval < 1) throw new Error(t("errors.interval"));

      let fixedBNBPerRound = 0n;
      let fixedTokenAmountPerRound = 0n;
      let balanceBps = 0;
      let maxBNBPerRound = 0n;
      if (mode === "fixed-bnb") {
        fixedBNBPerRound = parseTokenAmount(fixedBnb, 18);
        if (fixedBNBPerRound <= 0n) throw new Error(t("errors.amount"));
      } else if (mode === "fixed-token") {
        fixedTokenAmountPerRound = parseTokenAmount(fixedTokens, task.token.decimals);
        maxBNBPerRound = parseTokenAmount(maxBnb, 18);
        if (fixedTokenAmountPerRound <= 0n || maxBNBPerRound <= 0n) throw new Error(t("errors.amount"));
      } else {
        balanceBps = parsePercentageToBps(balanceShare);
        maxBNBPerRound = maxBnb.trim() ? parseTokenAmount(maxBnb, 18) : 0n;
      }

      const recipients = recipientsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      let outputMode = 0;
      let randomCount = 0;
      let recipient = ZERO_ADDRESS;
      if (output === "retain") {
        if (!isValidAddress(retainRecipient)) throw new Error(t("errors.retainWallet"));
        outputMode = 1;
        recipient = retainRecipient as Address;
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
            recipients.some((value) => !isValidAddress(value))
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
        interval: BigInt(interval * 60),
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
    <div className="mt-4 rounded-xl border border-[#2E5A5D] bg-[#0A151A] p-3.5 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2A4E53] pb-3">
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
          <>
            <CompactField label={t("labels.tokenAmountPerRound")} hint={t("help.tokenAmountPerRound")}>
              <Input value={fixedTokens} onChange={(event) => setFixedTokens(event.target.value)} inputMode="decimal" />
            </CompactField>
            <CompactField label={t("labels.maxBnbPerRound")} hint={t("help.maxBnbForToken")}>
              <Input value={maxBnb} onChange={(event) => setMaxBnb(event.target.value)} inputMode="decimal" />
            </CompactField>
          </>
        ) : null}
        {mode === "balance-percentage" ? (
          <>
            <CompactField label={t("labels.balancePercentage")} hint={t("help.balancePercentage")}>
              <Input value={balanceShare} onChange={(event) => setBalanceShare(event.target.value)} inputMode="decimal" />
            </CompactField>
            <CompactField label={t("labels.maxBnbPerRound")} hint={t("help.maxBnbForPercentage")}>
              <Input value={maxBnb} onChange={(event) => setMaxBnb(event.target.value)} inputMode="decimal" placeholder={t("placeholders.bnbOptional")} />
            </CompactField>
          </>
        ) : null}
        <CompactField label={t("labels.interval")} hint={t("help.interval")}>
          <Input value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} inputMode="numeric" />
        </CompactField>
      </div>
      <div className="mt-4 border-t border-[#2A4E53] pt-4">
        <p className="text-sm font-medium text-[#DDF1F0]">{t("labels.output")}</p>
        <p className="mt-1 text-xs leading-5 text-[#D5C585]">{t("help.editOutputRisk")}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {(["burn", "retain", "distribute"] as OutputMode[]).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={output === option ? "default" : "outline"}
              className={(output === option ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) + " h-10 justify-center rounded-lg px-3 text-xs"}
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
            <Input value={retainRecipient} onChange={(event) => setRetainRecipient(event.target.value)} className="font-mono text-xs" />
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
                className={(distributionMode === mode ? GOLD_PRIMARY_BUTTON : GOLD_OUTLINE_BUTTON) + " h-10 justify-center rounded-lg px-3 text-xs"}
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
              <textarea value={recipientsText} onChange={(event) => setRecipientsText(event.target.value)} rows={3} className="mt-3 w-full resize-y rounded-md border border-[#5C4B1D] bg-[#080806] px-3 py-2 font-mono text-xs text-[#FFF2C4] outline-none focus:border-[#F0B90B]" />
            </label>
          ) : (
            <div className="mt-3">
              <CompactField label={t("labels.randomHolderCount")} hint={t("help.randomHolders")}>
                <Input value={randomRecipientCount} onChange={(event) => setRandomRecipientCount(event.target.value)} inputMode="numeric" placeholder={t("placeholders.randomHolders")} />
              </CompactField>
            </div>
          )}
        </div>
      ) : null}
      {formError ? <p className="mt-3 rounded-lg border border-[#874A4A] bg-[#2A1518] px-3 py-2 text-xs text-[#FFB5AF]">{formError}</p> : null}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" size="sm" variant="outline" className={GOLD_OUTLINE_BUTTON + " h-10 rounded-lg px-4 text-xs"} onClick={onCancel}>
          {t("buttons.cancel")}
        </Button>
        <TxButton className={GOLD_PRIMARY_BUTTON + " h-10 rounded-lg px-4 text-xs"} idleLabel={t("buttons.saveRules")} state={buttonState} onClick={submitRules} disabled={!canWrite} />
      </div>
    </div>
  );
}

function CompactField({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block rounded-lg border border-[#2B4D53] bg-[#091217] p-3">
      <span className="block text-sm font-medium text-[#DDF1F0]">{label}</span>
      <span className="mt-1 block text-xs leading-5 text-[#91ABAB]">{hint}</span>
      <span className="mt-2 block [&_input]:h-10 [&_input]:rounded-md [&_input]:border-[#35565B] [&_input]:bg-[#071015] [&_input]:px-3 [&_input]:font-mono [&_input]:text-sm [&_input]:text-[#EAF9F7] [&_input]:focus:border-[#74DED8]">{children}</span>
    </label>
  );
}

function InfoTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[#29474D] bg-[#091217] px-3.5 py-3.5">
      <p className="text-xs text-[#8DA7A8]">{label}</p>
      <p className="mt-1.5 truncate font-mono text-sm font-semibold text-[#EAF9F7]">{value}</p>
      <p className="mt-1 truncate text-xs text-[#A9C7C5]">{detail}</p>
    </div>
  );
}

function TaskFunding({
  t,
  task,
  canWrite,
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
}: {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  task: TaskSnapshot;
  canWrite: boolean;
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
}) {
  const status = !task.active
    ? t("states.closed")
    : task.paused
      ? t("badges.paused")
      : !task.started
        ? t("states.awaitingStart")
      : task.triggerId
        ? t("states.scheduled")
        : t("states.needsFunding");
  return (
    <section className="rounded-2xl border border-[#263C43] bg-[#0B1014] p-4 shadow-[inset_0_1px_0_rgba(190,246,241,0.035)] sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#263C43] pb-4">
        <div className="flex items-center gap-2.5 text-base font-semibold text-[#F0FAF9]">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#3E7778] bg-[#11282C] text-[#87E1DC]">
            <Wallet className="h-4 w-4" />
          </span>
          {t("sections.taskFunds")}
        </div>
        <StatusBadge muted={!task.active || task.paused}>{status}</StatusBadge>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric
          label={t("labels.totalBnb")}
          value={formatTokenAmount(taskTotalBNB(task), 18)}
          hint="BNB"
          className="col-span-2 rounded-lg border-[#29474D] bg-[#091217] px-3.5 py-3.5 sm:col-span-1"
        />
        <Metric
          label={t("labels.availableBnb")}
          value={formatTokenAmount(task.availableBNB, 18)}
          hint="BNB"
          className="rounded-lg border-[#29474D] bg-[#091217] px-3.5 py-3.5"
        />
        <Metric
          label={t("labels.reservedBnb")}
          value={formatTokenAmount(task.reservedBNB, 18)}
          hint="BNB"
          className="rounded-lg border-[#29474D] bg-[#091217] px-3.5 py-3.5"
        />
      </div>
      {!task.started && task.active ? (
        <p className="mt-2 rounded-lg border border-[#356469] bg-[#102126] px-3 py-2 text-xs leading-5 text-[#A6E8E2]">{t("help.firstDirect")}</p>
      ) : null}

      {task.active ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-[#294A50] bg-[#091217] p-3.5">
            <label className="mb-2.5 block text-sm font-medium text-[#DDF1F0]">{t("labels.funding")}</label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                className="h-11 rounded-lg border-[#35565B] bg-[#071015] px-3.5 font-mono text-sm text-[#EAF9F7] placeholder:text-[#668183] focus:border-[#74DED8]"
                value={fundingAmount}
                onChange={(event) => setFundingAmount(event.target.value)}
                inputMode="decimal"
                placeholder={t("placeholders.bnb")}
              />
              <TxButton
                className={GOLD_PRIMARY_BUTTON + " h-11 min-w-[108px] rounded-lg px-4 text-xs"}
                idleLabel={t("buttons.fund")}
                state={buttonState("fund:" + task.address)}
                onClick={onFund}
                disabled={!canWrite}
              />
            </div>
          </div>
          <TxButton
            className={GOLD_SECONDARY_BUTTON + " h-10 w-full rounded-lg px-3 text-xs"}
            idleLabel={t(task.started ? "buttons.checkFunds" : "buttons.checkAndStart")}
            state={buttonState((task.started ? "poke:" : "start:") + task.address)}
            onClick={onCheck}
            disabled={!canWrite || task.paused || (!task.started && !isOwner)}
            variant="secondary"
          />
        </div>
      ) : null}

      {isOwner && task.active ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[#263C43] pt-4">
          {task.paused ? (
            <TxButton
              className={GOLD_PRIMARY_BUTTON + " h-10 rounded-lg px-4 text-xs"}
              idleLabel={t("buttons.resume")}
              state={buttonState("resume:" + task.address)}
              onClick={onResume}
              disabled={!canWrite}
            />
          ) : (
            <TxButton
              className={GOLD_SECONDARY_BUTTON + " h-10 rounded-lg px-4 text-xs"}
              idleLabel={t("buttons.pause")}
              state={buttonState("pause:" + task.address)}
              onClick={onPause}
              disabled={!canWrite}
              variant="secondary"
            />
          )}
          <TxButton
            className={GOLD_OUTLINE_BUTTON + " h-10 rounded-lg px-4 text-xs"}
            idleLabel={t("buttons.closeTask")}
            state={buttonState("close:" + task.address)}
            onClick={onClose}
            disabled={!canWrite}
            variant="outline"
          />
        </div>
      ) : null}

      {isOwner ? (
        <div className="mt-4 border-t border-[#263C43] pt-4">
          <label className="mb-2.5 flex items-center justify-between gap-2 text-sm font-medium text-[#DDF1F0]">
            <span>{t("labels.withdraw")}</span>
            <span className="font-mono text-xs text-[#8DE5DF]">{formatTokenAmount(task.availableBNB, 18)} BNB</span>
          </label>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <Input
              className="h-11 rounded-lg border-[#35565B] bg-[#071015] px-3.5 font-mono text-sm text-[#EAF9F7] placeholder:text-[#668183] focus:border-[#74DED8]"
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(event.target.value)}
              inputMode="decimal"
              placeholder={t("placeholders.bnb")}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={GOLD_SECONDARY_BUTTON + " h-11 rounded-lg px-4 text-xs"}
              onClick={onSetWithdrawMax}
              disabled={!task.availableBNB}
            >
              {t("buttons.max")}
            </Button>
            <TxButton
              className={GOLD_OUTLINE_BUTTON + " h-11 min-w-[108px] rounded-lg px-4 text-xs"}
              idleLabel={t("buttons.withdraw")}
              state={buttonState("withdraw:" + task.address)}
              onClick={onWithdraw}
              disabled={!canWrite || !task.availableBNB}
              variant="outline"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
