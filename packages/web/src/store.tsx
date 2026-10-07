/**
 * État partagé de l'application, exposé aux panneaux via un contexte React
 * (les panneaux sont rendus par dockview, chacun dans son propre conteneur).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getModels, getPool, getState, runPipeline, setKey, type RunBody } from "./api";
import {
  TIERS,
  type AccountPolicy,
  type AppState,
  type ErrorDescription,
  type LogEntry,
  type Mode,
  type Phase,
  type PipelineMetrics,
  type PoolResponse,
  type ProviderReadiness,
  type Strategy,
  type TaskView,
  type TierModels,
} from "./types";

/** Taille max du journal gardé en mémoire (les runs très longs restent fluides). */
const MAX_LOGS = 3000;

// Préférences locales (backend, modèles, disposition) — confort uniquement.
export const load = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
};
export const save = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
};

export const BILLING: Record<ProviderReadiness["billing"], string> = {
  free: "gratuit",
  subscription: "abonnement",
  "per-token": "à l'usage",
};

/** Backend par défaut : le dernier utilisé, sinon un backend gratuit prêt. */
function pickProvider(providers: ProviderReadiness[], fallback: string): string {
  const last = load<string>("relay.provider");
  if (last !== null && providers.some((p) => p.name === last)) return last;
  const free = providers.find((p) => p.ready && p.billing === "free" && p.name !== "ollama");
  return free?.name ?? providers.find((p) => p.ready && p.name === fallback)?.name ?? fallback;
}

interface Catalog {
  loading: boolean;
  models: string[];
  suggested: TierModels | null;
  error?: ErrorDescription;
}

