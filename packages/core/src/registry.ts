/**
 * Registre de modèles — source unique des prix et capacités, partagée par le routeur
 * et les providers. Ajouter un modèle (quel que soit le fournisseur) = une entrée ici.
 *
 * Voir docs/PROVIDERS.md pour la stratégie multi-fournisseurs.
 */

export interface ModelEntry {
  id: string;
  provider: string;
  /** Prix en $ par million de tokens. */
  inputPerM: number;
  outputPerM: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** false ⇒ le paramètre `effort` ne doit pas être envoyé (ex. Haiku 4.5). */
  supportsEffort: boolean;
}

/** Modèles v0.1 (Anthropic). Prix : tarifs API Anthropic. */
export const DEFAULT_MODELS: readonly ModelEntry[] = [
  { id: "claude-haiku-4-5", provider: "anthropic", inputPerM: 1, outputPerM: 5, contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: false },
  { id: "claude-sonnet-5-5", provider: "anthropic", inputPerM: 2, outputPerM: 10, contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true },
  { id: "claude-opus-5-5", provider: "anthropic", inputPerM: 4, outputPerM: 20, contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true },
  { id: "claude-fable-5-1", provider: "anthropic", inputPerM: 10, outputPerM: 50, contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true },
];

export class ModelRegistry {
  private readonly byId = new Map<string, ModelEntry>();

  constructor(entries: readonly ModelEntry[] = DEFAULT_MODELS) {
    for (const e of entries) this.byId.set(e.id, e);
  }

  get(id: string): ModelEntry | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  all(): ModelEntry[] {
    return [...this.byId.values()];
  }

  byProvider(provider: string): ModelEntry[] {
    return this.all().filter((e) => e.provider === provider);
  }

  register(entry: ModelEntry): void {
    this.byId.set(entry.id, entry);
  }

  /** Coût estimé ($) pour un volume de tokens. 0 si le modèle est inconnu. */
  estimateCost(id: string, inputTokens: number, outputTokens: number): number {
    const e = this.byId.get(id);
    if (e === undefined) return 0;
    return (inputTokens / 1_000_000) * e.inputPerM + (outputTokens / 1_000_000) * e.outputPerM;
  }
}

/** Registre par défaut (modèles v0.1). */
export const defaultRegistry = new ModelRegistry();
