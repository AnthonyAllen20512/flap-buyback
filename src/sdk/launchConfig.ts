import type { VaultLaunchConfigResult, VaultLaunchSchema } from "./types";

/** Public IVaultSchemasV1 interface. Reading and encoding belong to the host, not the form. */
export const VAULT_LAUNCH_SCHEMA_ABI = [{
  type: "function",
  name: "vaultDataSchema",
  stateMutability: "view",
  inputs: [],
  outputs: [{
    name: "schema",
    type: "tuple",
    components: [
      { name: "description", type: "string" },
      { name: "fields", type: "tuple[]", components: [
        { name: "name", type: "string" },
        { name: "fieldType", type: "string" },
        { name: "description", type: "string" },
        { name: "decimals", type: "uint8" },
      ] },
      { name: "isArray", type: "bool" },
    ],
  }],
}] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize decoded chain data and fail closed on malformed/ambiguous field definitions. */
export function parseVaultLaunchSchema(value: unknown): VaultLaunchSchema {
  if (!isRecord(value) || typeof value.isArray !== "boolean" || typeof value.description !== "string"
    || !Array.isArray(value.fields) || value.fields.length > 100) {
    throw new Error("Invalid vault launch schema.");
  }
  const names = new Set<string>();
  const fields = value.fields.map((field: unknown) => {
    if (!isRecord(field) || typeof field.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field.name)
      || names.has(field.name) || ["__proto__", "constructor", "prototype"].includes(field.name)
      || typeof field.fieldType !== "string" || !field.fieldType.trim() || field.fieldType.length > 100
      || typeof field.description !== "string" || !Number.isInteger(field.decimals)
      || (field.decimals as number) < 0 || (field.decimals as number) > 255) {
      throw new Error("Invalid vault launch schema field.");
    }
    names.add(field.name);
    return { name: field.name, fieldType: field.fieldType, description: field.description, decimals: field.decimals as number };
  });
  return { description: value.description, isArray: value.isArray, fields };
}

/** Shape gate shared by preview hosts. Hosts must still validate field types/policies and ABI-encode. */
export function isVaultLaunchConfigResultForSchema(value: unknown, schema: VaultLaunchSchema): value is VaultLaunchConfigResult {
  if (!isRecord(value)) return false;
  if (value.status === "invalid") return value.errors === undefined
    || (Array.isArray(value.errors) && value.errors.length <= 100 && value.errors.every((error) => typeof error === "string"));
  if (value.status !== "valid") return false;
  if (value.summary !== undefined && (!Array.isArray(value.summary) || value.summary.length > 12
    || !value.summary.every((item) => isRecord(item) && typeof item.label === "string" && item.label.length <= 160
      && typeof item.value === "string" && item.value.length <= 160))) return false;
  if (schema.isArray !== Array.isArray(value.values)) return false;
  const rows = schema.isArray ? value.values as unknown[] : [value.values];
  if (rows.length === 0 || rows.length > 100) return false;
  const names = schema.fields.map((field) => field.name);
  return rows.every((row) => isRecord(row) && Object.keys(row).length === names.length
    && names.every((name) => Object.hasOwn(row, name) && row[name] !== undefined));
}
