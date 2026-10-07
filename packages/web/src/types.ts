export interface ProviderReadiness {
  name: string;
  label: string;
  billing: "per-token" | "subscription" | "free";
  ready: boolean;
  needsModelOverride: boolean;
  envKey?: string;
  keyUrl?: string;
}

export interface ModelEntry {
  id: string;
  provider: string;
  inputPerM: number;
  outputPerM: number;
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
}

export interface AppState {
  providers: ProviderReadiness[];
  models: ModelEntry[];
  routes: Record<string, { provider: string; model: string; effort?: string }> | null;
  decomposer: { provider: string; model: string } | null;
  defaultProvider: string;
}

export interface Task {
  id: string;
  type: string;
  tier: string;
  description: string;
  dependsOn: string[];
}

export interface TaskMetrics {
  billedCost: number;
  referenceCost: number;
  inputTokens: number;
  outputTokens: number;
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
  | { type: "backend"; name: string; billing: string }
  | { type: "decomposing" }
  | { type: "pipeline:start"; pipeline: { tasks: Task[] } }
  | { type: "pipeline:plan"; tasks: Task[] }
  | { type: "task:start"; taskId: string; model: string; effort?: string }
  | { type: "task:chunk"; taskId: string; text: string }
  | { type: "task:done"; taskId: string; result: { summary: string }; metrics: TaskMetrics }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "pipeline:done"; metrics: PipelineMetrics }
  | { type: "pipeline:failed"; error: string }
  | { type: "error"; error: string }
  | { type: "end" };

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskView {
  task: Task;
  status: TaskStatus;
  model?: string;
  summary?: string;
  cost?: number;
  billed?: number;
}
