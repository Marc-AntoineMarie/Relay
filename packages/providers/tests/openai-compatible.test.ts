import { describe, expect, it } from "vitest";
import { buildChatParams } from "../src/index.js";
import type { CompletionRequest } from "@relay/core";

const base: CompletionRequest = {
  model: "gemini-2.0-flash",
  system: "Tu es un agent.",
  messages: [{ role: "user", content: "salut" }],
  maxTokens: 4096,
};

describe("buildChatParams", () => {
  it("place le system en tête puis les messages, en streaming avec usage", () => {
    const p = buildChatParams(base, "json_object");
    expect(p.model).toBe("gemini-2.0-flash");
    expect(p.messages[0]).toEqual({ role: "system", content: "Tu es un agent." });
    expect(p.messages[1]).toEqual({ role: "user", content: "salut" });
    expect(p.stream).toBe(true);
    expect(p.stream_options).toEqual({ include_usage: true });
    expect(p.max_tokens).toBe(4096);
  });

  it("n'ajoute pas de response_format sans format demandé", () => {
    expect(buildChatParams(base, "json_object").response_format).toBeUndefined();
  });

  it("utilise json_object quand un format est demandé (mode portable)", () => {
    const req: CompletionRequest = { ...base, format: { schema: { type: "object" } } };
    expect(buildChatParams(req, "json_object").response_format).toEqual({ type: "json_object" });
  });

  it("utilise json_schema strict quand demandé", () => {
    const schema = { type: "object", properties: {} };
    const req: CompletionRequest = { ...base, format: { schema } };
    expect(buildChatParams(req, "json_schema").response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "relay_output", schema, strict: true },
    });
  });

  it("n'ajoute aucun response_format en mode none", () => {
    const req: CompletionRequest = { ...base, format: { schema: { type: "object" } } };
    expect(buildChatParams(req, "none").response_format).toBeUndefined();
  });
});
