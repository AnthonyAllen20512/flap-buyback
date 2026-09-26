"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, VaultComponentProps } from "@/src/sdk";
import { ZERO_ADDRESS, formatPercentBps, formatTokenAmount, handleTxError, isValidAddress, parseTokenAmount, useFlapSdk } from "@/src/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, DetailTile, Input, Metric, StatusBadge, TxButton } from "@/src/ui";
import type { TxButtonState } from "@/src/ui";
import { ExternalLink, Flame, Plus, RefreshCw, Settings2, Users, Wallet, X } from "lucide-react";
import { factoryAbi, vaultAbi } from "./VaultABI";

const BOOST_FACTORY_TESTNET_ADDRESS = "0xdf7C0c2A1a4DB999A86e9dfdAC1774cb3A90817b" as Address;
const DISPLAY_LIMIT = 25n;

type TaskTuple = readonly [bigint, bigint, Address, number, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
type ExecutionTuple = readonly [bigint, bigint, bigint, bigint, number, number, boolean];
type TotalsTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type TokenPreviewTuple = readonly [string, number, bigint];
type BuybackMode = "fixed-bnb" | "balance-ratio" | "fixed-token";
type OutputMode = "burn" | "retain" | "distribute";
type DistributionMode = "fixed" | "random";

interface TaskRecord { id: bigint; task: TaskTuple; }
interface TaskTokenInfo { symbol: string; decimals: number; }
interface TokenTotals extends TaskTokenInfo { address: Address; bought: bigint; burned: bigint; retained: bigint; distributed: bigint; }
interface Snapshot {
  owner: Address;
  availableBNB: bigint;
  activeTaskCount: bigint;
  taskCount: bigint;
  totals: TotalsTuple;
  tasks: TaskRecord[];
  taskTokens: Record<string, TaskTokenInfo>;
  tokenTotals: TokenTotals[];
}
interface TokenPreview {
  address: Address;
  symbol: string;
  decimals: number;
  walletBalance: bigint;
  vaultBalance: bigint;
}

function asBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value) return BigInt(value);
  return 0n;
}
function asNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value) return Number(value);
  return 0;
}
function asAddress(value: unknown) {
  return typeof value === "string" && isValidAddress(value) ? value as Address : ZERO_ADDRESS;
}
/** viem exposes a Solidity single-struct return as a named object, while the table uses a compact tuple. */
function normalizeTask(value: unknown): TaskTuple {
  const task = Array.isArray(value)
    ? { createdAt: value[0], closedAt: value[1], targetToken: value[2], mode: value[3], tokenOutput: value[4], interval: value[5], amount: value[6], bnbAvailable: value[7], bnbSpent: value[8], executions: value[9], triggerId: value[10], scheduledFor: value[11], pendingExecution: value[12], active: value[13], paused: value[14] }
    : (value ?? {}) as Record<string, unknown>;
  return [
    asBigInt(task.createdAt), asBigInt(task.closedAt), asAddress(task.targetToken), asNumber(task.mode), asNumber(task.tokenOutput),
    asBigInt(task.interval), asBigInt(task.amount), asBigInt(task.bnbAvailable), asBigInt(task.bnbSpent), asBigInt(task.executions),
    asBigInt(task.triggerId), asBigInt(task.scheduledFor), asBigInt(task.pendingExecution), Boolean(task.active), Boolean(task.paused),
  ];
}

