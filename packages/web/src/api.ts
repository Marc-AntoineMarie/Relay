import type { AppState, ModelsResponse, ProviderReadiness, ServerEvent, TierModels } from "./types";

export async function getState(): Promise<AppState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error("impossible de charger l'état du moteur");
  return (await res.json()) as AppState;
}

export async function getModels(provider: string): Promise<ModelsResponse> {
  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
    return (await res.json()) as ModelsResponse;
  } catch {
    return {
      models: [],
      suggested: null,
      error: { kind: "network", title: "Moteur injoignable", detail: "La liste des modèles n'a pas pu être chargée." },
    };
  }
}

export async function setKey(provider: string, value: string): Promise<ProviderReadiness[]> {
  const res = await fetch("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, value }),
  });
  const data = (await res.json()) as { providers?: ProviderReadiness[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "échec de l'enregistrement de la clé");
  return data.providers ?? [];
}

/** Lance un pipeline et yield les événements SSE au fil de l'eau. `signal` l'interrompt. */
export async function* runPipeline(
  body: { prompt: string; provider: string; models: TierModels },
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new Error("le moteur n'a pas renvoyé de flux");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      const json = dataLine?.slice(5).trim();
      if (json) {
        try {
          yield JSON.parse(json) as ServerEvent;
        } catch {
          /* trame non-JSON : ignorée */
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}
