/**
 * Exécuteur — parcourt le DAG en ordre topologique, route chaque tâche, chaîne les
 * résultats et émet des événements typés (dont un journal lisible).
 *
 * Routage : `TaskRouting` fournit des candidats classés (mode manuel : un seul ; mode
 * automatique : tous les comptes). Si un candidat échoue (saturé, quota, retiré…), la
 * tâche passe au suivant — éventuellement chez un autre fournisseur.
 *
 * À VENIR (phase D) : remplacer `runTask` par une boucle d'outils (fichiers + shell).
 */
import { referenceCost } from "../catalog.js";
import { describeError, ProviderRequestError } from "../errors.js";
import { computePipelineMetrics } from "../metrics/index.js";
import { buildWorkerPrompt } from "../decomposer/system-prompt.js";
import { manualRouting, type RouteCandidate, type TaskRouting } from "../router/auto.js";
import { Router } from "../router/index.js";
import type {
  CompletionRequest,
  LogEntry,
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
/** Nombre max de modèles essayés pour une même tâche. */
const MAX_ROUTE_ATTEMPTS = 3;
/** Référence de la baseline « tout sur le modèle le plus fort » quand rien d'autre n'est fourni. */
const DEFAULT_BASELINE_MODEL = "claude-opus-5-5";

/** Résultat brut d'un worker. */
export interface WorkerResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Modèle réellement utilisé si le provider a fait un repli interne. */
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
  /** Routage (manuel ou automatique). À défaut : `provider` + `router` (mode manuel). */
  routing?: TaskRouting;
  provider?: Provider;
  router?: Router;
  /** Modèle de référence pour la baseline des métriques. */
  baselineModel?: string;
  /** Point d'injection du worker agentique. Défaut : génération simple. */
  runTask?: RunTask;
  /** Interrompt le pipeline avant la tâche suivante. */
  signal?: AbortSignal;
}

export class ExecutorError extends Error {
  override readonly name = "ExecutorError";
}

const log = (entry: Omit<LogEntry, "at">): PipelineEvent => ({ type: "log", entry: { at: Date.now(), ...entry } });

