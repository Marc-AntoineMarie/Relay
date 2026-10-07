import { describe, expect, it } from "vitest";
import {
  decompose,
  DecomposerError,
  PlanSchema,
  planJsonSchema,
} from "../src/decomposer/index.js";
import type { CompletionRequest, ModelAssignment, Provider, ProjectContext } from "../src/types.js";

/** Provider mocké : renvoie le texte fourni, sans appel réseau. */
function mockProvider(responseText: string, capture?: (req: CompletionRequest) => void): Provider {
  return {
    name: "mock",
    billing: "per-token",
    async models() {
      return [];
    },
    estimateCost() {
      return 0;
    },
    async countTokens() {
      return 0;
    },
    async *complete(req: CompletionRequest) {
      capture?.(req);
      yield { type: "text", text: responseText };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 0 } };
    },
  };
}

const model: ModelAssignment = { provider: "mock", model: "mock-model", effort: "medium" };
const context: ProjectContext = { cwd: "/repo", stack: ["typescript"] };

const validPlan = JSON.stringify({
  analysis: "Ajout d'un module de recherche.",
  tasks: [
    {
      id: "1",
      type: "scaffold",
      tier: "quick",
      description: "Créer src/search/index.ts",
      dependsOn: [],
      expectedOutput: "Fichier créé",
    },
    {
      id: "2",
      type: "implement",
      tier: "build",
      description: "Implémenter la recherche full-text",
      dependsOn: ["1"],
      expectedOutput: "Code fonctionnel",
    },
  ],
});

describe("decompose", () => {
  it("construit un pipeline à partir d'un plan valide", async () => {
    const pipeline = await decompose({ prompt: "ajoute la recherche", context, provider: mockProvider(validPlan), model });

    expect(pipeline.tasks).toHaveLength(2);
    expect(pipeline.status).toBe("pending");
    expect(pipeline.prompt).toBe("ajoute la recherche");
    const [t1, t2] = pipeline.tasks;
    expect(t1?.id).toBe("1");
    expect(t1?.status).toBe("pending");
    expect(t1?.attempts).toEqual([]);
    expect(t2?.dependsOn).toEqual(["1"]);
    expect(t2?.tier).toBe("build");
  });

  it("transmet le schéma de sortie structurée au provider", async () => {
    let seen: CompletionRequest | undefined;
    await decompose({
      prompt: "x",
      context,
      provider: mockProvider(validPlan, (r) => (seen = r)),
      model,
    });
    expect(seen?.format?.schema).toBeDefined();
    expect(seen?.effort).toBe("medium");
  });

  it("rejette une réponse non-JSON", async () => {
    await expect(
      decompose({ prompt: "x", context, provider: mockProvider("pas du json"), model }),
    ).rejects.toBeInstanceOf(DecomposerError);
  });

  it("rejette une dépendance vers un ID inexistant", async () => {
    const bad = JSON.stringify({
      analysis: "a",
      tasks: [
        { id: "1", type: "scaffold", tier: "quick", description: "d", dependsOn: ["99"], expectedOutput: "o" },
      ],
    });
    await expect(
      decompose({ prompt: "x", context, provider: mockProvider(bad), model }),
    ).rejects.toThrow(/inexistant/);
  });

  it("détecte un cycle de dépendances", async () => {
    const cyclic = JSON.stringify({
      analysis: "a",
      tasks: [
        { id: "1", type: "implement", tier: "build", description: "d", dependsOn: ["2"], expectedOutput: "o" },
        { id: "2", type: "implement", tier: "build", description: "d", dependsOn: ["1"], expectedOutput: "o" },
      ],
    });
    await expect(
      decompose({ prompt: "x", context, provider: mockProvider(cyclic), model }),
    ).rejects.toThrow(/cycle/);
  });
});

describe("planJsonSchema", () => {
  it("produit un JSON Schema sans clé racine $schema", () => {
    const schema = planJsonSchema();
    expect(schema["$schema"]).toBeUndefined();
    expect(schema["type"]).toBe("object");
  });

  it("le schéma Zod refuse un tier inconnu", () => {
    const res = PlanSchema.safeParse({
      analysis: "a",
      tasks: [{ id: "1", type: "scaffold", tier: "escalate", description: "d", dependsOn: [], expectedOutput: "o" }],
    });
    expect(res.success).toBe(false);
  });
});
