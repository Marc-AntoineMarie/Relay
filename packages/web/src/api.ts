import type {
  AccountPolicy,
  AppState,
  ModelsResponse,
  PoolResponse,
  ProviderReadiness,
  ServerEvent,
  Settings,
  Strategy,
  TierModels,
  KeyTestResult,
} from "./types";

export async function getSettings(): Promise<Settings | null> {
  try {
    return (await (await fetch("/api/settings")).json()) as Settings;
  } catch {
    return null;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings | null> {
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return (await res.json()) as Settings;
  } catch {
    return null;
  }
}

export async function testKey(provider: string, value?: string): Promise<KeyTestResult> {
  try {
    const res = await fetch("/api/keys/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value ? { provider, value } : { provider }),
    });
    return (await res.json()) as KeyTestResult;
  } catch {
    return { ok: false, error: { kind: "network", title: "Moteur injoignable", detail: "test impossible" } };
  }
}

export async function deleteKey(provider: string): Promise<ProviderReadiness[]> {
  const res = await fetch("/api/keys/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  const data = (await res.json()) as { providers?: ProviderReadiness[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "suppression impossible");
  return data.providers ?? [];
}

export type RunBody =
  | { mode: "auto"; prompt: string; strategy: Strategy; policies: Record<string, AccountPolicy> }
  | { mode: "manual"; prompt: string; provider: string; models: TierModels };

export async function getPool(): Promise<PoolResponse | null> {
  try {
    const res = await fetch("/api/pool");
    return (await res.json()) as PoolResponse;
  } catch {
    return null;
  }
}

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
export async function* runPipeline(body: RunBody, signal: AbortSignal): AsyncGenerator<ServerEvent> {
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
