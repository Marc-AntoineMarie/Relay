/**
 * Adaptateur Anthropic — écrit directement sur `@anthropic-ai/sdk`.
 *
 * Pièges gérés par modèle (vérifiés contre l'API) :
 *   - Haiku 4.5 n'accepte pas `effort` ni le thinking adaptatif → on ne les envoie pas.
 *   - Sonnet 5.5 / Opus 5.5 / Fable 5.1 : thinking non désactivable, `budget_tokens`
 *     rejeté → `thinking: {type:"adaptive"}`, profondeur pilotée par `effort`.
 *   - Pas de prefill ni de `tool_choice` forcé (le décomposeur passe par les
 *     structured outputs, hors de cet adaptateur).
 */
import Anthropic from "@anthropic-ai/sdk";
import { defaultRegistry, kindFromStatus, ModelRegistry, ProviderRequestError } from "@relay/core";
import type { CompletionChunk, CompletionRequest, ModelInfo, Provider, StopReason } from "@relay/core";

/** max_tokens par défaut (streaming) quand la requête n'en précise pas. */
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicProviderOptions {
  /** Par défaut : variable d'env ANTHROPIC_API_KEY (lue par le SDK). */
  apiKey?: string;
  /** Registre de modèles (prix, capacités). Par défaut : le registre central. */
  registry?: ModelRegistry;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly billing = "per-token" as const;
  private readonly client: Anthropic;
  private readonly registry: ModelRegistry;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic(
      options.apiKey === undefined ? {} : { apiKey: options.apiKey },
    );
    this.registry = options.registry ?? defaultRegistry;
  }

  async models(): Promise<ModelInfo[]> {
    return this.registry.byProvider("anthropic").map((e) => ({
      id: e.id,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
    }));
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.registry.estimateCost(model, inputTokens, outputTokens);
  }

  async countTokens(request: CompletionRequest): Promise<number> {
    const { system, messages } = splitMessages(request);
    const res = await this.client.messages.countTokens({
      model: request.model,
      system,
      messages,
    });
    return res.input_tokens;
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const spec = this.registry.get(request.model);
    const { system, messages } = splitMessages(request);

    const params: Anthropic.MessageStreamParams = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      messages,
    };

    if (request.tools !== undefined && request.tools.length > 0) {
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));
    }

    // output_config regroupe effort + format structuré.
    const outputConfig: Anthropic.OutputConfig = {};

    // Effort + thinking : seulement sur les modèles qui les supportent (Haiku exclu).
    if (spec?.supportsEffort === true) {
      params.thinking = { type: "adaptive" };
      if (request.effort !== undefined) outputConfig.effort = request.effort;
    }

    // Sortie structurée : indépendante du modèle.
    if (request.format !== undefined) {
      outputConfig.format = { type: "json_schema", schema: request.format.schema };
    }

    if (outputConfig.effort !== undefined || outputConfig.format !== undefined) {
      params.output_config = outputConfig;
    }

    let final: Anthropic.Message;
    try {
      const stream = this.client.messages.stream(params);
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      throw toAnthropicError(err, request.model);
    }

    for (const block of final.content) {
      if (block.type === "tool_use") {
        yield { type: "tool_use", toolUse: { name: block.name, input: block.input } };
      }
    }

    yield {
      type: "usage",
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        thinkingTokens: final.usage.output_tokens_details?.thinking_tokens ?? 0,
      },
    };
    yield { type: "stop", reason: STOP_REASONS[final.stop_reason ?? ""] ?? "other" };
  }
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  max_tokens: "length",
  refusal: "refusal",
  tool_use: "tool_use",
};

function toAnthropicError(err: unknown, model: string): ProviderRequestError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderRequestError("timeout", "délai de réponse dépassé", "anthropic", model);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderRequestError("network", err.message, "anthropic", model);
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderRequestError(kindFromStatus(err.status), err.message, "anthropic", model, err.status);
  }
  return new ProviderRequestError("unknown", err instanceof Error ? err.message : String(err), "anthropic", model);
}

/**
 * L'API sépare le prompt système du tableau de messages (user/assistant uniquement).
 * On fusionne tout message de rôle `system` dans le prompt système.
 */
function splitMessages(request: CompletionRequest): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  if (request.system.length > 0) systemParts.push(request.system);

  const messages: Anthropic.MessageParam[] = [];
  for (const msg of request.messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  return { system: systemParts.join("\n\n"), messages };
}
