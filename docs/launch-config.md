# Launch Configuration Surface

One reviewed artifact can provide both the post-launch Vault UI and the launch-time configuration UI for the same factory.

## Files and exports

Keep the four core package files. Add one optional file only when the factory needs a dedicated launch form:

```plain text
src/vaults/{folder-name}/
  Component.tsx
  LaunchConfig.tsx
  manifest.json
  VaultABI.ts
  i18n.json
```

Declare the surfaces in `manifest.json`:

```json
{
  "surfaces": ["vault-ui", "launch-config"]
}
```

`launch-config` requires at least one `match.bindings[].factoryAddress`. Export the component from `Component.tsx` so Workbench produces one `component.mjs` with both surfaces:

```tsx
export { default as LaunchConfig } from "./LaunchConfig";
```

The default export remains the post-launch Vault UI. Existing manifests that omit `surfaces` remain `vault-ui` only.

## Component contract

`LaunchConfig.tsx` receives `VaultLaunchConfigComponentProps` from `@/src/sdk`:

- `context.chainId`, `factoryAddress`, locale, token metadata, and the verified on-chain `vaultDataSchema()` result.
- `messages`, loaded from the package `i18n.json` for the active locale.
- `onChange(result)`, used to return either an invalid state or valid structured values.

Return structured values keyed by the on-chain schema field names. Do not ABI-encode bytes in the component. Do not render the final launch confirmation or send/simulate transactions. The flap.sh host validates the values against the on-chain schema, ABI-encodes `vaultData`, owns the Confirm button, and sends the launch transaction.

```tsx
onChange({
  status: "valid",
  values: { minBurnAmount: "1000000000000000000000" },
  summary: [{ label: t("summary.minimumBurn"), value: "1000 TOKEN" }],
});
```

All visible copy must come from `i18n.json`. `summary` is optional and display-only; it does not affect encoded values.

## Local testing

Run the template development server and open the launch surface directly:

```bash
yarn dev
```

```plain text
http://localhost:3000/{folder-name}?surface=launch-config
```

The developer homepage offers two entries. Open `/{folder-name}?surface=vault-ui` for the post-launch UI and `/{folder-name}?surface=launch-config` for the launch form; preview navigation switches between them while preserving language and runtime URL parameters. Packages without a declared/exported LaunchConfig show an explicit unavailable state instead of silently showing the Vault UI.

`?tab=custom` remains an alias for the hosted example link. Only `/example` supplies an explicitly labelled demonstration schema. Other launch previews read `vaultDataSchema()` from the manifest factory on its chain using the shared `VAULT_LAUNCH_SCHEMA_ABI` and `parseVaultLaunchSchema` SDK helpers. Schema read/parse failure and returned-field mismatches keep host confirmation disabled. `schema.fields[].decimals` is display metadata; component results use base units, not human-readable amounts. `isVaultLaunchConfigResultForSchema` checks payload shape only; it does not replace host ABI type/policy validation.

The `myx-perpetual-vault` local integration example pairs the existing generated Vault component with a MYX market quote selector and native BNB thresholds. A blank per-call cap means `maxUint256`; both native-launch gas fields are zero. The two fixed market quote asset addresses remain declared review candidates. This example is not publish approval. Preview confirmation is inert and never sends a transaction.

Then run the normal validation pipeline:

```bash
yarn vault:check {folder-name}
yarn vault:e2e {folder-name}
yarn vault:package {folder-name}
yarn vault:verify-package dist/{folder-name}.zip
```

`vault:e2e` tests the launch surface on PC, iPad, and H5, verifies invalid/valid states and host confirmation gating, and attests the exact `LaunchConfig.tsx` source hash. Workbench imports the same zip, verifies that the built module preserves the named export, and lets reviewers switch between the two surfaces. You do not need a separate hand-built “test package”; use the normal verified source zip.

For end-to-end flap.sh preview after Workbench builds the artifact, open the normal launch URL with the real factory plus the Workbench `artifactPath` preview parameter. If loading, verification, compatibility, or rendering fails, flap.sh falls back to the generic on-chain-schema form.
