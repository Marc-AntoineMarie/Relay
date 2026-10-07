/**
 * Santé des modèles : mémorise les échecs récents (saturé, quota, retiré…) pour que le
 * routeur évite un modèle en difficulté pendant un temps, puis le réessaie.
 */
import type { ErrorKind } from "../errors.js";

/** Durée pendant laquelle un échec pèse sur le routage. */
const WINDOW_MS: Partial<Record<ErrorKind, number>> = {
  overloaded: 5 * 60_000,
  timeout: 5 * 60_000,
  network: 2 * 60_000,
  rate_limited: 10 * 60_000,
  model_not_found: 60 * 60_000,
  auth: 60 * 60_000,
  invalid_output: 10 * 60_000,
};

export class HealthTracker {
  private readonly marks = new Map<string, { kind: ErrorKind; until: number }>();

  /** `windowMs` : durée annoncée par le fournisseur (ex. « réessaie dans 17 s »), sinon défaut du type. */
  reportFailure(provider: string, model: string, kind: ErrorKind, now = Date.now(), windowMs?: number): void {
    const window = windowMs !== undefined ? windowMs + 5_000 : WINDOW_MS[kind];
    if (window !== undefined) this.marks.set(`${provider}/${model}`, { kind, until: now + window });
  }

  reportSuccess(provider: string, model: string): void {
    this.marks.delete(`${provider}/${model}`);
  }

  /** Problème récent du modèle, ou `undefined` s'il est sain. */
  status(provider: string, model: string, now = Date.now()): ErrorKind | undefined {
    const key = `${provider}/${model}`;
    const mark = this.marks.get(key);
    if (mark === undefined) return undefined;
    if (now > mark.until) {
      this.marks.delete(key);
      return undefined;
    }
    return mark.kind;
  }
}
