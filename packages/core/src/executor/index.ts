/**
 * Exécuteur — parcourt le DAG en ordre topologique, route chaque tâche, chaîne les
 * résultats et émet des événements typés (dont un journal lisible).
 *
 * Routage : `TaskRouting` fournit des candidats classés (mode manuel : un seul ; mode
 * automatique : tous les comptes). Si un candidat échoue (saturé, quota, retiré, requête
 * trop volumineuse…), la tâche passe au suivant — éventuellement chez un autre compte.
 *
 * Phase D : avec un `runTask` agentique, la tâche agit sur un vrai dossier ; ses actions
 * (fichiers, commandes) sont streamées en direct. Si ses vérifications échouent encore,
 * elle est escaladée une fois vers un modèle plus fort.
 */
import { referenceCost } from "../catalog.js";
import { abortError, describeError, ProviderRequestError, retryDelayMs, shouldTryAnotherModel, SKIP_REASON } from "../errors.js";
import { computePipelineMetrics } from "../metrics/index.js";
import { buildWorkerPrompt } from "../decomposer/system-prompt.js";
import { candidateKey, manualRouting, type RouteCandidate, type TaskRouting } from "../router/auto.js";
import { Router } from "../router/index.js";
import { Workspace } from "../workspace/workspace.js";
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
const MAX_ROUTE_ATTEMPTS = 5;
/** Tous les modèles saturés : attente max d'un délai annoncé (« réessaie dans 17 s ») avant un dernier essai. */
const MAX_RATE_WAIT_MS = 30_000;
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
  /** Résumé en une ligne (sinon : première ligne du texte). */
  summary?: string;
  /** Données transmises dans `TaskIO.data` (fichiers écrits, commandes…). */
  data?: Record<string, unknown>;
  /** Temps de première réponse du modèle (premier appel de la tâche). */
  firstChunkMs?: number;
  /** Des vérifications (commandes) échouent encore à la fin de la tâche. */
  checksFailed?: boolean;
}

export interface RunTaskContext {
  task: Task;
  request: CompletionRequest;
  provider: Provider;
  /** Flux de texte au fil de l'eau (pour émettre des `task:chunk`). */
  onChunk: (text: string) => void;
  /** Émet un événement en direct (fichier écrit, commande, journal…). */
  emit: (event: PipelineEvent) => void;
}

/** Stratégie d'exécution d'une tâche. Par défaut : un appel au provider (texte). */
export type RunTask = (ctx: RunTaskContext) => Promise<WorkerResult>;

export interface ExecutorOptions {
  pipeline: Pipeline;
  /** Routage (manuel ou automatique). À défaut : `provider` + `router` (mode manuel). */
  routing?: TaskRouting;
  provider?: Provider;
  router?: Router;
  /** Modèle de référence pour la baseline des métriques. */
  baselineModel?: string;
  /** Worker : génération simple par défaut, agentique en phase D (`agenticRunTask`). */
  runTask?: RunTask;
  /** Interrompt le pipeline avant la tâche suivante. */
  signal?: AbortSignal;
  /** Assemble un livrable final à partir de tous les résultats (étape de synthèse). */
  synthesis?: boolean;
  /** Appelé au début de chaque tentative : `skip()` passe au modèle suivant (modèle trop lent). */
  onAttempt?: (attempt: { taskId: string; provider: string; model: string; skip: () => void }) => void;
}

const SYNTHESIS_SYSTEM =
  "Tu es le rédacteur final du pipeline Relay. Tu assembles les résultats des tâches en un livrable unique, cohérent et directement utilisable.";
/** Part de chaque résultat transmise à la synthèse (caractères) : borne l'entrée. */
const SYNTHESIS_INPUT_PER_TASK = 4_000;
const SYNTHESIS_MAX_TOKENS = 12_000;
const SYNTHESIS_TASK: Task = {
  id: "synthese",
  type: "document",
  description: "Synthèse finale",
  tier: "build",
  dependsOn: [],
  status: "pending",
  attempts: [],
};

export class ExecutorError extends Error {
  override readonly name = "ExecutorError";
}

const log = (entry: Omit<LogEntry, "at">): PipelineEvent => ({ type: "log", entry: { at: Date.now(), ...entry } });

