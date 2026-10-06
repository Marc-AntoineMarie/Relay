/**
 * Calcul des métriques de pipeline (v0.1 : en mémoire ; SQLite en v0.2).
 *
 * Note baseline : `baselineCost` est ici « tout sur le modèle `deep` ». C'est la
 * définition des types, mais elle gonfle les économies (voir le commentaire de
 * PipelineMetrics). La baseline honnête — un seul appel `deep` sur le prompt entier —
 * sera ajoutée quand on branchera l'exécution réelle.
 */
import { defaultRegistry, ModelRegistry } from "../registry.js";
import type { PipelineMetrics, TaskMetrics } from "../types.js";

export interface PipelineMetricsInput {
  pipelineId: string;
  taskMetrics: TaskMetrics[];
  /** Modèle de référence pour la baseline (en général la route `deep`). */
  baselineModel: string;
  registry?: ModelRegistry;
}

export function computePipelineMetrics(input: PipelineMetricsInput): PipelineMetrics {
  const registry = input.registry ?? defaultRegistry;
  const { taskMetrics } = input;

  const totalCost = sum(taskMetrics.map((m) => m.cost));
  const totalTokens = sum(taskMetrics.map((m) => m.inputTokens + m.outputTokens));
  const totalDurationMs = sum(taskMetrics.map((m) => m.durationMs));
  const successCount = taskMetrics.filter((m) => m.success).length;
  const escalationCount = taskMetrics.filter((m) => m.escalated).length;

  const baselineCost = sum(
    taskMetrics.map((m) => registry.estimateCost(input.baselineModel, m.inputTokens, m.outputTokens)),
  );
  const savings = baselineCost > 0 ? ((baselineCost - totalCost) / baselineCost) * 100 : 0;

  return {
    pipelineId: input.pipelineId,
    totalCost,
    totalTokens,
    totalDurationMs,
    taskCount: taskMetrics.length,
    successCount,
    escalationCount,
    baselineCost,
    savings,
    costPerTask: taskMetrics,
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
