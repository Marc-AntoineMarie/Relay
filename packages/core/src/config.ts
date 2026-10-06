/**
 * Chargement et validation de relay.config.json.
 *
 * Les valeurs `${VAR}` sont remplacées par les variables d'environnement (clés API, etc.),
 * jamais stockées en clair dans le fichier.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RelayConfig } from "./types.js";

const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

const ModelAssignmentSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: EffortSchema.optional(),
  maxRetries: z.number().int().nonnegative().optional(),
});

const RelayConfigSchema = z.object({
  routes: z.object({
    quick: ModelAssignmentSchema,
    build: ModelAssignmentSchema,
    deep: ModelAssignmentSchema,
    escalate: ModelAssignmentSchema,
  }),
  providers: z.record(
    z.string(),
    z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional() }),
  ),
  escalation: z.object({
    maxRetries: z.number().int().nonnegative(),
    effortFirst: z.boolean(),
  }),
  decomposer: ModelAssignmentSchema,
});

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Remplace récursivement les `${VAR}` dans les chaînes par `process.env[VAR]`. */
function substituteEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? "");
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

export function parseConfig(rawJson: string): RelayConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ConfigError("relay.config.json n'est pas un JSON valide");
  }
  const result = RelayConfigSchema.safeParse(substituteEnv(parsed));
  if (!result.success) {
    throw new ConfigError(`relay.config.json invalide : ${result.error.message}`);
  }
  return result.data;
}

export function loadConfig(path = "relay.config.json"): RelayConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`relay.config.json introuvable (${path})`);
  }
  return parseConfig(raw);
}
