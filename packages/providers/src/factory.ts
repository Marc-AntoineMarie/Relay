/**
 * Fabrique de providers partagée (CLI + serveur). Déclare les backends disponibles,
 * leur facturation, la variable d'environnement de leur clé, et leur politique de
 * modèles : modèle par tier, replis, support de l'effort.
 */
import { profileModel } from "@relay/core";
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
  /** Délai max avant le début de la réponse (ms) ; défaut 60 s. Les modèles locaux sur CPU sont lents. */
  timeoutMs?: number;
  /** Durée max d'une réponse complète (ms) ; défaut : réglage « délai max par appel ». */
  maxDurationMs?: number;
  /** Variable d'environnement qui remplace `baseURL` (ex. Ollama sur un VPS, via tunnel SSH). */
  baseURLEnv?: string;
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
    // Catalogue 2026 (les Llama 3 ont été retirés) ; pas de modèle « deep » sur Groq.
    tierModels: { quick: "openai/gpt-oss-20b", build: "openai/gpt-oss-120b", deep: "openai/gpt-oss-120b" },
    fallbackModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    reasoningEffort: true,
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
  nvidia: {
    kind: "openai-compatible",
    label: "NVIDIA (gratuit)",
    billing: "free",
    // Compte NVIDIA Developer : ~40 requêtes/min pour tout le compte, 100+ modèles ouverts.
    baseURL: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    // Mesuré le 2026-10-08 (palier gratuit) : Nemotron Lightning répond en < 1 s, GLM 5.3 Flash en
    // ~25 s ; DeepSeek V4.1 Flash (~2 min) et Kimi K3 (> 2 min) ont de longues files d'attente →
    // gardés en replis ; le routeur mesure ensuite la latence réelle et s'adapte.
    tierModels: {
      quick: "nvidia/nemotron-3.5-lightning-30b-a3b",
      build: "z-ai/glm-5.3-flash",
      deep: "nvidia/nemotron-3-ultra-550b-a55b",
    },
    fallbackModels: ["nvidia/nemotron-3-super-120b-a12b", "z-ai/glm-5.3", "deepseek-ai/deepseek-v4.1-flash", "moonshotai/kimi-k3"],
    timeoutMs: 120_000,
  },
  cerebras: {
    kind: "openai-compatible",
    label: "Cerebras (gratuit)",
    billing: "free",
    baseURL: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://cloud.cerebras.ai",
  },
  mistral: {
    kind: "openai-compatible",
    label: "Mistral (palier gratuit)",
    billing: "free",
    baseURL: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  huggingface: {
    kind: "openai-compatible",
    label: "Hugging Face (crédits gratuits)",
    billing: "free",
    baseURL: "https://router.huggingface.co/v1",
    envKey: "HF_TOKEN",
    needsModelOverride: true,
    keyUrl: "https://huggingface.co/settings/tokens",
  },
  "ollama-cloud": {
    kind: "openai-compatible",
    label: "Ollama Cloud",
    billing: "free",
    baseURL: "https://ollama.com/v1",
    envKey: "OLLAMA_API_KEY",
    needsModelOverride: true,
    keyUrl: "https://ollama.com/settings/keys",
    timeoutMs: 120_000,
  },
  ollama: {
    kind: "openai-compatible",
    label: "Ollama (local ou VPS)",
    billing: "free",
    baseURL: "http://127.0.0.1:11434/v1",
    baseURLEnv: "OLLAMA_BASE_URL",
    needsModelOverride: true,
    // Sur CPU, une réponse longue prend plusieurs minutes.
    timeoutMs: 600_000,
    maxDurationMs: 900_000,
  },
};

export class ProviderError extends Error {
  override readonly name = "ProviderError";
}

export interface CreateProviderOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Replis internes au provider. Désactivés en mode auto : le routeur gère (sans descendre de niveau). */
  fallbacks?: boolean;
  /** Durée max d'une réponse (réglage utilisateur) ; les presets lents (Ollama) la multiplient. */
  maxDurationMs?: number;
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
        baseURL: (preset.baseURLEnv !== undefined ? env[preset.baseURLEnv]?.trim() : undefined) || (preset.baseURL as string),
        billing: preset.billing,
        ...(preset.timeoutMs !== undefined ? { timeoutMs: preset.timeoutMs } : {}),
        ...(preset.maxDurationMs !== undefined || options.maxDurationMs !== undefined
          ? { maxDurationMs: preset.maxDurationMs ?? options.maxDurationMs }
          : {}),
        // Sur CPU (Ollama), le premier morceau peut tarder (chargement du modèle) : plus de patience.
        ...(name === "ollama" ? { idleTimeoutMs: 240_000 } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(preset.structuredMode !== undefined ? { structuredMode: preset.structuredMode } : {}),
        ...(preset.fallbackModels !== undefined && options.fallbacks !== false
          ? { fallbackModels: preset.fallbackModels }
          : {}),
        ...(preset.reasoningEffort !== undefined ? { reasoningEffort: preset.reasoningEffort } : {}),
      });
  }
}

/** Modèles qui ne font pas de chat texte (voix, image, vidéo, embeddings…). */
const NON_CHAT =
  /(tts|audio|speech|transcri|whisper|orpheus|playai|image|imagen|veo|video|embed|aqa|moderation|guard|nano-banana|robotics|computer-use|learnlm|native-audio)/i;

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

/**
 * Modèles qu'un compte apporte au pool automatique : la sélection éprouvée du preset
 * (modèles par tier + replis) quand elle est disponible, sinon les familles connues du
 * catalogue parmi les modèles détectés (les modèles inconnus restent hors du mode auto).
 */
export function autoPoolModels(name: string, detected: string[]): string[] {
  const preset = PROVIDER_PRESETS[name];
  const curated = [...new Set([...Object.values(preset?.tierModels ?? {}), ...(preset?.fallbackModels ?? [])])];
  if (curated.length > 0) {
    const available = detected.length === 0 ? curated : curated.filter((m) => detected.includes(m));
    if (available.length > 0) return available;
  }
  // Grands catalogues (NVIDIA, Hugging Face…) : les 2 meilleurs modèles connus par niveau.
  const known = detected.filter((m) => profileModel(m).known);
  const byLevel = new Map<string, string[]>();
  for (const m of [...known].sort((a, b) => profileModel(b).quality - profileModel(a).quality)) {
    const level = profileModel(m).level;
    const list = byLevel.get(level) ?? [];
    if (list.length < 2) byLevel.set(level, [...list, m]);
  }
  return [...byLevel.values()].flat();
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
