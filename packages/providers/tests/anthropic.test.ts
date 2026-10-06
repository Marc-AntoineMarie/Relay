import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/index.js";

// Pas d'appel réseau : on teste le calcul de coût et le catalogue de modèles,
// qui sont purs. L'adaptateur lit ANTHROPIC_API_KEY mais ne l'utilise pas ici.
const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });

describe("AnthropicProvider.estimateCost", () => {
  it("applique les prix Opus 5.5 (4/20 $ par M)", () => {
    const cost = provider.estimateCost("claude-opus-5-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(24, 6);
  });

  it("applique les prix Haiku 4.5 (1/5 $ par M)", () => {
    const cost = provider.estimateCost("claude-haiku-4-5", 500_000, 200_000);
    expect(cost).toBeCloseTo(0.5 + 1, 6);
  });

  it("applique les prix Fable 5.1 (10/50 $ par M) — plus cher qu'Opus", () => {
    const fable = provider.estimateCost("claude-fable-5-1", 1_000_000, 1_000_000);
    const opus = provider.estimateCost("claude-opus-5-5", 1_000_000, 1_000_000);
    expect(fable).toBeCloseTo(60, 6);
    expect(fable).toBeGreaterThan(opus);
  });

  it("renvoie 0 pour un modèle inconnu", () => {
    expect(provider.estimateCost("modele-bidon", 1000, 1000)).toBe(0);
  });
});

describe("AnthropicProvider.models", () => {
  it("expose les quatre modèles v0.1", async () => {
    const ids = (await provider.models()).map((m) => m.id);
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("claude-sonnet-5-5");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("claude-fable-5-1");
  });
});
