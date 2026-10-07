/**
 * Routage automatique multi-comptes : pour chaque tâche, classe tous les modèles du pool
 * (tous les comptes connectés) selon la stratégie, et explique le choix.
 *
 * Règles : les modèles du bon niveau passent toujours d'abord ; un modèle de niveau
 * inférieur n'arrive qu'en dernier recours (signalé), quand aucun n'est disponible ou que
 * tous ont échoué. Jamais de tâche « web » sans modèle web ; modèle retiré/clé refusée
 * écarté ; plafonds par compte respectés.
 * Score (plus bas = meilleur) : coût, sur-dimensionnement, besoins non couverts, lenteur,
 * qualité, santé récente — pondérés par la stratégie.
 */
import { CAPABILITY_LABEL, profileModel } from "../catalog.js";
import { retryDelayMs, type ProviderRequestError } from "../errors.js";
import type { BillingMode, Capability, Effort, Provider, RouteTier, Task } from "../types.js";
import type { HealthTracker } from "./health.js";
import type { Router } from "./index.js";

export type Strategy = "economy" | "balanced" | "quality";
export const STRATEGIES: readonly Strategy[] = ["economy", "balanced", "quality"];

export interface PoolEntry {
  provider: string;
  model: string;
  billing: BillingMode;
}

/** Ce qu'un compte a le droit de faire en mode automatique. */
export interface AccountPolicy {
  enabled: boolean;
  /** Niveaux autorisés (ex. Claude Code réservé à « deep »). Absent ⇒ tous. */
  levels?: RouteTier[];
  /** Nombre max d'appels par run (préserver un quota d'abonnement). */
  maxCallsPerRun?: number;
  /** Modèles retirés du pool auto pour ce compte. */
  disabledModels?: string[];
  /** Modèles détectés ajoutés au pool auto (en plus de la sélection recommandée). */
  extraModels?: string[];
}

export interface RouteCandidate {
  provider: string;
  model: string;
  effort?: Effort;
  /** Pourquoi ce modèle (affiché dans l'UI et le journal). */
  reason: string;
  score: number;
}

/** Ce dont l'exécuteur a besoin pour router chaque tâche (mode manuel ou automatique). */
export interface TaskRouting {
  /** Candidats classés, meilleur d'abord. */
  candidates(task: Pick<Task, "tier" | "needs">): RouteCandidate[];
  provider(name: string): Provider;
  /** Appelé quand un candidat est réellement utilisé. */
  onUse?(candidate: RouteCandidate): void;
  /** Résultat d'un appel : sans erreur ⇒ succès. */
  report?(candidate: RouteCandidate, error?: ProviderRequestError): void;
  /** Coût réellement facturé d'un appel (suivi du budget). */
  onCost?(candidate: RouteCandidate, billedCost: number): void;
  /** Modèle plus fort pour réessayer une tâche dont les vérifications échouent (`tried` : "provider/model"). */
  escalate?(task: Pick<Task, "tier" | "needs">, tried: string[]): RouteCandidate | undefined;
}

const NEXT_TIER: Record<RouteTier, RouteTier> = { quick: "build", build: "deep", deep: "deep" };
export const candidateKey = (c: { provider: string; model: string }): string => `${c.provider}/${c.model}`;

const LEVEL: Record<RouteTier, number> = { quick: 0, build: 1, deep: 2 };
const EFFORT: Record<RouteTier, Effort> = { quick: "low", build: "medium", deep: "high" };
const SPEED = { fast: 0, normal: 0.5, slow: 1 } as const;
const HEALTH_PENALTY: Record<string, number> = { overloaded: 4, timeout: 4, rate_limited: 6, network: 3, invalid_output: 3 };
/** Assez grand pour qu'un modèle sous-dimensionné passe après tous ceux du bon niveau. */
const DEGRADED_PENALTY = 100;
const HEALTH_LABEL: Record<string, string> = {
  overloaded: "saturé",
  timeout: "lent à répondre",
  rate_limited: "quota atteint",
  network: "injoignable",
  invalid_output: "réponses inutilisables",
};

interface Weights {
  cost: number;
  over: number;
  needs: number;
  speed: number;
  quality: number;
  level: number;
  /** Coût virtuel d'un appel sur abonnement (préserver le quota). */
  subscription: number;
}

const WEIGHTS: Record<Strategy, Weights> = {
  economy: { cost: 3, over: 1.2, needs: 1, speed: 0.4, quality: 0.3, level: 0, subscription: 2.5 },
  balanced: { cost: 1.5, over: 0.8, needs: 1.5, speed: 0.5, quality: 1, level: 0.3, subscription: 1 },
  quality: { cost: 0.3, over: 0.2, needs: 2, speed: 0.1, quality: 3, level: 0.8, subscription: 0.2 },
};

export interface AutoRouterOptions {
  strategy: Strategy;
  policies?: Record<string, AccountPolicy>;
  health?: HealthTracker;
  /** Budget max facturé par run ($). Atteint ⇒ plus de comptes à l'usage (gratuit et abonnement restent). */
  budget?: number;
}

