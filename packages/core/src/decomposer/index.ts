/**
 * Décomposeur — transforme un prompt en pipeline structuré.
 *
 * Robustesse (backends hétérogènes, dont des paliers gratuits capricieux) :
 *  - structured outputs quand le provider les gère, schéma aussi inscrit dans le prompt ;
 *  - extraction JSON tolérante (blocs ```json, texte autour) ;
 *  - troncature détectée (`stop: length`) → relance avec un budget de tokens doublé ;
 *  - JSON/plan invalide → relance de réparation (sortie fautive + erreur renvoyées au modèle).
 */
import { z } from "zod";
import { isCapability, referenceCost } from "../catalog.js";
import type {
  CompletionRequest,
  LogEntry,
  Message,
  ModelAssignment,
  Pipeline,
  ProjectContext,
  Provider,
  StopReason,
  Task,
  TaskMetrics,
} from "../types.js";
import { DECOMPOSER_SYSTEM_PROMPT } from "./system-prompt.js";

export { DECOMPOSER_SYSTEM_PROMPT, buildWorkerPrompt } from "./system-prompt.js";

/** Tiers que le décomposeur peut assigner (pas `escalate`, réservé à l'échec). */
export const PLAN_TIERS = ["quick", "build", "deep"] as const;

export const PLAN_TASK_TYPES = [
  "scaffold",
  "architecture",
  "implement",
  "test",
  "verify",
  "review",
  "format",
  "document",
  "clarify",
] as const;

export const PlanTaskSchema = z.object({
  // coerce : certains modèles renvoient des ids numériques (1, 2…).
  id: z.coerce.string(),
  type: z.enum(PLAN_TASK_TYPES),
  tier: z.enum(PLAN_TIERS),
  description: z.string(),
  dependsOn: z.array(z.coerce.string()),
  expectedOutput: z.string(),
  // Tolérant : les étiquettes inconnues sont ignorées plutôt que de rejeter le plan.
  needs: z.array(z.string()).optional(),
  /** Précisions (le « comment » essentiel) quand la tâche est délicate. */
  spec: z.string().optional(),
});

export const PlanQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).max(5).optional(),
});

export const PlanSchema = z.object({
  analysis: z.string(),
  /** Hypothèses prises faute de précision. */
  assumptions: z.array(z.string()).optional(),
  /** Questions de cadrage (demande trop floue) : dans ce cas, pas de tâches. */
  questions: z.array(PlanQuestionSchema).max(3).optional(),
  /** Contrats partagés : fichiers, signatures, formats, commandes de test. */
  contracts: z.string().optional(),
  /** Commande exacte pour lancer le programme depuis la racine (vide : rien à lancer, ex. page web). */
  launch: z.string().optional(),
  tasks: z.array(PlanTaskSchema).max(8),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/** Nombre total de tentatives (1 initiale + relances). */
const MAX_ATTEMPTS = 3;
const INITIAL_MAX_TOKENS = 12_000;

/** JSON Schema (draft 2020-12) du plan, pour les structured outputs. */
export function planJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PlanSchema) as Record<string, unknown>;
  // Anthropic n'attend pas la clé `$schema` au niveau racine du format.
  delete schema["$schema"];
  return schema;
}

export type DecomposerErrorKind = "empty" | "invalid_json" | "schema" | "dependencies" | "truncated";

export class DecomposerError extends Error {
  override readonly name = "DecomposerError";
  constructor(
    message: string,
    readonly kind: DecomposerErrorKind = "invalid_json",
  ) {
    super(message);
  }
}

export interface DecomposeOptions {
  prompt: string;
  context: ProjectContext;
  provider: Provider;
  /** Assignation modèle du décomposeur (depuis relay.config.json). */
  model: ModelAssignment;
  /** Journal des tentatives (requête, réponse brute, réparations). */
  onLog?: (entry: LogEntry) => void;
  /** Le planificateur peut poser des questions de cadrage au lieu de planifier. Défaut : oui. */
  allowQuestions?: boolean;
  /** Arrêt du pipeline pendant la planification. */
  signal?: AbortSignal;
}

