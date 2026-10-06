import { describe, expect, it } from "vitest";
import { Router } from "../src/router/index.js";
import type { ModelAssignment, RelayConfig, RouteTier, Task } from "../src/types.js";

function makeConfig(effortFirst = true): RelayConfig {
  return {
    routes: {
      quick: { provider: "anthropic", model: "claude-haiku-4-5" },
      build: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
      deep: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      escalate: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
    },
    providers: { anthropic: {} },
    escalation: { maxRetries: 1, effortFirst },
    decomposer: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
  };
}

function task(tier: RouteTier): Task {
  return { id: "1", type: "implement", description: "d", tier, dependsOn: [], status: "pending", attempts: [] };
}

describe("Router.assign", () => {
  it("assigne le modèle du tier (quick = Haiku, sans effort)", () => {
    const t = new Router(makeConfig()).assign(task("quick"));
    expect(t.assignedModel).toBe("claude-haiku-4-5");
    expect(t.assignedEffort).toBeUndefined();
  });

  it("assigne modèle + effort pour build", () => {
    const t = new Router(makeConfig()).assign(task("build"));
    expect(t.assignedModel).toBe("claude-sonnet-5-5");
    expect(t.assignedEffort).toBe("medium");
  });
});

describe("Router.escalate (effortFirst)", () => {
  const router = new Router(makeConfig(true));

  it("monte l'effort d'abord sur le même modèle", () => {
    const next = router.escalate({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" });
    expect(next).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
  });

  it("passe au modèle escalate si l'effort ne peut pas monter (Haiku sans effort)", () => {
    const next = router.escalate({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(next).toEqual({ provider: "anthropic", model: "claude-fable-5-1", effort: "high" });
  });

  it("renvoie null quand le modèle escalate est au max", () => {
    const next = router.escalate({ provider: "anthropic", model: "claude-fable-5-1", effort: "max" });
    expect(next).toBeNull();
  });
});

describe("Router.escalate (modèle d'abord)", () => {
  it("change de modèle avant de monter l'effort", () => {
    const router = new Router(makeConfig(false));
    const next = router.escalate({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" });
    expect(next?.model).toBe("claude-fable-5-1");
  });
});

describe("Router.validate", () => {
  it("avertit pour un modèle absent du registre", () => {
    const config = makeConfig();
    config.routes.build = { provider: "anthropic", model: "modele-fantome" } as ModelAssignment;
    const warnings = new Router(config).validate();
    expect(warnings.some((w) => w.includes("modele-fantome"))).toBe(true);
  });

  it("ne produit aucun avertissement pour une config valide", () => {
    expect(new Router(makeConfig()).validate()).toEqual([]);
  });
});