function decimalToBps(value: string) {
  if (!/^\d+(\.\d{0,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}
function shortAddress(address: string) {
  return isValidAddress(address) ? address.slice(0, 6) + "…" + address.slice(-4) : "—";
}
function explorerAddressHref(address: string) {
  return "https://testnet.bscscan.com/address/" + address;
}
function formatTime(timestamp: bigint, nowSeconds: number, ready: string, unknown: string) {
  if (timestamp <= 0n) return unknown;
  return Number(timestamp) <= nowSeconds ? ready : new Date(Number(timestamp) * 1000).toLocaleString();
}
function modeFromValue(value: number): BuybackMode {
  return value === 1 ? "balance-ratio" : value === 2 ? "fixed-token" : "fixed-bnb";
}
function outputFromValue(value: number): OutputMode {
  return value === 1 ? "retain" : value === 2 ? "distribute" : "burn";
}

export default function FlapBoostMiniApp(_props: VaultComponentProps) {
  const sdk = useFlapSdk();
  const { context, i18n } = sdk;
  const t = i18n.t;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [personalVaultAddress, setPersonalVaultAddress] = useState<Address | null>(null);
  const [factoryUnavailable, setFactoryUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxButtonState>("idle");
  const [now, setNow] = useState(() => Date.now());
  const [showCreateTask, setShowCreateTask] = useState(false);

  const [buybackMode, setBuybackMode] = useState<BuybackMode>("fixed-bnb");
  const [modeAmount, setModeAmount] = useState("0.1");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [slippage, setSlippage] = useState("1");
  const [outputMode, setOutputMode] = useState<OutputMode>("burn");
  const [retainRecipient, setRetainRecipient] = useState("");
  const [distributionMode, setDistributionMode] = useState<DistributionMode>("random");
  const [randomHolders, setRandomHolders] = useState("100");
  const [fixedRecipientsText, setFixedRecipientsText] = useState("");

  const [tokenAddressInput, setTokenAddressInput] = useState<string>(context.tokenAddress);
  const [tokenPreview, setTokenPreview] = useState<TokenPreview | null>(null);
  const [tokenLookupLoading, setTokenLookupLoading] = useState(false);
  const [bnbFundingAmount, setBnbFundingAmount] = useState("");
  const [bnbWithdrawAmount, setBnbWithdrawAmount] = useState("");
  const requestRef = useRef(0);
  const autoLoadedTokenRef = useRef<string | null>(null);

  const factoryAddress = context.chainId === 97 ? BOOST_FACTORY_TESTNET_ADDRESS : null;
  const vaultAddress = personalVaultAddress ?? ZERO_ADDRESS;
  const wrongNetwork = sdk.wallet.isWrongNetwork;
  const canWrite = Boolean(context.userAddress && personalVaultAddress && !factoryUnavailable && !wrongNetwork);
  const isOwner = Boolean(snapshot?.owner && context.userAddress && snapshot.owner.toLowerCase() === context.userAddress.toLowerCase());
  const tokenDecimals = tokenPreview?.decimals ?? 18;
  const nowSeconds = Math.floor(now / 1000);

  const config = useMemo(() => {
    try {
      const interval = Number(intervalMinutes);
      const slippageBps = decimalToBps(slippage);
      if (!isValidAddress(tokenAddressInput)) throw new Error(t("errors.targetToken"));
      if (!Number.isInteger(interval) || interval < 1) throw new Error(t("errors.interval"));
      if (slippageBps === null || slippageBps > 5000) throw new Error(t("errors.slippage"));
      let amount: bigint;
      let buybackModeValue = 0;
      if (buybackMode === "balance-ratio") {
        const bps = decimalToBps(modeAmount);
        if (bps === null || bps <= 0 || bps > 10_000) throw new Error(t("errors.amount"));
        amount = BigInt(bps);
        buybackModeValue = 1;
      } else {
        amount = parseTokenAmount(modeAmount, buybackMode === "fixed-token" ? tokenDecimals : 18);
        if (amount <= 0n) throw new Error(t("errors.amount"));
        if (buybackMode === "fixed-token") buybackModeValue = 2;
      }
      const fixedRecipients = fixedRecipientsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      let outputModeValue = 0;
      let distributionModeValue = 0;
      let recipient = ZERO_ADDRESS;
      let randomCount = 0;
      if (outputMode === "retain") {
        if (!isValidAddress(retainRecipient)) throw new Error(t("errors.retainWallet"));
        outputModeValue = 1;
        recipient = retainRecipient as Address;
      }
      if (outputMode === "distribute") {
        outputModeValue = 2;
        if (distributionMode === "fixed") {
          const unique = new Set(fixedRecipients.map((item) => item.toLowerCase()));
          if (fixedRecipients.length < 1 || fixedRecipients.length > 5 || unique.size !== fixedRecipients.length || fixedRecipients.some((item) => !isValidAddress(item))) throw new Error(t("errors.fixedRecipients"));
          distributionModeValue = 1;
        } else {
          const count = Number(randomHolders);
          if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error(t("errors.randomHolders"));
          distributionModeValue = 2;
          randomCount = count;
        }
      }
      return {
        buybackMode: buybackModeValue,
        amountPerRound: amount,
        intervalSeconds: BigInt(interval * 60),
        maxSlippageBps: slippageBps,
        outputMode: outputModeValue,
        retainRecipient: recipient,
        distributionMode: distributionModeValue,
        randomHolderCount: randomCount,
        fixedRecipients: fixedRecipients as Address[],
        targetToken: tokenAddressInput as Address,
      };
    } catch (nextError) {
      return nextError instanceof Error ? nextError : new Error(t("errors.amount"));
    }
  }, [buybackMode, distributionMode, fixedRecipientsText, intervalMinutes, modeAmount, outputMode, randomHolders, retainRecipient, slippage, t, tokenAddressInput, tokenDecimals]);

  const loadPersonalVault = useCallback(async () => {
    if (!context.userAddress || !factoryAddress) {
      setPersonalVaultAddress(null);
      setFactoryUnavailable(!factoryAddress);
      return;
    }
    const address = await sdk.readContract<Address>({
      contract: "boostFactory",
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "personalVaultOf",
      args: [context.userAddress],
    });
    setPersonalVaultAddress(address === ZERO_ADDRESS ? null : address);
    setFactoryUnavailable(false);
  }, [context.userAddress, factoryAddress, sdk]);

  const loadData = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!personalVaultAddress) {
      if (requestId === requestRef.current) setSnapshot(null);
      return;
    }
    const [owner, availableBNB, taskCount, activeTaskCount, totals] = await Promise.all([
      sdk.readContract<Address>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "planOwner" }),
      sdk.readContract<bigint>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "availableBNB" }),
      sdk.readContract<bigint>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "taskCount" }),
      sdk.readContract<bigint>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "activeTaskCount" }),
      sdk.readContract<TotalsTuple>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "getTotals" }),
    ]);
    const allTaskIds = Array.from({ length: Number(taskCount) }, (_, index) => BigInt(index + 1));
    const allTasks = await Promise.all(allTaskIds.map(async (id) => ({ id, task: normalizeTask(await sdk.readContract<unknown>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "getTask", args: [id] })) })));
    const tasks = allTasks.slice(-Number(DISPLAY_LIMIT)).reverse();
    const targetTokens = Array.from(new Set(allTasks.map(({ task }) => task[2].toLowerCase())));
    const taskTokens = Object.fromEntries(await Promise.all(targetTokens.map(async (token) => {
      try {
        const preview = await sdk.readContract<TokenPreviewTuple>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "getTokenPreview", args: [token as Address, ZERO_ADDRESS] });
        return [token, { symbol: preview[0] || "TOKEN", decimals: preview[1] }] as const;
      } catch {
        return [token, { symbol: "TOKEN", decimals: 18 }] as const;
      }
    }))) as Record<string, TaskTokenInfo>;
    const taskById = new Map(allTasks.map(({ id, task }) => [id.toString(), task]));
    const tokenTotalsByAddress = new Map<string, TokenTotals>(targetTokens.map((token) => {
      const info = taskTokens[token] ?? { symbol: "TOKEN", decimals: 18 };
      return [token, { address: token as Address, ...info, bought: 0n, burned: 0n, retained: 0n, distributed: 0n }];
    }));
    const executionIds = Array.from({ length: Number(totals[6]) }, (_, index) => BigInt(index + 1));
    const executions = await Promise.all(executionIds.map((id) => sdk.readContract<ExecutionTuple>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "getExecution", args: [id] })));
    for (const execution of executions) {
      const task = taskById.get(execution[0].toString());
      if (!task) continue;
      const aggregate = tokenTotalsByAddress.get(task[2].toLowerCase());
      if (!aggregate) continue;
      aggregate.bought += execution[3];
      if (execution[5] === 0) aggregate.burned += execution[3];
      if (execution[5] === 1) aggregate.retained += execution[3];
      if (execution[5] === 2 && execution[6]) aggregate.distributed += execution[3];
    }
    if (requestId === requestRef.current) setSnapshot({ owner, availableBNB, taskCount, activeTaskCount, totals, tasks, taskTokens, tokenTotals: Array.from(tokenTotalsByAddress.values()) });
  }, [personalVaultAddress, sdk, vaultAddress]);

  useEffect(() => {
    void loadPersonalVault().catch(() => setFactoryUnavailable(true));
    const timer = window.setInterval(() => void loadPersonalVault().catch(() => setFactoryUnavailable(true)), 15_000);
    return () => window.clearInterval(timer);
  }, [loadPersonalVault]);

  useEffect(() => {
    requestRef.current += 1;
    autoLoadedTokenRef.current = null;
    setSnapshot(null);
    setTokenPreview(null);
  }, [personalVaultAddress]);

  useEffect(() => {
    if (!personalVaultAddress) return;
    void loadData().catch(() => undefined);
    const timer = window.setInterval(() => void loadData().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [loadData, personalVaultAddress]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const buttonState = (key: string): TxButtonState => activeAction === key ? txState : "idle";
  const runAction = useCallback(async (key: string, operation: () => Promise<void>, message: string) => {
    setError(null);
    setActiveAction(key);
    try {
      await operation();
      sdk.notify.success(message);
      await loadData();
    } catch (nextError) {
      setError(handleTxError(nextError, { simulationFailed: t("errors.simulation"), unknown: t("errors.tx") }));
      setTxState("failed");
    } finally {
      setActiveAction(null);
      setTxState("idle");
    }
  }, [loadData, sdk, t]);

  async function createPersonalVault() {
    if (!factoryAddress || !context.userAddress || wrongNetwork || factoryUnavailable) return;
    await runAction("create-vault", async () => {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({ contract: "boostFactory", address: factoryAddress, abi: factoryAbi, functionName: "createPersonalVault" });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
      await loadPersonalVault();
    }, t("messages.vaultCreated"));
  }

  const loadToken = useCallback(async (value = tokenAddressInput) => {
    const token = value.trim();
    if (!isValidAddress(token)) {
      setError(t("errors.targetToken"));
      return;
    }
    if (!personalVaultAddress) return;
    setError(null);
    setTokenLookupLoading(true);
    try {
      const [wallet, vault] = await Promise.all([
        sdk.readContract<TokenPreviewTuple>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "getTokenPreview", args: [token as Address, context.userAddress ?? ZERO_ADDRESS] }),
        sdk.readContract<TokenPreviewTuple>({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "getTokenPreview", args: [token as Address, vaultAddress] }),
      ]);
      setTokenAddressInput(token);
      setTokenPreview({ address: token as Address, symbol: wallet[0], decimals: wallet[1], walletBalance: wallet[2], vaultBalance: vault[2] });
    } catch (nextError) {
      setError(handleTxError(nextError, { unknown: t("errors.targetLookup") }));
    } finally {
      setTokenLookupLoading(false);
    }
  }, [context.userAddress, personalVaultAddress, sdk, t, tokenAddressInput, vaultAddress]);

  useEffect(() => {
    if (!personalVaultAddress || !isValidAddress(context.tokenAddress)) return;
    const key = (personalVaultAddress + ":" + context.tokenAddress).toLowerCase();
    if (autoLoadedTokenRef.current === key) return;
    autoLoadedTokenRef.current = key;
    setTokenAddressInput(context.tokenAddress);
    void loadToken(context.tokenAddress);
  }, [context.tokenAddress, loadToken, personalVaultAddress]);

  async function loadProjectCa() {
    if (!isValidAddress(context.tokenAddress)) {
      setError(t("errors.targetToken"));
      return;
    }
    setTokenAddressInput(context.tokenAddress);
    await loadToken(context.tokenAddress);
  }

  async function createTask() {
    if (!canWrite || !isOwner || config instanceof Error || !tokenPreview) {
      if (config instanceof Error) setError(config.message);
      else if (!tokenPreview) setError(t("errors.loadTokenFirst"));
      return;
    }
    await runAction("create-task", async () => {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "createTask", args: [config] });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
      setShowCreateTask(false);
    }, t("messages.taskCreated"));
  }

  async function fundBNB() {
    if (!canWrite || !isOwner) return;
    let amount: bigint;
    try {
      amount = parseTokenAmount(bnbFundingAmount, 18);
      if (amount <= 0n) throw new Error(t("errors.funding"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("errors.funding"));
      return;
    }
    await runAction("fund-bnb", async () => {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "fundBNB", value: amount });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
      setBnbFundingAmount("");
    }, t("messages.bnbFunded"));
  }

  async function withdrawBNB() {
    if (!canWrite || !isOwner) return;
    let amount: bigint;
    try {
      amount = parseTokenAmount(bnbWithdrawAmount, 18);
      if (amount <= 0n || amount > (snapshot?.availableBNB ?? 0n)) throw new Error(t("errors.withdraw"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("errors.withdraw"));
      return;
    }
    await runAction("withdraw-bnb", async () => {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "withdrawBNB", args: [context.userAddress as Address, amount] });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
      setBnbWithdrawAmount("");
    }, t("messages.withdrawn"));
  }

  async function checkFundsAndSchedule() {
    if (!canWrite || !isOwner) return;
    await runAction("sync-tasks", async () => {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: "sync" });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
    }, t("messages.tasksChecked"));
  }

  async function taskAction(taskId: bigint, action: "pauseTask" | "resumeTask" | "closeTask") {
    if (!canWrite || !isOwner) return;
    const key = action + ":" + taskId.toString();
    const message = action === "pauseTask" ? t("messages.paused") : action === "resumeTask" ? t("messages.resumed") : t("messages.taskClosed");
    await runAction(key, async () => {
      setTxState("simulating");
      const simulation = await sdk.simulateContract({ contract: "vault", address: vaultAddress, abi: vaultAbi, functionName: action, args: [taskId] });
      setTxState("writing");
      const hash = await sdk.writeContract(simulation.request);
      setTxState("confirming");
      await sdk.waitForTx(hash);
    }, message);
  }

  const modeOptions = [
    { value: "fixed-bnb" as const, label: t("modes.fixedBnb") },
    { value: "balance-ratio" as const, label: t("modes.balanceRatio") },
    { value: "fixed-token" as const, label: t("modes.fixedToken") },
  ];
  const outputOptions = [
    { value: "burn" as const, label: t("outputs.burn") },
    { value: "retain" as const, label: t("outputs.retain") },
    { value: "distribute" as const, label: t("outputs.distribute") },
  ];

  return (
    <div className="min-h-full w-full space-y-3 sm:space-y-4">
      <Card className="overflow-hidden rounded-[18px] border-white/10 bg-gradient-to-b from-[#10150f] to-[#070808] shadow-[0_20px_70px_-38px_rgba(208,255,0,0.42)]">
        <CardHeader className="p-4 pb-3 sm:p-5 sm:pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#D0FF00] shadow-[0_0_12px_rgba(208,255,0,0.8)]" /><CardTitle className="text-base sm:text-lg">{t("title")}</CardTitle></div>
              <p className="max-w-2xl text-sm font-medium leading-6 text-[#9ba693]">{t("subtitleMulti")}</p>
            </div>
            <StatusBadge tone={snapshot?.activeTaskCount ? "success" : "warning"}>{snapshot?.activeTaskCount ? t("badges.active") : t("badges.unconfigured")}</StatusBadge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:space-y-4 sm:p-5 sm:pt-0">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric label={t("labels.activeTasks")} value={String(snapshot?.activeTaskCount ?? 0n)} hint={t("labels.tasks")} tone="primary" />
            <Metric label={t("labels.availableBnb")} value={formatTokenAmount(snapshot?.availableBNB, 18)} hint={t("labels.sharedBnb")} />
            <Metric label={t("labels.totalSpent")} value={formatTokenAmount(snapshot?.totals[0], 18)} hint={t("labels.bnb")} />
            <Metric label={t("labels.totalExecutions")} value={String(snapshot?.totals[6] ?? 0n)} hint={t("labels.rounds")} />
          </div>
          {wrongNetwork ? <Alert tone="warning">{t("states.wrongNetwork", undefined, { chain: sdk.wallet.requiredChainLabel })}</Alert> : null}
          {factoryUnavailable ? <Alert tone="warning">{t("states.factoryUnavailable")}</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          {!personalVaultAddress ? (
            <section className="rounded-[14px] border border-[#D0FF00]/30 bg-black/25 p-3 sm:p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-white"><Wallet className="h-4 w-4 text-[#D0FF00]" />{t("sections.personalVault")}</div>
              <p className="mt-2 text-xs leading-5 text-[#9ba693]">{t("states.createMultiVault")}</p>
              <div className="mt-3"><TxButton idleLabel={t("buttons.createVault")} state={buttonState("create-vault")} onClick={() => void createPersonalVault()} disabled={!factoryAddress || !context.userAddress || wrongNetwork || factoryUnavailable} /></div>
            </section>
          ) : (
            <>
              <section className="rounded-[14px] border border-[#D0FF00]/30 bg-[#101400]/20 p-3 sm:p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Settings2 className="h-4 w-4 text-[#D0FF00]" />{t("sections.targetToken")}</div>
                <p className="mb-3 text-xs leading-5 text-[#9ba693]">{t("help.targetToken")}</p>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"><Input value={tokenAddressInput} onChange={(event) => { setTokenAddressInput(event.target.value); setTokenPreview(null); }} placeholder={t("placeholders.targetToken")} /><Button type="button" size="sm" variant="secondary" onClick={() => void loadToken()} disabled={tokenLookupLoading}>{tokenLookupLoading ? t("buttons.loading") : t("buttons.loadToken")}</Button><Button type="button" size="sm" variant="ghost" onClick={() => void loadProjectCa()}>{t("buttons.useProjectCa")}</Button>{isValidAddress(tokenAddressInput) ? <Button asChild type="button" size="sm" variant="outline"><a href={explorerAddressHref(tokenAddressInput)} target="_blank" rel="noreferrer">BscScan<ExternalLink className="h-3.5 w-3.5" /></a></Button> : null}</div>
                {tokenPreview ? <div className="mt-3 grid gap-2 sm:grid-cols-3"><a href={explorerAddressHref(tokenPreview.address)} target="_blank" rel="noreferrer" className="rounded-[8px] border border-[#00E5D0]/45 bg-[#003B36]/35 p-3 transition-colors hover:border-[#00E5D0] hover:bg-[#003B36]/55"><div className="text-xs text-[#9ba693]">{t("labels.targetToken")}</div><div className="mt-1 font-semibold text-white">{tokenPreview.symbol}</div><div className="mt-1 inline-flex items-center gap-1 text-xs text-[#86f7ec]">{shortAddress(tokenPreview.address)}<ExternalLink className="h-3 w-3" /></div></a><DetailTile label={t("labels.walletTokenBalance")} value={formatTokenAmount(tokenPreview.walletBalance, tokenPreview.decimals)} detail={tokenPreview.symbol} /><DetailTile label={t("labels.vaultTokenBalance")} value={formatTokenAmount(tokenPreview.vaultBalance, tokenPreview.decimals)} detail={tokenPreview.symbol} tone="success" /></div> : null}
              </section>

              <section className="rounded-[14px] border border-[#D0FF00]/30 bg-[#101400]/20 p-3 sm:p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Wallet className="h-4 w-4 text-[#D0FF00]" />{t("sections.bnbFunds")}</div>
                <p className="mb-3 text-xs leading-5 text-[#9ba693]">{t("help.bnbFunds")}</p>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="h-full rounded-[10px] border border-white/10 bg-black/20 p-3"><label className="mb-2 block text-xs font-semibold uppercase text-[#9ba693]">{t("labels.depositBnb")}</label><div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Input value={bnbFundingAmount} onChange={(event) => setBnbFundingAmount(event.target.value)} placeholder={t("placeholders.bnb")} inputMode="decimal" /><TxButton idleLabel={t("buttons.depositBnb")} state={buttonState("fund-bnb")} onClick={() => void fundBNB()} disabled={!canWrite || !isOwner} /></div></div>
                  <div className="h-full rounded-[10px] border border-white/10 bg-black/20 p-3"><label className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase text-[#9ba693]"><span>{t("buttons.withdrawBnb")}</span><span className="font-mono normal-case text-[#86f7ec]">{t("labels.availableBnb")} {formatTokenAmount(snapshot?.availableBNB, 18)} {t("labels.bnb")}</span></label><div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Input value={bnbWithdrawAmount} onChange={(event) => setBnbWithdrawAmount(event.target.value)} placeholder={t("placeholders.bnb")} inputMode="decimal" /><TxButton idleLabel={t("buttons.withdrawBnb")} state={buttonState("withdraw-bnb")} onClick={() => void withdrawBNB()} disabled={!canWrite || !isOwner || !(snapshot?.availableBNB ?? 0n)} /></div></div>
                </div>
              </section>

              <section className="rounded-[14px] border border-[#D0FF00]/30 bg-black/25 p-3 sm:p-4">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white"><Settings2 className="h-4 w-4 text-[#D0FF00]" />{t("sections.taskTable")}</div>
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                    <Button type="button" variant="ghost" size="sm" onClick={() => void loadData()}><RefreshCw className="h-3.5 w-3.5" />{t("buttons.refresh")}</Button>
                    <Button type="button" size="sm" className="flex-1 sm:flex-none" onClick={() => setShowCreateTask((visible) => !visible)} disabled={!canWrite || !isOwner}>{showCreateTask ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{showCreateTask ? t("buttons.cancel") : t("buttons.newTask")}</Button>
                  </div>
                </div>
                <p className="mb-3 text-xs leading-5 text-[#9ba693]">{t("help.taskTable")}</p>
                {!isOwner ? <Alert tone="warning">{t("states.ownerOnly")}</Alert> : null}
                {!showCreateTask && !snapshot?.tasks.length ? <div className="mb-4 flex flex-col gap-3 rounded-[12px] border border-[#D0FF00]/25 bg-[#101400]/35 p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-white">{t("labels.noTaskFunding")}</p><p className="mt-1 text-xs leading-5 text-[#9ba693]">{t("help.noTaskFunding")}</p></div><Button type="button" size="sm" className="shrink-0" onClick={() => setShowCreateTask(true)} disabled={!canWrite || !isOwner}><Plus className="h-3.5 w-3.5" />{t("buttons.newTask")}</Button></div> : null}
                {showCreateTask ? (
                  <div className="mb-4 rounded-[12px] border border-[#D0FF00]/25 bg-[#101400]/25 p-3">
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Plus className="h-4 w-4 text-[#D0FF00]" />{t("sections.newTask")}</div>
                    <TaskForm t={t} tokenPreview={tokenPreview} buybackMode={buybackMode} setBuybackMode={setBuybackMode} modeAmount={modeAmount} setModeAmount={setModeAmount} intervalMinutes={intervalMinutes} setIntervalMinutes={setIntervalMinutes} slippage={slippage} setSlippage={setSlippage} outputMode={outputMode} setOutputMode={setOutputMode} retainRecipient={retainRecipient} setRetainRecipient={setRetainRecipient} distributionMode={distributionMode} setDistributionMode={setDistributionMode} randomHolders={randomHolders} setRandomHolders={setRandomHolders} fixedRecipientsText={fixedRecipientsText} setFixedRecipientsText={setFixedRecipientsText} modeOptions={modeOptions} outputOptions={outputOptions} />
                    <div className="mt-3 border-t border-white/10 pt-3"><TxButton idleLabel={t("buttons.createTask")} state={buttonState("create-task")} onClick={() => void createTask()} disabled={!canWrite || !isOwner || config instanceof Error || !tokenPreview} /></div>
                  </div>
                ) : null}
                <TaskTable t={t} nowSeconds={nowSeconds} tasks={snapshot?.tasks ?? []} taskTokens={snapshot?.taskTokens ?? {}} modeOptions={modeOptions} outputOptions={outputOptions} buttonState={buttonState} canWrite={canWrite} isOwner={isOwner} onCheckFunds={() => void checkFundsAndSchedule()} onAction={(id, action) => void taskAction(id, action)} />
                {snapshot?.tokenTotals.length ? <TokenResults t={t} totals={snapshot.tokenTotals} automationFees={snapshot.totals[1]} /> : null}
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface TaskTableProps {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  nowSeconds: number;
  tasks: TaskRecord[];
  taskTokens: Record<string, TaskTokenInfo>;
  modeOptions: Array<{ value: BuybackMode; label: string }>;
  outputOptions: Array<{ value: OutputMode; label: string }>;
  buttonState: (key: string) => TxButtonState;
  canWrite: boolean;
  isOwner: boolean;
  onCheckFunds: () => void;
  onAction: (taskId: bigint, action: "pauseTask" | "resumeTask" | "closeTask") => void;
}

function TaskTable(props: TaskTableProps) {
  const { t, nowSeconds, tasks, taskTokens, modeOptions, outputOptions, buttonState, canWrite, isOwner, onCheckFunds, onAction } = props;
  return (
    <div className="overflow-x-auto rounded-[10px] border border-white/10">
      <div className="min-w-[960px]">
        <div className="grid grid-cols-6 gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#9ba693]"><span>{t("labels.taskNumber")}</span><span>{t("labels.buybackDetails", t("labels.rule"))}</span><span>{t("labels.nextRun")}</span><span>{t("labels.bnbConsumed", t("labels.bnbUsed"))}</span><span>{t("labels.taskStatus")}</span><span>{t("labels.actions")}</span></div>
        {tasks.length ? tasks.map(({ id, task }) => {
          const key = id.toString();
          const active = task[13];
          const paused = task[14];
          const waitingForFunds = active && !paused && task[10] === 0n && task[12] === 0n;
          const status = !active ? t("states.closed") : paused ? t("badges.paused") : task[10] > 0n ? t("states.scheduled") : t("states.needsFunding");
          const token = taskTokens[task[2].toLowerCase()] ?? { symbol: "TOKEN", decimals: 18 };
          const amount = task[3] === 0 ? formatTokenAmount(task[6], 18) + " " + t("labels.bnb") : task[3] === 1 ? formatPercentBps(task[6]) + " " + t("labels.availableBnb") : formatTokenAmount(task[6], token.decimals) + " " + token.symbol;
          const intervalMinutes = Math.max(1, Math.round(Number(task[5]) / 60));
          return <div key={key} className="border-b border-white/10 last:border-b-0">
            <div className="grid grid-cols-6 items-center gap-2 px-3 py-3 text-xs">
              <div className="font-semibold text-white">{"#" + key}<div className="mt-1 text-[#9ba693]">{task[9].toString() + " " + t("labels.rounds")}</div></div>
              <div><div className="font-semibold text-white">{t("labels.buyback", t("labels.target"))} {token.symbol}</div><div className="mt-1 text-[#9ba693]">{modeOptions.find((option) => option.value === modeFromValue(task[3]))?.label ?? t("states.none")} · {amount} · {outputOptions.find((option) => option.value === outputFromValue(task[4]))?.label ?? t("states.none")}</div></div>
              <div><div className="font-semibold text-white">{task[10] > 0n ? formatTime(task[11], nowSeconds, t("time.now"), t("time.unknown")) : t("states.notScheduled")}</div><div className="mt-1 text-[#9ba693]">{task[12] > 0n ? t("states.pendingDistribution") : intervalMinutes.toString() + " " + t("labels.minutes")}</div></div>
              <div className="font-mono text-sm font-semibold text-white">{formatTokenAmount(task[8], 18)} <span className="text-xs text-[#9ba693]">{t("labels.bnb")}</span></div>
              <div className={"text-sm font-semibold " + (!active ? "text-[#9ba693]" : paused ? "text-[#F5C842]" : "text-[#D0FF00]")}>{status}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {active ? <>{waitingForFunds ? <TxButton idleLabel={t("buttons.checkFunds")} state={buttonState("sync-tasks")} onClick={onCheckFunds} disabled={!canWrite || !isOwner} /> : null}{paused ? <TxButton idleLabel={t("buttons.resume")} state={buttonState("resumeTask:" + key)} onClick={() => onAction(id, "resumeTask")} disabled={!canWrite || !isOwner || task[12] > 0n} /> : <TxButton idleLabel={t("buttons.pause")} state={buttonState("pauseTask:" + key)} onClick={() => onAction(id, "pauseTask")} disabled={!canWrite || !isOwner} variant="secondary" />}<TxButton idleLabel={t("buttons.closeTask")} state={buttonState("closeTask:" + key)} onClick={() => onAction(id, "closeTask")} disabled={!canWrite || !isOwner} variant="secondary" /></> : null}
              </div>
            </div>
          </div>;
        }) : <div className="p-5 text-center text-sm text-[#9ba693]">{t("states.noTasks")}</div>}
      </div>
    </div>
  );
}

interface TokenResultsProps {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  totals: TokenTotals[];
  automationFees: bigint;
}

function TokenResults({ t, totals, automationFees }: TokenResultsProps) {
  return (
    <section className="mt-4 border-t border-white/10 pt-4">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><Flame className="h-4 w-4 text-[#D0FF00]" />{t("sections.results")}</div>
          <p className="mt-1 text-xs leading-5 text-[#9ba693]">{t("help.results")}</p>
        </div>
        <p className="text-xs text-[#9ba693]">{t("labels.totalFees")} <span className="font-mono font-semibold text-[#86f7ec]">{formatTokenAmount(automationFees, 18)} {t("labels.bnb")}</span></p>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {totals.map((token) => (
          <div key={token.address} className="overflow-hidden rounded-[10px] border border-white/10 bg-black/20">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
              <div className="min-w-0"><div className="truncate font-semibold text-white">{token.symbol}</div><div className="mt-0.5 font-mono text-[11px] text-[#9ba693]">{t("labels.tokenCa")} {shortAddress(token.address)}</div></div>
              <div className="shrink-0 text-right"><div className="text-[11px] text-[#9ba693]">{t("labels.tokensBought")}</div><div className="font-mono text-sm font-semibold text-white">{formatTokenAmount(token.bought, token.decimals)}</div></div>
            </div>
            <div className="grid grid-cols-3 divide-x divide-white/10">
              <ResultValue label={t("labels.burned")} value={formatTokenAmount(token.burned, token.decimals)} />
              <ResultValue label={t("labels.retained")} value={formatTokenAmount(token.retained, token.decimals)} />
              <ResultValue label={t("labels.distributed")} value={formatTokenAmount(token.distributed, token.decimals)} accent />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultValue({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-0 px-3 py-2.5"><div className="text-[11px] text-[#9ba693]">{label}</div><div className={"mt-1 truncate font-mono text-sm font-semibold " + (accent ? "text-[#86f7ec]" : "text-white")}>{value}</div></div>;
}

interface TaskFormProps {
  t: (key: string, fallback?: string, params?: Record<string, string | number>) => string;
  tokenPreview: TokenPreview | null;
  buybackMode: BuybackMode;
  setBuybackMode: (value: BuybackMode) => void;
  modeAmount: string;
  setModeAmount: (value: string) => void;
  intervalMinutes: string;
  setIntervalMinutes: (value: string) => void;
  slippage: string;
  setSlippage: (value: string) => void;
  outputMode: OutputMode;
  setOutputMode: (value: OutputMode) => void;
  retainRecipient: string;
  setRetainRecipient: (value: string) => void;
  distributionMode: DistributionMode;
  setDistributionMode: (value: DistributionMode) => void;
  randomHolders: string;
  setRandomHolders: (value: string) => void;
  fixedRecipientsText: string;
  setFixedRecipientsText: (value: string) => void;
  modeOptions: Array<{ value: BuybackMode; label: string }>;
  outputOptions: Array<{ value: OutputMode; label: string }>;
}

function TaskForm(props: TaskFormProps) {
  const { t, tokenPreview, buybackMode, setBuybackMode, modeAmount, setModeAmount, intervalMinutes, setIntervalMinutes, slippage, setSlippage, outputMode, setOutputMode, retainRecipient, setRetainRecipient, distributionMode, setDistributionMode, randomHolders, setRandomHolders, fixedRecipientsText, setFixedRecipientsText, modeOptions, outputOptions } = props;
  const amountLabel = buybackMode === "balance-ratio" ? t("modes.balanceRatio") : buybackMode === "fixed-token" ? t("modes.fixedToken") : t("modes.fixedBnb");
  const amountPlaceholder = buybackMode === "balance-ratio" ? t("placeholders.ratio") : buybackMode === "fixed-token" ? t("placeholders.tokens") : t("placeholders.bnb");
  return <div className="space-y-3">
    <DetailTile label={t("labels.targetToken")} value={tokenPreview?.symbol ?? t("states.none")} detail={tokenPreview ? shortAddress(tokenPreview.address) : t("states.selectTokenFirst")} tone={tokenPreview ? "success" : "warning"} />
    <div className="grid gap-2 sm:grid-cols-3">{modeOptions.map((option) => <Button key={option.value} type="button" size="sm" variant={buybackMode === option.value ? "default" : "outline"} onClick={() => setBuybackMode(option.value)}>{option.label}</Button>)}</div>
    <div className="grid gap-3 sm:grid-cols-3"><Field label={amountLabel} value={modeAmount} onChange={setModeAmount} placeholder={amountPlaceholder} decimal /><Field label={t("labels.interval")} value={intervalMinutes} onChange={setIntervalMinutes} placeholder={t("placeholders.interval")} /><Field label={t("labels.slippage")} value={slippage} onChange={setSlippage} placeholder={t("placeholders.slippage")} decimal /></div>
    <div className="space-y-2 border-t border-white/10 pt-3"><label className="text-xs font-semibold uppercase text-[#9ba693]">{t("labels.output")}</label><div className="grid gap-2 sm:grid-cols-3">{outputOptions.map((option) => <Button key={option.value} type="button" size="sm" variant={outputMode === option.value ? "default" : "outline"} onClick={() => setOutputMode(option.value)}>{option.value === "burn" ? <Flame className="h-3.5 w-3.5" /> : option.value === "distribute" ? <Users className="h-3.5 w-3.5" /> : null}{option.label}</Button>)}</div></div>
    {outputMode === "retain" ? <Field label={t("labels.retainWallet")} value={retainRecipient} onChange={setRetainRecipient} placeholder={t("placeholders.wallet")} /> : null}
    {outputMode === "distribute" ? <div className="space-y-3 rounded-[10px] border border-[#D0FF00]/20 bg-[#101400]/35 p-3"><div className="grid gap-2 sm:grid-cols-2"><Button type="button" size="sm" variant={distributionMode === "fixed" ? "default" : "outline"} onClick={() => setDistributionMode("fixed")}>{t("distribution.fixed")}</Button><Button type="button" size="sm" variant={distributionMode === "random" ? "default" : "outline"} onClick={() => setDistributionMode("random")}>{t("distribution.random")}</Button></div>{distributionMode === "fixed" ? <label className="block space-y-1.5 text-xs font-semibold uppercase text-[#9ba693]"><span>{t("labels.fixedRecipients")}</span><textarea value={fixedRecipientsText} onChange={(event) => setFixedRecipientsText(event.target.value)} placeholder={t("placeholders.fixedRecipients")} rows={5} className="flex min-h-32 w-full resize-y rounded-[6px] border border-[#303236] bg-black px-3 py-2 text-sm font-semibold text-white caret-[#D0FF00] outline-none placeholder:text-[#84888C] focus:border-[#D0FF00] focus:ring-2 focus:ring-[#D0FF00]/25" /><span className="block normal-case text-[#9ba693]">{t("help.fixed")}</span></label> : <Field label={t("labels.randomHolders")} value={randomHolders} onChange={setRandomHolders} placeholder={t("placeholders.holders")} />}</div> : null}
  </div>;
}

function Field({ label, value, onChange, placeholder, decimal = false }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; decimal?: boolean }) {
  return <label className="space-y-1.5 text-xs font-semibold uppercase text-[#9ba693]"><span>{label}</span><Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} inputMode={decimal ? "decimal" : "numeric"} /></label>;
}
