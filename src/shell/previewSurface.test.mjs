import assert from "node:assert/strict";
import test from "node:test";
import { readPreviewSurface, previewSurfaceHref } from "./previewSurface.ts";

test("defaults to vault UI and preserves the existing custom alias", () => {
  assert.equal(readPreviewSurface(new URLSearchParams()), "vault-ui");
  assert.equal(readPreviewSurface(new URLSearchParams("tab=custom")), "launch-config");
  assert.equal(readPreviewSurface(new URLSearchParams("surface=vault-ui&tab=custom")), "vault-ui");
  assert.equal(readPreviewSurface(new URLSearchParams("surface=launch-config")), "launch-config");
});

test("switching surfaces preserves runtime targets and locale, removing the old alias", () => {
  const href = previewSurfaceHref("/example", "lang=zh&chainId=56&factoryAddress=0xabc&tab=custom", "vault-ui");
  const params = new URL(href, "http://localhost:3001").searchParams;
  assert.equal(params.get("surface"), "vault-ui");
  assert.equal(params.get("lang"), "zh");
  assert.equal(params.get("chainId"), "56");
  assert.equal(params.get("factoryAddress"), "0xabc");
  assert.equal(params.has("tab"), false);
});
