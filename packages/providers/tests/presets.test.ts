import { describe, expect, it } from "vitest";
import { autoPoolModels, createProvider, PROVIDER_PRESETS } from "../src/factory.js";

describe("comptes gratuits supplémentaires", () => {
  it("NVIDIA, Cerebras, Mistral, Hugging Face, Ollama Cloud : clé dans .env, API compatible OpenAI", () => {
    for (const name of ["nvidia", "cerebras", "mistral", "huggingface", "ollama-cloud"]) {
      const p = PROVIDER_PRESETS[name];
      expect(p?.kind).toBe("openai-compatible");
      expect(p?.envKey).toMatch(/^[A-Z_]+$/);
      expect(() => createProvider(name, { env: {} })).toThrow(); // sans clé : refus clair
      expect(createProvider(name, { env: { [p?.envKey ?? ""]: "cle-de-test" } }).name).toBe(name);
    }
  });

  it("NVIDIA : sélection éprouvée si disponible, sinon les 2 meilleurs modèles connus par niveau", () => {
    const detected = ["moonshotai/kimi-k3", "nvidia/nemotron-3.5-lightning-30b-a3b", "meta/llama-3.1-8b-instruct"];
    expect(autoPoolModels("nvidia", detected)).toEqual(["nvidia/nemotron-3.5-lightning-30b-a3b", "moonshotai/kimi-k3"]);
    const big = ["a/llama-3.1-8b", "b/llama-3.2-3b", "c/llama-3.2-1b", "qwen/qwen2.5-coder-32b", "mistralai/mistral-large-3", "x/inconnu-7b"];
    const pool = autoPoolModels("huggingface", big);
    expect(pool.filter((m) => /llama-3\.\d-(8b|3b|1b)/.test(m))).toHaveLength(2); // 2 par niveau, pas 3
    expect(pool).not.toContain("x/inconnu-7b");
  });

  it("Ollama : adresse remplaçable (VPS via tunnel SSH), délai long pour les modèles sur CPU", () => {
    expect(PROVIDER_PRESETS["ollama"]?.baseURLEnv).toBe("OLLAMA_BASE_URL");
    expect(PROVIDER_PRESETS["ollama"]?.timeoutMs).toBeGreaterThanOrEqual(300_000);
  });
});
