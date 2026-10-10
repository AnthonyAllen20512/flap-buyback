"use client";

import { ComponentType, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { VaultComponentProps, VaultLaunchConfigComponentProps, VaultManifest } from "@/src/sdk";
import { useLang } from "@/src/i18n/useLang";
import { Alert } from "@/src/ui/Alert";
import { FlapPreviewShell } from "./FlapPreviewShell";
import { MiniAppPreviewShell } from "./MiniAppPreviewShell";
import { vaultModules } from "@/src/vaults";
import { LaunchConfigPreviewShell } from "./LaunchConfigPreviewShell";
import { PreviewSurfaceNav } from "./PreviewSurfaceNav";
import { readPreviewSurface } from "./previewSurface";

interface LoadedVault {
  Component: ComponentType<VaultComponentProps>;
  LaunchConfig?: ComponentType<VaultLaunchConfigComponentProps>;
  manifest: VaultManifest;
  i18n: Record<string, Record<string, string>>;
}

export function VaultPreviewClient({ folderName }: { folderName: string }) {
  const { lang } = useLang();
  const searchParams = useSearchParams();
  const [loaded, setLoaded] = useState<LoadedVault | null>(null);
  const [error, setError] = useState<string | null>(null);
  const i18nSnapshotRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    const vaultModule = vaultModules[folderName];
    if (!vaultModule) {
      setError(`${lang.preview.unknownVault}: ${folderName}`);
      return;
    }
    Promise.all([vaultModule.loadComponent(), vaultModule.loadManifest(), vaultModule.loadI18n()])
      .then(([component, manifest, i18n]) => {
        if (cancelled) return;
        i18nSnapshotRef.current = JSON.stringify(i18n.default);
        setLoaded({
          Component: component.default,
          LaunchConfig: component.LaunchConfig,
          manifest: manifest.default,
          i18n: i18n.default,
        });
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [folderName, lang.preview.unknownVault]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let cancelled = false;
    const refreshI18n = () => {
      void vaultModules[folderName]?.loadI18n().then(({ default: nextI18n }) => {
        if (cancelled) return;
        const snapshot = JSON.stringify(nextI18n);
        if (snapshot === i18nSnapshotRef.current) return;
        i18nSnapshotRef.current = snapshot;
        setLoaded((current) => current ? { ...current, i18n: nextI18n } : current);
      }).catch(() => {});
    };
    window.addEventListener("focus", refreshI18n);
    const timer = window.setInterval(refreshI18n, 4000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshI18n);
      window.clearInterval(timer);
    };
  }, [folderName]);

  if (error) {
    return (
      <main className="min-h-screen p-6">
        <div className="mx-auto max-w-3xl">
          <Alert tone="danger">{error}</Alert>
        </div>
      </main>
    );
  }

  if (!loaded) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/60">{lang.preview.loading}</div>
      </main>
    );
  }

  const { Component, LaunchConfig, manifest, i18n } = loaded;
  const requestedSurface = readPreviewSurface(searchParams);
  const hasLaunchConfig = Boolean(LaunchConfig && manifest.surfaces?.includes("launch-config"));
  if (requestedSurface === "launch-config") {
    return <>
      <PreviewSurfaceNav active={requestedSurface} />
      {hasLaunchConfig && LaunchConfig ? <LaunchConfigPreviewShell folderName={folderName} manifest={manifest} i18n={i18n} Component={LaunchConfig} /> : <main className="min-h-screen bg-[#070808] p-6"><Alert tone="warning">{lang.home.surfaces.unavailable}</Alert></main>}
    </>;
  }
  const Shell = manifest.mode === "mini-app" ? MiniAppPreviewShell : FlapPreviewShell;
  return (
    <>
    {hasLaunchConfig ? <PreviewSurfaceNav active={requestedSurface} /> : null}
    <Shell folderName={folderName} manifest={manifest} i18n={i18n}>
      <Component />
    </Shell>
    </>
  );
}