export class AutoRouter {
  private readonly calls = new Map<string, number>();
  private spent = 0;

  constructor(
    private readonly pool: PoolEntry[],
    private readonly opts: AutoRouterOptions,
  ) {}

  get size(): number {
    return this.pool.length;
  }

  rank(task: Pick<Task, "tier" | "needs">): RouteCandidate[] {
    const w = WEIGHTS[this.opts.strategy];
    const needs: Capability[] = task.needs ?? [];
    const required = LEVEL[task.tier];
    const out: RouteCandidate[] = [];

    for (const entry of this.pool) {
      const policy = this.opts.policies?.[entry.provider];
      if (policy !== undefined && !policy.enabled) continue;
      if (policy?.levels !== undefined && !policy.levels.includes(task.tier)) continue;
      if (policy?.maxCallsPerRun !== undefined && (this.calls.get(entry.provider) ?? 0) >= policy.maxCallsPerRun) continue;
      if (policy?.disabledModels?.includes(entry.model) === true) continue;
      if (entry.billing === "per-token" && this.opts.budget !== undefined && this.spent >= this.opts.budget) continue;

      const p = profileModel(entry.model);
      const level = LEVEL[p.level];
      const degraded = level < required; // dernier recours seulement
      if (needs.includes("web") && !p.tags.includes("web")) continue; // le web ne s'improvise pas

      const health = this.opts.health?.status(entry.provider, entry.model);
      if (health === "model_not_found" || health === "auth") continue;

      const missing = needs.filter((n) => !p.tags.includes(n));
      const price = (p.inputPerM + 3 * p.outputPerM) / 4; // pondéré vers la sortie, plus chère
      const costTerm =
        entry.billing === "per-token" ? Math.log1p(price) : entry.billing === "subscription" ? w.subscription : 0;
      const score =
        w.cost * costTerm +
        w.over * (level - required) +
        w.needs * missing.length +
        w.speed * SPEED[p.speed] -
        w.quality * p.quality -
        w.level * level +
        (health !== undefined ? (HEALTH_PENALTY[health] ?? 2) : 0) +
        (degraded ? DEGRADED_PENALTY - 10 * level : 0);

      const reason = [
        degraded ? `⚠ niveau ${p.level}, en dessous de ${task.tier} (dernier recours)` : "",
        entry.billing === "free" ? "gratuit" : entry.billing === "subscription" ? "abonnement" : `~$${price.toFixed(2)}/M`,
        degraded ? "" : level === required ? `niveau ${p.level}` : `niveau ${p.level} (au-dessus de ${task.tier})`,
        ...needs.map((n) => `${CAPABILITY_LABEL[n]} ${p.tags.includes(n) ? "✓" : "✗"}`),
        p.speed === "fast" ? "rapide" : "",
        health !== undefined ? `récemment ${HEALTH_LABEL[health] ?? health}` : "",
      ]
        .filter((s) => s.length > 0)
        .join(" · ");

      out.push({ provider: entry.provider, model: entry.model, effort: EFFORT[task.tier], reason, score });
    }

    return out.sort((a, b) => a.score - b.score);
  }

  /** Compte un appel réel (plafonds par run). */
  consume(provider: string): void {
    this.calls.set(provider, (this.calls.get(provider) ?? 0) + 1);
  }

  /** Ajoute un coût facturé au budget du run. */
  spend(cost: number): void {
    this.spent += cost;
  }

  get spentSoFar(): number {
    return this.spent;
  }
}

/** Routage automatique : pool multi-comptes, repli entre fournisseurs, santé partagée. */
export function autoRouting(
  router: AutoRouter,
  provider: (name: string) => Provider,
  health?: HealthTracker,
): TaskRouting {
  return {
    candidates: (task) => router.rank(task),
    provider,
    onUse: (c) => router.consume(c.provider),
    onCost: (_c, cost) => router.spend(cost),
    report: (c, error) =>
      error !== undefined
        ? health?.reportFailure(c.provider, c.model, error.kind, Date.now(), retryDelayMs(error))
        : health?.reportSuccess(c.provider, c.model),
    escalate: (task, tried) =>
      router
        .rank({ tier: NEXT_TIER[task.tier], ...(task.needs !== undefined ? { needs: task.needs } : {}) })
        .find((c) => !tried.includes(candidateKey(c)) && !c.reason.includes("dernier recours")),
  };
}

/** Routage manuel : un provider, un modèle par tier (relay.config.json ou choix de l'UI). */
export function manualRouting(router: Router, provider: Provider): TaskRouting {
  return {
    candidates: (task) => {
      const a = router.forTier(task.tier);
      return [{ provider: provider.name, model: a.model, effort: a.effort, reason: `choix manuel · tier ${task.tier}`, score: 0 }];
    },
    provider: () => provider,
    // Escalade de relay.config.json : effort d'abord, puis modèle « escalate ».
    escalate: (task) => {
      const next = router.escalate(router.forTier(task.tier));
      return next === null
        ? undefined
        : { provider: provider.name, model: next.model, effort: next.effort, reason: "escalade (relay.config.json)", score: 0 };
    },
  };
}