/** Décompose un prompt en pipeline (tâches non encore exécutées). */
export async function decompose(opts: DecomposeOptions): Promise<Pipeline> {
  const schema = planJsonSchema();
  const messages: Message[] = [
    {
      role: "user",
      content: `${buildUserMessage(opts.prompt, opts.context)}${
        opts.allowQuestions === false
          ? "\n\n# Cadrage\nNe pose aucune question : planifie en prenant des hypothèses raisonnables (listées dans \"assumptions\")."
          : ""
      }

# Format de sortie
Réponds UNIQUEMENT avec un objet JSON valide conforme à ce schéma, sans texte ni bloc de code autour :
${JSON.stringify(schema)}`,
    },
  ];

  let maxTokens = INITIAL_MAX_TOKENS;
  let lastError: DecomposerError | undefined;
  // Coût du plan, relances comprises : compté dans les totaux du pipeline.
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  let servedModel = opts.model.model;
  const log = (entry: Omit<LogEntry, "at" | "category">): void =>
    opts.onLog?.({ at: Date.now(), category: "plan", ...entry });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    log({
      level: "info",
      title: `Plan : tentative ${attempt + 1} → ${opts.provider.name} · ${opts.model.model}`,
      detail: `[système]\n${DECOMPOSER_SYSTEM_PROMPT}\n\n[demande]\n${messages.at(-1)?.content ?? ""}`,
    });
    const reply = await collect(opts.provider, {
      model: opts.model.model,
      effort: opts.model.effort,
      system: DECOMPOSER_SYSTEM_PROMPT,
      messages,
      format: { schema },
      maxTokens,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const { text, stop } = reply;
    usage.inputTokens += reply.inputTokens;
    usage.outputTokens += reply.outputTokens;
    usage.thinkingTokens += reply.thinkingTokens;
    if (reply.servedModel !== undefined) servedModel = reply.servedModel;

    try {
      if (stop === "length") {
        throw new DecomposerError("réponse tronquée (limite de tokens atteinte)", "truncated");
      }
      const plan = parsePlan(text, opts.allowQuestions !== false);
      validateDependencies(plan);
      if (plan.tasks.length === 0) {
        log({
          level: "info",
          title: `Questions de cadrage : ${plan.questions?.length ?? 0}`,
          detail: `${plan.analysis}\n\n${(plan.questions ?? []).map((q) => `- ${q.question}${q.options?.length ? ` (${q.options.join(" / ")})` : ""}`).join("\n")}`,
        });
        return buildPipeline(opts, plan, planningMetrics(opts, servedModel, usage, started));
      }
      log({
        level: "info",
        title: `Plan prêt : ${plan.tasks.length} tâche(s)`,
        detail: `${plan.analysis}\n\n${plan.tasks
          .map((t) => `[${t.id}] ${t.tier}/${t.type}${t.needs?.length ? ` {${t.needs.join(", ")}}` : ""} — ${t.description}`)
          .join("\n")}`,
      });
      return buildPipeline(opts, plan, planningMetrics(opts, servedModel, usage, started));
    } catch (err) {
      if (!(err instanceof DecomposerError)) throw err;
      lastError = err;
      log({
        level: "warn",
        title: `Plan rejeté (${err.message}) → ${err.kind === "truncated" ? "relance avec plus de tokens" : "relance de réparation"}`,
        detail: text,
      });
      if (err.kind === "truncated") {
        maxTokens *= 2; // même demande, plus de place
      } else {
        messages.push(
          { role: "assistant", content: text.slice(0, 6_000) || "(réponse vide)" },
          { role: "user", content: repairPrompt(err) },
        );
      }
    }
  }

  throw new DecomposerError(
    `${lastError?.message ?? "échec"} (après ${MAX_ATTEMPTS} tentatives)`,
    lastError?.kind ?? "invalid_json",
  );
}

/** Extrait l'objet JSON d'une réponse (tolère les blocs ```json et le texte autour). */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  const body = fenced ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end > start ? body.slice(start, end + 1) : body.trim();
}

interface Reply {
  text: string;
  stop: StopReason | undefined;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  servedModel?: string;
}

async function collect(provider: Provider, request: CompletionRequest): Promise<Reply> {
  const reply: Reply = { text: "", stop: undefined, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  for await (const chunk of provider.complete(request)) {
    if (chunk.type === "text") reply.text += chunk.text;
    else if (chunk.type === "stop") reply.stop = chunk.reason;
    else if (chunk.type === "model") reply.servedModel = chunk.model;
    else if (chunk.type === "usage") {
      reply.inputTokens += chunk.usage.inputTokens;
      reply.outputTokens += chunk.usage.outputTokens;
      reply.thinkingTokens += chunk.usage.thinkingTokens ?? 0;
    }
  }
  return reply;
}

function planningMetrics(
  opts: DecomposeOptions,
  model: string,
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number },
  started: number,
): TaskMetrics {
  const ref = referenceCost(model, usage.inputTokens, usage.outputTokens);
  return {
    taskId: "plan",
    model,
    provider: opts.provider.name,
    ...(opts.model.effort !== undefined ? { effort: opts.model.effort } : {}),
    tier: "build",
    ...usage,
    referenceCost: ref,
    billedCost: opts.provider.billing === "per-token" ? ref : 0,
    durationMs: Date.now() - started,
    success: true,
    escalated: false,
    ...(model !== opts.model.model ? { fallbackFrom: opts.model.model } : {}),
  };
}

