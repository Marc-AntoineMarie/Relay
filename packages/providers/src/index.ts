/**
 * @relay/providers — adaptateurs LLM écrits directement sur les SDK officiels.
 *
 * v0.1 : Anthropic (Haiku, Sonnet, Opus, Fable).
 * v0.2+ : OpenAI, Ollama. v0.3+ : OpenRouter.
 */
export const PROVIDERS_VERSION = "0.1.0";

export { AnthropicProvider } from "./anthropic.js";
export type { AnthropicProviderOptions } from "./anthropic.js";
export { ClaudeCodeProvider, ClaudeCodeError, interpretStreamJsonLine } from "./claude-code.js";
export type {
  ClaudeCodeProviderOptions,
  ClaudePermissionMode,
  InterpretedChunk,
} from "./claude-code.js";
