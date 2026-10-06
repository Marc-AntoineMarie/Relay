/**
 * Types partagés de Relay — le contrat entre tous les composants.
 *
 * Fidèle à docs/ARCHITECTURE.md, avec les ajustements actés en v0.1 :
 *   - `effort` est optionnel : Haiku 4.5 ne l'accepte pas (ne rien envoyer).
 *   - le type de tâche `clarify` est inclus (demande de précisions si prompt vague).
 *   - `CompletionChunk` est une union discriminée (typage plus sûr que des champs optionnels).
 *
 * Les schémas Zod de validation (sortie du décomposeur, résultats de tâches) vivent
 * avec les composants qui franchissent la frontière LLM (décomposeur, étape 4).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Routage & effort
// ─────────────────────────────────────────────────────────────────────────────

/** Niveaux d'effort (`output_config.effort`). Absent ⇒ réglage par défaut du modèle. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Tiers de routage. `escalate` n'est pas assigné par le décomposeur mais à l'échec. */
export type RouteTier = "quick" | "build" | "deep";

/** Type de travail d'une tâche, utilisé pour router et pour choisir les vérifications. */
export type TaskType =
  | "scaffold" // créer des fichiers ou dossiers
  | "architecture" // concevoir, planifier, décider une structure
  | "implement" // écrire du code fonctionnel
  | "test" // écrire les tests
  | "verify" // exécuter tests / lint / type checker
  | "review" // relire et valider le résultat global
  | "format" // reformatter, renommer
  | "document" // écrire ou mettre à jour la documentation
  | "clarify"; // demander des précisions quand la demande est trop vague

export type TaskStatus = "pending" | "running" | "done" | "failed" | "escalated";

export type PipelineStatus = "pending" | "running" | "done" | "failed";

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline & tâches
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectContext {
  cwd: string;
  /** Fichiers pertinents détectés ou fournis. */
  files?: string[];
  /** Langages, frameworks détectés. */
  stack?: string[];
  /** Extrait du CLAUDE.md ou équivalent. */
  conventions?: string;
}

/** Entrée ou sortie d'une tâche — résumé lisible + fichiers touchés + données libres. */
export interface TaskIO {
  summary: string;
  files?: string[];
  data?: Record<string, unknown>;
}

export interface Task {
  id: string;
  type: TaskType;
  description: string;
  tier: RouteTier;
  /** IDs des tâches prérequises. Sans dépendance mutuelle ⇒ parallélisables (v0.2). */
  dependsOn: string[];
  /** Assemblée par l'exécuteur à partir des sorties des dépendances. */
  input?: TaskIO;
  output?: TaskIO;
  status: TaskStatus;
  assignedModel?: string;
  assignedEffort?: Effort;
  attempts: TaskAttempt[];
  /** Sortie attendue, telle que décrite par le décomposeur. */
  expectedOutput?: string;
}

export interface TaskAttempt {
  model: string;
  effort?: Effort;
  success: boolean;
  metrics: TaskMetrics;
  result?: string;
  error?: string;
}

export interface Pipeline {
  id: string;
  prompt: string;
  context: ProjectContext;
  tasks: Task[];
  status: PipelineStatus;
  metrics?: PipelineMetrics;
  created: Date;
  finished?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (miroir de relay.config.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelAssignment {
  provider: string;
  model: string;
  /** Omis pour les modèles qui ne supportent pas l'effort (ex. Haiku 4.5). */
  effort?: Effort;
  maxRetries?: number;
}

export interface RouteConfig {
  quick: ModelAssignment;
  build: ModelAssignment;
  deep: ModelAssignment;
  escalate: ModelAssignment;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface EscalationConfig {
  maxRetries: number;
  /** true ⇒ on monte d'abord l'effort, puis seulement on change de modèle. */
  effortFirst: boolean;
}

export interface RelayConfig {
  routes: RouteConfig;
  providers: Record<string, ProviderConfig>;
  escalation: EscalationConfig;
  decomposer: ModelAssignment;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fournisseur (abstraction des API LLM)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema des paramètres. */
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  /** Piloté par le routeur ; ignoré pour les modèles sans effort. */
  effort?: Effort;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
}

/** Fragment de streaming émis par un provider. */
export type CompletionChunk =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUse: { name: string; input: unknown } }
  | { type: "usage"; usage: Usage };

export interface Provider {
  name: string;
  models(): Promise<ModelInfo[]>;
  complete(request: CompletionRequest): AsyncIterable<CompletionChunk>;
  estimateCost(model: string, inputTokens: number, outputTokens: number): number;
  countTokens(request: CompletionRequest): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Événements (streamés par le moniteur à toutes les interfaces)
// ─────────────────────────────────────────────────────────────────────────────

export type PipelineEvent =
  | { type: "pipeline:start"; pipeline: Pipeline }
  | { type: "pipeline:plan"; pipeline: Pipeline; tasks: Task[] }
  | { type: "task:start"; taskId: string; model: string; effort?: Effort }
  | { type: "task:chunk"; taskId: string; text: string }
  | { type: "task:done"; taskId: string; result: TaskIO; metrics: TaskMetrics }
  | { type: "task:failed"; taskId: string; error: string; metrics: TaskMetrics }
  | {
      type: "task:escalate";
      taskId: string;
      from: ModelAssignment;
      to: ModelAssignment;
      reason: string;
    }
  | { type: "pipeline:done"; pipeline: Pipeline; metrics: PipelineMetrics }
  | { type: "pipeline:failed"; pipeline: Pipeline; error: string };

export type PipelineEventType = PipelineEvent["type"];

// ─────────────────────────────────────────────────────────────────────────────
// Métriques
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskMetrics {
  taskId: string;
  model: string;
  provider: string;
  effort?: Effort;
  tier: RouteTier;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cost: number;
  durationMs: number;
  success: boolean;
  escalated: boolean;
}

export interface PipelineMetrics {
  pipelineId: string;
  totalCost: number;
  totalTokens: number;
  totalDurationMs: number;
  taskCount: number;
  successCount: number;
  escalationCount: number;
  /**
   * Coût de référence pour calculer les économies.
   *
   * NB (décision ouverte, voir étape métriques) : définir honnêtement cette baseline.
   * « tout sur deep/Opus » gonfle les économies ; la comparaison honnête est plutôt
   * « un seul appel Opus sur le prompt entier » vs le coût réel du pipeline.
   */
  baselineCost: number;
  /** Économie en pourcentage vs `baselineCost`. */
  savings: number;
  costPerTask: TaskMetrics[];
}