/** Une tentative d'exécution d'une tâche sur un candidat. */
interface Attempt {
  candidate: RouteCandidate;
  provider: Provider;
  result: WorkerResult;
  model: string;
  referenceCost: number;
  billedCost: number;
  durationMs: number;
}

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
    const started = Date.now();
    const attempts: Attempt[] = [];

    // 1. Premier choix, puis replis si le fournisseur échoue.
    let failure: unknown;
    let lastTried = first;
    const waitable: Array<{ c: RouteCandidate; delay: number }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i] as RouteCandidate;
      lastTried = c;
      let outcome = yield* attempt(task, c, prompt, routing, runTask, opts);
      if (!("result" in outcome) && outcome.error instanceof ProviderRequestError && outcome.error.kind === "invalid_output" && !aborted(opts.signal)) {
        // Souvent aléatoire (outil inventé, réponse vide) : un second essai sur le même modèle.
        yield log({ level: "warn", category: "fallback", taskId: task.id, title: `#${task.id} réponse inutilisable de ${c.model} → second essai` });
        outcome = yield* attempt(task, c, prompt, routing, runTask, opts);
      }
      if ("result" in outcome) {
        attempts.push(outcome);
        failure = undefined;
        break;
      }
      failure = outcome.error;
      if (outcome.error instanceof ProviderRequestError && outcome.error.kind === "rate_limited") {
        const delay = retryDelayMs(outcome.error);
        if (delay !== undefined && delay <= MAX_RATE_WAIT_MS) waitable.push({ c, delay });
      }
      const next = candidates[i + 1];
      if (next !== undefined && outcome.error instanceof ProviderRequestError && shouldTryAnotherModel(outcome.error)) {
        const d = describeError(outcome.error);
        yield log({
          level: "warn",
          category: "fallback",
          taskId: task.id,
          title: `#${task.id} ${c.provider} · ${c.model} : ${d.title.toLowerCase()} → repli sur ${next.provider} · ${next.model}`,
          detail: d.detail,
        });
        continue;
      }
      break;
    }

    // Tout est saturé, mais un fournisseur a dit quand réessayer (limite par minute) : on patiente.
    const patient = waitable.sort((a, b) => a.delay - b.delay)[0];
    if (attempts.length === 0 && patient !== undefined && !aborted(opts.signal)) {
      yield log({
        level: "warn",
        category: "fallback",
        taskId: task.id,
        title: `#${task.id} tous les modèles sont saturés → pause ${Math.ceil(patient.delay / 1000)} s puis nouvel essai sur ${patient.c.provider} · ${patient.c.model}`,
      });
      await sleep(patient.delay + 1_000, opts.signal);
      if (!aborted(opts.signal)) {
        lastTried = patient.c;
        const outcome = yield* attempt(task, patient.c, prompt, routing, runTask, opts);
        if ("result" in outcome) attempts.push(outcome);
        else failure = outcome.error;
      }
    }

    // Arrêt demandé pendant la tâche : on s'arrête là, sans attendre ni compter un échec du modèle.
    if (aborted(opts.signal)) {
      task.status = "failed";
      pipeline.status = "failed";
      yield log({ level: "warn", category: "info", taskId: task.id, title: "Pipeline arrêté par l'utilisateur" });
      yield { type: "pipeline:failed", pipeline, error: "pipeline arrêté par l'utilisateur" };
      return;
    }

    const firstSuccess = attempts[0];
    if (firstSuccess === undefined) {
      const description = describeError(failure);
      const error = `${description.title} — ${description.detail}`;
      const metrics = failMetrics(task, lastTried, started);
      task.status = "failed";
      task.attempts.push({ model: metrics.model, ...(metrics.effort !== undefined ? { effort: metrics.effort } : {}), success: false, metrics, error });
      taskMetrics.push(metrics);
      yield log({ level: "error", category: "error", taskId: task.id, title: `#${task.id} échec : ${description.title}`, detail: description.detail });
      yield { type: "task:failed", taskId: task.id, error, metrics, description };
      pipeline.status = "failed";
      yield { type: "pipeline:failed", pipeline, error, description };
      return;
    }

    // 2. Escalade : vérifications encore en échec → un modèle plus fort, une fois.
    if (firstSuccess.result.checksFailed === true && routing.escalate !== undefined) {
      const tried = [...new Set([...candidates.map(candidateKey), candidateKey(firstSuccess.candidate)])];
      const up = routing.escalate(task, tried);
      if (up !== undefined) {
        yield {
          type: "task:escalate",
          taskId: task.id,
          from: { provider: firstSuccess.candidate.provider, model: firstSuccess.model, ...(firstSuccess.candidate.effort !== undefined ? { effort: firstSuccess.candidate.effort } : {}) },
          to: { provider: up.provider, model: up.model, ...(up.effort !== undefined ? { effort: up.effort } : {}) },
          reason: "vérifications encore en échec",
        };
        yield log({
          level: "warn",
          category: "fallback",
          taskId: task.id,
          title: `#${task.id} escalade : vérifications en échec avec ${firstSuccess.model} → ${up.provider} · ${up.model}`,
          detail: `Raison : ${up.reason}`,
        });
        const retryPrompt = `${prompt}\n\n## Tentative précédente (${firstSuccess.model})\nElle n'a pas réussi à faire passer les vérifications. Reprends le travail à partir de l'état actuel du dossier.\n${firstSuccess.result.text.slice(0, 3_000)}`;
        const outcome = yield* attempt(task, up, retryPrompt, routing, runTask, opts);
        if ("result" in outcome) attempts.push(outcome);
        else yield log({ level: "warn", category: "error", taskId: task.id, title: `#${task.id} escalade impossible : ${describeError(outcome.error).title} — résultat précédent conservé` });
      }
    }

    const final = attempts.at(-1) as Attempt;
    const result = final.result;
    const truncated = result.stop === "length";
    const output: TaskIO = {
      summary: result.summary ?? firstLine(result.text),
      data: { result: result.text, ...result.data, ...(truncated ? { truncated: true } : {}) },
    };
    const sum = (f: (a: Attempt) => number): number => attempts.reduce((n, a) => n + f(a), 0);
    const metrics: TaskMetrics = {
      taskId: task.id,
      model: final.model,
      provider: final.candidate.provider,
      ...(final.candidate.effort !== undefined ? { effort: final.candidate.effort } : {}),
      tier: task.tier,
      inputTokens: sum((a) => a.result.inputTokens),
      outputTokens: sum((a) => a.result.outputTokens),
      thinkingTokens: sum((a) => a.result.thinkingTokens),
      referenceCost: sum((a) => a.referenceCost),
      billedCost: sum((a) => a.billedCost),
      durationMs: Date.now() - started,
      success: true,
      escalated: attempts.length > 1,
    };
    // Repli interne au provider, ou candidat de repli / escalade du routeur.
    if (final.model !== final.candidate.model) metrics.fallbackFrom = final.candidate.model;
    else if (candidateKey(final.candidate) !== candidateKey(first)) metrics.fallbackFrom = `${first.provider} · ${first.model}`;

    task.output = output;
    task.status = "done";
    for (const a of attempts) {
      task.attempts.push({ model: a.model, ...(a.candidate.effort !== undefined ? { effort: a.candidate.effort } : {}), success: true, metrics, result: a.result.text });
    }
    taskMetrics.push(metrics);

    yield log({
      level: truncated || result.checksFailed === true ? "warn" : "info",
      category: "response",
      taskId: task.id,
      title: `#${task.id} terminée par ${final.model} · ${metrics.outputTokens} tokens${
        metrics.thinkingTokens > 0 ? ` (dont ${metrics.thinkingTokens} de réflexion)` : ""
      } · ${(metrics.durationMs / 1000).toFixed(1)} s${truncated ? " · TRONQUÉE" : ""}${result.checksFailed === true ? " · ⚠ vérifications en échec" : ""}`,
      detail: result.text,
    });
    yield { type: "task:done", taskId: task.id, result: output, metrics };
  }

  const synthesis = opts.synthesis === true && !aborted(opts.signal) ? yield* synthesize(pipeline, routing, opts.signal) : undefined;
  const overhead = [pipeline.planning, synthesis].filter((m): m is TaskMetrics => m !== undefined);
  const metrics = computePipelineMetrics({ pipelineId: pipeline.id, taskMetrics, overhead, baselineModel });
  pipeline.metrics = metrics;
  pipeline.status = "done";
  pipeline.finished = new Date();
  yield { type: "pipeline:done", pipeline, metrics };
}

