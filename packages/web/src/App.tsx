import { useEffect, useMemo, useRef, useState } from "react";
import { getModels, getState, runPipeline, setKey } from "./api";
import { ErrorCard, MetricsBar, TaskDetail, TierPicker } from "./components";
import { PipelineView } from "./PipelineView";
import {
  TIERS,
  type AppState,
  type ErrorDescription,
  type Phase,
  type PipelineMetrics,
  type ProviderReadiness,
  type TaskView,
  type TierModels,
} from "./types";

// Préférences locales (backend choisi, modèles par tier) — confort uniquement.
const load = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
};
const save = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
};

/** Backend par défaut : le dernier utilisé, sinon un backend gratuit prêt. */
function pickProvider(providers: ProviderReadiness[], fallback: string): string {
  const last = load<string>("relay.provider");
  if (last !== null && providers.some((p) => p.name === last)) return last;
  const free = providers.find((p) => p.ready && p.billing === "free" && p.name !== "ollama");
  return free?.name ?? providers.find((p) => p.ready && p.name === fallback)?.name ?? fallback;
}

const BILLING: Record<ProviderReadiness["billing"], string> = {
  free: "gratuit",
  subscription: "abonnement",
  "per-token": "à l'usage",
};

interface Catalog {
  loading: boolean;
  models: string[];
  suggested: TierModels | null;
  error?: ErrorDescription;
}

