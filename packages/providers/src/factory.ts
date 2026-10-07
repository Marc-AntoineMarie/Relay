/**
 * Fabrique de providers partagée (CLI + serveur). Déclare les backends disponibles,
 * leur facturation, la variable d'environnement de leur clé, et leur politique de
 * modèles : modèle par tier, replis, support de l'effort.
 */
import type { BillingMode, Provider, TierModels } from "@relay/core";
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
  /** true ⇒ les routes par défaut (modèles Claude) ne conviennent pas : choisir des modèles. */
  needsModelOverride: boolean;
  /** Lien pour obtenir une clé (affiché dans l'UI). */
  keyUrl?: string;
  /** Modèle recommandé par tier (validé contre les modèles réellement disponibles). */
  tierModels?: TierModels;
  /** Replis si le modèle demandé est saturé ou retiré. */
  fallbackModels?: string[];
  /** Le backend accepte `reasoning_effort` (budget de réflexion). */
  reasoningEffort?: boolean;
}

const CLAUDE_TIERS: TierModels = { quick: "claude-haiku-4-5", build: "claude-sonnet-5-5", deep: "claude-opus-5-5" };

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    kind: "anthropic",
    label: "Anthropic (API)",
    billing: "per-token",
    envKey: "ANTHROPIC_API_KEY",
    needsModelOverride: false,
    keyUrl: "https://console.anthropic.com",
    tierModels: CLAUDE_TIERS,
  },
  "claude-code": {
    kind: "claude-code",
    label: "Claude Code (abonnement)",
    billing: "subscription",
    needsModelOverride: false,
    tierModels: CLAUDE_TIERS,
  },
  gemini: {
    kind: "openai-compatible",
    label: "Gemini (gratuit)",
    billing: "free",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GEMINI_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://aistudio.google.com/api-keys",
    // Alias « latest » : jamais dépréciés, contrairement aux versions figées.
    tierModels: { quick: "gemini-flash-lite-latest", build: "gemini-flash-latest", deep: "gemini-pro-latest" },
    fallbackModels: ["gemini-flash-lite-latest", "gemini-flash-latest"],
    reasoningEffort: true,
  },
  groq: {
    kind: "openai-compatible",
    label: "Groq (gratuit)",
    billing: "free",
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://console.groq.com/keys",
    tierModels: { quick: "llama-3.1-8b-instant", build: "llama-3.3-70b-versatile", deep: "llama-3.3-70b-versatile" },
    fallbackModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  openrouter: {
    kind: "openai-compatible",
    label: "OpenRouter",
    billing: "per-token",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://openrouter.ai/keys",
  },
  deepseek: {
    kind: "openai-compatible",
    label: "DeepSeek",
    billing: "per-token",
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    tierModels: { quick: "deepseek-chat", build: "deepseek-chat", deep: "deepseek-reasoner" },
    fallbackModels: ["deepseek-chat"],
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
    throw new ProviderError(`${preset.envKey} manquante pour '${name}' : ajoute la clé dans le panneau des backends.`);
  }

  switch (preset.kind) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: apiKey as string });
    case "claude-code":
      return new ClaudeCodeProvider(
        options.cwd === undefined ? { permissionMode: "none" } : { cwd: options.cwd, permissionMode: "none" },
      );
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        name,
        baseURL: preset.baseURL as string,
        billing: preset.billing,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(preset.structuredMode !== undefined ? { structuredMode: preset.structuredMode } : {}),
        ...(preset.fallbackModels !== undefined ? { fallbackModels: preset.fallbackModels } : {}),
        ...(preset.reasoningEffort !== undefined ? { reasoningEffort: preset.reasoningEffort } : {}),
      });
  }
}

/** Modèles qui ne font pas de chat texte (voix, image, vidéo, embeddings…). */
const NON_CHAT =
  /(tts|audio|speech|transcri|whisper|image|imagen|veo|video|embed|aqa|moderation|guard|nano-banana|robotics|computer-use|learnlm|native-audio)/i;

/** Garde les modèles de chat texte, alias « latest » en tête. */
export function filterChatModels(ids: string[]): string[] {
  const latestFirst = (id: string): number => (id.includes("latest") ? 0 : 1);
  return [...new Set(ids)]
    .filter((id) => !NON_CHAT.test(id))
    .sort((a, b) => latestFirst(a) - latestFirst(b) || a.localeCompare(b));
}

/** Indices de nommage, par ordre de préférence, quand le preset n'a pas de recommandation. */
const TIER_HINTS: Record<keyof TierModels, RegExp[]> = {
  quick: [/lite-latest$/i, /(lite|mini|instant|8b|haiku|small|flash-8b)/i],
  build: [/(^|-)flash-latest$/i, /flash(?!.*lite)/i, /(sonnet|chat|versatile|medium|turbo)/i],
  deep: [/pro-latest$/i, /(-pro\b|opus|reasoner|large|70b|405b)/i],
};

/**
 * Propose un modèle par tier : la recommandation du preset si elle est disponible,
 * sinon un modèle choisi d'après son nom parmi ceux détectés.
 */
export function suggestTierModels(name: string, available: string[]): TierModels | undefined {
  const preset = PROVIDER_PRESETS[name]?.tierModels;
  if (available.length === 0) return preset;

  const pick = (tier: keyof TierModels): string | undefined => {
    const recommended = preset?.[tier];
    if (recommended !== undefined && available.includes(recommended)) return recommended;
    for (const re of TIER_HINTS[tier]) {
      const found = available.find((id) => re.test(id));
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const build = pick("build") ?? available[0];
  if (build === undefined) return undefined;
  return { quick: pick("quick") ?? build, build, deep: pick("deep") ?? build };
}

export interface ProviderReadiness {
  name: string;
  label: string;
  billing: BillingMode;
  ready: boolean;
  needsModelOverride: boolean;
  envKey?: string;
  keyUrl?: string;
  tierModels?: TierModels;
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
    if (p.tierModels !== undefined) r.tierModels = p.tierModels;
    return r;
  });
}
