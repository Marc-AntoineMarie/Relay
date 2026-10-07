/**
 * Décomposeur — transforme un prompt en pipeline structuré.
 *
 * Le plan est produit via structured outputs : le schéma Zod ci-dessous est converti en
 * JSON Schema et passé au provider, qui garantit une réponse conforme. On valide quand
 * même avec Zod avant de construire le pipeline (ceinture + bretelles).
 */
import { z } from "zod";
import type {
  CompletionRequest,
  ModelAssignment,
  Pipeline,
  ProjectContext,
  Provider,
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
  id: z.string(),
  type: z.enum(PLAN_TASK_TYPES),
  tier: z.enum(PLAN_TIERS),
  description: z.string(),
  dependsOn: z.array(z.string()),
  expectedOutput: z.string(),
});

export const PlanSchema = z.object({
  analysis: z.string(),
  tasks: z.array(PlanTaskSchema).min(1).max(8),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/** JSON Schema (draft 2020-12) du plan, pour les structured outputs. */
export function planJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PlanSchema) as Record<string, unknown>;
  // Anthropic n'attend pas la clé `$schema` au niveau racine du format.
  delete schema["$schema"];
  return schema;
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
  // Le schéma est aussi inscrit dans le prompt : les backends sans structured outputs
  // natifs (mode json_object) produisent alors la bonne structure ; les autres l'ignorent.
  const userMessage = `${buildUserMessage(opts.prompt, opts.context)}

# Format de sortie
Réponds UNIQUEMENT avec un objet JSON valide conforme à ce schéma, sans texte autour :
${JSON.stringify(schema)}`;

  const request: CompletionRequest = {
    model: opts.model.model,
    effort: opts.model.effort,
    system: DECOMPOSER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    format: { schema },
    maxTokens: 8_000,
  };

  let raw = "";
  for await (const chunk of opts.provider.complete(request)) {
    if (chunk.type === "text") raw += chunk.text;
  }

  const plan = parsePlan(raw);
  validateDependencies(plan);

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
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DecomposerError(`le décomposeur n'a pas renvoyé du JSON valide : ${truncate(raw)}`);
  }
  const result = PlanSchema.safeParse(json);
  if (!result.success) {
    throw new DecomposerError(`plan non conforme au schéma : ${result.error.message}`);
  }
  return result.data;
}

/** Vérifie que chaque `dependsOn` référence un ID existant et qu'il n'y a pas de cycle. */
function validateDependencies(plan: Plan): void {
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new DecomposerError(`tâche ${task.id} dépend d'un ID inexistant : ${dep}`);
      }
      if (dep === task.id) {
        throw new DecomposerError(`tâche ${task.id} dépend d'elle-même`);
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
    if (s === "visiting") throw new DecomposerError(`cycle de dépendances détecté sur ${id}`);
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) visit(dep);
    state.set(id, "done");
  };

  for (const task of plan.tasks) visit(task.id);
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class DecomposerError extends Error {
  override readonly name = "DecomposerError";
}
