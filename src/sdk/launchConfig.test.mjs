import assert from "node:assert/strict";
import { test } from "node:test";
import { isVaultLaunchConfigResultForSchema, parseVaultLaunchSchema, VAULT_LAUNCH_SCHEMA_ABI } from "./launchConfig.ts";

const chainSchema = { description: "Threshold", isArray: false, fields: [
  { name: "minProcessAmount", fieldType: "uint256", description: "Base units", decimals: 0 },
] };

test("normalizes the public schema including uint8 decimal metadata", () => {
  assert.deepEqual(parseVaultLaunchSchema(chainSchema), chainSchema);
  assert.equal(VAULT_LAUNCH_SCHEMA_ABI[0].name, "vaultDataSchema");
});
test("rejects malformed, duplicate and prototype field names", () => {
  for (const fields of [
    [chainSchema.fields[0], chainSchema.fields[0]],
    [{ ...chainSchema.fields[0], name: "__proto__" }],
    [{ ...chainSchema.fields[0], decimals: 256 }],
    [{ ...chainSchema.fields[0], decimals: -1 }],
    [{ ...chainSchema.fields[0], decimals: "18" }],
  ]) assert.throws(() => parseVaultLaunchSchema({ ...chainSchema, fields }));
  assert.throws(() => parseVaultLaunchSchema({ ...chainSchema, isArray: "false" }));
});
test("gates structured result shape, rejecting missing/extra fields and array mismatch", () => {
  const schema = parseVaultLaunchSchema(chainSchema);
  assert.equal(isVaultLaunchConfigResultForSchema({ status: "valid", values: { minProcessAmount: "1" } }, schema), true);
  for (const values of [{}, { minProcessAmount: undefined }, { minProcessAmount: "1", hidden: "2" }, [{ minProcessAmount: "1" }], null]) {
    assert.equal(isVaultLaunchConfigResultForSchema({ status: "valid", values }, schema), false);
  }
  assert.equal(isVaultLaunchConfigResultForSchema({ status: "invalid", errors: ["Required"] }, schema), true);
  assert.equal(isVaultLaunchConfigResultForSchema({ status: "invalid", errors: [1] }, schema), false);
});
test("limits row count and display summaries without conflating shape with ABI validation", () => {
  const schema = { ...chainSchema, isArray: true };
  assert.equal(isVaultLaunchConfigResultForSchema({ status: "valid", values: [{ minProcessAmount: "1" }] }, schema), true);
  for (const values of [[], Array.from({ length: 101 }, () => ({ minProcessAmount: "1" }))]) {
    assert.equal(isVaultLaunchConfigResultForSchema({ status: "valid", values }, schema), false);
  }
  assert.equal(isVaultLaunchConfigResultForSchema({ status: "valid", values: [{ minProcessAmount: "1" }], summary: [{ label: "x", value: "x".repeat(161) }] }, schema), false);
});