/** Exécute une tâche sur un candidat ; streame ses événements ; renvoie le résultat ou l'erreur. */
async function* attempt(
  task: Task,
  c: RouteCandidate,
  prompt: string,
  routing: TaskRouting,
  runTask: RunTask,
  opts: Pick<ExecutorOptions, "signal" | "onAttempt">,
): AsyncGenerator<PipelineEvent, Attempt | { error: unknown }> {
  // Annulation propre à cette tentative : arrêt du pipeline, ou « passer au modèle suivant ».
  const control = new AbortController();
  const onStop = (): void => control.abort(opts.signal?.reason);
  if (opts.signal?.aborted === true) control.abort(opts.signal.reason);
  opts.signal?.addEventListener("abort", onStop, { once: true });
  opts.onAttempt?.({ taskId: task.id, provider: c.provider, model: c.model, skip: () => control.abort(SKIP_REASON) });
  try {
    return yield* attemptOnce(task, c, prompt, routing, runTask, control.signal);
  } finally {
    opts.signal?.removeEventListener("abort", onStop);
  }
}

async function* attemptOnce(
  task: Task,
  c: RouteCandidate,
  prompt: string,
  routing: TaskRouting,
  runTask: RunTask,
  signal: AbortSignal,
): AsyncGenerator<PipelineEvent, Attempt | { error: unknown }> {
  const provider = routing.provider(c.provider);
  routing.onUse?.(c);
  task.assignedModel = c.model;
  if (c.effort !== undefined) task.assignedEffort = c.effort;

  yield { type: "task:start", taskId: task.id, model: c.model, provider: c.provider, reason: c.reason, ...(c.effort !== undefined ? { effort: c.effort } : {}) };
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
    signal,
    tag: { purpose: "task", taskId: task.id },
  };

  const started = Date.now();
  let result: WorkerResult;
  try {
    result = yield* streamWhile((emit) => {
      // Le texte du modèle part en direct, par paquets (toutes les 250 ms) : l'interface voit qu'il écrit.
      let pending = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (pending) emit({ type: "task:chunk", taskId: task.id, text: pending });
        pending = "";
      };
      const onChunk = (t: string): void => {
        pending += t;
        timer ??= setTimeout(flush, 250);
      };
      return runTask({ task, request, provider, emit, onChunk }).finally(flush);
    });
  } catch (err) {
    // Annulé pendant un appel ou une commande : erreur explicite (repli si « passer », arrêt sinon).
    const e = signal.aborted && !(err instanceof ProviderRequestError && err.kind !== "unknown") ? abortError(signal, c.provider, c.model) : err;
    routing.report?.(c, e instanceof ProviderRequestError && e.kind !== "aborted" ? e : undefined);
    return { error: e };
  }
  if (signal.aborted) return { error: abortError(signal, c.provider, c.model) };
  if (result.text.trim().length === 0) {
    // Réponse vide (tout parti en réflexion…) : inutilisable, un autre modèle prendra le relais.
    const err = new ProviderRequestError("invalid_output", "réponse vide (aucun texte produit)", c.provider, c.model);
    routing.report?.(c, err);
    return { error: err };
  }
  routing.report?.(c, undefined, result.firstChunkMs !== undefined ? { firstChunkMs: result.firstChunkMs } : undefined);

  const model = result.servedModel ?? c.model;
  const refCost = referenceCost(model, result.inputTokens, result.outputTokens);
  const billedCost = provider.billing === "per-token" ? refCost : 0;
  routing.onCost?.(c, billedCost);
  return { candidate: c, provider, result, model, referenceCost: refCost, billedCost, durationMs: Date.now() - started };
}

