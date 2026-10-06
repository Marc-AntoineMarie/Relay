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
import type { CompletionChunk, CompletionRequest, ModelInfo, Provider } from "@relay/core";

/** Prix ($/1M tokens) et capacités par modèle. Source : tarifs API Anthropic. */
interface ModelSpec {
  inputPerM: number;
  outputPerM: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** Haiku 4.5 ne supporte ni `effort` ni le thinking adaptatif. */
  supportsEffort: boolean;
}

const MODELS: Record<string, ModelSpec> = {
  "claude-haiku-4-5": {
    inputPerM: 1,
    outputPerM: 5,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsEffort: false,
  },
  "claude-sonnet-5-5": {
    inputPerM: 2,
    outputPerM: 10,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsEffort: true,
  },
  "claude-opus-5-5": {
    inputPerM: 4,
    outputPerM: 20,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsEffort: true,
  },
  "claude-fable-5-1": {
    inputPerM: 10,
    outputPerM: 50,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsEffort: true,
  },
};

/** max_tokens par défaut (streaming) quand la requête n'en précise pas. */
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicProviderOptions {
  /** Par défaut : variable d'env ANTHROPIC_API_KEY (lue par le SDK). */
  apiKey?: string;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic(
      options.apiKey === undefined ? {} : { apiKey: options.apiKey },
    );
  }

  async models(): Promise<ModelInfo[]> {
    return Object.entries(MODELS).map(([id, spec]) => ({
      id,
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutputTokens,
    }));
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const spec = MODELS[model];
    if (spec === undefined) return 0;
    return (inputTokens / 1_000_000) * spec.inputPerM + (outputTokens / 1_000_000) * spec.outputPerM;
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
    const spec = MODELS[request.model];
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

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();

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
  }
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
