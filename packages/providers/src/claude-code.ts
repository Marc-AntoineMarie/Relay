/**
 * Provider Claude Code — pilote le binaire `claude` en mode non-interactif (`-p`).
 *
 * C'est « l'effet Morphy » : au lieu d'appeler l'API Messages avec une clé, on lance
 * Claude Code, qui s'authentifie avec l'abonnement de l'utilisateur. On change de modèle
 * par tâche via `--model`, on force le JSON du décomposeur via `--json-schema`, et on
 * récupère la progression + l'usage via `--output-format stream-json`.
 *
 * Facturation : `subscription` → coût réellement facturé = 0 ; le coût de référence
 * ($ équivalent API) est estimé via le registre, pour prouver l'économie.
 *
 * Sécurité par défaut : `permissionMode: "none"` → aucun outil qui demanderait une
 * permission ne s'exécute (pas d'écriture disque ni de shell). Le futur worker agentique
 * passera un mode permissif (`acceptEdits`/`bypassPermissions`) dans un espace maîtrisé.
 *
 * Hypothèses sur le format stream-json de `claude` (à confirmer au premier run réel) :
 * événements `{type:"assistant", message:{content:[{type:"text",text}]}}` pour le texte,
 * et `{type:"result", result, usage, total_cost_usd}` en fin. Le parsing est tolérant.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { defaultRegistry, ModelRegistry } from "@relay/core";
import type { CompletionChunk, CompletionRequest, ModelInfo, Provider } from "@relay/core";

export type ClaudePermissionMode = "none" | "acceptEdits" | "auto" | "bypassPermissions" | "manual";

export interface ClaudeCodeProviderOptions {
  /** Binaire à lancer. Défaut : "claude" (doit être dans le PATH). */
  bin?: string;
  /** Répertoire de travail de la session. Défaut : process.cwd(). */
  cwd?: string;
  registry?: ModelRegistry;
  /** Permissions des outils. Défaut : "none" (aucun effet de bord). */
  permissionMode?: ClaudePermissionMode;
  /** Retire les outils qui exécutent du code/commandes (Bash). Défaut : true. */
  restricted?: boolean;
}

export class ClaudeCodeError extends Error {
  override readonly name = "ClaudeCodeError";
}

export class ClaudeCodeProvider implements Provider {
  readonly name = "claude-code";
  readonly billing = "subscription" as const;
  private readonly bin: string;
  private readonly cwd: string | undefined;
  private readonly registry: ModelRegistry;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly restricted: boolean;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.bin = options.bin ?? "claude";
    this.cwd = options.cwd;
    this.registry = options.registry ?? defaultRegistry;
    this.permissionMode = options.permissionMode ?? "none";
    this.restricted = options.restricted ?? true;
  }

  async models(): Promise<ModelInfo[]> {
    // Claude Code exécute les modèles Claude ; on réutilise leurs entrées du registre.
    return this.registry.byProvider("anthropic").map((e) => ({
      id: e.id,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
    }));
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.registry.estimateCost(model, inputTokens, outputTokens);
  }

  /** Non disponible via Claude Code (pas d'endpoint count_tokens). */
  async countTokens(): Promise<number> {
    return 0;
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const args = ["-p", "--model", request.model, "--output-format", "stream-json", "--verbose"];
    if (request.system.length > 0) args.push("--append-system-prompt", request.system);
    if (request.format !== undefined) args.push("--json-schema", JSON.stringify(request.format.schema));
    args.push("--permission-mode", this.permissionMode);
    if (this.restricted) args.push("--restricted");

    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    // Arrêt du pipeline ou « passer au modèle suivant » : on coupe le processus claude.
    request.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    // Le prompt passe par stdin (évite les limites de longueur d'argument).
    const prompt = request.messages.map((m) => m.content).join("\n\n");
    child.stdin.on("error", () => {
      /* EPIPE si le process se termine tôt : ignoré */
    });
    child.stdin.end(prompt);

    let sawText = false;
    let finalUsage: CompletionChunk | undefined;
    let resultText: string | undefined;

    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      const chunk = interpretStreamJsonLine(line);
      if (chunk === null) continue;
      if (chunk.kind === "text") {
        sawText = true;
        yield { type: "text", text: chunk.text };
      } else {
        if (chunk.text !== undefined) resultText = chunk.text;
        if (chunk.usage !== undefined) {
          finalUsage = { type: "usage", usage: chunk.usage };
        }
      }
    }

    const code: number = await new Promise((resolve) => {
      child.on("close", (c) => resolve(c ?? 0));
    });

    if (spawnError !== undefined) {
      throw new ClaudeCodeError(`impossible de lancer '${this.bin}' : ${spawnError.message}`);
    }
    if (code !== 0) {
      throw new ClaudeCodeError(`claude a quitté avec le code ${code} : ${stderr.trim() || "(stderr vide)"}`);
    }

    // Si le texte n'est arrivé que dans l'événement final.
    if (!sawText && resultText !== undefined && resultText.length > 0) {
      yield { type: "text", text: resultText };
    }
    if (finalUsage !== undefined) yield finalUsage;
  }
}

/** Fragment interprété d'une ligne stream-json (fonction pure, testable). */
export type InterpretedChunk =
  | { kind: "text"; text: string }
  | { kind: "result"; text?: string; usage?: { inputTokens: number; outputTokens: number; thinkingTokens: number } };

export function interpretStreamJsonLine(line: string): InterpretedChunk | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let evt: unknown;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (evt === null || typeof evt !== "object") return null;
  const e = evt as Record<string, unknown>;

  if (e["type"] === "assistant") {
    const text = extractAssistantText(e["message"]);
    return text.length > 0 ? { kind: "text", text } : null;
  }

  if (e["type"] === "result") {
    const result: InterpretedChunk = { kind: "result" };
    if (typeof e["result"] === "string") result.text = e["result"];
    const usage = extractUsage(e["usage"]);
    if (usage !== undefined) result.usage = usage;
    return result;
  }

  return null;
}

function extractAssistantText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b !== null &&
        typeof b === "object" &&
        (b as Record<string, unknown>)["type"] === "text" &&
        typeof (b as Record<string, unknown>)["text"] === "string",
    )
    .map((b) => b.text)
    .join("");
}

function extractUsage(
  usage: unknown,
): { inputTokens: number; outputTokens: number; thinkingTokens: number } | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = numberOr(u["input_tokens"], 0);
  const output = numberOr(u["output_tokens"], 0);
  const details = u["output_tokens_details"];
  const thinking =
    details !== null && typeof details === "object"
      ? numberOr((details as Record<string, unknown>)["thinking_tokens"], 0)
      : 0;
  return { inputTokens: input, outputTokens: output, thinkingTokens: thinking };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
