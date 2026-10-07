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
  category: "plan" | "route" | "request" | "response" | "fallback" | "error" | "info";
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
      result: { summary: string; data?: { result?: string; truncated?: boolean } };
      metrics: TaskMetrics;
    }
  | { type: "task:failed"; taskId: string; error: string; description?: ErrorDescription }
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
}

export type Phase = "idle" | "planning" | "running" | "done" | "failed" | "stopped";
