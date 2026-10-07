/**
 * Fabrique de providers partagée (CLI + serveur). Déclare les backends disponibles,
 * leur mode de facturation et la variable d'environnement qui porte leur clé.
 */
import type { BillingMode, Provider } from "@relay/core";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import { OpenAICompatibleProvider, type StructuredMode } from "./openai-compatible.js";

export interface ProviderPreset {
  kind: "anthropic" | "claude-code" | "openai-compatible";
  label: string;
  billing: BillingMode;
  baseURL?: string;
  /** Variable d'env portant la clé. Absente ⇒ aucune clé requise. */
  envKey?: string;
  structuredMode?: StructuredMode;
  /** true ⇒ les routes par défaut (modèles Claude) ne conviennent pas, forcer un modèle. */
  needsModelOverride: boolean;
  /** Lien pour obtenir une clé (affiché dans l'UI). */
  keyUrl?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    kind: "anthropic",
    label: "Anthropic (API)",
    billing: "per-token",
    envKey: "ANTHROPIC_API_KEY",
    needsModelOverride: false,
    keyUrl: "https://console.anthropic.com",
  },
  "claude-code": {
    kind: "claude-code",
    label: "Claude Code (abonnement)",
    billing: "subscription",
    needsModelOverride: false,
  },
  gemini: {
    kind: "openai-compatible",
    label: "Gemini (gratuit)",
    billing: "free",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GEMINI_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://ai.google.dev",
  },
  groq: {
    kind: "openai-compatible",
    label: "Groq (gratuit)",
    billing: "free",
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://console.groq.com",
  },
  openrouter: {
    kind: "openai-compatible",
    label: "OpenRouter",
    billing: "per-token",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://openrouter.ai",
  },
  deepseek: {
    kind: "openai-compatible",
    label: "DeepSeek",
    billing: "per-token",
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://platform.deepseek.com",
  },
  ollama: {
    kind: "openai-compatible",
    label: "Ollama (local)",
    billing: "free",
    baseURL: "http://localhost:11434/v1",
    needsModelOverride: true,
  },
};

export class ProviderError extends Error {
  override readonly name = "ProviderError";
}

export interface CreateProviderOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Instancie le provider nommé. Lève `ProviderError` si inconnu ou clé manquante. */
export function createProvider(name: string, options: CreateProviderOptions = {}): Provider {
  const preset = PROVIDER_PRESETS[name];
  if (preset === undefined) {
    throw new ProviderError(`provider inconnu : ${name} (${Object.keys(PROVIDER_PRESETS).join(" | ")})`);
  }
  const env = options.env ?? process.env;
  const apiKey = preset.envKey ? env[preset.envKey]?.trim() : undefined;
  if (preset.envKey && !apiKey) {
    throw new ProviderError(`${preset.envKey} manquante pour '${name}'.`);
  }

  switch (preset.kind) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: apiKey as string });
    case "claude-code":
      return new ClaudeCodeProvider(
        options.cwd === undefined ? { permissionMode: "none" } : { cwd: options.cwd, permissionMode: "none" },
      );
    case "openai-compatible": {
      const opts: {
        name: string;
        baseURL: string;
        billing: BillingMode;
        apiKey?: string;
        structuredMode?: StructuredMode;
      } = { name, baseURL: preset.baseURL as string, billing: preset.billing };
      if (apiKey !== undefined) opts.apiKey = apiKey;
      if (preset.structuredMode !== undefined) opts.structuredMode = preset.structuredMode;
      return new OpenAICompatibleProvider(opts);
    }
  }
}

export interface ProviderReadiness {
  name: string;
  label: string;
  billing: BillingMode;
  ready: boolean;
  needsModelOverride: boolean;
  envKey?: string;
  keyUrl?: string;
}

/** État de préparation de chaque backend (pour l'UI) : clé présente ou non requise. */
export function providerReadiness(env: NodeJS.ProcessEnv = process.env): ProviderReadiness[] {
  return Object.entries(PROVIDER_PRESETS).map(([name, p]) => {
    const r: ProviderReadiness = {
      name,
      label: p.label,
      billing: p.billing,
      ready: p.envKey ? Boolean(env[p.envKey]?.trim()) : true,
      needsModelOverride: p.needsModelOverride,
    };
    if (p.envKey !== undefined) r.envKey = p.envKey;
    if (p.keyUrl !== undefined) r.keyUrl = p.keyUrl;
    return r;
  });
}
