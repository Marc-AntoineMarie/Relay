export type Billing = "per-token" | "subscription" | "free";
export type Tier = "quick" | "build" | "deep";
export type TierModels = Record<Tier, string>;
export const TIERS: readonly Tier[] = ["quick", "build", "deep"];

export interface ProviderReadiness {
  name: string;
  label: string;
  billing: Billing;
  ready: boolean;
  needsModelOverride: boolean;
  envKey?: string;
  keyUrl?: string;
  tierModels?: TierModels;
  /** Fin de la clé enregistrée (« …KlvA ») — jamais la clé entière. */
  keyHint?: string;
}

export interface Settings {
  mode: Mode;
  strategy: Strategy;
  policies: Record<string, AccountPolicy>;
  budgetPerRun: number | null;
  synthesis: boolean;
  agentic: boolean;
  workspaceRoot: string;
  commandPolicy: CommandPolicy;
  askQuestions: boolean;
  globalMemory: string;
  projectMemory: boolean;
}

export interface MachineInfo {
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  ramTotalGb: number;
  ramAvailableGb: number;
  gpu: string | null;
  vramGb: number | null;
  diskFreeGb: number | null;
}

export interface OllamaServer {
  url: string;
  installed: boolean;
  binary: string | null;
  managed: boolean;
  startedByRelay: boolean;
  running: boolean;
  version: string | null;
  models: Array<{ name: string; sizeGb: number; parameters?: string; quantization?: string }>;
  loaded: string[];
}

export interface RemoteTarget {
  host?: string;
  user?: string;
  port?: number;
  keyPath?: string;
}

export interface OllamaInfo {
  machine: MachineInfo;
  verdict: string;
  local: OllamaServer;
  remote: OllamaServer | null;
  target: "local" | "remote";
  remoteTarget: RemoteTarget | null;
  tunnel: { running: boolean; error: string | null };
  url: string;
  suggestions: Array<{ name: string; sizeGb: number; tier: Tier; use: string; fit: "ok" | "tight" | "too_big" }>;
}

export interface PlanQuestion {
  question: string;
  options?: string[];
}

export interface ProjectInfo {
  name: string;
  root: string;
  updated: number;
  messages: number;
  last?: string;
}

export interface ConversationMessage {
  id: string;
  at: string;
  role: "user" | "relay";
  kind: "prompt" | "answer" | "fix" | "questions" | "result";
  text: string;
  analysis?: string;
  assumptions?: string[];
  questions?: PlanQuestion[];
  tasks?: Array<{ id: string; description: string; tier: Tier; status: string; model?: string; provider?: string }>;
  files?: string[];
  outcome?: "done" | "failed" | "stopped";
  cost?: { billed: number; reference: number; durationMs: number; tokens: number };
  error?: string;
}

export type CommandPolicy = "ask" | "safe" | "auto";

export interface WorkspaceFile {
  path: string;
  size: number;
}

export interface RunDir {
  name: string;
  root: string;
  modified: number;
}

/** Commande lancée (par un agent ou par toi) et son résultat. */
export interface CommandView {
  id: string;
  taskId?: string;
  command: string;
  running: boolean;
  exitCode?: number | null;
  output?: string;
  durationMs?: number;
  timedOut?: boolean;
  refused?: string;
  /** Lancée sans attendre (application graphique), suivie jusqu'à sa fermeture. */
  launched?: boolean;
  launchId?: string;
  by: "agent" | "toi";
}

/** Erreur rencontrée en testant, à faire corriger par Relay. */
export interface FixRequest {
  source: string;
  output: string;
  exitCode?: number | null;
  note?: string;
}

export interface LaunchState {
  id: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  output: string;
}

export interface ApprovalRequest {
  key: string;
  taskId: string;
  command: string;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface KeyTestResult {
  ok: boolean;
  detail?: string;
  error?: ErrorDescription;
  ms?: number;
}

export interface Synthesis {
  text: string;
  provider: string;
  model: string;
  metrics: TaskMetrics;
}

export interface AppState {
  providers: ProviderReadiness[];
  defaultProvider: string;
}

export interface ErrorDescription {
  kind: string;
  title: string;
  detail: string;
  hint?: string;
}

export interface ModelsResponse {
  models: string[];
  suggested: TierModels | null;
  error?: ErrorDescription;
}

export type Mode = "auto" | "manual";
export type Strategy = "economy" | "balanced" | "quality";
export type Capability = "code" | "reasoning" | "long_context" | "web" | "fast";

export interface AccountPolicy {
  enabled: boolean;
  levels?: Tier[];
  maxCallsPerRun?: number;
  disabledModels?: string[];
  extraModels?: string[];
}

export interface PoolModel {
  model: string;
  level: Tier;
  tags: Capability[];
  family: string;
  known: boolean;
  inputPerM: number;
  outputPerM: number;
  health?: string;
}

export interface PoolAccount {
  name: string;
  label: string;
  billing: Billing;
  models: PoolModel[];
  available: Array<PoolModel & { recommended: boolean; inPool: boolean }>;
  error?: ErrorDescription;
}

export interface PoolResponse {
  accounts: PoolAccount[];
  defaultPolicies: Record<string, AccountPolicy>;
}

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  category: "plan" | "route" | "request" | "response" | "fallback" | "tool" | "error" | "info";
  taskId?: string;
  title: string;
  detail?: string;
}

