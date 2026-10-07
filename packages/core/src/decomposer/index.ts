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
import type {
  CompletionRequest,
  Message,
  ModelAssignment,
  Pipeline,
  ProjectContext,
  Provider,
  StopReason,
  Task,
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
});

export const PlanSchema = z.object({
  analysis: z.string(),
  tasks: z.array(PlanTaskSchema).min(1).max(8),
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
}

/** Décompose un prompt en pipeline (tâches non encore exécutées). */
export async function decompose(opts: DecomposeOptions): Promise<Pipeline> {
  const schema = planJsonSchema();
  const messages: Message[] = [
    {
      role: "user",
      content: `${buildUserMessage(opts.prompt, opts.context)}

# Format de sortie
Réponds UNIQUEMENT avec un objet JSON valide conforme à ce schéma, sans texte ni bloc de code autour :
${JSON.stringify(schema)}`,
    },
  ];

  let maxTokens = INITIAL_MAX_TOKENS;
  let lastError: DecomposerError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { text, stop } = await collect(opts.provider, {
      model: opts.model.model,
      effort: opts.model.effort,
      system: DECOMPOSER_SYSTEM_PROMPT,
      messages,
      format: { schema },
      maxTokens,
    });

    try {
      if (stop === "length") {
        throw new DecomposerError("réponse tronquée (limite de tokens atteinte)", "truncated");
      }
      const plan = parsePlan(text);
      validateDependencies(plan);
      return buildPipeline(opts, plan);
    } catch (err) {
      if (!(err instanceof DecomposerError)) throw err;
      lastError = err;
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

async function collect(
  provider: Provider,
  request: CompletionRequest,
): Promise<{ text: string; stop: StopReason | undefined }> {
  let text = "";
  let stop: StopReason | undefined;
  for await (const chunk of provider.complete(request)) {
    if (chunk.type === "text") text += chunk.text;
    else if (chunk.type === "stop") stop = chunk.reason;
  }
  return { text, stop };
}

function repairPrompt(err: DecomposerError): string {
  return `Ta réponse précédente est inutilisable : ${err.message}.
Renvoie UNIQUEMENT l'objet JSON complet et valide, conforme au schéma demandé (3 à 8 tâches, ids existants dans dependsOn, pas de cycle), sans texte ni bloc de code autour.`;
}

function buildPipeline(opts: DecomposeOptions, plan: Plan): Pipeline {
  const tasks: Task[] = plan.tasks.map((t) => ({
    id: t.id,
    type: t.type,
    description: t.description,
    tier: t.tier,
    dependsOn: t.dependsOn,
    status: "pending",
    attempts: [],
    expectedOutput: t.expectedOutput,
  }));
  return {
    id: crypto.randomUUID(),
    prompt: opts.prompt,
    context: opts.context,
    tasks,
    status: "pending",
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

function parsePlan(raw: string): Plan {
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
  return result.data;
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
