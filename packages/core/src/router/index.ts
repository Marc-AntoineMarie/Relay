/**
 * Routeur — assigne modèle + effort à chaque tâche selon son tier, et calcule les
 * étapes d'escalade.
 *
 * v0.1 : config-driven (un modèle par tier dans relay.config.json), mais adossé au
 * registre de modèles pour que la politique « disponible + capable → le moins cher »
 * du multi-fournisseurs (docs/PROVIDERS.md) se branche sans refonte en v0.2.
 */
import { defaultRegistry, ModelRegistry } from "../registry.js";
import type { Effort, ModelAssignment, RelayConfig, RouteTier, Task } from "../types.js";

const EFFORT_LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const ALL_TIERS = ["quick", "build", "deep"] as const;

export class Router {
  constructor(
    private readonly config: RelayConfig,
    private readonly registry: ModelRegistry = defaultRegistry,
  ) {}

  /** Assignation configurée pour un tier. */
  forTier(tier: RouteTier): ModelAssignment {
    return this.config.routes[tier];
  }

  /** Renvoie une copie de la tâche avec modèle + effort assignés selon son tier. */
  assign(task: Task): Task {
    const a = this.forTier(task.tier);
    return { ...task, assignedModel: a.model, assignedEffort: a.effort };
  }

  /**
   * Étape d'escalade suivante à partir d'une assignation, ou `null` si épuisée.
   * `effortFirst` (défaut) : on monte l'effort tant que possible, puis on passe au
   * modèle `escalate` ; sinon on change de modèle d'abord.
   */
  escalate(current: ModelAssignment): ModelAssignment | null {
    const esc = this.config.routes.escalate;
    const bumped = this.bumpEffort(current);

    if (this.config.escalation.effortFirst) {
      if (bumped !== null) return bumped;
      if (!sameModel(current, esc)) return esc;
      return null;
    }

    // Modèle d'abord.
    if (!sameModel(current, esc)) return esc;
    return bumped;
  }

  /** Monte l'effort d'un cran ; `null` si le modèle n'a pas d'effort ou est déjà au max. */
  private bumpEffort(a: ModelAssignment): ModelAssignment | null {
    const entry = this.registry.get(a.model);
    if (entry !== undefined && !entry.supportsEffort) return null;
    if (a.effort === undefined) return null;
    const i = EFFORT_LADDER.indexOf(a.effort);
    if (i < 0 || i >= EFFORT_LADDER.length - 1) return null;
    const next = EFFORT_LADDER[i + 1];
    if (next === undefined) return null;
    return { ...a, effort: next };
  }

  /** Avertissements de config : modèles de route absents du registre. */
  validate(): string[] {
    const warnings: string[] = [];
    for (const tier of [...ALL_TIERS, "escalate"] as const) {
      const model = this.config.routes[tier].model;
      if (!this.registry.has(model)) {
        warnings.push(`modèle inconnu du registre pour la route '${tier}' : ${model}`);
      }
    }
    return warnings;
  }
}

function sameModel(a: ModelAssignment, b: ModelAssignment): boolean {
  return a.provider === b.provider && a.model === b.model;
}
