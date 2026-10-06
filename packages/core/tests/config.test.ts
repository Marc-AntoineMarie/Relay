import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const valid = {
  $schema: "./relay.schema.json",
  routes: {
    quick: { provider: "anthropic", model: "claude-haiku-4-5" },
    build: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
    deep: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
    escalate: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
  },
  providers: { anthropic: { apiKey: "${TEST_RELAY_KEY}" } },
  escalation: { maxRetries: 1, effortFirst: true },
  decomposer: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
};

describe("parseConfig", () => {
  it("valide une config correcte et ignore la clé $schema", () => {
    const config = parseConfig(JSON.stringify(valid));
    expect(config.routes.quick.model).toBe("claude-haiku-4-5");
    expect(config.routes.build.effort).toBe("medium");
    expect(config.escalation.effortFirst).toBe(true);
  });

  it("substitue les ${VAR} depuis l'environnement", () => {
    process.env["TEST_RELAY_KEY"] = "sk-ant-secret";
    const config = parseConfig(JSON.stringify(valid));
    expect(config.providers["anthropic"]?.apiKey).toBe("sk-ant-secret");
    delete process.env["TEST_RELAY_KEY"];
  });

  it("rejette un JSON invalide", () => {
    expect(() => parseConfig("{pas du json")).toThrow(ConfigError);
  });

  it("rejette un effort inconnu", () => {
    const bad = structuredClone(valid);
    bad.routes.build.effort = "turbo";
    expect(() => parseConfig(JSON.stringify(bad))).toThrow(ConfigError);
  });

  it("rejette une route manquante", () => {
    const bad = structuredClone(valid) as Record<string, unknown>;
    delete (bad["routes"] as Record<string, unknown>)["deep"];
    expect(() => parseConfig(JSON.stringify(bad))).toThrow(ConfigError);
  });
});
