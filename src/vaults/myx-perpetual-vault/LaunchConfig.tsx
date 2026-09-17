"use client";

import { useEffect, useMemo, useState } from "react";
import { maxUint256, parseUnits } from "viem";
import type { VaultLaunchConfigComponentProps, VaultLaunchConfigResult } from "@/src/sdk";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/src/ui";

const MARKET_ASSETS = [
  { id: "usdt", address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT" },
  { id: "usdc", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC" },
] as const;
const EXPECTED_FIELDS: Record<string, string> = {
  marketQuoteToken: "address",
  minProcessAmount: "uint256",
  gasThreshold: "uint256",
  gasRefillAmount: "uint256",
  maxProcessAmount: "uint256",
};

export default function MyxLaunchConfig({ context, messages, onChange }: VaultLaunchConfigComponentProps) {
  const t = (key: string) => messages[key] ?? key;
  const [assetId, setAssetId] = useState<string>("usdt");
  const [minimum, setMinimum] = useState("0.1");
  const [maximum, setMaximum] = useState("");
  const asset = MARKET_ASSETS.find((candidate) => candidate.id === assetId) ?? MARKET_ASSETS[0];
  const compatible = context.chainId === 56 && !context.schema.isArray
    && context.schema.fields.length === Object.keys(EXPECTED_FIELDS).length
    && Object.entries(EXPECTED_FIELDS).every(([name, type]) =>
      context.schema.fields.filter((field) => field.name === name && field.fieldType === type).length === 1);

  const result = useMemo<VaultLaunchConfigResult>(() => {
    if (!compatible) return { status: "invalid", errors: [messages["launch.unsupported"] ?? "launch.unsupported"] };
    const amount = (input: string) => {
      if (!/^\d{1,60}(?:\.\d{1,18})?$/.test(input.trim())) return null;
      try { const value = parseUnits(input.trim(), 18); return value > 0n && value <= maxUint256 ? value : null; }
      catch { return null; }
    };
    const min = amount(minimum);
    if (min === null) return { status: "invalid", errors: [messages["launch.invalidMinimum"] ?? "launch.invalidMinimum"] };
    const max = maximum.trim() === "" ? maxUint256 : amount(maximum);
    if (max === null || max < min) return { status: "invalid", errors: [messages["launch.invalidMaximum"] ?? "launch.invalidMaximum"] };
    return {
      status: "valid",
      values: { marketQuoteToken: asset.address, minProcessAmount: min.toString(), gasThreshold: "0", gasRefillAmount: "0", maxProcessAmount: max.toString() },
      summary: [
        { label: messages["launch.quote"] ?? "launch.quote", value: asset.symbol },
        { label: messages["launch.minimum"] ?? "launch.minimum", value: `${minimum.trim()} BNB` },
        { label: messages["launch.maximum"] ?? "launch.maximum", value: maximum.trim() === "" ? messages["launch.unlimited"] ?? "launch.unlimited" : `${maximum.trim()} BNB` },
      ],
    };
  }, [asset.address, asset.symbol, compatible, maximum, messages, minimum]);

  useEffect(() => { onChange(result); }, [onChange, result]);
  const control = "mt-2 min-h-11 w-full rounded-md border border-white/20 bg-[#050606] px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D0FF00] disabled:opacity-50";
  return (
    <Card className="w-full border-white/10 bg-[#090A0B]" data-flap-launch-config="true">
      <CardHeader className="border-b border-white/10 p-4 sm:p-5">
        <CardTitle className="text-base text-white sm:text-lg">{t("launch.title")}</CardTitle>
        <p className="mt-2 text-sm leading-6 text-[#92959B]">{t("launch.description")}</p>
      </CardHeader>
      <CardContent className="space-y-5 p-4 sm:p-5">
        {!compatible ? <Alert tone="danger">{t("launch.unsupported")}</Alert> : null}
        <div>
          <label className="text-sm font-medium text-white" htmlFor="myx-market-asset">{t("launch.quote")}</label>
          <select id="myx-market-asset" className={control} disabled={!compatible} value={assetId} onChange={(event) => setAssetId(event.target.value)}>
            {MARKET_ASSETS.map((item) => <option key={item.id} value={item.id}>{item.id === "usdt" ? t("launch.usdt") : t("launch.usdc")}</option>)}
          </select>
          <p className="mt-2 text-xs leading-5 text-[#92959B]">{t("launch.quoteHint")}</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-white" htmlFor="myx-min-process">{t("launch.minimum")}</label>
            <input id="myx-min-process" className={control} inputMode="decimal" autoComplete="off" maxLength={79} disabled={!compatible} value={minimum} onChange={(event) => setMinimum(event.target.value)} aria-invalid={result.status === "invalid"} aria-describedby="myx-min-hint" />
            <p id="myx-min-hint" className="mt-2 text-xs leading-5 text-[#92959B]">{t("launch.minimumHint")}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-white" htmlFor="myx-max-process">{t("launch.maximum")}</label>
            <input id="myx-max-process" className={control} inputMode="decimal" autoComplete="off" maxLength={79} disabled={!compatible} value={maximum} onChange={(event) => setMaximum(event.target.value)} aria-describedby="myx-max-hint" />
            <p id="myx-max-hint" className="mt-2 text-xs leading-5 text-[#92959B]">{t("launch.maximumHint")}</p>
          </div>
        </div>
        {result.status === "invalid" && compatible ? <Alert tone="danger">{result.errors?.[0]}</Alert> : null}
        <Alert tone="info">{t("launch.nativeGas")}</Alert>
        <p className="text-xs leading-5 text-[#92959B]">{t("launch.valuesNotice")}</p>
      </CardContent>
    </Card>
  );
}
