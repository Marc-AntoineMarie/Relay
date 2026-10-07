import { describe, expect, it } from "vitest";
import { decompose, DecomposerError, extractJson } from "../src/decomposer/index.js";
import { cleanProviderMessage, describeError, kindFromStatus, ProviderRequestError } from "../src/errors.js";
import type { CompletionChunk, CompletionRequest, Provider } from "../src/types.js";

const plan = JSON.stringify({
  analysis: "a",
  tasks: [
    { id: 1, type: "scaffold", tier: "quick", description: "d", dependsOn: [], expectedOutput: "o" },
    { id: "2", type: "implement", tier: "build", description: "d", dependsOn: [1], expectedOutput: "o" },
  ],
});

/** Provider qui renvoie une réponse différente à chaque appel. */
function sequenceProvider(responses: CompletionChunk[][], seen: CompletionRequest[] = []): Provider {
  let i = 0;
  return {
    name: "mock",
    billing: "free",
    async models() {
      return [];
    },
    estimateCost: () => 0,
    countTokens: async () => 0,
    async *complete(req) {
      seen.push(structuredClone(req));
      const chunks = responses[Math.min(i++, responses.length - 1)] ?? [];
      for (const c of chunks) yield c;
    },
  };
}

const ctx = { cwd: "/repo" };
const model = { provider: "mock", model: "m" };

describe("extractJson", () => {
  it("retire un bloc ```json et le texte autour", () => {
    expect(extractJson('Voici :\n```json\n{"a":1}\n```\nfin')).toBe('{"a":1}');
  });
  it("isole l'objet au milieu d'un texte", () => {
    expect(extractJson('bla {"a":{"b":2}} bla')).toBe('{"a":{"b":2}}');
  });
});

describe("decompose — robustesse", () => {
  it("accepte des ids numériques et un JSON enrobé", async () => {
    const p = sequenceProvider([[{ type: "text", text: "```json\n" + plan + "\n```" }]]);
    const pipeline = await decompose({ prompt: "x", context: ctx, provider: p, model });
    expect(pipeline.tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(pipeline.tasks[1]?.dependsOn).toEqual(["1"]);
  });

  it("répare : relance avec l'erreur quand le premier JSON est invalide", async () => {
    const seen: CompletionRequest[] = [];
    const p = sequenceProvider([[{ type: "text", text: '{"analysis": "coupé' }], [{ type: "text", text: plan }]], seen);
    const pipeline = await decompose({ prompt: "x", context: ctx, provider: p, model });
    expect(pipeline.tasks).toHaveLength(2);
    expect(seen).toHaveLength(2);
    const last = seen[1]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toMatch(/inutilisable/);
  });

  it("troncature : relance avec un budget de tokens doublé", async () => {
    const seen: CompletionRequest[] = [];
    const p = sequenceProvider(
      [
        [{ type: "text", text: '{"analysis":' }, { type: "stop", reason: "length" }],
        [{ type: "text", text: plan }, { type: "stop", reason: "end" }],
      ],
      seen,
    );
    await decompose({ prompt: "x", context: ctx, provider: p, model });
    expect(seen[1]?.maxTokens).toBe((seen[0]?.maxTokens ?? 0) * 2);
  });

  it("abandonne après 3 tentatives avec une erreur typée", async () => {
    const p = sequenceProvider([[{ type: "text", text: "pas du json" }]]);
    await expect(decompose({ prompt: "x", context: ctx, provider: p, model })).rejects.toBeInstanceOf(DecomposerError);
  });
});

describe("erreurs normalisées", () => {
  it("classe les statuts HTTP", () => {
    expect(kindFromStatus(401)).toBe("auth");
    expect(kindFromStatus(404)).toBe("model_not_found");
    expect(kindFromStatus(429)).toBe("rate_limited");
    expect(kindFromStatus(503)).toBe("overloaded");
    expect(kindFromStatus(400)).toBe("bad_request");
  });

  it("extrait le message lisible d'une erreur fournisseur brute", () => {
    const raw = '404 [{"error":{"code":404,"message":"This model is no longer available.","status":"NOT_FOUND"}}]';
    expect(cleanProviderMessage(raw)).toBe("This model is no longer available.");
  });

  it("décrit une erreur provider avec titre, détail et conseil", () => {
    const d = describeError(new ProviderRequestError("overloaded", '503 {"message":"high demand"}', "gemini", "g-flash"));
    expect(d.title).toBe("Service saturé");
    expect(d.detail).toBe("gemini · g-flash — high demand");
    expect(d.hint).toBeDefined();
    expect(new ProviderRequestError("overloaded", "x", "p").retryable).toBe(true);
    expect(new ProviderRequestError("auth", "x", "p").retryable).toBe(false);
  });
});
