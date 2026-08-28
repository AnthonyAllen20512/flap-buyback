"use client";

import { useCallback, useState, type ComponentType } from "react";
import type {
  VaultLaunchConfigComponentProps,
  VaultLaunchConfigResult,
  VaultManifest,
} from "@/src/sdk";
import { useLang } from "@/src/i18n/useLang";
import { Alert, Button } from "@/src/ui";

const PREVIEW_FACTORY = "0xC3e4EE8f3c616D16297fAfcB9daab122D31eFA9E" as const;

interface LaunchConfigPreviewShellProps {
  manifest: VaultManifest;
  i18n: Record<string, Record<string, string>>;
  Component: ComponentType<VaultLaunchConfigComponentProps>;
}

export function LaunchConfigPreviewShell({
  manifest,
  i18n,
  Component,
}: LaunchConfigPreviewShellProps) {
  const { languageCode } = useLang();
  const [result, setResult] = useState<VaultLaunchConfigResult>({ status: "invalid" });
  const messages = i18n[languageCode] ?? i18n.en ?? {};
  const onChange = useCallback((nextResult: VaultLaunchConfigResult) => {
    setResult(nextResult);
  }, []);

  return (
    <main className="min-h-screen bg-[#000] font-mono text-white">
      <header className="border-b border-[#303236] bg-[#070808] px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[900px] items-center justify-between gap-4">
          <span className="text-sm font-semibold uppercase tracking-[0.14em] text-[#D0FF00]">FLAP</span>
          <span className="truncate text-xs text-[#84888C]">{manifest.name}</span>
        </div>
      </header>
      <div className="mx-auto w-full max-w-[900px] px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-5 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#D0FF00]">
            Launch Config Preview
          </p>
          <h1 className="text-xl font-semibold uppercase sm:text-2xl">{manifest.name}</h1>
          <p className="text-sm leading-6 text-[#84888C]">
            The component collects structured values. The host owns validation, encoding, confirmation, and the launch transaction.
          </p>
        </div>

        <div
          data-vault-e2e-scope="vault-preview"
          data-launch-config-preview="true"
          className="border border-[#84888C] bg-[#070808] p-3 sm:p-5"
        >
          <Component
            context={{
              chainId: manifest.match.bindings[0]?.chainId ?? 56,
              factoryAddress: manifest.match.bindings[0]?.factoryAddress ?? PREVIEW_FACTORY,
              locale: languageCode,
              tokenName: "Preview Token",
              tokenSymbol: "PREVIEW",
              schema: {
                isArray: false,
                description: "Minimum burn threshold",
                fields: [
                  {
                    name: "minBurnAmount",
                    fieldType: "uint256",
                    description: "Minimum burn amount with 18 decimals",
                  },
                ],
              },
            }}
            messages={messages}
            onChange={onChange}
          />

          <div className="mt-4 border-t border-[#303236] pt-4">
            {result.status === "valid" ? (
              <Alert tone="info">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(result.values, null, 2)}
                </pre>
              </Alert>
            ) : null}
            <Button
              className="mt-3 w-full"
              disabled={result.status !== "valid"}
              data-launch-config-confirm="true"
            >
              Confirm in host
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