function useRelayState() {
  const [state, setState] = useState<AppState | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [provider, setProvider] = useState("");
  const [catalog, setCatalog] = useState<Catalog>({ loading: false, models: [], suggested: null });
  const [tiers, setTiers] = useState<TierModels | null>(null);
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [views, setViews] = useState<TaskView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const [mode, setModeState] = useState<Mode>(() => load<Mode>("relay.mode") ?? "auto");
  const [strategy, setStrategyState] = useState<Strategy>(() => load<Strategy>("relay.strategy") ?? "balanced");
  const [savedPolicies, setSavedPolicies] = useState<Record<string, AccountPolicy>>(
    () => load<Record<string, AccountPolicy>>("relay.policies") ?? {},
  );
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runInfo, setRunInfo] = useState<{ mode: Mode; accounts: string[]; strategy?: Strategy } | null>(null);

  const busy = phase === "planning" || phase === "running";
  const selected = useMemo(() => state?.providers.find((p) => p.name === provider), [state, provider]);

  // Chargement de l'état (avec reconnexion automatique).
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loadState = (): void => {
      getState()
        .then((s) => {
          if (cancelled) return;
          setState(s);
          setServerDown(false);
          setProvider((p) => p || pickProvider(s.providers, s.defaultProvider));
        })
        .catch(() => {
          if (cancelled) return;
          setServerDown(true);
          timer = window.setTimeout(loadState, 2000);
        });
    };
    loadState();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  // Détection des modèles du backend choisi + modèles par tier (mémorisés ou recommandés).
  useEffect(() => {
    if (!provider || selected?.ready !== true) {
      setCatalog({ loading: false, models: [], suggested: selected?.tierModels ?? null });
      setTiers(selected?.tierModels ?? null);
      return;
    }
    let cancelled = false;
    setCatalog((c) => ({ ...c, loading: true }));
    void getModels(provider).then((res) => {
      if (cancelled) return;
      setCatalog({ loading: false, models: res.models, suggested: res.suggested, ...(res.error ? { error: res.error } : {}) });
      const saved = load<TierModels>(`relay.tiers.${provider}`);
      const valid =
        saved !== null && TIERS.every((t) => saved[t] && (res.models.length === 0 || res.models.includes(saved[t])));
      setTiers(valid ? saved : res.suggested);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, selected?.ready, selected?.tierModels]);

  // Pool du mode auto : rechargé quand l'état des comptes change (clé ajoutée…).
  useEffect(() => {
    if (state === null) return;
    let cancelled = false;
    void getPool().then((p) => {
      if (!cancelled && p !== null) setPool(p);
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // Chrono pendant l'exécution : montre que ça tourne.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [busy]);

  function chooseProvider(name: string): void {
    if (busy) return;
    setProvider(name);
    save("relay.provider", name);
  }

  function changeTiers(next: TierModels): void {
    setTiers(next);
    save(`relay.tiers.${provider}`, next);
  }

  function resetTiers(): void {
    if (catalog.suggested !== null) changeTiers(catalog.suggested);
    setError(null);
  }

  async function saveKey(name: string): Promise<void> {
    const value = (keyDraft[name] ?? "").trim();
    if (!value) return;
    try {
      const providers = await setKey(name, value);
      setState((s) => (s ? { ...s, providers } : s));
      setKeyDraft((d) => ({ ...d, [name]: "" }));
      chooseProvider(name);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Clé non enregistrée", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const patch = (id: string, update: (v: TaskView) => Partial<TaskView>): void =>
    setViews((vs) => vs.map((v) => (v.task.id === id ? { ...v, ...update(v) } : v)));

  // Plafonds effectifs : défauts du moteur, surchargés par les choix de l'utilisateur.
  const policies: Record<string, AccountPolicy> = { ...pool?.defaultPolicies, ...savedPolicies };
  const policyOf = (name: string): AccountPolicy => policies[name] ?? { enabled: true };
  const usableAccounts =
    pool?.accounts.filter((a) => a.models.length > 0 && policyOf(a.name).enabled) ?? [];

  function setMode(next: Mode): void {
    if (busy) return;
    setModeState(next);
    save("relay.mode", next);
  }

  function setStrategy(next: Strategy): void {
    setStrategyState(next);
    save("relay.strategy", next);
  }

  function setPolicy(name: string, next: AccountPolicy): void {
    setSavedPolicies((p) => {
      const updated = { ...p, [name]: next };
      save("relay.policies", updated);
      return updated;
    });
  }

  const pushLog = (entry: LogEntry): void =>
    setLogs((ls) => (ls.length >= MAX_LOGS ? [...ls.slice(-MAX_LOGS + 1), entry] : [...ls, entry]));

  async function run(): Promise<void> {
    let body: RunBody;
    if (mode === "auto") {
      body = { mode: "auto", prompt, strategy, policies };
    } else {
      if (tiers === null) return;
      body = { mode: "manual", prompt, provider, models: tiers };
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("planning");
    setError(null);
    setMetrics(null);
    setViews([]);
    setLogs([]);
    setRunInfo(null);
    setSelectedId(null);
    setStartedAt(Date.now());

    try {
      for await (const ev of runPipeline(body, ac.signal)) {
        switch (ev.type) {
          case "mode":
            setRunInfo({ mode: ev.mode, accounts: ev.accounts, ...(ev.strategy ? { strategy: ev.strategy } : {}) });
            break;
          case "log":
            pushLog(ev.entry);
            break;
          case "pipeline:plan":
            setPhase("running");
            setViews(ev.tasks.map((task) => ({ task, status: "pending", output: "" })));
            break;
          case "task:route":
            patch(ev.taskId, () => ({
              provider: ev.provider,
              model: ev.model,
              reason: ev.reason,
              alternatives: ev.alternatives,
            }));
            break;
          case "task:start":
            patch(ev.taskId, () => ({ status: "running", model: ev.model, ...(ev.provider ? { provider: ev.provider } : {}) }));
            setSelectedId(ev.taskId);
            break;
          case "task:chunk":
            patch(ev.taskId, (v) => ({ output: v.output + ev.text }));
            break;
          case "task:done":
            patch(ev.taskId, (v) => ({
              status: "done",
              summary: ev.result.summary,
              output: ev.result.data?.result ?? v.output,
              metrics: ev.metrics,
              model: ev.metrics.model,
              provider: ev.metrics.provider,
              ...(ev.metrics.fallbackFrom !== undefined ? { fallbackFrom: ev.metrics.fallbackFrom } : {}),
              ...(ev.result.data?.truncated === true ? { truncated: true } : {}),
            }));
            break;
          case "task:failed":
            patch(ev.taskId, () => ({ status: "failed", error: ev.error }));
            setSelectedId(ev.taskId);
            break;
          case "pipeline:done":
            setMetrics(ev.metrics);
            setPhase("done");
            break;
          case "pipeline:failed":
            setError(ev.description ?? { kind: "unknown", title: "Pipeline interrompu", detail: ev.error });
            setPhase("failed");
            break;
          case "error":
            setError(ev.error);
            setPhase("failed");
            break;
          default:
            break;
        }
      }
    } catch (e: unknown) {
      if (ac.signal.aborted) {
        setPhase("stopped");
      } else {
        setError({
          kind: "network",
          title: "Connexion au moteur perdue",
          detail: e instanceof Error ? e.message : String(e),
          hint: "Relance l'application si le problème persiste.",
        });
        setPhase("failed");
      }
    } finally {
      abortRef.current = null;
      setNow(Date.now()); // fige le chrono sur la durée réelle
      setPhase((p) => (p === "planning" || p === "running" ? "done" : p));
    }
  }

  const tiersComplete = tiers !== null && TIERS.every((t) => tiers[t].trim().length > 0);

  return {
    state,
    serverDown,
    provider,
    selected,
    catalog,
    tiers,
    prompt,
    setPrompt,
    phase,
    busy,
    views,
    selectedId,
    setSelectedId,
    selectedView: views.find((v) => v.task.id === selectedId) ?? views.find((v) => v.status === "running"),
    metrics,
    error,
    setError,
    keyDraft,
    setKeyDraft,
    elapsed: startedAt !== null ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0,
    doneCount: views.filter((v) => v.status === "done").length,
    tiersComplete,
    canRun:
      !busy &&
      prompt.trim().length > 0 &&
      (mode === "auto" ? usableAccounts.length > 0 : selected?.ready === true && tiersComplete),
    mode,
    setMode,
    strategy,
    setStrategy,
    pool,
    policyOf,
    setPolicy,
    usableAccounts,
    logs,
    runInfo,
    isRecommended:
      tiers !== null && catalog.suggested !== null && TIERS.every((t) => tiers[t] === catalog.suggested?.[t]),
    chooseProvider,
    changeTiers,
    resetTiers,
    saveKey,
    run,
    stop: () => abortRef.current?.abort(),
  };
}

export type Relay = ReturnType<typeof useRelayState>;

const RelayContext = createContext<Relay | null>(null);

export function RelayProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const relay = useRelayState();
  return <RelayContext.Provider value={relay}>{children}</RelayContext.Provider>;
}

export function useRelay(): Relay {
  const relay = useContext(RelayContext);
  if (relay === null) throw new Error("useRelay doit être utilisé dans <RelayProvider>");
  return relay;
}
