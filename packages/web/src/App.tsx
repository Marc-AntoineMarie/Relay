import { useEffect, useMemo, useState } from "react";
import { getState, runPipeline, setKey } from "./api";
import { PipelineView } from "./PipelineView";
import type { AppState, PipelineMetrics, TaskView } from "./types";

const MODEL_HINTS: Record<string, string[]> = {
  gemini: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-flash-latest"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  openrouter: ["meta-llama/llama-3.3-70b-instruct:free", "google/gemini-2.0-flash-exp:free"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  ollama: ["qwen2.5-coder", "llama3.2", "mistral"],
};

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null);
  const [provider, setProvider] = useState<string>("claude-code");
  const [model, setModel] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [views, setViews] = useState<TaskView[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [backend, setBackend] = useState<{ name: string; billing: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    getState()
      .then((s) => {
        setState(s);
        setProvider(s.defaultProvider);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const selected = useMemo(
    () => state?.providers.find((p) => p.name === provider),
    [state, provider],
  );

  const needsModel = selected?.needsModelOverride === true;
  const canRun =
    !running &&
    prompt.trim().length > 0 &&
    selected?.ready === true &&
    (!needsModel || model.trim().length > 0);

  async function saveKey(name: string): Promise<void> {
    const value = keyDraft[name] ?? "";
    if (value.trim().length === 0) return;
    try {
      const providers = await setKey(name, value);
      setState((s) => (s ? { ...s, providers } : s));
      setKeyDraft((d) => ({ ...d, [name]: "" }));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    setMetrics(null);
    setViews([]);
    setBackend(null);
    setStatus("Décomposition du prompt…");

    const body: { prompt: string; provider: string; model?: string } = { prompt, provider };
    if (needsModel && model.trim().length > 0) body.model = model.trim();

    try {
      for await (const ev of runPipeline(body)) {
        switch (ev.type) {
          case "backend":
            setBackend({ name: ev.name, billing: ev.billing });
            break;
          case "decomposing":
            setStatus("Décomposition du prompt…");
            break;
          case "pipeline:plan":
            setStatus("Exécution…");
            setViews(ev.tasks.map((task) => ({ task, status: "pending" })));
            break;
          case "task:start":
            setViews((vs) =>
              vs.map((v) =>
                v.task.id === ev.taskId ? { ...v, status: "running", model: ev.model } : v,
              ),
            );
            break;
          case "task:done":
            setViews((vs) =>
              vs.map((v) =>
                v.task.id === ev.taskId
                  ? {
                      ...v,
                      status: "done",
                      summary: ev.result.summary,
                      cost: ev.metrics.referenceCost,
                      billed: ev.metrics.billedCost,
                    }
                  : v,
              ),
            );
            break;
          case "task:failed":
            setViews((vs) =>
              vs.map((v) => (v.task.id === ev.taskId ? { ...v, status: "failed" } : v)),
            );
            break;
          case "pipeline:done":
            setMetrics(ev.metrics);
            setStatus("Terminé.");
            break;
          case "pipeline:failed":
          case "error":
            setError(ev.error);
            setStatus("");
            break;
          case "end":
            setRunning(false);
            break;
          default:
            break;
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span> Relay
        </div>
        <div className="subtitle">orchestrateur de pipeline agentique</div>
      </header>

      {error !== null ? <div className="banner error">⚠ {error}</div> : null}

      <div className="layout">
        <aside className="sidebar">
          <h2>Backends & clés</h2>
          <p className="muted small">Les clés restent sur ta machine (fichier .env).</p>
          <ul className="providers">
            {state?.providers.map((p) => {
              const active = p.name === provider;
              return (
                <li key={p.name} className={`provider ${active ? "active" : ""}`}>
                  <button className="provider-pick" onClick={() => setProvider(p.name)}>
                    <span className={`dot ${p.ready ? "dot-done" : "dot-pending"}`} />
                    <span className="provider-label">{p.label}</span>
                    <span className={`billing billing-${p.billing}`}>{billingLabel(p.billing)}</span>
                  </button>
                  {p.envKey !== undefined ? (
                    <div className="key-row">
                      <input
                        type="password"
                        placeholder={p.ready ? "clé enregistrée — remplacer" : `${p.envKey}…`}
                        value={keyDraft[p.name] ?? ""}
                        onChange={(e) => setKeyDraft((d) => ({ ...d, [p.name]: e.target.value }))}
                      />
                      <button onClick={() => void saveKey(p.name)}>OK</button>
                      {p.keyUrl !== undefined ? (
                        <a href={p.keyUrl} target="_blank" rel="noreferrer" className="small">
                          obtenir
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <div className="muted small no-key">aucune clé requise</div>
                  )}
                </li>
              );
            }) ?? <li className="muted">chargement…</li>}
          </ul>
        </aside>

        <main className="main">
          <section className="run-card">
            <div className="run-head">
              <strong>{selected?.label ?? provider}</strong>
              {needsModel ? (
                <input
                  className="model-input"
                  list="model-hints"
                  placeholder="modèle (ex. gemini-2.0-flash)"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              ) : (
                <span className="muted small">routes par défaut (Haiku / Sonnet / Opus)</span>
              )}
              <datalist id="model-hints">
                {(MODEL_HINTS[provider] ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <textarea
              className="prompt"
              placeholder="Décris ce que tu veux… (ex. ajoute une recherche full-text dans des notes markdown)"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
            />
            <div className="run-actions">
              <button className="run-btn" disabled={!canRun} onClick={() => void run()}>
                {running ? "En cours…" : "Lancer le pipeline"}
              </button>
              {selected?.ready === false ? (
                <span className="muted small">renseigne d'abord la clé de ce backend</span>
              ) : null}
              {status.length > 0 ? <span className="muted small">{status}</span> : null}
              {backend !== null ? (
                <span className="muted small">
                  backend : {backend.name} ({backend.billing})
                </span>
              ) : null}
            </div>
          </section>

          {metrics !== null ? <MetricsBar m={metrics} /> : null}

          <section className="pipeline">
            <PipelineView views={views} />
          </section>
        </main>
      </div>
    </div>
  );
}

function MetricsBar({ m }: { m: PipelineMetrics }): React.JSX.Element {
  const billingWin =
    m.totalReferenceCost > 0 ? ((m.totalReferenceCost - m.totalBilledCost) / m.totalReferenceCost) * 100 : 0;
  return (
    <section className="metrics">
      <Metric label="Payé" value={`$${m.totalBilledCost.toFixed(4)}`} highlight />
      <Metric label="Équivalent API" value={`$${m.totalReferenceCost.toFixed(4)}`} />
      <Metric label="Baseline (deep)" value={`$${m.baselineCost.toFixed(4)}`} />
      <Metric label="Éco. routage" value={`${m.savings.toFixed(1)} %`} />
      <Metric label="Éco. facturation" value={`${billingWin.toFixed(1)} %`} />
      <Metric label="Tokens" value={String(m.totalTokens)} />
      <Metric label="Durée" value={`${m.totalDurationMs} ms`} />
      <Metric label="Tâches" value={`${m.successCount}/${m.taskCount}`} />
    </section>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.JSX.Element {
  return (
    <div className={`metric ${highlight ? "metric-hl" : ""}`}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function billingLabel(b: string): string {
  if (b === "free") return "gratuit";
  if (b === "subscription") return "abonnement";
  return "à l'usage";
}