/**
 * Exécute `fn` et yield en temps réel les événements qu'elle émet ; renvoie son résultat.
 * (Le worker agentique écrit des fichiers et lance des commandes pendant qu'on l'attend.)
 */
async function* streamWhile<T>(fn: (emit: (e: PipelineEvent) => void) => Promise<T>): AsyncGenerator<PipelineEvent, T> {
  const buffer: PipelineEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;

  void fn((e) => {
    buffer.push(e);
    wake?.();
  }).then(
    (v) => {
      value = v;
      done = true;
      wake?.();
    },
    (e: unknown) => {
      error = e;
      failed = true;
      done = true;
      wake?.();
    },
  );

  while (true) {
    while (buffer.length > 0) yield buffer.shift() as PipelineEvent;
    if (done) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
  while (buffer.length > 0) yield buffer.shift() as PipelineEvent;
  if (failed) throw error;
  return value as T;
}

/**
 * Synthèse : un modèle « build » à long contexte assemble tous les résultats en un livrable.
 * En cas d'échec, le pipeline reste réussi (les résultats des tâches sont là).
 */
async function* synthesize(pipeline: Pipeline, routing: TaskRouting, signal?: AbortSignal): AsyncGenerator<PipelineEvent, TaskMetrics | undefined> {
  const candidates = routing.candidates({ tier: "build", needs: ["long_context"] }).slice(0, MAX_ROUTE_ATTEMPTS);
  const prompt = buildSynthesisPrompt(pipeline);

  for (const [i, c] of candidates.entries()) {
    const provider = routing.provider(c.provider);
    routing.onUse?.(c);
    yield log({ level: "info", category: "route", title: `Synthèse → ${c.provider} · ${c.model}`, detail: `Raison : ${c.reason}` });
    yield log({ level: "info", category: "request", title: `Synthèse : requête → ${c.model}`, detail: prompt });
    const started = Date.now();
    try {
      const r = await defaultRunTask({
        task: SYNTHESIS_TASK,
        request: {
          model: c.model,
          ...(c.effort !== undefined ? { effort: c.effort } : {}),
          system: SYNTHESIS_SYSTEM,
          messages: [{ role: "user", content: prompt }],
          maxTokens: SYNTHESIS_MAX_TOKENS,
          ...(signal !== undefined ? { signal } : {}),
          tag: { purpose: "synthesis" },
        },
        provider,
        onChunk: () => undefined,
        emit: () => undefined,
      });
      routing.report?.(c);
      const model = r.servedModel ?? c.model;
      const ref = referenceCost(model, r.inputTokens, r.outputTokens);
      const metrics: TaskMetrics = {
        taskId: SYNTHESIS_TASK.id,
        model,
        provider: c.provider,
        ...(c.effort !== undefined ? { effort: c.effort } : {}),
        tier: "build",
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        thinkingTokens: r.thinkingTokens,
        referenceCost: ref,
        billedCost: provider.billing === "per-token" ? ref : 0,
        durationMs: Date.now() - started,
        success: true,
        escalated: false,
      };
      routing.onCost?.(c, metrics.billedCost);
      yield log({
        level: r.stop === "length" ? "warn" : "info",
        category: "response",
        title: `Synthèse prête · ${r.outputTokens} tokens · ${(metrics.durationMs / 1000).toFixed(1)} s${r.stop === "length" ? " · TRONQUÉE" : ""}`,
        detail: r.text,
      });
      yield { type: "pipeline:synthesis", text: r.text, provider: c.provider, model, metrics };
      return metrics;
    } catch (err) {
      routing.report?.(c, err instanceof ProviderRequestError ? err : undefined);
      const d = describeError(err);
      const last = i === candidates.length - 1;
      yield log({
        level: last ? "error" : "warn",
        category: last ? "error" : "fallback",
        title: `Synthèse ${c.model} : ${d.title.toLowerCase()}${last ? " — résultats des tâches conservés" : " → modèle suivant"}`,
        detail: d.detail,
      });
    }
  }
  return undefined;
}

function buildSynthesisPrompt(pipeline: Pipeline): string {
  const results = pipeline.tasks
    .map((t) => {
      const raw = t.output?.data?.["result"];
      const out = typeof raw === "string" ? raw : (t.output?.summary ?? "(pas de résultat)");
      const clipped = out.length > SYNTHESIS_INPUT_PER_TASK ? `${out.slice(0, SYNTHESIS_INPUT_PER_TASK)}\n[…tronqué]` : out;
      return `## [${t.id}] (${t.tier}/${t.type}) ${t.description}\n${clipped}`;
    })
    .join("\n\n");

  if (pipeline.workspace !== undefined) {
    // Les fichiers existent déjà : on ne recopie pas le code, on explique comment s'en servir.
    const files = new Workspace(pipeline.workspace)
      .list()
      .map((f) => `- ${f.path} (${f.size} o)`)
      .join("\n");
    return `# Demande originale
${pipeline.prompt}

# Dossier de travail
${pipeline.workspace}
${files || "(vide)"}

# Résultats des tâches
${results}

# Consignes
Les fichiers sont DÉJÀ écrits dans le dossier : ne recopie pas le code. Rédige un compte rendu court et utile :
1. L'arborescence et le rôle de chaque fichier.
2. Comment lancer et tester (commandes exactes, depuis le dossier).
3. L'état des vérifications (tests passés ou en échec, avec la cause).
4. Les limites ou prochaines étapes éventuelles.`;
  }

  return `# Demande originale
${pipeline.prompt}

# Résultats des tâches
${results}

# Consignes
- Produis le livrable final complet et directement utilisable : le contenu final de chaque fichier dans un bloc de code précédé de son nom, puis comment l'utiliser et le tester.
- Résous les incohérences entre tâches (noms, signatures, formats) en faveur d'une version qui fonctionne.
- Ne raconte pas les étapes : donne le résultat.`;
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
      case "latency":
        result.firstChunkMs ??= chunk.firstChunkMs;
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
    pipeline.workspace === undefined ? `cwd: ${ctx.cwd}` : "",
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
    ...(pipeline.contracts !== undefined ? { contracts: pipeline.contracts } : {}),
    ...(task.spec !== undefined ? { spec: task.spec } : {}),
  });
}

/** Fonction (et non test direct) : l'état change pendant les `await`. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/** Attente interrompue par l'arrêt du pipeline. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
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
