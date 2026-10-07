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

export interface Task {
  id: string;
  type: string;
  tier: Tier;
  description: string;
  dependsOn: string[];
}

export interface TaskMetrics {
  model: string;
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
}

export type ServerEvent =
  | { type: "backend"; name: string; billing: Billing }
  | { type: "decomposing" }
  | { type: "routes"; routes: Record<string, { model: string; effort?: string }> }
  | { type: "pipeline:start" }
  | { type: "pipeline:plan"; tasks: Task[] }
  | { type: "task:start"; taskId: string; model: string; effort?: string }
  | { type: "task:chunk"; taskId: string; text: string }
  | {
      type: "task:done";
      taskId: string;
      result: { summary: string; data?: { result?: string; truncated?: boolean } };
      metrics: TaskMetrics;
    }
  | { type: "task:failed"; taskId: string; error: string; description?: ErrorDescription }
  | { type: "pipeline:done"; metrics: PipelineMetrics }
  | { type: "pipeline:failed"; error: string; description?: ErrorDescription }
  | { type: "error"; error: ErrorDescription }
  | { type: "end" };

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskView {
  task: Task;
  status: TaskStatus;
  output: string;
  model?: string;
  fallbackFrom?: string;
  summary?: string;
  metrics?: TaskMetrics;
  error?: string;
  truncated?: boolean;
}

export type Phase = "idle" | "planning" | "running" | "done" | "failed" | "stopped";
