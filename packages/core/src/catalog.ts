/**
 * Catalogue de modèles : profil de chaque famille connue (niveau, besoins couverts,
 * prix de référence, vitesse, qualité relative dans son niveau). Sert au routage
 * automatique et au calcul du coût « équivalent API ».
 *
 * Les prix hors Anthropic sont des **références approximatives** pour comparer, pas une
 * facture (les paliers gratuits et l'abonnement coûtent 0 réellement).
 */
import { defaultRegistry } from "./registry.js";
import type { Capability, RouteTier } from "./types.js";

export const CAPABILITIES: readonly Capability[] = ["code", "reasoning", "long_context", "web", "fast"];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  code: "code",
  reasoning: "raisonnement",
  long_context: "long contexte",
  web: "web",
  fast: "rapide",
};

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export type Speed = "fast" | "normal" | "slow";

export interface ModelProfile {
  level: RouteTier;
  tags: Capability[];
  /** Prix de référence API ($ par million de tokens). */
  inputPerM: number;
  outputPerM: number;
  speed: Speed;
  /** Qualité relative dans son niveau (0..1). */
  quality: number;
  /** Famille reconnue par le catalogue (sinon profil deviné d'après le nom). */
  known: boolean;
  family: string;
}

type Profile = Omit<ModelProfile, "known" | "family">;

/** Règles par famille, la première qui correspond gagne (ordre : du plus spécifique au plus général). */
const RULES: Array<{ match: RegExp; family: string; profile: Profile }> = [
  { match: /fable/i, family: "Claude Fable", profile: { level: "deep", tags: ["reasoning", "code", "long_context"], inputPerM: 10, outputPerM: 50, speed: "slow", quality: 1 } },
  { match: /opus/i, family: "Claude Opus", profile: { level: "deep", tags: ["reasoning", "code", "long_context"], inputPerM: 4, outputPerM: 20, speed: "slow", quality: 0.95 } },
  { match: /sonnet/i, family: "Claude Sonnet", profile: { level: "build", tags: ["code", "long_context"], inputPerM: 2, outputPerM: 10, speed: "normal", quality: 0.9 } },
  { match: /haiku/i, family: "Claude Haiku", profile: { level: "quick", tags: ["fast", "code"], inputPerM: 1, outputPerM: 5, speed: "fast", quality: 0.75 } },
  { match: /gemini.*lite/i, family: "Gemini Flash-Lite", profile: { level: "quick", tags: ["fast", "long_context"], inputPerM: 0.1, outputPerM: 0.4, speed: "fast", quality: 0.6 } },
  { match: /gemini.*flash/i, family: "Gemini Flash", profile: { level: "build", tags: ["code", "long_context", "fast"], inputPerM: 0.3, outputPerM: 2.5, speed: "fast", quality: 0.75 } },
  { match: /gemini.*pro/i, family: "Gemini Pro", profile: { level: "deep", tags: ["reasoning", "code", "long_context"], inputPerM: 1.25, outputPerM: 10, speed: "normal", quality: 0.85 } },
  { match: /deepseek.*(reasoner|r1)/i, family: "DeepSeek Reasoner", profile: { level: "deep", tags: ["reasoning", "code"], inputPerM: 0.55, outputPerM: 2.19, speed: "slow", quality: 0.8 } },
  { match: /deepseek/i, family: "DeepSeek Chat", profile: { level: "build", tags: ["code"], inputPerM: 0.27, outputPerM: 1.1, speed: "normal", quality: 0.7 } },
  { match: /gpt-oss-120b/i, family: "GPT-OSS 120B", profile: { level: "build", tags: ["code", "reasoning", "fast"], inputPerM: 0.15, outputPerM: 0.6, speed: "fast", quality: 0.75 } },
  { match: /gpt-oss/i, family: "GPT-OSS 20B", profile: { level: "quick", tags: ["fast", "code"], inputPerM: 0.075, outputPerM: 0.3, speed: "fast", quality: 0.55 } },
  { match: /kimi/i, family: "Kimi K2", profile: { level: "build", tags: ["code", "long_context"], inputPerM: 1, outputPerM: 3, speed: "normal", quality: 0.8 } },
  { match: /llama-4/i, family: "Llama 4", profile: { level: "build", tags: ["fast", "long_context"], inputPerM: 0.11, outputPerM: 0.34, speed: "fast", quality: 0.6 } },
  { match: /llama.*(405b|90b|70b)/i, family: "Llama 70B+", profile: { level: "build", tags: ["code", "fast"], inputPerM: 0.59, outputPerM: 0.79, speed: "fast", quality: 0.6 } },
  { match: /llama.*(8b|3b|1b|instant)/i, family: "Llama 8B", profile: { level: "quick", tags: ["fast"], inputPerM: 0.05, outputPerM: 0.08, speed: "fast", quality: 0.4 } },
  { match: /qwen.*coder/i, family: "Qwen Coder", profile: { level: "build", tags: ["code"], inputPerM: 0.3, outputPerM: 0.9, speed: "normal", quality: 0.65 } },
  { match: /(qwq|qwen.*think)/i, family: "Qwen Reasoning", profile: { level: "deep", tags: ["reasoning", "code"], inputPerM: 0.3, outputPerM: 1.2, speed: "slow", quality: 0.7 } },
  { match: /qwen/i, family: "Qwen", profile: { level: "build", tags: ["code", "reasoning"], inputPerM: 0.29, outputPerM: 0.59, speed: "normal", quality: 0.7 } },
  { match: /sonar/i, family: "Perplexity Sonar", profile: { level: "build", tags: ["web"], inputPerM: 1, outputPerM: 1, speed: "normal", quality: 0.7 } },
];

const QUICK_HINT = /(lite|mini|instant|small|tiny|nano|\b[1-8]b\b)/i;
const DEEP_HINT = /(pro|large|ultra|70b|72b|reason|think)/i;

/** Profil d'un modèle : famille connue, sinon deviné d'après le nom (non utilisé en auto). */
export function profileModel(model: string): ModelProfile {
  const exact = defaultRegistry.get(model);
  for (const rule of RULES) {
    if (rule.match.test(model)) {
      const p: ModelProfile = { ...rule.profile, tags: [...rule.profile.tags], known: true, family: rule.family };
      if (exact !== undefined) {
        p.inputPerM = exact.inputPerM;
        p.outputPerM = exact.outputPerM;
      }
      return p;
    }
  }
  const level: RouteTier = QUICK_HINT.test(model) ? "quick" : DEEP_HINT.test(model) ? "deep" : "build";
  return {
    level,
    tags: [],
    inputPerM: exact?.inputPerM ?? 0,
    outputPerM: exact?.outputPerM ?? 0,
    speed: "normal",
    quality: 0.5,
    known: false,
    family: "inconnue",
  };
}

/** Coût au tarif API de référence ($) — échelle commune pour comparer tous les backends. */
export function referenceCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = profileModel(model);
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}
