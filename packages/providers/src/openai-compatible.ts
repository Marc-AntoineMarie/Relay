/**
 * Provider compatible OpenAI — un seul adaptateur pour tous les backends qui exposent
 * l'API Chat Completions : Gemini, Groq, OpenRouter, DeepSeek, Qwen, Ollama, OpenAI.
 *
 * Gestion des modèles :
 *  - repli automatique sur `fallbackModels` si le modèle demandé est saturé, limité ou
 *    retiré — uniquement tant qu'aucun texte n'a été émis (pas de réponse hybride) ;
 *    un chunk `model` signale le modèle réellement utilisé ;
 *  - effort Relay → `reasoning_effort` pour les backends qui le supportent (budget de
 *    réflexion des modèles « thinking ») ; retiré automatiquement si le modèle le refuse ;
 *  - erreurs SDK traduites en `ProviderRequestError` (kind exploitable par le moteur/UI).
 */
import OpenAI from "openai";
import { defaultRegistry, kindFromStatus, ModelRegistry, ProviderRequestError, shouldTryAnotherModel } from "@relay/core";
import type {
  BillingMode,
  CompletionChunk,
  CompletionRequest,
  Effort,
  ModelInfo,
  Provider,
  StopReason,
} from "@relay/core";

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
  /** Modèles de repli, par ordre de préférence. */
  fallbackModels?: string[];
  /** Le backend accepte `reasoning_effort`. */
  reasoningEffort?: boolean;
  /** Retentatives du SDK sur erreurs transitoires (défaut 1). */
  maxRetries?: number;
  /** Implémentation fetch (tests). */
  fetch?: typeof fetch;
}

/** Nombre maximal de modèles de repli essayés après le modèle demandé. */
const MAX_FALLBACKS = 2;

const REASONING: Record<Effort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  readonly billing: BillingMode;
  private readonly client: OpenAI;
  private readonly structuredMode: StructuredMode;
  private readonly registry: ModelRegistry;
  private readonly fallbackModels: string[];
  private readonly reasoningEffort: boolean;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.billing = options.billing;
    this.structuredMode = options.structuredMode ?? "json_object";
    this.registry = options.registry ?? defaultRegistry;
    this.fallbackModels = options.fallbackModels ?? [];
    this.reasoningEffort = options.reasoningEffort ?? false;
    // Certains backends locaux (Ollama) n'exigent pas de clé : le SDK en veut une quand même.
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey ?? "not-needed",
      timeout: options.timeoutMs ?? 60_000,
      // Avec des replis, on bascule tout de suite plutôt que de réessayer un modèle saturé.
      maxRetries: options.maxRetries ?? (this.fallbackModels.length > 0 ? 0 : 1),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  async models(): Promise<ModelInfo[]> {
    const list = await this.client.models.list().catch((err: unknown) => {
      throw toProviderError(err, this.name);
    });
    const out: ModelInfo[] = [];
    for await (const m of list) {
      // Gemini renvoie "models/gemini-…" → on garde l'id court.
      out.push({ id: m.id.replace(/^models\//, "") });
    }
    return out;
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.registry.estimateCost(model, inputTokens, outputTokens);
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const candidates = [...new Set([request.model, ...this.fallbackModels])].slice(0, 1 + MAX_FALLBACKS);
    let useReasoning = this.reasoningEffort;
    let lastError: ProviderRequestError | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i] as string;
      let emitted = false;
      try {
        const params = buildChatParams({ ...request, model }, this.structuredMode, useReasoning);
        const stream = await this.client.chat.completions.create(params);
        let usage: CompletionChunk | undefined;
        let stop: StopReason = "end";

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const text = choice?.delta?.content;
          if (typeof text === "string" && text.length > 0) {
            if (!emitted && model !== request.model) yield { type: "model", model, fallbackFrom: request.model };
            emitted = true;
            yield { type: "text", text };
          }
          if (choice?.finish_reason) stop = mapFinishReason(choice.finish_reason);
          if (chunk.usage) {
            usage = {
              type: "usage",
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
                thinkingTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              },
            };
          }
        }

        if (!emitted && model !== request.model) yield { type: "model", model, fallbackFrom: request.model };
        if (usage !== undefined) yield usage;
        yield { type: "stop", reason: stop };
        return;
      } catch (err) {
        const e = toProviderError(err, this.name, model);
        if (emitted) throw e; // échec en plein flux : on ne mélange pas deux réponses
        if (e.kind === "bad_request" && useReasoning && /reasoning/i.test(e.message)) {
          useReasoning = false; // ce modèle refuse reasoning_effort : même modèle, sans le paramètre
          i--;
          continue;
        }
        lastError = e;
        // Changer de modèle n'aide pas pour une clé refusée ou une requête invalide.
        if (!shouldTryAnotherModel(e)) throw e;
      }
    }

    throw lastError ?? new ProviderRequestError("unknown", "aucun modèle n'a répondu", this.name, request.model);
  }
}

/** Construit les paramètres Chat Completions (fonction pure, testable). */
export function buildChatParams(
  request: CompletionRequest,
  structuredMode: StructuredMode,
  reasoning = false,
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
  if (reasoning && request.effort !== undefined) params.reasoning_effort = REASONING[request.effort];

  if (request.format !== undefined && structuredMode !== "none") {
    params.response_format =
      structuredMode === "json_schema"
        ? { type: "json_schema", json_schema: { name: "relay_output", schema: request.format.schema, strict: true } }
        : { type: "json_object" };
  }

  return params;
}

function mapFinishReason(reason: string): StopReason {
  if (reason === "stop") return "end";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "refusal";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return "other";
}

/** Traduit une erreur du SDK OpenAI en erreur normalisée. */
export function toProviderError(err: unknown, provider: string, model?: string): ProviderRequestError {
  if (err instanceof ProviderRequestError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderRequestError("timeout", "délai de réponse dépassé", provider, model);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderRequestError("network", err.message, provider, model);
  }
  if (err instanceof OpenAI.APIError) {
    return new ProviderRequestError(kindFromStatus(err.status, err.message), err.message, provider, model, err.status);
  }
  return new ProviderRequestError("unknown", err instanceof Error ? err.message : String(err), provider, model);
}
