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
};

export class HealthTracker {
  private readonly marks = new Map<string, { kind: ErrorKind; at: number }>();

  reportFailure(provider: string, model: string, kind: ErrorKind, now = Date.now()): void {
    if (WINDOW_MS[kind] !== undefined) this.marks.set(`${provider}/${model}`, { kind, at: now });
  }

  reportSuccess(provider: string, model: string): void {
    this.marks.delete(`${provider}/${model}`);
  }

  /** Problème récent du modèle, ou `undefined` s'il est sain. */
  status(provider: string, model: string, now = Date.now()): ErrorKind | undefined {
    const key = `${provider}/${model}`;
    const mark = this.marks.get(key);
    if (mark === undefined) return undefined;
    if (now - mark.at > (WINDOW_MS[mark.kind] ?? 0)) {
      this.marks.delete(key);
      return undefined;
    }
    return mark.kind;
  }
}