function repairPrompt(err: DecomposerError): string {
  return `Ta réponse précédente est inutilisable : ${err.message}.
Renvoie UNIQUEMENT l'objet JSON complet et valide, conforme au schéma demandé (3 à 8 tâches, ids existants dans dependsOn, pas de cycle), sans texte ni bloc de code autour.`;
}

function buildPipeline(opts: DecomposeOptions, plan: Plan, planning: TaskMetrics): Pipeline {
  const tasks: Task[] = plan.tasks.map((t) => {
    const needs = [...new Set((t.needs ?? []).filter(isCapability))];
    const spec = t.spec?.trim();
    return {
      id: t.id,
      type: t.type,
      description: t.description,
      tier: t.tier,
      ...(needs.length > 0 ? { needs } : {}),
      ...(spec ? { spec } : {}),
      dependsOn: t.dependsOn,
      status: "pending",
      attempts: [],
      expectedOutput: t.expectedOutput,
    };
  });
  const contracts = plan.contracts?.trim();
  return {
    id: crypto.randomUUID(),
    prompt: opts.prompt,
    context: opts.context,
    tasks,
    status: "pending",
    planning,
    ...(contracts ? { contracts } : {}),
    ...(plan.analysis.trim() ? { analysis: plan.analysis.trim() } : {}),
    ...(plan.launch?.trim() ? { launch: plan.launch.trim() } : {}),
    ...(plan.assumptions?.length ? { assumptions: plan.assumptions } : {}),
    ...(plan.questions?.length ? { questions: plan.questions.map((q) => ({ question: q.question, ...(q.options?.length ? { options: q.options } : {}) })) } : {}),
    created: new Date(),
  };
}

function buildUserMessage(prompt: string, context: ProjectContext): string {
  const parts = [`# Demande\n${prompt}`, "", "# Contexte projet", `cwd: ${context.cwd}`];
  if (context.stack && context.stack.length > 0) parts.push(`stack: ${context.stack.join(", ")}`);
  if (context.files && context.files.length > 0) {
    parts.push(`fichiers pertinents: ${context.files.join(", ")}`);
  }
  if (context.conventions) parts.push(`conventions:\n${context.conventions}`);
  return parts.join("\n");
}

function parsePlan(raw: string, allowQuestions = true): Plan {
  if (raw.trim().length === 0) throw new DecomposerError("réponse vide", "empty");
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    throw new DecomposerError(`JSON invalide : ${truncate(raw)}`, "invalid_json");
  }
  const result = PlanSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "racine"} : ${i.message}`)
      .join(" ; ");
    throw new DecomposerError(`plan non conforme au schéma (${issues})`, "schema");
  }
  const plan = result.data;
  if (plan.tasks.length === 0) {
    if (!allowQuestions || (plan.questions ?? []).length === 0) {
      throw new DecomposerError("plan vide : donne au moins une tâche", "schema");
    }
  } else if (plan.questions !== undefined) {
    delete plan.questions; // un plan avec des tâches s'exécute : les questions deviennent sans objet
  }
  return plan;
}

/** Vérifie que chaque `dependsOn` référence un ID existant et qu'il n'y a pas de cycle. */
function validateDependencies(plan: Plan): void {
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new DecomposerError(`tâche ${task.id} dépend d'un ID inexistant : ${dep}`, "dependencies");
      }
      if (dep === task.id) {
        throw new DecomposerError(`tâche ${task.id} dépend d'elle-même`, "dependencies");
      }
    }
  }
  detectCycle(plan);
}

function detectCycle(plan: Plan): void {
  const deps = new Map(plan.tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") throw new DecomposerError(`cycle de dépendances détecté sur ${id}`, "dependencies");
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) visit(dep);
    state.set(id, "done");
  };

  for (const task of plan.tasks) visit(task.id);
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
