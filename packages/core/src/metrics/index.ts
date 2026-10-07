/**
 * Calcul des métriques de pipeline (v0.1 : en mémoire ; SQLite en v0.2).
 *
 * Honnêteté : les coûts d'orchestration (planification, synthèse) sont inclus dans les
 * totaux et dans la baseline, mais pas dans le décompte des tâches.
 *
 * Baseline : « chaque appel au tarif du modèle `deep` » — comparable à totalReferenceCost.
 */
import { referenceCost } from "../catalog.js";
import type { PipelineMetrics, TaskMetrics } from "../types.js";

export interface PipelineMetricsInput {
  pipelineId: string;
  taskMetrics: TaskMetrics[];
  /** Appels hors tâches (plan, synthèse). */
  overhead?: TaskMetrics[];
  /** Modèle de référence pour la baseline (en général la route `deep`). */
  baselineModel: string;
}

export function computePipelineMetrics(input: PipelineMetricsInput): PipelineMetrics {
  const { taskMetrics } = input;
  const overhead = input.overhead ?? [];
  const all = [...taskMetrics, ...overhead];

  const totalBilledCost = sum(all.map((m) => m.billedCost));
  const totalReferenceCost = sum(all.map((m) => m.referenceCost));
  const baselineCost = sum(all.map((m) => referenceCost(input.baselineModel, m.inputTokens, m.outputTokens)));

  return {
    pipelineId: input.pipelineId,
    totalBilledCost,
    totalReferenceCost,
    totalTokens: sum(all.map((m) => m.inputTokens + m.outputTokens)),
    totalDurationMs: sum(all.map((m) => m.durationMs)),
    taskCount: taskMetrics.length,
    successCount: taskMetrics.filter((m) => m.success).length,
    escalationCount: taskMetrics.filter((m) => m.escalated).length,
    baselineCost,
    savings: baselineCost > 0 ? ((baselineCost - totalReferenceCost) / baselineCost) * 100 : 0,
    overheadReferenceCost: sum(overhead.map((m) => m.referenceCost)),
    costPerTask: taskMetrics,
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
