/**
 * Provider compatible OpenAI — un seul adaptateur pour tous les backends qui exposent
 * l'API Chat Completions d'OpenAI : Gemini (palier gratuit), Groq (gratuit), OpenRouter
 * (modèles `:free`), DeepSeek / Qwen (chinois, très bon marché), Ollama local… et OpenAI.
 *
 * On choisit le backend via `baseURL` + `apiKey` + `model`. La facturation (`billing`)
 * est fournie par l'appelant : `free` pour les paliers gratuits et le local, `per-token`
 * pour les API payantes.
 *
 * Note `effort` : l'API Chat Completions n'a pas de notion d'effort générique — on
 * l'ignore ici (le routage par effort reste pertinent pour les providers qui le gèrent).
 */
import OpenAI from "openai";
import { defaultRegistry, ModelRegistry } from "@relay/core";
import type { BillingMode, CompletionChunk, CompletionRequest, ModelInfo, Provider } from "@relay/core";

/** Comment forcer le JSON structuré selon ce que le backend supporte. */
export type StructuredMode = "json_object" | "json_schema" | "none";

export interface OpenAICompatibleOptions {
  name: string;
  baseURL: string;
  apiKey?: string;
  billing: BillingMode;
  /** Défaut : "json_object" (le plus portable). */
  structuredMode?: StructuredMode;
  registry?: ModelRegistry;
  /** Timeout par requête (ms). Défaut 60 s : évite de pendre si un backend gratuit sature. */
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  readonly billing: BillingMode;
  private readonly client: OpenAI;
  private readonly structuredMode: StructuredMode;
  private readonly registry: ModelRegistry;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.billing = options.billing;
    this.structuredMode = options.structuredMode ?? "json_object";
    this.registry = options.registry ?? defaultRegistry;
    // Certains backends locaux (Ollama) n'exigent pas de clé : l'SDK en veut une quand même.
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey ?? "not-needed",
      timeout: options.timeoutMs ?? 60_000,
      maxRetries: 1,
    });
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const list = await this.client.models.list();
      const out: ModelInfo[] = [];
      for await (const m of list) {
        // Gemini renvoie "models/gemini-2.0-flash" → on garde l'id court.
        out.push({ id: m.id.replace(/^models\//, "") });
      }
      return out;
    } catch {
      return [];
    }
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.registry.estimateCost(model, inputTokens, outputTokens);
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const params = buildChatParams(request, this.structuredMode);
    const stream = await this.client.chat.completions.create(params);

    let usage: CompletionChunk | undefined;
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "text", text };
      }
      if (chunk.usage) {
        usage = {
          type: "usage",
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            thinkingTokens: 0,
          },
        };
      }
    }
    if (usage !== undefined) yield usage;
  }
}

/** Construit les paramètres Chat Completions (fonction pure, testable). */
export function buildChatParams(
  request: CompletionRequest,
  structuredMode: StructuredMode,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (request.system.length > 0) messages.push({ role: "system", content: request.system });
  for (const m of request.messages) {
    messages.push({ role: m.role, content: m.content });
  }

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.maxTokens !== undefined) params.max_tokens = request.maxTokens;

  if (request.format !== undefined && structuredMode !== "none") {
    params.response_format =
      structuredMode === "json_schema"
        ? { type: "json_schema", json_schema: { name: "relay_output", schema: request.format.schema, strict: true } }
        : { type: "json_object" };
  }

  return params;
}
