/**
 * Erreurs normalisées. Chaque provider traduit ses erreurs HTTP/SDK en
 * `ProviderRequestError` : le moteur décide du repli/retry sur `kind`, l'UI affiche
 * un message clair via `describeError`.
 */

export type ErrorKind =
  | "auth" // clé invalide ou sans accès
  | "model_not_found" // modèle inexistant ou retiré pour ce compte
  | "rate_limited" // quota / débit dépassé
  | "overloaded" // service saturé (5xx)
  | "timeout" // pas de réponse dans le délai
  | "bad_request" // paramètre refusé par le fournisseur
  | "too_large" // requête trop volumineuse pour ce modèle / cette offre (contexte, tokens par minute)
  | "network" // connexion impossible
  | "invalid_output" // réponse inutilisable (vide, appel d'outil inventé…)
  | "unknown";

const RETRYABLE: ReadonlySet<ErrorKind> = new Set(["rate_limited", "overloaded", "timeout", "network"]);

export class ProviderRequestError extends Error {
  override readonly name = "ProviderRequestError";
  readonly retryable: boolean;

  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly provider: string,
    readonly model?: string,
    readonly status?: number,
  ) {
    super(message);
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Un autre modèle peut-il réussir là où celui-ci a échoué ? (repli du routeur) */
export function shouldTryAnotherModel(error: ProviderRequestError): boolean {
  return error.retryable || error.kind === "model_not_found" || error.kind === "too_large" || error.kind === "invalid_output";
}

/** Délai annoncé par le fournisseur avant de réessayer (« try again in 17.4s », « retryDelay: "41s" »). */
export function retryDelayMs(error: ProviderRequestError): number | undefined {
  const m =
    /(?:try again|retry) in\s*(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(error.message) ??
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)(s)"/i.exec(error.message);
  if (m === null) return undefined;
  const n = Number.parseFloat(m[1] ?? "");
  return Number.isFinite(n) ? Math.ceil(m[2] === "ms" ? n : n * 1000) : undefined;
}

/** Le modèle a « appelé un outil » qu'on ne lui a pas donné (fréquent avec gpt-oss) : sa réponse est perdue. */
const INVALID_OUTPUT = /(called a tool|tool_use_failed|failed to call a function|tool call validation|attempted to call tool)/i;

const TOO_LARGE = /(request too large|too many tokens|context length|maximum context|context window|reduce (your|the) (message|prompt))/i;

/** Classe une erreur HTTP (le message affine certains cas ambigus). */
export function kindFromStatus(status: number | undefined, message = ""): ErrorKind {
  if (INVALID_OUTPUT.test(message)) return "invalid_output";
  if (status === undefined) return "unknown";
  if (status === 413 || ((status === 400 || status === 429) && TOO_LARGE.test(message))) return "too_large";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  // « quota limit: 0 » : le modèle n'est pas inclus dans l'offre du compte (ex. palier gratuit).
  if (status === 429) return /limit:\s*0\b/i.test(message) ? "model_not_found" : "rate_limited";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "overloaded";
  return "unknown";
}

/** Erreur prête à afficher : titre court, détail, conseil d'action. */
export interface ErrorDescription {
  kind: ErrorKind | "decomposer" | "config";
  title: string;
  detail: string;
  hint?: string;
}

const COPY: Record<ErrorKind, { title: string; hint: string }> = {
  auth: { title: "Clé API refusée", hint: "Vérifie ou remplace la clé de ce backend dans le panneau de gauche." },
  model_not_found: {
    title: "Modèle indisponible",
    hint: "Ce modèle n'existe pas, a été retiré, ou n'est pas inclus dans ton offre (palier gratuit) : choisis-en un autre.",
  },
  rate_limited: {
    title: "Quota ou débit dépassé",
    hint: "Attends un peu, ou bascule sur un autre backend gratuit (Groq, Gemini…).",
  },
  overloaded: {
    title: "Service saturé",
    hint: "Le fournisseur est surchargé (fréquent sur les paliers gratuits). Réessaie, ou choisis un modèle « lite ».",
  },
  timeout: { title: "Pas de réponse à temps", hint: "Le backend n'a pas répondu dans le délai. Réessaie ou change de modèle." },
  bad_request: {
    title: "Requête refusée par le fournisseur",
    hint: "Un paramètre n'est pas supporté par ce modèle : essaie un autre modèle.",
  },
  too_large: {
    title: "Requête trop volumineuse pour ce modèle",
    hint: "Le modèle (ou ton offre gratuite) limite la taille des requêtes : un modèle à plus grand contexte, comme Gemini, convient mieux.",
  },
  invalid_output: {
    title: "Réponse du modèle inutilisable",
    hint: "Le modèle a renvoyé une réponse vide ou malformée : Relay passe à un autre modèle. Si ça se répète, retire-le du pool (Réglages › Modèles).",
  },
  network: { title: "Connexion impossible", hint: "Vérifie ta connexion (ou qu'Ollama tourne, pour le local)." },
  unknown: { title: "Erreur inattendue", hint: "Réessaie ; si ça persiste, change de modèle ou de backend." },
};

/** Extrait le message lisible d'une erreur fournisseur (souvent du JSON brut). */
export function cleanProviderMessage(message: string): string {
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)?.[1];
  return (inner ?? message).replace(/\\n/g, " ").replace(/\\"/g, '"').trim().slice(0, 400);
}

export function describeError(err: unknown): ErrorDescription {
  if (err instanceof ProviderRequestError) {
    const copy = COPY[err.kind];
    const where = err.model !== undefined ? `${err.provider} · ${err.model}` : err.provider;
    return { kind: err.kind, title: copy.title, detail: `${where} — ${cleanProviderMessage(err.message)}`, hint: copy.hint };
  }
  if (err instanceof Error) {
    if (err.name === "DecomposerError") {
      return {
        kind: "decomposer",
        title: "Plan inexploitable",
        detail: err.message,
        hint: "Le modèle n'a pas produit un plan valide malgré les relances : choisis un modèle plus capable pour le tier « build ».",
      };
    }
    if (err.name === "ConfigError" || err.name === "ProviderError") {
      return { kind: "config", title: "Configuration incomplète", detail: err.message };
    }
    return { kind: "unknown", title: COPY.unknown.title, detail: err.message, hint: COPY.unknown.hint };
  }
  return { kind: "unknown", title: COPY.unknown.title, detail: String(err), hint: COPY.unknown.hint };
}