export interface RouteAlternative {
  provider: string;
  model: string;
  reason: string;
}

export interface Task {
  id: string;
  type: string;
  tier: Tier;
  needs?: Capability[];
  description: string;
  dependsOn: string[];
  spec?: string;
}

export interface TaskMetrics {
  model: string;
  provider: string;
  fallbackFrom?: string;
  billedCost: number;
  referenceCost: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  escalated?: boolean;
}

export interface PipelineMetrics {
  totalBilledCost: number;
  totalReferenceCost: number;
  baselineCost: number;
  savings: number;
  totalTokens: number;
  totalDurationMs: number;
  taskCount: number;
  successCount: number;
  overheadReferenceCost: number;
}

export type ServerEvent =
  | { type: "mode"; mode: Mode; strategy?: Strategy; accounts: string[]; poolSize?: number }
  | { type: "decomposing"; provider?: string; model?: string }
  | { type: "routes"; routes: Record<string, { model: string; effort?: string }> }
  | { type: "log"; entry: LogEntry }
  | { type: "pipeline:start" }
  | { type: "pipeline:plan"; tasks: Task[] }
  | {
      type: "task:route";
      taskId: string;
      provider: string;
      model: string;
      effort?: string;
      reason: string;
      alternatives: RouteAlternative[];
    }
  | { type: "task:start"; taskId: string; model: string; provider?: string; effort?: string; reason?: string }
  | { type: "task:chunk"; taskId: string; text: string }
  | {
      type: "task:done";
      taskId: string;
      result: {
        summary: string;
        data?: {
          result?: string;
          truncated?: boolean;
          files?: string[];
          commands?: Array<{ command: string; exitCode: number | null }>;
          checksFailed?: boolean;
        };
      };
      metrics: TaskMetrics;
    }
  | { type: "task:failed"; taskId: string; error: string; description?: ErrorDescription }
  | {
      type: "task:escalate";
      taskId: string;
      from: { provider?: string; model: string };
      to: { provider?: string; model: string };
      reason: string;
    }
  | { type: "workspace"; root: string; name?: string; policy: CommandPolicy; round?: number }
  | { type: "questions"; questions: PlanQuestion[]; analysis: string }
  | { type: "memory"; root: string }
  | { type: "file:write"; taskId: string; path: string; bytes: number; created: boolean }
  | { type: "command:start"; taskId: string; id: string; command: string }
  | {
      type: "command:done";
      taskId: string;
      id: string;
      command: string;
      exitCode: number | null;
      output: string;
      durationMs: number;
      timedOut: boolean;
      refused?: string;
    }
  | { type: "approval:request"; key: string; taskId: string; id: string; command: string }
  | { type: "approval:done"; key: string; ok: boolean }
  | { type: "pipeline:synthesis"; text: string; provider: string; model: string; metrics: TaskMetrics }
  | { type: "pipeline:done"; metrics: PipelineMetrics }
  | { type: "pipeline:failed"; error: string; description?: ErrorDescription }
  | { type: "error"; error: ErrorDescription }
  | { type: "end" };

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskView {
  task: Task;
  status: TaskStatus;
  output: string;
  provider?: string;
  reason?: string;
  alternatives?: RouteAlternative[];
  model?: string;
  fallbackFrom?: string;
  summary?: string;
  metrics?: TaskMetrics;
  error?: string;
  truncated?: boolean;
  /** Phase D : fichiers écrits et commandes lancées par la tâche. */
  files?: string[];
  commands?: Array<{ command: string; exitCode: number | null }>;
  checksFailed?: boolean;
  escalatedFrom?: string;
  /** Nœud « erreur rencontrée en testant » (pas une tâche du moteur). */
  userError?: FixRequest;
}

export type Phase = "idle" | "planning" | "running" | "done" | "failed" | "stopped";
