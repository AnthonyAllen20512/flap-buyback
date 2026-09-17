"use client";

export { default as LaunchConfig } from "./LaunchConfig";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Clock3, Coins, Gift, Layers3, RefreshCcw, Repeat2, ShieldCheck, Wallet } from "lucide-react";
import type { ActionAvailabilityStage, Address, VaultComponentProps } from "@/src/sdk";
import {
  ZERO_ADDRESS,
  formatTokenAmount,
  handleTxError,
  isActionAvailableForPhase,
  readTaxVaultHostContext,
  useFlapSdk,
} from "@/src/sdk";
import { AddressLink, Alert, Button, Card, CardContent, CardHeader, CardTitle, DetailTile, ExternalLink, Metric, StatusBadge } from "@/src/ui";
import { vaultAbi } from "./VaultABI";

interface VaultSnapshot {
  pendingQuote: bigint | null;
  minProcessAmount: bigint | null;
  maxProcessAmount: bigint | null;
  totalLpMinted: bigint | null;
  totalRewardsForwarded: bigint | null;
  hasPendingTrigger: boolean | null;
  pendingTriggerId: bigint | null;
  quoteToken: Address | null;
  gasBalance: bigint | null;
  pendingReward: bigint | null;
  poolId: string | null;
}

type ActionKind = "claim" | "deploy" | null;

const EMPTY_SNAPSHOT: VaultSnapshot = {
  pendingQuote: null,
  minProcessAmount: null,
  maxProcessAmount: null,
  totalLpMinted: null,
  totalRewardsForwarded: null,
  hasPendingTrigger: null,
  pendingTriggerId: null,
  quoteToken: null,
  gasBalance: null,
  pendingReward: null,
  poolId: null,
};

