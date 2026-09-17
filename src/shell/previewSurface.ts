export type PreviewSurface = "vault-ui" | "launch-config";

export function readPreviewSurface(params: { get(name: string): string | null }): PreviewSurface {
  const surface = params.get("surface");
  if (surface) return surface === "launch-config" ? "launch-config" : "vault-ui";
  return params.get("tab") === "custom" ? "launch-config" : "vault-ui";
}

export function previewSurfaceHref(pathname: string, search: string, surface: PreviewSurface) {
  const params = new URLSearchParams(search);
  params.delete("tab");
  params.set("surface", surface);
  return `${pathname}?${params.toString()}`;
}
