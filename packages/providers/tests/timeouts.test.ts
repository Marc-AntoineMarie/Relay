import { describe, expect, it } from "vitest";
import { ProviderRequestError, SKIP_REASON } from "@relay/core";
import { OpenAICompatibleProvider } from "../src/openai-compatible.js";

/** Faux serveur compatible OpenAI : envoie des morceaux SSE avec un délai, en respectant l'annulation. */
function slowFetch(count: number, delayMs: number): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const enc = new TextEncoder();
    const chunk = (text: string): string =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          for (let i = 0; i < count; i++) {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, delayMs);
              signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
            });
            ctrl.enqueue(enc.encode(chunk(`m${i} `)));
          }
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctrl.close();
        } catch (e) {
          ctrl.error(e);
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

async function drain(p: OpenAICompatibleProvider, signal?: AbortSignal): Promise<string> {
  let text = "";
  for await (const c of p.complete({ model: "m", system: "", messages: [{ role: "user", content: "x" }], ...(signal ? { signal } : {}) })) {
    if (c.type === "text") text += c.text;
  }
  return text;
}

const make = (fetch: typeof globalThis.fetch, idle: number, max: number): OpenAICompatibleProvider =>
  new OpenAICompatibleProvider({ name: "fake", baseURL: "http://fake/v1", billing: "free", apiKey: "k", fetch, idleTimeoutMs: idle, maxDurationMs: max, maxRetries: 0 });

describe("garde-fous de durée des modèles", () => {
  it("réponse normale : rien ne change", async () => {
    expect(await drain(make(slowFetch(3, 10), 1_000, 5_000))).toBe("m0 m1 m2 ");
  });

  it("modèle muet trop longtemps → délai dépassé (repli possible)", async () => {
    const err = await drain(make(slowFetch(3, 400), 100, 5_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect((err as ProviderRequestError).kind).toBe("timeout");
    expect((err as ProviderRequestError).message).toContain("aucune réponse");
  });

  it("réponse qui avance mais n'en finit pas → abandonnée à la durée max", async () => {
    const err = await drain(make(slowFetch(50, 40), 1_000, 300)).catch((e: unknown) => e);
    expect((err as ProviderRequestError).kind).toBe("timeout");
    expect((err as ProviderRequestError).message).toContain("trop longue");
  });

  it("« passer au modèle suivant » → délai (repli) ; arrêt → arrêté (pas de repli)", async () => {
    const skip = new AbortController();
    setTimeout(() => skip.abort(SKIP_REASON), 60);
    const e1 = await drain(make(slowFetch(50, 20), 1_000, 5_000), skip.signal).catch((e: unknown) => e);
    expect((e1 as ProviderRequestError).kind).toBe("timeout");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 60);
    const e2 = await drain(make(slowFetch(50, 20), 1_000, 5_000), stop.signal).catch((e: unknown) => e);
    expect((e2 as ProviderRequestError).kind).toBe("aborted");
  });
});
