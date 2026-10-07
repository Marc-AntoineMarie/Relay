import { describe, expect, it } from "vitest";
import { decompose } from "../src/decomposer/index.js";
import { ProviderRequestError } from "../src/errors.js";
import { execute } from "../src/executor/index.js";
import { AutoRouter, autoRouting, type PoolEntry } from "../src/router/auto.js";
import type { Pipeline, PipelineEvent, Provider } from "../src/types.js";

const PLAN = JSON.stringify({
  analysis: "a",
  tasks: [{ id: "1", type: "implement", tier: "build", description: "d", dependsOn: [], expectedOutput: "o" }],
});

function provider(name: string, opts: { billing?: Provider["billing"]; fail?: boolean; text?: string } = {}): Provider {
  return {
    name,
    billing: opts.billing ?? "free",
    async models() {
      return [];
    },
    estimateCost: () => 0,
    countTokens: async () => 0,
    async *complete(req) {
      if (opts.fail) throw new ProviderRequestError("overloaded", "503", name, req.model);
      yield { type: "text", text: opts.text ?? `réponse de ${name}` };
      yield { type: "usage", usage: { inputTokens: 1_000, outputTokens: 500 } };
    },
  };
}

const pipelineOf = (): Pipeline => ({
  id: "p",
  prompt: "fais-le",
  context: { cwd: "/" },
  tasks: [{ id: "1", type: "implement", description: "d", tier: "build", dependsOn: [], status: "pending", attempts: [] }],
  status: "pending",
  created: new Date(),
});

async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("AutoRouter — budget et modèles retirés", () => {
  const pool: PoolEntry[] = [
    { provider: "deepseek", model: "deepseek-chat", billing: "per-token" },
    { provider: "groq", model: "llama-3.3-70b-versatile", billing: "free" },
  ];

  it("un modèle retiré du pool par le compte n'est plus proposé", () => {
    const r = new AutoRouter(pool, { strategy: "quality", policies: { groq: { enabled: true, disabledModels: ["llama-3.3-70b-versatile"] } } });
    expect(r.rank({ tier: "build" }).map((c) => c.provider)).toEqual(["deepseek"]);
  });

  it("budget atteint : plus de comptes à l'usage, le gratuit reste", () => {
    const r = new AutoRouter(pool, { strategy: "quality", budget: 0.01 });
    expect(r.rank({ tier: "build" }).some((c) => c.provider === "deepseek")).toBe(true);
    r.spend(0.02);
    expect(r.rank({ tier: "build" }).map((c) => c.provider)).toEqual(["groq"]);
  });
});

describe("coûts d'orchestration et synthèse", () => {
  it("le plan compte ses tokens (relances comprises)", async () => {
    let calls = 0;
    const p: Provider = {
      ...provider("m"),
      async *complete() {
        calls++;
        yield { type: "text", text: calls === 1 ? "pas du json" : PLAN };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } };
      },
    };
    const pipeline = await decompose({ prompt: "x", context: { cwd: "/" }, provider: p, model: { provider: "m", model: "gemini-flash-latest" } });
    expect(pipeline.planning).toMatchObject({ taskId: "plan", inputTokens: 200, outputTokens: 100, billedCost: 0 });
    expect(pipeline.planning?.referenceCost).toBeGreaterThan(0);
  });

  it("la synthèse produit le livrable et son coût entre dans les totaux, pas dans les tâches", async () => {
    const pipeline = pipelineOf();
    pipeline.planning = {
      taskId: "plan", model: "gemini-flash-latest", provider: "gemini", tier: "build",
      inputTokens: 1_000, outputTokens: 500, thinkingTokens: 0, referenceCost: 0.01, billedCost: 0,
      durationMs: 10, success: true, escalated: false,
    };
    const router = new AutoRouter([{ provider: "gemini", model: "gemini-flash-latest", billing: "free" }], { strategy: "economy" });
    const events = await collect(
      execute({ pipeline, routing: autoRouting(router, () => provider("gemini", { text: "LIVRABLE" })), synthesis: true }),
    );

    const synth = events.find((e) => e.type === "pipeline:synthesis");
    expect(synth?.type === "pipeline:synthesis" && synth.text).toBe("LIVRABLE");
    const done = events.at(-1);
    if (done?.type !== "pipeline:done") throw new Error("pipeline non terminé");
    expect(done.metrics.taskCount).toBe(1);
    expect(done.metrics.totalTokens).toBe(4_500); // tâche + plan + synthèse
    expect(done.metrics.overheadReferenceCost).toBeGreaterThan(0.01);
  });

  it("une synthèse qui échoue ne fait pas échouer un pipeline réussi", async () => {
    let n = 0;
    const flaky: Provider = {
      ...provider("gemini"),
      async *complete(req) {
        n++;
        if (n > 1) throw new ProviderRequestError("overloaded", "503", "gemini", req.model);
        yield { type: "text", text: "ok" };
      },
    };
    const router = new AutoRouter([{ provider: "gemini", model: "gemini-flash-latest", billing: "free" }], { strategy: "economy" });
    const events = await collect(execute({ pipeline: pipelineOf(), routing: autoRouting(router, () => flaky), synthesis: true }));
    expect(events.some((e) => e.type === "pipeline:synthesis")).toBe(false);
    expect(events.at(-1)?.type).toBe("pipeline:done");
  });
});