export default function App(): React.JSX.Element {
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
      const valid = saved !== null && TIERS.every((t) => saved[t] && (res.models.length === 0 || res.models.includes(saved[t])));
      setTiers(valid ? saved : res.suggested);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, selected?.ready, selected?.tierModels]);

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

  async function run(): Promise<void> {
    if (tiers === null) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("planning");
    setError(null);
    setMetrics(null);
    setViews([]);
    setSelectedId(null);
    setStartedAt(Date.now());

    try {
      for await (const ev of runPipeline({ prompt, provider, models: tiers }, ac.signal)) {
        switch (ev.type) {
          case "pipeline:plan":
            setPhase("running");
            setViews(ev.tasks.map((task) => ({ task, status: "pending", output: "" })));
            break;
          case "task:start":
            patch(ev.taskId, () => ({ status: "running", model: ev.model }));
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

  const doneCount = views.filter((v) => v.status === "done").length;
  const elapsed = startedAt !== null ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const tiersComplete = tiers !== null && TIERS.every((t) => tiers[t].trim().length > 0);
  const canRun = !busy && prompt.trim().length > 0 && selected?.ready === true && tiersComplete;
  const selectedView = views.find((v) => v.task.id === selectedId) ?? views.find((v) => v.status === "running");
  const isRecommended =
    tiers !== null && catalog.suggested !== null && TIERS.every((t) => tiers[t] === catalog.suggested?.[t]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span> Relay
        </div>
        <div className="subtitle">orchestrateur de pipeline agentique</div>
        <div className="topbar-right">
          {selected !== undefined ? (
            <span className={`pill billing-${selected.billing}`}>
              {selected.label} · {BILLING[selected.billing]}
            </span>
          ) : null}
        </div>
      </header>

      {serverDown ? (
        <div className="banner">Moteur Relay injoignable — reconnexion automatique…</div>
      ) : null}

      <div className="layout">
        <aside className="sidebar">
          <h2>Backends</h2>
          <p className="muted small">Tes clés restent sur ta machine (fichier .env).</p>
          <ul className="providers">
            {state?.providers.map((p) => (
              <li key={p.name} className={`provider ${p.name === provider ? "active" : ""}`}>
                <button className="provider-pick" onClick={() => chooseProvider(p.name)} disabled={busy}>
                  <span className={`dot ${p.ready ? "dot-done" : "dot-pending"}`} />
                  <span className="provider-label">{p.label}</span>
                  <span className={`billing billing-${p.billing}`}>{BILLING[p.billing]}</span>
                </button>
                {p.envKey !== undefined ? (
                  <div className="key-row">
                    <input
                      type="password"
                      placeholder={p.ready ? "clé enregistrée · remplacer" : `colle ta clé ${p.envKey}`}
                      value={keyDraft[p.name] ?? ""}
                      onChange={(e) => setKeyDraft((d) => ({ ...d, [p.name]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && void saveKey(p.name)}
                    />
                    <button onClick={() => void saveKey(p.name)} disabled={!(keyDraft[p.name] ?? "").trim()}>
                      OK
                    </button>
                  </div>
                ) : (
                  <div className="muted small no-key">aucune clé requise</div>
                )}
                {!p.ready && p.keyUrl !== undefined ? (
                  <a className="small key-link" href={p.keyUrl} target="_blank" rel="noreferrer">
                    Obtenir une clé →
                  </a>
                ) : null}
              </li>
            )) ?? <li className="muted">chargement…</li>}
          </ul>
        </aside>

        <main className="main">
          <section className="composer">
            <div className="composer-head">
              <h2>Routage des modèles</h2>
              <span className="muted small">
                {catalog.loading
                  ? "détection des modèles…"
                  : catalog.models.length > 0
                    ? `${catalog.models.length} modèles détectés`
                    : selected?.ready === false
                      ? "ajoute la clé de ce backend pour détecter ses modèles"
                      : ""}
              </span>
              {isRecommended ? <span className="badge ok">recommandé</span> : null}
              {!isRecommended && catalog.suggested !== null && !busy ? (
                <button className="link" onClick={resetTiers}>
                  revenir aux recommandés
                </button>
              ) : null}
            </div>

            {tiers !== null ? (
              <TierPicker models={catalog.models} value={tiers} disabled={busy} onChange={changeTiers} />
            ) : (
              <p className="muted small">Sélectionne un backend prêt pour choisir ses modèles.</p>
            )}

            {catalog.error !== undefined && selected?.ready === true ? (
              <p className="inline-error">
                ⚠ {catalog.error.title} — {catalog.error.detail}
              </p>
            ) : null}

            <textarea
              className="prompt"
              placeholder="Décris ce que tu veux… ex. « Crée un parseur CSV en TypeScript avec gestion des erreurs et des tests »"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && canRun && void run()}
              rows={3}
              disabled={busy}
            />

            <div className="run-actions">
              {busy ? (
                <button className="stop-btn" onClick={() => abortRef.current?.abort()}>
                  Arrêter
                </button>
              ) : (
                <button className="run-btn" disabled={!canRun} onClick={() => void run()}>
                  Lancer le pipeline
                </button>
              )}
              <Stepper phase={phase} done={doneCount} total={views.length} elapsed={elapsed} />
              {!busy && !canRun ? <span className="muted small">{whyDisabled(prompt, selected, tiersComplete)}</span> : null}
            </div>
          </section>

          {error !== null ? (
            <ErrorCard
              error={error}
              onDismiss={() => setError(null)}
              {...(canRun ? { onRetry: () => void run() } : {})}
              {...(!isRecommended && catalog.suggested !== null ? { onReset: resetTiers } : {})}
            />
          ) : null}

          <MetricsBar m={metrics} />

          <section className="workspace">
            <div className="pipeline">
              <PipelineView views={views} selectedId={selectedView?.task.id ?? null} onSelect={setSelectedId} />
            </div>
            <TaskDetail view={selectedView} />
          </section>
        </main>
      </div>
    </div>
  );
}

function Stepper(props: { phase: Phase; done: number; total: number; elapsed: number }): React.JSX.Element | null {
  const { phase, done, total, elapsed } = props;
  if (phase === "idle") return null;
  const label: Record<Phase, string> = {
    idle: "",
    planning: "Planification du pipeline…",
    running: `Exécution ${done}/${total}`,
    done: `Terminé · ${total} tâche(s)`,
    failed: "Échec",
    stopped: "Arrêté",
  };
  const busy = phase === "planning" || phase === "running";
  return (
    <span className={`stepper stepper-${phase}`}>
      {busy ? <span className="spinner" /> : null}
      {label[phase]}
      {busy || elapsed > 0 ? <span className="muted"> · {elapsed} s</span> : null}
    </span>
  );
}

function whyDisabled(prompt: string, p: ProviderReadiness | undefined, tiersComplete: boolean): string {
  if (p === undefined) return "choisis un backend";
  if (!p.ready) return "ajoute la clé de ce backend (panneau de gauche)";
  if (!tiersComplete) return "choisis un modèle pour chaque tier";
  if (prompt.trim().length === 0) return "écris ta demande";
  return "";
}
