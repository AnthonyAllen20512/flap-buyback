"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useLang } from "@/src/i18n/useLang";
import { previewSurfaceHref, type PreviewSurface } from "./previewSurface";

export function PreviewSurfaceNav({ active }: { active: PreviewSurface }) {
  const { lang, languageCode } = useLang();
  const pathname = usePathname();
  const params = useSearchParams();
  const copy = lang.home.surfaces;
  return (
    <nav aria-label={copy.previewLabel} className="border-b border-[#303236] bg-[#070808] px-4 py-3 text-white sm:px-6">
      <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-2">
        <Link href={`/?lang=${languageCode}`} className="mr-auto rounded-md px-3 py-2 text-sm text-white/60 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5533FF]">{copy.back}</Link>
        {(["vault-ui", "launch-config"] as const).map((surface) => (
          <Link key={surface} href={previewSurfaceHref(pathname, params.toString(), surface)} aria-current={active === surface ? "page" : undefined} className={`rounded-md border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#5533FF] ${active === surface ? "border-[#5533FF] bg-[#5533FF] text-white" : "border-[#303236] text-white/60 hover:text-white"}`}>
            {surface === "vault-ui" ? copy.vaultTitle : copy.launchTitle}
          </Link>
        ))}
      </div>
    </nav>
  );
}
