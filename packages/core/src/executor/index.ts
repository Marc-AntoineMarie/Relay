/**
 * Exécuteur — parcourt le DAG en ordre topologique, chaîne les résultats et émet des
 * événements typés.
 *
 * v0.1 : chaque tâche = un appel au provider assigné (génération), séquentiel.
 * Le provider gère le repli de modèle (saturé/retiré) ; l'exécuteur enregistre le modèle
 * réellement utilisé. Arrêt possible via `signal` (bouton « Arrêter » de l'UI).
 *
 * À VENIR (worker « agent exécutant ») : remplacer `runTask` par une boucle d'outils
 * (fichiers + shell). Escalade automatique (router.escalate) et parallélisme : v0.2.
 */
import { describeError } from "../errors.js";
import { computePipelineMetrics } from "../metrics/index.js";
import { buildWorkerPrompt } from "../decomposer/system-prompt.js";
import { Router } from "../router/index.js";
import type {
  CompletionRequest,
  Pipeline,
  PipelineEvent,
  Provider,
  StopReason,
  Task,
  TaskIO,
  TaskMetrics,
} from "../types.js";

const WORKER_SYSTEM =
  "Tu es un agent d'exécution dans le pipeline Relay. Tu réalises une tâche précise et renvoies un résultat structuré.";

/** Budget large : les modèles « thinking » consomment une partie de max_tokens en réflexion. */
const DEFAULT_WORKER_MAX_TOKENS = 16_000;

/** Résultat brut d'un worker. */
export interface WorkerResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Modèle réellement utilisé si le provider a fait un repli. */
  servedModel?: string;
  stop?: StopReason;
}

export interface RunTaskContext {
  task: Task;
  request: CompletionRequest;
  provider: Provider;
  /** Flux de texte au fil de l'eau (pour émettre des `task:chunk`). */
  onChunk: (text: string) => void;
}

/** Stratégie d'exécution d'une tâche. Par défaut : un appel au provider. */
export type RunTask = (ctx: RunTaskContext) => Promise<WorkerResult>;

export interface ExecutorOptions {
  pipeline: Pipeline;
  provider: Provider;
  router: Router;
  /** Modèle de référence pour la baseline des métriques (défaut : route `deep`). */
  baselineModel?: string;
  /** Point d'injection du worker agentique. Défaut : génération simple. */
  runTask?: RunTask;
  /** Interrompt le pipeline avant la tâche suivante. */
  signal?: AbortSignal;
}

export class ExecutorError extends Error {
  override readonly name = "ExecutorError";
}

/** Exécute le pipeline et émet les événements au fil de l'eau. */
export async function* execute(opts: ExecutorOptions): AsyncGenerator<PipelineEvent> {
  const { pipeline, provider, router } = opts;
  const runTask = opts.runTask ?? defaultRunTask;
  const baselineModel = opts.baselineModel ?? router.forTier("deep").model;

  pipeline.status = "running";
  yield { type: "pipeline:start", pipeline };
  yield { type: "pipeline:plan", pipeline, tasks: pipeline.tasks };

  const order = topoOrder(pipeline.tasks);
  const taskMetrics: TaskMetrics[] = [];

  for (const task of order) {
    if (opts.signal?.aborted === true) {
      pipeline.status = "failed";
      yield { type: "pipeline:failed", pipeline, error: "pipeline arrêté par l'utilisateur" };
      return;
    }

    const assigned = router.assign(task);
    task.assignedModel = assigned.assignedModel;
    task.assignedEffort = assigned.assignedEffort;
    task.status = "running";

    const model = task.assignedModel;
    if (model === undefined) {
      task.status = "failed";
      pipeline.status = "failed";
      yield { type: "pipeline:failed", pipeline, error: `aucun modèle assigné pour la tâche ${task.id}` };
      return;
    }

    yield { type: "task:start", taskId: task.id, model, effort: task.assignedEffort };

    const request: CompletionRequest = {
      model,
      effort: task.assignedEffort,
      system: WORKER_SYSTEM,
      messages: [{ role: "user", content: buildTaskPrompt(pipeline, task) }],
      maxTokens: DEFAULT_WORKER_MAX_TOKENS,
    };

    const started = Date.now();
    const chunks: string[] = [];
    let result: WorkerResult;
    try {
      result = await runTask({ task, request, provider, onChunk: (text) => chunks.push(text) });
    } catch (err) {
      const description = describeError(err);
      const error = `${description.title} — ${description.detail}`;
      const metrics = failMetrics(task, model, provider.name, started);
      task.status = "failed";
      task.attempts.push({ model, effort: task.assignedEffort, success: false, metrics, error });
      taskMetrics.push(metrics);
      yield { type: "task:failed", taskId: task.id, error, metrics, description };
      pipeline.status = "failed";
      yield { type: "pipeline:failed", pipeline, error, description };
      return;
    }

    for (const text of chunks) yield { type: "task:chunk", taskId: task.id, text };

    const servedModel = result.servedModel ?? model;
    const truncated = result.stop === "length";
    const output: TaskIO = {
      summary: firstLine(result.text),
      data: { result: result.text, ...(truncated ? { truncated: true } : {}) },
    };
    const referenceCost = provider.estimateCost(servedModel, result.inputTokens, result.outputTokens);
    const metrics: TaskMetrics = {
      taskId: task.id,
      model: servedModel,
      provider: provider.name,
      effort: task.assignedEffort,
      tier: task.tier,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      thinkingTokens: result.thinkingTokens,
      referenceCost,
      billedCost: provider.billing === "per-token" ? referenceCost : 0,
      durationMs: Date.now() - started,
      success: true,
      escalated: false,
    };
    if (servedModel !== model) metrics.fallbackFrom = model;

    task.output = output;
    task.status = "done";
    task.attempts.push({ model: servedModel, effort: task.assignedEffort, success: true, metrics, result: result.text });
    taskMetrics.push(metrics);

    yield { type: "task:done", taskId: task.id, result: output, metrics };
  }

  const metrics = computePipelineMetrics({ pipelineId: pipeline.id, taskMetrics, baselineModel });
  pipeline.metrics = metrics;
  pipeline.status = "done";
  pipeline.finished = new Date();
  yield { type: "pipeline:done", pipeline, metrics };
}