/** Exécute le pipeline et émet les événements au fil de l'eau. */
export async function* execute(opts: ExecutorOptions): AsyncGenerator<PipelineEvent> {
  const { pipeline } = opts;
  const routing = resolveRouting(opts);
  const runTask = opts.runTask ?? defaultRunTask;
  const baselineModel = opts.baselineModel ?? opts.router?.forTier("deep").model ?? DEFAULT_BASELINE_MODEL;

  pipeline.status = "running";
  yield { type: "pipeline:start", pipeline };
  yield { type: "pipeline:plan", pipeline, tasks: pipeline.tasks };

  const order = topoOrder(pipeline.tasks);
  const taskMetrics: TaskMetrics[] = [];

  for (const task of order) {
    if (opts.signal?.aborted === true) {
      pipeline.status = "failed";
      yield log({ level: "warn", category: "info", title: "Pipeline arrêté par l'utilisateur" });
      yield { type: "pipeline:failed", pipeline, error: "pipeline arrêté par l'utilisateur" };
      return;
    }

    const candidates = routing.candidates(task).slice(0, MAX_ROUTE_ATTEMPTS);
    const first = candidates[0];
    if (first === undefined) {
      const error = `aucun modèle disponible pour la tâche ${task.id} (niveau ${task.tier}${
        task.needs?.length ? `, besoins : ${task.needs.join(", ")}` : ""
      }) — vérifie tes comptes et leurs plafonds`;
      task.status = "failed";
      pipeline.status = "failed";
      yield log({ level: "error", category: "error", taskId: task.id, title: error });
      yield { type: "pipeline:failed", pipeline, error };
      return;
    }

    yield {
      type: "task:route",
      taskId: task.id,
      provider: first.provider,
      model: first.model,
      ...(first.effort !== undefined ? { effort: first.effort } : {}),
      reason: first.reason,
      alternatives: candidates.slice(1).map((c) => ({ provider: c.provider, model: c.model, reason: c.reason })),
    };
    yield log({
      level: "info",
      category: "route",
      taskId: task.id,
      title: `#${task.id} ${task.tier} → ${first.provider} · ${first.model}`,
      detail: [`Raison : ${first.reason}`, ...candidates.slice(1).map((c, i) => `Repli ${i + 1} : ${c.provider} · ${c.model} (${c.reason})`)].join("\n"),
    });

    task.status = "running";
    const prompt = buildTaskPrompt(pipeline, task);
    let finished = false;

    for (let i = 0; i < candidates.length && !finished; i++) {
      const c = candidates[i] as RouteCandidate;
      const provider = routing.provider(c.provider);
      routing.onUse?.(c);
      task.assignedModel = c.model;
      if (c.effort !== undefined) task.assignedEffort = c.effort;

      yield { type: "task:start", taskId: task.id, model: c.model, provider: c.provider, ...(c.effort !== undefined ? { effort: c.effort } : {}) };
      yield log({
        level: "info",
        category: "request",
        taskId: task.id,
        title: `#${task.id} requête → ${c.provider} · ${c.model}${c.effort !== undefined ? ` (effort ${c.effort})` : ""}`,
        detail: `[système]\n${WORKER_SYSTEM}\n\n[demande]\n${prompt}`,
      });

      const request: CompletionRequest = {
        model: c.model,
        ...(c.effort !== undefined ? { effort: c.effort } : {}),
        system: WORKER_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        maxTokens: DEFAULT_WORKER_MAX_TOKENS,
      };

      const started = Date.now();
      const chunks: string[] = [];
      let result: WorkerResult;
      try {
        result = await runTask({ task, request, provider, onChunk: (text) => chunks.push(text) });
      } catch (err) {
        const pe = err instanceof ProviderRequestError ? err : undefined;
        routing.report?.(c, pe);
        const description = describeError(err);
        const next = candidates[i + 1];
        if (next !== undefined && pe !== undefined && (pe.retryable || pe.kind === "model_not_found")) {
          yield log({
            level: "warn",
            category: "fallback",
            taskId: task.id,
            title: `#${task.id} ${c.provider} · ${c.model} : ${description.title.toLowerCase()} → repli sur ${next.provider} · ${next.model}`,
            detail: description.detail,
          });
          continue;
        }
        const error = `${description.title} — ${description.detail}`;
        const metrics = failMetrics(task, c, started);
        task.status = "failed";
        task.attempts.push({ model: c.model, ...(c.effort !== undefined ? { effort: c.effort } : {}), success: false, metrics, error });
        taskMetrics.push(metrics);
        yield log({ level: "error", category: "error", taskId: task.id, title: `#${task.id} échec : ${description.title}`, detail: description.detail });
        yield { type: "task:failed", taskId: task.id, error, metrics, description };
        pipeline.status = "failed";
        yield { type: "pipeline:failed", pipeline, error, description };
        return;
      }

      routing.report?.(c);
      for (const text of chunks) yield { type: "task:chunk", taskId: task.id, text };

      const servedModel = result.servedModel ?? c.model;
      const truncated = result.stop === "length";
      const output: TaskIO = {
        summary: firstLine(result.text),
        data: { result: result.text, ...(truncated ? { truncated: true } : {}) },
      };
      const refCost = referenceCost(servedModel, result.inputTokens, result.outputTokens);
      const durationMs = Date.now() - started;
      const metrics: TaskMetrics = {
        taskId: task.id,
        model: servedModel,
        provider: c.provider,
        ...(c.effort !== undefined ? { effort: c.effort } : {}),
        tier: task.tier,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        thinkingTokens: result.thinkingTokens,
        referenceCost: refCost,
        billedCost: provider.billing === "per-token" ? refCost : 0,
        durationMs,
        success: true,
        escalated: false,
      };
      // Repli interne au provider, ou candidat de repli du routeur.
      if (servedModel !== c.model) metrics.fallbackFrom = c.model;
      else if (i > 0) metrics.fallbackFrom = `${first.provider} · ${first.model}`;

      task.output = output;
      task.status = "done";
      task.attempts.push({ model: servedModel, ...(c.effort !== undefined ? { effort: c.effort } : {}), success: true, metrics, result: result.text });
      taskMetrics.push(metrics);

      yield log({
        level: truncated ? "warn" : "info",
        category: "response",
        taskId: task.id,
        title: `#${task.id} réponse de ${servedModel} · ${result.outputTokens} tokens${
          result.thinkingTokens > 0 ? ` (dont ${result.thinkingTokens} de réflexion)` : ""
        } · ${(durationMs / 1000).toFixed(1)} s${truncated ? " · TRONQUÉE" : ""}`,
        detail: result.text,
      });
      yield { type: "task:done", taskId: task.id, result: output, metrics };
      finished = true;
    }
  }

  const metrics = computePipelineMetrics({ pipelineId: pipeline.id, taskMetrics, baselineModel });
  pipeline.metrics = metrics;
  pipeline.status = "done";
  pipeline.finished = new Date();
  yield { type: "pipeline:done", pipeline, metrics };
}

function resolveRouting(opts: ExecutorOptions): TaskRouting {
  if (opts.routing !== undefined) return opts.routing;
  if (opts.provider !== undefined && opts.router !== undefined) return manualRouting(opts.router, opts.provider);
  throw new ExecutorError("exécuteur : fournir `routing`, ou `provider` + `router`");
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

function failMetrics(task: Task, c: RouteCandidate, started: number): TaskMetrics {
  return {
    taskId: task.id,
    model: c.model,
    provider: c.provider,
    ...(c.effort !== undefined ? { effort: c.effort } : {}),
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
