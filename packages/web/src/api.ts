import type { AppState, ProviderReadiness, ServerEvent } from "./types";

export async function getState(): Promise<AppState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error("impossible de charger l'état du serveur");
  return (await res.json()) as AppState;
}

export async function getModels(provider: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
    const data = (await res.json()) as { models?: string[] };
    return data.models ?? [];
  } catch {
    return [];
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

/** Lance un pipeline et yield les événements SSE au fil de l'eau. */
export async function* runPipeline(body: {
  prompt: string;
  provider: string;
  model?: string;
}): AsyncGenerator<ServerEvent> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("le serveur n'a pas renvoyé de flux");

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
      if (dataLine !== undefined) {
        const json = dataLine.slice(5).trim();
        if (json.length > 0) {
          try {
            yield JSON.parse(json) as ServerEvent;
          } catch {
            /* trame partielle ou non-JSON : ignorée */
          }
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}
