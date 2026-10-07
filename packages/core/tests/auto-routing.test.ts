import { describe, expect, it } from "vitest";
import { profileModel, referenceCost } from "../src/catalog.js";
import { decompose } from "../src/decomposer/index.js";
import { ProviderRequestError } from "../src/errors.js";
import { execute } from "../src/executor/index.js";
import { AutoRouter, autoRouting, type PoolEntry } from "../src/router/auto.js";
import { HealthTracker } from "../src/router/health.js";
import type { Pipeline, PipelineEvent, Provider, Task } from "../src/types.js";

const POOL: PoolEntry[] = [
  { provider: "gemini", model: "gemini-flash-lite-latest", billing: "free" },
  { provider: "gemini", model: "gemini-flash-latest", billing: "free" },
  { provider: "gemini", model: "gemini-pro-latest", billing: "free" },
  { provider: "groq", model: "llama-3.3-70b-versatile", billing: "free" },
  { provider: "claude-code", model: "claude-opus-5-5", billing: "subscription" },
  { provider: "anthropic", model: "claude-sonnet-5-5", billing: "per-token" },
];

const top = (r: AutoRouter, tier: Task["tier"], needs?: Task["needs"]): string => {
  const c = r.rank({ tier, ...(needs ? { needs } : {}) })[0];
  return c ? `${c.provider}/${c.model}` : "aucun";
};

describe("catalogue", () => {
  it("profile les familles connues et devine les inconnues", () => {
    expect(profileModel("gemini-flash-lite-latest")).toMatchObject({ level: "quick", known: true });
    expect(profileModel("claude-opus-5-5")).toMatchObject({ level: "deep", inputPerM: 4, outputPerM: 20 });
    expect(profileModel("mystere-pro-9000")).toMatchObject({ level: "deep", known: false });
  });
  it("calcule un coût de référence pour tout modèle connu", () => {
    expect(referenceCost("gemini-flash-latest", 1_000_000, 1_000_000)).toBeCloseTo(2.8, 6);
  });
});

describe("AutoRouter", () => {
  it("économie : le gratuit le plus juste pour chaque niveau", () => {
    const r = new AutoRouter(POOL, { strategy: "economy" });
    expect(top(r, "quick")).toBe("gemini/gemini-flash-lite-latest");
    expect(top(r, "deep")).toBe("gemini/gemini-pro-latest");
  });

  it("qualité : le meilleur modèle du niveau, même sur abonnement", () => {
    const r = new AutoRouter(POOL, { strategy: "quality" });
    expect(top(r, "deep")).toBe("claude-code/claude-opus-5-5");
  });

  it("ne sous-dimensionne jamais : une tâche deep n'a que des modèles deep", () => {
    const r = new AutoRouter(POOL, { strategy: "economy" });
    for (const c of r.rank({ tier: "deep" })) expect(profileModel(c.model).level).toBe("deep");
  });

  it("respecte les plafonds : compte désactivé, niveaux autorisés, appels max", () => {
    const r = new AutoRouter(POOL, {
      strategy: "quality",
      policies: {
        "claude-code": { enabled: true, levels: ["deep"], maxCallsPerRun: 1 },
        anthropic: { enabled: false },
      },
    });
    expect(r.rank({ tier: "build" }).some((c) => c.provider === "claude-code" || c.provider === "anthropic")).toBe(false);
    expect(top(r, "deep")).toBe("claude-code/claude-opus-5-5");
    r.consume("claude-code");
    expect(top(r, "deep")).toBe("gemini/gemini-pro-latest");
  });

  it("évite un modèle saturé récemment et écarte un modèle retiré", () => {
    const health = new HealthTracker();
    const r = new AutoRouter(POOL, { strategy: "economy", health });
    health.reportFailure("gemini", "gemini-flash-lite-latest", "overloaded");
    expect(top(r, "quick")).not.toBe("gemini/gemini-flash-lite-latest");
    health.reportFailure("gemini", "gemini-pro-latest", "model_not_found");
    expect(r.rank({ tier: "deep" }).some((c) => c.model === "gemini-pro-latest")).toBe(false);
  });

  it("une tâche « web » sans modèle web n'a aucun candidat", () => {
    expect(new AutoRouter(POOL, { strategy: "economy" }).rank({ tier: "build", needs: ["web"] })).toEqual([]);
  });

  it("explique le choix", () => {
    const c = new AutoRouter(POOL, { strategy: "economy" }).rank({ tier: "build", needs: ["code"] })[0];
    expect(c?.reason).toMatch(/gratuit/);
    expect(c?.reason).toMatch(/code ✓/);
  });
});

function fakeProvider(name: string, behavior: "ok" | "overloaded"): Provider {
  return {
    name,
    billing: "free",
    async models() {
      return [];
    },
    estimateCost: () => 0,
    countTokens: async () => 0,
    async *complete(req) {
      if (behavior === "overloaded") throw new ProviderRequestError("overloaded", "503 saturé", name, req.model);
      yield { type: "text", text: `fait par ${name}` };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

describe("exécution en mode automatique", () => {
  it("repli entre fournisseurs quand le premier choix est saturé, et journalise", async () => {
    const health = new HealthTracker();
    const router = new AutoRouter(
      [
        { provider: "gemini", model: "gemini-flash-latest", billing: "free" },
        { provider: "groq", model: "llama-3.3-70b-versatile", billing: "free" },
      ],
      { strategy: "economy", health },
    );
    const providers: Record<string, Provider> = { gemini: fakeProvider("gemini", "overloaded"), groq: fakeProvider("groq", "ok") };
    const pipeline: Pipeline = {
      id: "p",
      prompt: "x",
      context: { cwd: "/" },
      tasks: [{ id: "1", type: "implement", description: "d", tier: "build", dependsOn: [], status: "pending", attempts: [] }],
      status: "pending",
      created: new Date(),
    };

    const events: PipelineEvent[] = [];
    for await (const e of execute({ pipeline, routing: autoRouting(router, (n) => providers[n] as Provider, health) })) events.push(e);

    const done = events.find((e) => e.type === "task:done");
    expect(done?.type === "task:done" && done.metrics.provider).toBe("groq");
    expect(done?.type === "task:done" && done.metrics.fallbackFrom).toBe("gemini · gemini-flash-latest");
    expect(events.some((e) => e.type === "log" && e.entry.category === "fallback")).toBe(true);
    expect(health.status("gemini", "gemini-flash-latest")).toBe("overloaded");
    expect(events.at(-1)?.type).toBe("pipeline:done");
  });
});

describe("décomposeur — besoins", () => {
  it("garde les besoins connus et ignore les autres", async () => {
    const plan = {
      analysis: "a",
      tasks: [{ id: "1", type: "implement", tier: "build", description: "d", dependsOn: [], expectedOutput: "o", needs: ["code", "magie", "code"] }],
    };
    const provider: Provider = {
      ...fakeProvider("m", "ok"),
      async *complete() {
        yield { type: "text", text: JSON.stringify(plan) };
      },
    };
    const pipeline = await decompose({ prompt: "x", context: { cwd: "/" }, provider, model: { provider: "m", model: "m" } });
    expect(pipeline.tasks[0]?.needs).toEqual(["code"]);
  });
});
