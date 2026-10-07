import { describe, expect, it } from "vitest";
import { ClaudeCodeProvider, interpretStreamJsonLine } from "../src/index.js";

describe("interpretStreamJsonLine", () => {
  it("extrait le texte d'un message assistant", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Bonjour" }, { type: "tool_use", id: "x" }] },
    });
    expect(interpretStreamJsonLine(line)).toEqual({ kind: "text", text: "Bonjour" });
  });

  it("extrait usage + texte d'un événement result", () => {
    const line = JSON.stringify({
      type: "result",
      result: "{\"ok\":true}",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1200, output_tokens: 340, output_tokens_details: { thinking_tokens: 50 } },
    });
    expect(interpretStreamJsonLine(line)).toEqual({
      kind: "result",
      text: '{"ok":true}',
      usage: { inputTokens: 1200, outputTokens: 340, thinkingTokens: 50 },
    });
  });

  it("gère un result sans détails de thinking", () => {
    const line = JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 } });
    expect(interpretStreamJsonLine(line)).toEqual({
      kind: "result",
      usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 0 },
    });
  });

  it("ignore un type inconnu, une ligne vide et du JSON invalide", () => {
    expect(interpretStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull();
    expect(interpretStreamJsonLine("   ")).toBeNull();
    expect(interpretStreamJsonLine("{pas du json")).toBeNull();
  });

  it("ignore un message assistant sans texte", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }] } });
    expect(interpretStreamJsonLine(line)).toBeNull();
  });
});

describe("ClaudeCodeProvider (métadonnées, sans spawn)", () => {
  const provider = new ClaudeCodeProvider();

  it("facture sur abonnement", () => {
    expect(provider.billing).toBe("subscription");
    expect(provider.name).toBe("claude-code");
  });

  it("estime un coût de référence au tarif API du modèle", () => {
    // Opus 5.5 : 4/20 $ par M → 1M in + 1M out = 24 $ équivalent.
    expect(provider.estimateCost("claude-opus-5-5", 1_000_000, 1_000_000)).toBeCloseTo(24, 6);
  });

  it("expose les modèles Claude", async () => {
    const ids = (await provider.models()).map((m) => m.id);
    expect(ids).toContain("claude-opus-5-5");
  });
});
