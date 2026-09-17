"use client";

import Link from "next/link";
import { useLang } from "@/src/i18n/useLang";

export function DeveloperSurfaceEntry() {
  const { lang, languageCode } = useLang();
  const copy = lang.home.surfaces;
  return (
    <section className="mb-10 rounded-xl border border-[#303236] bg-[#070808] p-5 text-white sm:p-6">
      <h2 className="text-xl font-semibold">{copy.title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[#84888C]">{copy.description}</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {(["vault-ui", "launch-config"] as const).map((surface) => (
          <Link key={surface} href={`/example?surface=${surface}&lang=${languageCode}`} className="rounded-lg border border-[#303236] bg-[#111214] p-4 transition-colors hover:border-[#5533FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5533FF]">
            <h3 className="text-base font-semibold">{surface === "vault-ui" ? copy.vaultTitle : copy.launchTitle}</h3>
            <p className="mt-2 text-sm leading-6 text-[#84888C]">{surface === "vault-ui" ? copy.vaultDescription : copy.launchDescription}</p>
            <code className="mt-3 block text-xs text-white/70">{surface === "vault-ui" ? "Component.tsx" : "LaunchConfig.tsx"}</code>
            <span className="mt-4 inline-block text-sm text-[#A99AFF]">{copy.openPreview}</span>
          </Link>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-[#84888C]">{copy.packageNotice}</p>
      <div className="mt-5 border-t border-[#303236] pt-4">
        <p className="text-sm text-white/70">{copy.demoLabel}</p>
        <div className="mt-3 flex flex-wrap gap-3 text-sm text-[#A99AFF]">
          <Link href={`/myx-perpetual-vault?surface=vault-ui&lang=${languageCode}`} className="rounded-md px-2 py-1 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5533FF]">{copy.demoVault}</Link>
          <Link href={`/myx-perpetual-vault?surface=launch-config&lang=${languageCode}`} className="rounded-md px-2 py-1 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5533FF]">{copy.demoLaunch}</Link>
        </div>
      </div>
    </section>
  );
}
