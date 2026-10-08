import { describe, expect, it } from "vitest";
import type { Provider } from "@relay/core";
import { setPriceOverrides } from "@relay/core";
import { meter, periodStart, summarize, toCsv, UsageStore } from "../src/usage.js";

const fake = (billing: Provider["billing"], fail = false): Provider => ({
  name: billing === "free" ? "groq" : "deepseek",
  billing,
  async models() {
    return [];
  },
  estimateCost: () => 0,
  async countTokens() {
    return 0;
  },
  async *complete() {
    if (fail) throw Object.assign(new Error("429"), { kind: "rate_limited" });
    yield { type: "text", text: "ok" };
    yield { type: "latency", firstChunkMs: 1200 };
    yield { type: "quota", quota: { limitRequests: 1000, remainingRequests: 990 } };
    yield { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0 } };
  },
});

async function drain(p: Provider, purpose: "plan" | "task" = "task"): Promise<void> {
  for await (const _ of p.complete({ model: "deepseek-chat", system: "", messages: [], tag: { purpose, taskId: "1" } })) {
    /* rien */
  }
}

describe("registre d'usage", () => {
  it("chaque appel est mesuré (y compris les échecs), quotas retenus, payé seulement à l'usage", async () => {
    const store = new UsageStore(":memory:");
    const ctx = { runId: "r1", project: "calc" };
    await drain(meter(fake("free"), store, () => ctx), "plan");
    await drain(meter(fake("per-token"), store, () => ctx));
    await expect(drain(meter(fake("free", true), store, () => ctx))).rejects.toThrow();
    const calls = store.calls(0);
    expect(calls.map((c) => [c.purpose, c.outcome, c.billing])).toEqual([
      ["plan", "ok", "free"],
      ["task", "ok", "per-token"],
      ["task", "rate_limited", "free"],
    ]);
    expect(calls[0]?.billed).toBe(0); // gratuit : rien payé
    expect(calls[1]?.billed).toBeGreaterThan(0); // à l'usage : dépense réelle
    expect(calls[0]?.firstChunkMs).toBe(1200);
    expect(store.quotas()["groq"]?.remainingRequests).toBe(990);

    store.addRun({ runId: "r1", at: Date.now(), project: "calc", root: "/p", prompt: "x", mode: "auto", outcome: "done", durationMs: 10, tasks: 2, launchOk: true });
    const s = summarize(store.calls(0), store.runs(0), {
      baselineModel: "claude-opus-5-5",
      period: "all",
      since: 0,
      budgetMonthly: 0.1,
      budgetAlertPct: 80,
      spentThisMonth: store.billedSince(0),
      quotas: store.quotas(),
    });
    expect(s.totals.calls).toBe(3);
    expect(s.totals.failed).toBe(1);
    expect(s.totals.rateLimited).toBe(1);
    expect(s.totals.baseline).toBeGreaterThan(s.totals.reference); // Opus plus cher que DeepSeek / Groq
    expect(s.totals.routingSavings).toBeCloseTo(s.totals.baseline - s.totals.reference);
    expect(s.byPurpose.map((p) => p.purpose).sort()).toEqual(["plan", "task"]);
    expect(s.recentRuns[0]?.calls).toBe(3);
    expect(s.totals.launchOk).toBe(1);
    expect(s.budget.exceeded).toBe(true); // 0,27 $ dépensés > budget de 0,10 $
    expect(toCsv(store.calls(0), "claude-opus-5-5").split("\n")[0]).toContain("equivalent_api_usd");
  });

  it("les prix personnalisés remplacent la référence du catalogue", () => {
    const store = new UsageStore(":memory:");
    store.addCall({ at: Date.now(), runId: "r", project: "p", purpose: "task", provider: "deepseek", billing: "per-token", model: "deepseek-chat", inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0, billed: 0.27, durationMs: 1, outcome: "ok" });
    const opts = { baselineModel: "deepseek-chat", period: "all" as const, since: 0, budgetMonthly: null, budgetAlertPct: 80, spentThisMonth: 0, quotas: {} };
    const before = summarize(store.calls(0), [], opts).totals.reference;
    setPriceOverrides({ "DeepSeek Chat": { inputPerM: 1, outputPerM: 1 } });
    const after = summarize(store.calls(0), [], opts).totals.reference;
    setPriceOverrides({});
    expect(before).toBeCloseTo(0.27);
    expect(after).toBeCloseTo(1);
    expect(periodStart("day")).toBeLessThanOrEqual(Date.now());
  });
});
