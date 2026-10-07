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
  CommandResult,
  FixRequest,
  LaunchState,
  ConversationMessage,
  ProjectInfo,
  RunDir,
  WorkspaceFile,
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

// ── Dossier de travail (phase D) ────────────────────────────────────────────

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `erreur ${res.status}`);
  return data;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const listRuns = (): Promise<{ base: string; runs: RunDir[] }> => call("/api/workspace/runs");

export const listFiles = (root: string): Promise<{ root: string; files: WorkspaceFile[] }> =>
  call(`/api/workspace/files?root=${encodeURIComponent(root)}`);

export const readFile = (root: string, path: string): Promise<{ path: string; content: string }> =>
  call(`/api/workspace/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);

export const runInWorkspace = (root: string, command: string, stdin?: string): Promise<CommandResult> =>
  call("/api/workspace/run", post({ root, command, ...(stdin ? { stdin } : {}) }));

export const launchInWorkspace = (
  root: string,
  command: string,
): Promise<{ id: string; pid?: number; exited: boolean; exitCode: number | null; output: string }> =>
  call("/api/workspace/run", post({ root, command, detached: true }));

export const openWorkspace = (root: string, target: "folder" | "vscode", path?: string): Promise<{ ok: boolean }> =>
  call("/api/workspace/open", post({ root, target, ...(path !== undefined ? { path } : {}) }));

export const getLaunches = (root: string): Promise<{ launches: LaunchState[] }> =>
  call(`/api/workspace/launches?root=${encodeURIComponent(root)}`);

export const stopLaunch = (id: string): Promise<{ found: boolean }> => call("/api/workspace/stop", post({ id }));

export const getProjects = (): Promise<{ base: string; projects: ProjectInfo[] }> => call("/api/projects");

export const getProject = (root: string): Promise<{ root: string; name: string; messages: ConversationMessage[]; memory: string }> =>
  call(`/api/projects/detail?root=${encodeURIComponent(root)}`);

export const saveProjectMemory = (root: string, content: string): Promise<{ ok: boolean }> =>
  call("/api/projects/memory", { ...post({ root, content }), method: "PUT" });

export const importProject = (root: string): Promise<{ root: string; name: string }> => call("/api/projects/import", post({ root }));

/** URL d'aperçu d'un fichier de projet : le dossier est encodé (base64url) pour accepter tout emplacement. */
export function previewUrl(root: string, path: string, nonce: number): string {
  const bytes = new TextEncoder().encode(root);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const id = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `/ws/${id}/${path.split("/").map(encodeURIComponent).join("/")}?v=${nonce}`;
}

/** Sélecteur de dossier natif (app desktop) ; null dans un navigateur ou si annulé. */
export async function pickFolder(title: string): Promise<string | null> {
  const desktop = (window as unknown as { relayDesktop?: { pickFolder: (t: string) => Promise<string | null> } }).relayDesktop;
  return desktop !== undefined ? desktop.pickFolder(title) : null;
}

export const hasNativePicker = (): boolean => (window as unknown as { relayDesktop?: unknown }).relayDesktop !== undefined;

export const answerApproval = (key: string, ok: boolean): Promise<{ found: boolean }> =>
  call("/api/approve", post({ key, ok }));

export type RunBody = (
  | { mode: "auto"; prompt: string; strategy: Strategy; policies: Record<string, AccountPolicy> }
  | { mode: "manual"; prompt: string; provider: string; models: TierModels }
) & {
  /** Continuer dans le dossier d'un run (session). */
  workspace?: string;
  /** Corriger une erreur rencontrée en testant. */
  fix?: FixRequest;
  /** Nouveau projet : nom et emplacement (facultatifs). */
  project?: { name?: string; location?: string };
  /** Réponses aux questions de cadrage. */
  kind?: "prompt" | "answer";
};

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
