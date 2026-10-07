import { describe, expect, it } from "vitest";
import type { CompletionChunk } from "@relay/core";
import { ProviderRequestError } from "@relay/core";
import { buildChatParams, filterChatModels, OpenAICompatibleProvider, suggestTierModels } from "../src/index.js";

const GEMINI = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-flash-image",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-pro-latest",
  "nano-banana-pro-preview",
  "text-embedding-004",
];

describe("filterChatModels", () => {
  it("retire voix/image/embeddings et met les alias latest en tête", () => {
    const out = filterChatModels(GEMINI);
    expect(out).not.toContain("gemini-2.5-flash-preview-tts");
    expect(out).not.toContain("gemini-2.5-flash-image");
    expect(out).not.toContain("nano-banana-pro-preview");
    expect(out).not.toContain("text-embedding-004");
    expect(out.slice(0, 3).every((m) => m.includes("latest"))).toBe(true);
  });
});

describe("suggestTierModels", () => {
  it("utilise les recommandations du preset quand elles sont disponibles", () => {
    expect(suggestTierModels("gemini", filterChatModels(GEMINI))).toEqual({
      quick: "gemini-flash-lite-latest",
      build: "gemini-flash-latest",
      deep: "gemini-pro-latest",
    });
  });

  it("devine d'après les noms quand le preset ne connaît pas les modèles", () => {
    const s = suggestTierModels("ollama", ["qwen2.5-coder:7b", "llama3.1:70b", "phi3:mini"]);
    expect(s?.quick).toBe("phi3:mini");
    expect(s?.deep).toBe("llama3.1:70b");
  });

  it("retombe sur le preset si la détection a échoué", () => {
    expect(suggestTierModels("gemini", [])?.build).toBe("gemini-flash-latest");
  });
});

describe("buildChatParams — effort", () => {
  const req = { model: "m", system: "", messages: [], effort: "xhigh" as const };
  it("mappe l'effort sur reasoning_effort si le backend le supporte", () => {
    expect(buildChatParams(req, "none", true).reasoning_effort).toBe("high");
  });
  it("ne l'envoie pas sinon", () => {
    expect(buildChatParams(req, "none", false).reasoning_effort).toBeUndefined();
  });
});

/** Faux backend OpenAI : 503 pour les modèles listés, flux SSE sinon. */
function fakeFetch(failing: Record<string, number>): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    const status = failing[model];
    if (status !== undefined) {
      return new Response(JSON.stringify({ error: { message: `${model} indisponible` } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const frames = [
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
      .map((f) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model, ...f })}\n\n`)
      .join("");
    return new Response(`${frames}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

async function run(provider: OpenAICompatibleProvider, model: string): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const c of provider.complete({ model, system: "", messages: [{ role: "user", content: "x" }] })) out.push(c);
  return out;
}

function provider(failing: Record<string, number>): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: "gemini",
    baseURL: "http://fake.local/v1",
    apiKey: "k",
    billing: "free",
    fallbackModels: ["lite"],
    maxRetries: 0,
    fetch: fakeFetch(failing),
  });
}

describe("OpenAICompatibleProvider — repli de modèle", () => {
  it("bascule sur le repli si le modèle demandé est saturé, et le signale", async () => {
    const chunks = await run(provider({ flash: 503 }), "flash");
    expect(chunks[0]).toEqual({ type: "model", model: "lite", fallbackFrom: "flash" });
    expect(chunks).toContainEqual({ type: "text", text: "ok" });
    expect(chunks.at(-1)).toEqual({ type: "stop", reason: "length" });
  });

  it("bascule aussi si le modèle est retiré (404)", async () => {
    const chunks = await run(provider({ flash: 404 }), "flash");
    expect(chunks[0]).toMatchObject({ type: "model", model: "lite" });
  });

  it("ne change pas de modèle pour une clé refusée", async () => {
    await expect(run(provider({ flash: 401 }), "flash")).rejects.toMatchObject({ kind: "auth" });
  });

  it("lève une erreur normalisée quand tous les modèles échouent", async () => {
    const err = await run(provider({ flash: 503, lite: 503 }), "flash").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect((err as ProviderRequestError).kind).toBe("overloaded");
  });
});
