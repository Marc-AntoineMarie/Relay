import { describe, expect, it } from "vitest";
import { decompose, DecomposerError } from "../src/decomposer/index.js";
import { cleanMemory, clipMemory, memoryPrompt } from "../src/memory/index.js";
import type { CompletionRequest, ModelAssignment, Provider } from "../src/types.js";

function replies(texts: string[], seen: CompletionRequest[] = []): Provider {
  let i = 0;
  return {
    name: "mock",
    billing: "free",
    async models() {
      return [];
    },
    estimateCost: () => 0,
    async countTokens() {
      return 0;
    },
    async *complete(req) {
      seen.push(req);
      yield { type: "text", text: texts[Math.min(i++, texts.length - 1)] ?? "" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10, thinkingTokens: 0 } };
    },
  };
}

const model: ModelAssignment = { provider: "mock", model: "m" };
const questions = JSON.stringify({
  analysis: "Une « appli » sans précision.",
  questions: [{ question: "Quel type d'application ?", options: ["page web", "ligne de commande"] }],
  tasks: [],
});
const task = { id: "1", type: "implement", tier: "build", description: "Faire", dependsOn: [], expectedOutput: "x" };

describe("questions de cadrage", () => {
  it("demande floue : le plan revient avec des questions et sans tâche", async () => {
    const p = await decompose({ prompt: "fais une appli", context: { cwd: "/p" }, provider: replies([questions]), model });
    expect(p.tasks).toEqual([]);
    expect(p.questions).toEqual([{ question: "Quel type d'application ?", options: ["page web", "ligne de commande"] }]);
    expect(p.analysis).toBe("Une « appli » sans précision.");
  });

  it("questions désactivées : on exige un plan, avec hypothèses", async () => {
    const seen: CompletionRequest[] = [];
    const plan = JSON.stringify({ analysis: "ok", assumptions: ["page web"], tasks: [task] });
    const p = await decompose({ prompt: "fais une appli", context: { cwd: "/p" }, provider: replies([questions, plan], seen), model, allowQuestions: false });
    expect(seen[0]?.messages[0]?.content).toContain("Ne pose aucune question");
    expect(p.tasks).toHaveLength(1);
    expect(p.assumptions).toEqual(["page web"]);
    expect(p.questions).toBeUndefined();
  });

  it("le plan donne la commande de lancement (vérifiée par Relay en fin de run)", async () => {
    const plan = JSON.stringify({ analysis: "ok", launch: "python3 main.py", tasks: [task] });
    const p = await decompose({ prompt: "x", context: { cwd: "/p" }, provider: replies([plan]), model });
    expect(p.launch).toBe("python3 main.py");
  });

  it("plan vide sans question : rejeté", async () => {
    const empty = JSON.stringify({ analysis: "?", tasks: [] });
    await expect(decompose({ prompt: "x", context: { cwd: "/p" }, provider: replies([empty]), model })).rejects.toBeInstanceOf(DecomposerError);
  });
});

describe("mémoire de projet", () => {
  it("prompt complet, nettoyage et bornage", () => {
    const prompt = memoryPrompt({ projectName: "calculatrice", current: "", turn: "Tour 1 : créée", files: ["calc.py"] });
    expect(prompt).toContain("# calculatrice");
    expect(prompt).toContain("(vide : premier tour)");
    expect(cleanMemory("```markdown\n# calculatrice\n## Objectif\n```")).toBe("# calculatrice\n## Objectif\n");
    expect(clipMemory("x".repeat(10), 4)).toBe("xxxx\n[…mémoire tronquée]");
  });
});

describe("routage attentif à la latence", () => {
  it("un modèle observé lent (file d'attente) passe après un modèle réactif", async () => {
    const { AutoRouter } = await import("../src/router/auto.js");
    const { HealthTracker } = await import("../src/router/health.js");
    const health = new HealthTracker();
    const pool = [
      { provider: "nvidia", model: "deepseek-ai/deepseek-v4.1-flash", billing: "free" as const },
      { provider: "nvidia", model: "z-ai/glm-5.3-flash", billing: "free" as const },
    ];
    const router = new AutoRouter(pool, { strategy: "balanced", health });
    health.reportLatency("nvidia", "deepseek-ai/deepseek-v4.1-flash", 114_000);
    health.reportLatency("nvidia", "z-ai/glm-5.3-flash", 2_000);
    const ranked = router.rank({ tier: "build" });
    expect(ranked[0]?.model).toBe("z-ai/glm-5.3-flash");
    expect(ranked.find((c) => c.model.includes("deepseek"))?.reason).toContain("1re réponse ~114 s");
  });
});