/** Worker par défaut : un appel au provider, texte accumulé. */
const defaultRunTask: RunTask = async (ctx) => {
  const result: WorkerResult = { text: "", inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

  for await (const chunk of ctx.provider.complete(ctx.request)) {
    switch (chunk.type) {
      case "text":
        result.text += chunk.text;
        ctx.onChunk(chunk.text);
        break;
      case "usage":
        result.inputTokens = chunk.usage.inputTokens;
        result.outputTokens = chunk.usage.outputTokens;
        result.thinkingTokens = chunk.usage.thinkingTokens ?? 0;
        break;
      case "model":
        result.servedModel = chunk.model;
        break;
      case "stop":
        result.stop = chunk.reason;
        break;
      default:
        break;
    }
  }

  return result;
};

function buildTaskPrompt(pipeline: Pipeline, task: Task): string {
  const planSummary = pipeline.tasks
    .map((t) => `- [${t.id}] (${t.tier}/${t.type}) ${t.description}`)
    .join("\n");

  // Résumés seulement : renvoyer les sorties complètes ferait exploser l'input.
  const depResults = task.dependsOn
    .map((id) => pipeline.tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined && t.output !== undefined)
    .map((t) => `### Tâche ${t.id}\n${t.output?.summary ?? ""}`)
    .join("\n\n");

  const ctx = pipeline.context;
  const projectContext = [
    `cwd: ${ctx.cwd}`,
    ctx.stack && ctx.stack.length > 0 ? `stack: ${ctx.stack.join(", ")}` : "",
    ctx.conventions ? `conventions:\n${ctx.conventions}` : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  return buildWorkerPrompt({
    prompt: pipeline.prompt,
    planSummary,
    taskDescription: task.description,
    dependencyResults: depResults,
    projectContext,
  });
}

/** Tri topologique (le décomposeur garantit déjà l'absence de cycle ; on reste prudent). */
function topoOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const temp = new Set<string>();
  const order: Task[] = [];

  const visit = (t: Task): void => {
    if (visited.has(t.id)) return;
    if (temp.has(t.id)) throw new ExecutorError(`cycle de dépendances détecté sur ${t.id}`);
    temp.add(t.id);
    for (const dep of t.dependsOn) {
      const d = byId.get(dep);
      if (d !== undefined) visit(d);
    }
    temp.delete(t.id);
    visited.add(t.id);
    order.push(t);
  };

  for (const t of tasks) visit(t);
  return order;
}

function failMetrics(task: Task, model: string, providerName: string, started: number): TaskMetrics {
  return {
    taskId: task.id,
    model,
    provider: providerName,
    effort: task.assignedEffort,
    tier: task.tier,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    referenceCost: 0,
    billedCost: 0,
    durationMs: Date.now() - started,
    success: false,
    escalated: false,
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line?.replace(/^[#*\s>-]+/, "").trim() || "(résultat vide)";
}
