import { describe, expect, it } from "vitest";
import { execute } from "../src/executor/index.js";
import { computePipelineMetrics } from "../src/metrics/index.js";
import { defaultRegistry } from "../src/registry.js";
import { Router } from "../src/router/index.js";
import type { Pipeline, PipelineEvent, Provider, RelayConfig, Task, TaskMetrics } from "../src/types.js";

function config(): RelayConfig {
  return {
    routes: {
      quick: { provider: "anthropic", model: "claude-haiku-4-5" },
      build: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
      deep: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      escalate: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
    },
    providers: { anthropic: {} },
    escalation: { maxRetries: 1, effortFirst: true },
    decomposer: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
  };
}

function okProvider(): Provider {
  return {
    name: "anthropic",
    async models() {
      return [];
    },
    estimateCost(m, i, o) {
      return defaultRegistry.estimateCost(m, i, o);
    },
    async countTokens() {
      return 0;
    },
    async *complete(req) {
      yield { type: "text", text: `Résumé de ${req.model}.\nDétails.` };
      yield { type: "usage", usage: { inputTokens: 1000, outputTokens: 500, thinkingTokens: 0 } };
    },
  };
}

function task(id: string, tier: Task["tier"], dependsOn: string[] = []): Task {
  return { id, type: "implement", description: `tâche ${id}`, tier, dependsOn, status: "pending", attempts: [] };
}

function pipeline(tasks: Task[]): Pipeline {
  return { id: "p1", prompt: "fais le travail", context: { cwd: "/repo" }, tasks, status: "pending", created: new Date() };
}

async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("execute", () => {
  it("exécute les tâches en ordre topologique et termine le pipeline", async () => {
    const p = pipeline([task("2", "build", ["1"]), task("1", "quick")]);
    const events = await collect(execute({ pipeline: p, provider: okProvider(), router: new Router(config()) }));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("pipeline:start");
    expect(types[1]).toBe("pipeline:plan");
    expect(types.at(-1)).toBe("pipeline:done");

    // Tâche 1 (dépendance) terminée avant le démarrage de la tâche 2.
    const done1 = types.indexOf("task:done");
    const starts = events.filter((e) => e.type === "task:start").map((e) => (e as { taskId: string }).taskId);
    expect(starts).toEqual(["1", "2"]);
    expect(done1).toBeGreaterThan(-1);

    expect(p.status).toBe("done");
    expect(p.tasks.every((t) => t.status === "done")).toBe(true);
  });

  it("assigne les modèles par tier et calcule des métriques avec économies", async () => {
    const p = pipeline([task("1", "quick"), task("2", "build")]);
    const events = await collect(execute({ pipeline: p, provider: okProvider(), router: new Router(config()) }));

    const done = events.at(-1);
    expect(done?.type).toBe("pipeline:done");
    if (done?.type !== "pipeline:done") throw new Error("inattendu");

    expect(done.metrics.taskCount).toBe(2);
    expect(done.metrics.successCount).toBe(2);
    expect(done.metrics.totalCost).toBeGreaterThan(0);
    // Baseline = tout sur Opus (deep) ⇒ plus cher que Haiku+Sonnet ⇒ économies > 0.
    expect(done.metrics.baselineCost).toBeGreaterThan(done.metrics.totalCost);
    expect(done.metrics.savings).toBeGreaterThan(0);

    expect(p.tasks[0]?.assignedModel).toBe("claude-haiku-4-5");
    expect(p.tasks[1]?.assignedModel).toBe("claude-sonnet-5-5");
  });

  it("émet task:failed puis pipeline:failed quand un worker échoue", async () => {
    const boom: Provider = {
      ...okProvider(),
      async *complete() {
        throw new Error("boom");
        yield { type: "text", text: "" }; // inatteignable
      },
    };
    const p = pipeline([task("1", "quick")]);
    const events = await collect(execute({ pipeline: p, provider: boom, router: new Router(config()) }));

    const types = events.map((e) => e.type);
    expect(types).toContain("task:failed");
    expect(types.at(-1)).toBe("pipeline:failed");
    expect(p.status).toBe("failed");
  });
});

describe("computePipelineMetrics", () => {
  it("additionne coûts/tokens et calcule la baseline + économies", () => {
    const tm: TaskMetrics[] = [
      { taskId: "1", model: "claude-haiku-4-5", provider: "anthropic", tier: "quick", inputTokens: 1_000_000, outputTokens: 1_000_000, thinkingTokens: 0, cost: 6, durationMs: 10, success: true, escalated: false },
    ];
    const m = computePipelineMetrics({ pipelineId: "p", taskMetrics: tm, baselineModel: "claude-opus-5-5" });
    expect(m.totalCost).toBe(6);
    expect(m.totalTokens).toBe(2_000_000);
    // Baseline Opus : 1M×4 + 1M×20 = 24 $.
    expect(m.baselineCost).toBeCloseTo(24, 6);
    expect(m.savings).toBeCloseTo(((24 - 6) / 24) * 100, 6);
  });

  it("renvoie 0 d'économies si la baseline est nulle", () => {
    const m = computePipelineMetrics({ pipelineId: "p", taskMetrics: [], baselineModel: "inconnu" });
    expect(m.savings).toBe(0);
    expect(m.taskCount).toBe(0);
  });
});