export default function MyxPerpetualVault(_props: VaultComponentProps) {
  const sdk = useFlapSdk();
  const { context, i18n } = sdk;
  const t = i18n.t;
  const host = readTaxVaultHostContext(context.host);
  const actionStage: ActionAvailabilityStage = "both";
  const marketPhase = host.marketPhase;
  const actionsAvailable = isActionAvailableForPhase(actionStage, marketPhase);
  const [snapshot, setSnapshot] = useState<VaultSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<ActionKind>(null);
  const [error, setError] = useState<string | null>(null);

  const marketPhaseLabel =
    marketPhase === "internal-market"
      ? t("states.marketPhaseInternal")
      : marketPhase === "dex-listed"
        ? t("states.marketPhaseDexListed")
        : t("states.marketPhaseUnknown");
  const riskLevel = host.vaultInfo?.riskLevel ?? host.taxInfo?.vaultInfo?.riskLevel ?? null;
  const riskLabel =
    riskLevel === 1
      ? t("states.riskLow")
      : riskLevel === 2
        ? t("states.riskLowMedium")
        : riskLevel === 3
          ? t("states.riskMedium")
          : riskLevel === 4
            ? t("states.riskHigh")
            : riskLevel === 0
              ? t("states.riskUnverified")
              : t("states.riskMissing");
  const riskTone = riskLevel === null || riskLevel === 0 || riskLevel >= 4 ? "danger" : riskLevel >= 3 ? "warning" : "success";

  const txErrorMessages = useMemo(
    () => ({
      userRejected: t("errors.userRejected"),
      walletDisconnected: t("errors.walletDisconnected"),
      wrongNetwork: t("errors.wrongNetwork"),
      insufficientFunds: t("errors.insufficientFunds"),
      simulationFailed: t("errors.simulationFailed"),
      reverted: t("errors.txReverted"),
      unknown: t("errors.txFailed"),
    }),
    [t],
  );
  const previewFixture = context.extraConfig?.previewFixture === true;
  const hasVaultAddress = context.vaultAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase();
  const quoteDecimals = context.paymentToken?.decimals ?? 18;
  const quoteSymbol = context.paymentToken?.symbol ?? t("units.quote");
  const baseTokenName = context.tokenName?.trim() || context.tokenSymbol?.trim() || t("states.tokenFallback");
  const lpSymbol = t("units.lp", undefined, { base: baseTokenName });
  const tradeTokenSymbol = context.tokenSymbol?.trim() || context.tokenName?.trim() || t("states.tokenFallback");

  const applyPreviewData = useCallback(() => {
    setSnapshot({
      pendingQuote: 3_820_000_000_000_000_000n,
      minProcessAmount: 5_000_000_000_000_000_000n,
      maxProcessAmount: 25_000_000_000_000_000_000n,
      totalLpMinted: 128_430_000_000_000_000_000_000n,
      totalRewardsForwarded: 126_840_000_000_000_000_000_000n,
      hasPendingTrigger: false,
      pendingTriggerId: 0n,
      quoteToken: ZERO_ADDRESS,
      gasBalance: 0n,
      pendingReward: context.userAddress ? 428_500_000_000_000_000_000n : 0n,
      poolId: null,
    });
    setLoading(false);
    setError(null);
  }, [context.userAddress]);

  const loadData = useCallback(async () => {
    if (previewFixture) {
      applyPreviewData();
      return;
    }

    if (!hasVaultAddress) {
      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(false);
      setError(t("errors.vaultUnavailable"));
      return;
    }

    setLoading(true);
    const read = <T,>(functionName: string, args?: unknown[]) =>
      sdk
        .readContract<T>({
          contract: "vault",
          address: context.vaultAddress,
          abi: vaultAbi,
          functionName,
          args,
        })
        .catch(() => null);

    const [
      pendingQuote,
      minProcessAmount,
      maxProcessAmount,
      totalLpMinted,
      totalRewardsForwarded,
      hasPendingTrigger,
      pendingTriggerId,
      quoteToken,
      gasBalance,
      pendingReward,
      poolId,
    ] = await Promise.all([
      read<bigint>("pendingQuote"),
      read<bigint>("minProcessAmount"),
      read<bigint>("maxProcessAmount"),
      read<bigint>("totalLpMinted"),
      read<bigint>("totalRewardsForwarded"),
      read<boolean>("hasPendingTrigger"),
      read<bigint>("pendingTriggerId"),
      read<Address>("quoteToken"),
      read<bigint>("gasBalance"),
      context.userAddress ? read<bigint>("pendingReward", [context.userAddress]) : Promise.resolve(null),
      read<string>("poolId"),
    ]);

    const nextSnapshot: VaultSnapshot = {
      pendingQuote,
      minProcessAmount,
      maxProcessAmount,
      totalLpMinted,
      totalRewardsForwarded,
      hasPendingTrigger,
      pendingTriggerId,
      quoteToken,
      gasBalance,
      pendingReward,
      poolId: poolId && /^0x[0-9a-fA-F]{64}$/.test(poolId) && !/^0x0{64}$/.test(poolId) ? poolId : null,
    };
    setSnapshot(nextSnapshot);
    setError(pendingQuote === null && totalLpMinted === null ? t("errors.readFailed") : null);
    setLoading(false);
  }, [applyPreviewData, context.userAddress, context.vaultAddress, hasVaultAddress, previewFixture, sdk, t]);

  useEffect(() => {
    void loadData().catch((nextError) => {
      setLoading(false);
      setError(handleTxError(nextError, { ...txErrorMessages, unknown: t("errors.readFailed") }));
    });
  }, [loadData, sdk.refetchNonce, t, txErrorMessages]);

  const pendingQuote = snapshot.pendingQuote ?? 0n;
  const minProcessAmount = snapshot.minProcessAmount ?? 0n;
  const claimable = snapshot.pendingReward ?? 0n;
  const maxProcessDisplay = snapshot.maxProcessAmount !== null
    && snapshot.maxProcessAmount > 1_000_000n * 10n ** BigInt(quoteDecimals)
    ? t("units.millionPlus")
    : formatTokenAmount(snapshot.maxProcessAmount, quoteDecimals, 4);
  const tradeUrl = snapshot.poolId ? `https://app.myx.finance/trade/${context.chainId}/${snapshot.poolId}` : null;
  const sellUrl = snapshot.poolId ? `https://app.myx.finance/trench/${context.chainId}/${snapshot.poolId}?side=SELL` : null;
  const deferredRewards =
    snapshot.totalLpMinted !== null && snapshot.totalRewardsForwarded !== null && snapshot.totalLpMinted > snapshot.totalRewardsForwarded
      ? snapshot.totalLpMinted - snapshot.totalRewardsForwarded
      : 0n;
  const progressBps = minProcessAmount > 0n ? Number((pendingQuote * 10_000n) / minProcessAmount) : 0;
  const progressPercent = Math.min(100, progressBps / 100);
  const thresholdReached = snapshot.pendingQuote !== null && minProcessAmount > 0n && pendingQuote >= minProcessAmount;
  const processingState =
    snapshot.hasPendingTrigger === true
      ? t("states.processingScheduled")
      : thresholdReached
        ? t("states.readyToProcess")
        : snapshot.pendingQuote === null
          ? t("states.dataUnavailable")
          : t("states.collectingTax");
  const processingTone = snapshot.hasPendingTrigger || thresholdReached ? "success" : "neutral";

  const writeUnavailableReason = !hasVaultAddress
    ? t("states.vaultUnavailable")
    : !context.userAddress
      ? t("states.connectWallet")
    : sdk.wallet.isWrongNetwork
      ? t("states.wrongNetwork", undefined, { chain: sdk.wallet.requiredChainLabel })
      : !actionsAvailable
        ? t("states.actionsUnavailable")
        : null;
  const writesDisabled = Boolean(writeUnavailableReason);
  const claimDisabled = writesDisabled || snapshot.pendingReward === null || claimable <= 0n;
  const deployDisabled = writesDisabled || snapshot.poolId === null;

  async function runAction(kind: Exclude<ActionKind, null>, functionName: "claimReward" | "ensurePoolDeployed") {
    setError(null);
    setActiveAction(kind);
    try {
      const simulation = await sdk.simulateContract({
        contract: "vault",
        address: context.vaultAddress,
        abi: vaultAbi,
        functionName,
        args: [],
        value: 0n,
      });
      const hash = await sdk.writeContract(simulation.request);
      const receipt = await sdk.waitForTx(hash);
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      sdk.notify.success(kind === "claim" ? t("messages.claimSuccess") : t("messages.deploySuccess"));
      await sdk.refetch();
    } catch (nextError) {
      setError(handleTxError(nextError, txErrorMessages));
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <div className="w-full space-y-3 sm:space-y-4">
      <Card className="overflow-hidden border-white/10 bg-[#090A0B] shadow-[0_24px_80px_-48px_rgba(208,255,0,0.34)]">
        <CardHeader className="border-b border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(208,255,0,0.10),transparent_34%)] p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[#D0FF00]">
                <Repeat2 className="h-4 w-4" />
                <CardTitle className="text-base text-white sm:text-lg">{t("title")}</CardTitle>
              </div>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-[#92959B]">{t("subtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <StatusBadge tone={riskTone}>{riskLabel}</StatusBadge>
              <StatusBadge tone={actionsAvailable ? "success" : "warning"}>{marketPhaseLabel}</StatusBadge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 p-4 sm:p-5">
          {riskLevel === null ? (
            <Alert tone="danger">
              <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{t("notices.riskMissing")}</span>
            </Alert>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <section className="rounded-[14px] border border-white/10 bg-[#050606] p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#777B82]">{t("sections.mechanism")}</p>
                <p className="mt-1 text-sm font-semibold text-white">{t("mechanism.summary")}</p>
              </div>
              <StatusBadge tone="success">{t("badges.allTax")}</StatusBadge>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
              {[
                { icon: Coins, title: t("flow.tax"), detail: t("flow.taxDetail") },
                { icon: Repeat2, title: t("flow.buyback"), detail: t("flow.buybackDetail") },
                { icon: Layers3, title: t("flow.liquidity"), detail: t("flow.liquidityDetail", undefined, { lp: lpSymbol }) },
                { icon: Gift, title: t("flow.rewards"), detail: t("flow.rewardsDetail") },
              ].map((item, index) => (
                <div key={item.title} className="contents">
                  {index > 0 ? <ArrowRight className="hidden h-4 w-4 self-center text-[#D0FF00] sm:block" /> : null}
                  <div className="min-w-0 rounded-[10px] border border-white/10 bg-white/[0.03] p-2.5 sm:p-3">
                    <item.icon className="h-4 w-4 text-[#D0FF00]" />
                    <div className="mt-2 truncate text-xs font-semibold text-white sm:text-sm">{item.title}</div>
                    <div className="mt-0.5 truncate text-[10px] font-medium text-[#777B82] sm:text-xs">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-3 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="rounded-[14px] border border-white/10 bg-[#0D0E0F] p-3 sm:p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#777B82]">{t("sections.automation")}</p>
                  <p className="mt-1 text-sm font-semibold text-white">{processingState}</p>
                </div>
                <StatusBadge tone={processingTone}>{snapshot.hasPendingTrigger ? t("badges.queued") : t("badges.automatic")}</StatusBadge>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-[#D0FF00] transition-[width]" style={{ width: `${progressPercent}%` }} />
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-xs font-medium text-[#92959B]">
                <span>{formatTokenAmount(snapshot.pendingQuote, quoteDecimals, 4)} {quoteSymbol}</span>
                <span>{formatTokenAmount(snapshot.minProcessAmount, quoteDecimals, 4)} {quoteSymbol}</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <DetailTile
                  icon={<Clock3 className="h-4 w-4" />}
                  label={t("labels.trigger")}
                  value={snapshot.hasPendingTrigger ? t("states.triggerQueued") : t("states.triggerIdle")}
                  detail={snapshot.hasPendingTrigger && snapshot.pendingTriggerId !== null ? snapshot.pendingTriggerId.toString() : t("hints.mevProtected")}
                  tone={snapshot.hasPendingTrigger ? "primary" : "muted"}
                />
                <DetailTile
                  icon={<Coins className="h-4 w-4" />}
                  label={t("labels.batchCap")}
                  value={`${maxProcessDisplay} ${quoteSymbol}`}
                  detail={t("hints.batchCap")}
                />
              </div>
            </section>

            <section className="grid grid-cols-2 gap-2">
              <Metric label={t("labels.pendingTax")} value={formatTokenAmount(snapshot.pendingQuote, quoteDecimals, 4)} hint={quoteSymbol} tone="primary" />
              <Metric label={t("labels.lpMinted")} value={formatTokenAmount(snapshot.totalLpMinted, 18, 2)} hint={lpSymbol} />
              <Metric label={t("labels.rewardsForwarded")} value={formatTokenAmount(snapshot.totalRewardsForwarded, 18, 2)} hint={lpSymbol} tone="success" />
              <Metric label={t("labels.deferredRewards")} value={formatTokenAmount(deferredRewards, 18, 2)} hint={lpSymbol} tone={deferredRewards > 0n ? "warning" : "success"} />
            </section>
          </div>

          <section className="rounded-[14px] border border-[#D0FF00]/25 bg-[linear-gradient(135deg,rgba(208,255,0,0.08),rgba(208,255,0,0.02))] p-3 sm:p-4">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="flex min-w-0 items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-[#D0FF00]/30 bg-[#D0FF00]/10 text-[#D0FF00]">
                  <Wallet className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#A6B16F]">{t("sections.holderReward")}</p>
                  <p className="mt-1 text-xl font-semibold text-white">{formatTokenAmount(snapshot.pendingReward, 18, 4)} <span className="text-sm text-[#92959B]">{lpSymbol}</span></p>
                  <p className="mt-1 text-xs font-medium leading-5 text-[#92959B]">{writeUnavailableReason ?? (claimable > 0n ? t("hints.claimReady", undefined, { lp: lpSymbol }) : t("hints.noReward"))}</p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[400px]">
                <Button
                  type="button"
                  loading={activeAction === "claim"}
                  disabled={claimDisabled || activeAction !== null}
                  onClick={() => void runAction("claim", "claimReward")}
                >
                  <Gift className="h-4 w-4" />
                  <span className="normal-case">
                    {activeAction === "claim" ? t("actions.confirming") : t("actions.claim", undefined, { lp: lpSymbol })}
                  </span>
                </Button>
                {tradeUrl ? (
                  <ExternalLink url={tradeUrl} locale={i18n.locale} className="min-h-10 w-full justify-center rounded-[10px] border border-white/20 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white hover:border-[#D0FF00]/50 sm:text-sm">
                    {t("actions.trade", undefined, { token: tradeTokenSymbol })}
                  </ExternalLink>
                ) : (
                  <Button type="button" variant="secondary" disabled><ArrowUpRight className="h-4 w-4" />{t("actions.trade", undefined, { token: tradeTokenSymbol })}</Button>
                )}
                {sellUrl ? (
                  <ExternalLink url={sellUrl} locale={i18n.locale} className="min-h-10 w-full justify-center rounded-[10px] border border-white/20 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white hover:border-[#D0FF00]/50 sm:text-sm">
                    {t("actions.sellLp")}
                  </ExternalLink>
                ) : (
                  <Button type="button" variant="secondary" disabled><ArrowUpRight className="h-4 w-4" />{t("actions.sellLp")}</Button>
                )}
              </div>
            </div>
            {!snapshot.poolId ? <p className="mt-2 text-xs text-[#92959B]">{t("hints.poolIdUnavailable")}</p> : null}
          </section>

          <section className="rounded-[14px] border border-white/10 bg-[#0D0E0F] p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-white/15 bg-white/[0.04] text-[#D0FF00]">
                  <Layers3 className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white sm:text-base">{t("sections.createMarket")}</h3>
                  <p className="mt-1 text-xs font-medium leading-5 text-[#92959B]">{t("market.intro", undefined, { lp: lpSymbol })}</p>
                </div>
              </div>
              <Button
                type="button"
                loading={activeAction === "deploy"}
                disabled={deployDisabled || activeAction !== null}
                onClick={() => void runAction("deploy", "ensurePoolDeployed")}
              >
                <Layers3 className="h-4 w-4" />
                {activeAction === "deploy" ? t("actions.confirming") : t("actions.createMarket")}
              </Button>
            </div>
            <p className="mt-3 border-t border-white/10 pt-3 text-xs font-medium leading-5 text-[#777B82]">{t("market.threshold")}</p>
            {deployDisabled ? <p className="mt-1 text-xs text-[#92959B]">{writeUnavailableReason ?? t("hints.poolIdUnavailable")}</p> : null}
          </section>

          <div className="grid grid-cols-2 overflow-hidden rounded-[14px] border border-white/10 lg:grid-cols-4">
            <div className="min-w-0 bg-[#0D0E0F] p-3 lg:border-r lg:border-white/10">
              <div className="text-xs font-medium text-[#777B82]">{t("labels.vault")}</div>
              <div className="mt-2"><AddressLink address={context.vaultAddress} explorerBaseUrl={context.explorerBaseUrl} /></div>
            </div>
            <div className="min-w-0 border-l border-white/10 bg-[#0D0E0F] p-3 lg:border-r">
              <div className="text-xs font-medium text-[#777B82]">{t("labels.token")}</div>
              <div className="mt-2"><AddressLink address={context.tokenAddress} explorerBaseUrl={context.explorerBaseUrl} label={context.tokenSymbol ?? t("states.tokenFallback")} /></div>
            </div>
            <div className="min-w-0 border-t border-white/10 bg-[#0D0E0F] p-3 sm:border-l lg:border-l-0 lg:border-t-0 lg:border-r">
              <div className="text-xs font-medium text-[#777B82]">{t("labels.quoteAsset")}</div>
              <div className="mt-2 text-sm font-semibold text-white">{snapshot.quoteToken === ZERO_ADDRESS ? t("states.nativeQuote") : quoteSymbol}</div>
            </div>
            <div className="min-w-0 border-l border-t border-white/10 bg-[#0D0E0F] p-3 lg:border-t-0">
              <div className="text-xs font-medium text-[#777B82]">{t("labels.wallet")}</div>
              <div className="mt-2 text-sm font-semibold text-white">{context.userAddress ? t("states.walletConnected") : t("states.walletRequired")}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-medium text-[#777B82]">
            <span className="inline-flex items-center gap-2"><Check className="h-3.5 w-3.5 text-[#D0FF00]" />{t("notices.permissionless")}</span>
            <Button type="button" variant="ghost" size="sm" loading={loading} onClick={() => void loadData()}>
              <RefreshCcw className="h-3.5 w-3.5" />
              {t("actions.refresh")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
