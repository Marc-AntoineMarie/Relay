/**
 * Panneaux de l'espace de travail. Chacun est rendu par dockview dans son propre
 * conteneur (déplaçable, redimensionnable, empilable) et lit l'état partagé via
 * `useRelay`. La gestion des comptes et des clés est dans les Réglages.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MetricsBar, Segmented, TaskDetail, TierPicker, money } from "./components";
import { ZoomableDag } from "./PipelineView";
import { BILLING, useRelay, type Relay } from "./store";
import type { LogEntry, Phase, Strategy } from "./types";
import { ErrorDetail } from "./workspace-panels";

export function ComposerPanel(): React.JSX.Element {
  const r = useRelay();
  const runName = r.workspace?.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <div className="panel">
      {r.workspace !== null && r.settings.agentic && !r.busy ? (
        <div className={`session-chip ${r.continuing ? "on" : ""}`}>
          {r.continuing ? (
            <>
              ↪ Suite dans <code title={r.workspace}>{runName}</code>
              <span className="muted small">les modèles reçoivent le dossier et l'historique du projet</span>
              <button className="link" onClick={() => r.setContinueSession(false)}>
                nouveau projet
              </button>
            </>
          ) : (
            <>
              <span className="muted small">Nouveau projet (nouveau dossier)</span>
              <button className="link" onClick={() => r.setContinueSession(true)}>
                continuer plutôt dans {runName}
              </button>
            </>
          )}
        </div>
      ) : null}
      <textarea
        className="prompt"
        placeholder={
          r.continuing
            ? "Décris la suite ou ce qui ne va pas… ex. « le bouton = ne fait rien », « ajoute un historique des calculs »"
            : "Décris ce que tu veux… ex. « Crée une calculatrice en Python avec ses tests »"
        }
        value={r.prompt}
        onChange={(e) => r.setPrompt(e.target.value)}
        onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && r.canRun && void r.run()}
        disabled={r.busy}
      />
      <div className="run-actions">
        {r.busy ? (
          <button className="stop-btn" onClick={r.stop}>
            Arrêter
          </button>
        ) : (
          <button className="run-btn" disabled={!r.canRun} onClick={() => void r.run()}>
            {r.continuing ? "Continuer" : "Lancer le pipeline"}
          </button>
        )}
        <Stepper phase={r.phase} done={r.doneCount} total={r.taskCount} elapsed={r.elapsed} />
        {r.runInfo !== null ? (
          <span className="muted small">
            {r.runInfo.mode === "auto" ? `auto · ${STRATEGY_LABEL[r.runInfo.strategy ?? "balanced"]}` : "manuel"} ·{" "}
            {r.runInfo.accounts.join(", ") || "aucun compte"}
          </span>
        ) : null}
        {!r.busy && !r.canRun ? <span className="muted small">{whyDisabled(r)}</span> : null}
      </div>
    </div>
  );
}

const STRATEGY_LABEL: Record<Strategy, string> = { economy: "Économie", balanced: "Équilibré", quality: "Qualité" };
const STRATEGY_HINT: Record<Strategy, string> = {
  economy: "Le moins cher qui fait le travail : gratuit d'abord, abonnement et payant en dernier.",
  balanced: "Bon compromis coût / qualité ; peut monter d'un niveau quand c'est utile.",
  quality: "Le meilleur modèle de chaque niveau, même s'il coûte (abonnement, API).",
};

export function RoutingPanel(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="panel">
      <Segmented
        value={r.mode}
        disabled={r.busy}
        onChange={r.setMode}
        options={[
          { value: "auto", label: "Automatique", hint: "Le routeur choisit le modèle de chaque tâche parmi tous tes comptes" },
          { value: "manual", label: "Manuel", hint: "Tu choisis un compte et un modèle par niveau" },
        ]}
      />
      {r.mode === "auto" ? <AutoRouting r={r} /> : <ManualRouting r={r} />}
    </div>
  );
}

function AutoRouting({ r }: { r: Relay }): React.JSX.Element {
  const routed = r.views.filter((v) => v.model !== undefined && v.userError === undefined);
  return (
    <>
      <div className="field">
        <span className="field-label">Stratégie</span>
        <Segmented
          value={r.strategy}
          disabled={r.busy}
          onChange={r.setStrategy}
          options={(["economy", "balanced", "quality"] as const).map((s) => ({ value: s, label: STRATEGY_LABEL[s], hint: STRATEGY_HINT[s] }))}
        />
        <span className="muted small">{STRATEGY_HINT[r.strategy]}</span>
      </div>

      <div className="field">
        <span className="field-label">
          Comptes utilisés
          <button className="link" onClick={() => r.openSettings("routing")}>
            plafonds, budget…
          </button>
        </span>
        {r.pool === null ? (
          <span className="muted small">chargement du pool…</span>
        ) : r.pool.accounts.length === 0 ? (
          <span className="muted small">
            Aucun compte prêt.{" "}
            <button className="link" onClick={() => r.openSettings("accounts")}>
              Ajouter une clé
            </button>
          </span>
        ) : (
          <ul className="accounts compact">
            {r.pool.accounts.map((a) => {
              const policy = r.policyOf(a.name);
              return (
                <li key={a.name} className={`account ${policy.enabled ? "" : "account-off"}`}>
                  <label className="account-head">
                    <input
                      type="checkbox"
                      checked={policy.enabled}
                      disabled={r.busy || a.models.length === 0}
                      onChange={(e) => r.setPolicy(a.name, { ...policy, enabled: e.target.checked })}
                    />
                    <span className="provider-label">{a.label}</span>
                    <span className={`billing billing-${a.billing}`}>{BILLING[a.billing]}</span>
                  </label>
                  <span className="muted small">
                    {a.error !== undefined
                      ? `⚠ ${a.error.title}`
                      : `${a.models.map((m) => `${m.model}${m.health ? ` (${m.health})` : ""}`).join(" · ") || "aucun modèle"}${
                          policy.levels !== undefined && policy.levels.length < 3 ? ` — niveaux : ${policy.levels.join(", ")}` : ""
                        }`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {routed.length > 0 ? (
        <div className="field">
          <span className="field-label">Décisions du routeur</span>
          <ul className="decisions">
            {routed.map((v) => (
              <li key={v.task.id} onClick={() => r.setSelectedId(v.task.id)}>
                <span className={`tier tier-${v.task.tier}`}>{v.task.tier}</span>
                <span className="decision-main">
                  #{v.task.id} → <strong>{v.provider}</strong> · {v.model}
                  {v.fallbackFrom !== undefined ? <span className="badge warn">repli</span> : null}
                </span>
                {v.reason !== undefined ? <span className="muted small decision-why">{v.reason}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ManualRouting({ r }: { r: Relay }): React.JSX.Element {
  const { catalog } = r;
  const ready = r.state?.providers.filter((p) => p.ready) ?? [];
  return (
    <>
      <div className="field">
        <span className="field-label">Compte</span>
        <select value={r.provider} disabled={r.busy} onChange={(e) => r.chooseProvider(e.target.value)}>
          {ready.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label} — {BILLING[p.billing]}
            </option>
          ))}
          {ready.length === 0 ? <option value="">aucun compte prêt</option> : null}
        </select>
      </div>
      <div className="composer-head">
        <span className="field-label">Modèles par niveau</span>
        {r.isRecommended ? <span className="badge ok">recommandé</span> : null}
        {!r.isRecommended && catalog.suggested !== null && !r.busy ? (
          <button className="link" onClick={r.resetTiers}>
            revenir aux recommandés
          </button>
        ) : null}
        <span className="muted small">
          {catalog.loading ? "détection…" : catalog.models.length > 0 ? `${catalog.models.length} détectés` : ""}
        </span>
      </div>
      {r.tiers !== null ? (
        <TierPicker models={catalog.models} value={r.tiers} disabled={r.busy} onChange={r.changeTiers} />
      ) : (
        <p className="muted small">
          Aucun compte prêt.{" "}
          <button className="link" onClick={() => r.openSettings("accounts")}>
            Ajouter une clé
          </button>
        </p>
      )}
      {catalog.error !== undefined && r.selected?.ready === true ? (
        <p className="inline-error">
          ⚠ {catalog.error.title} — {catalog.error.detail}
        </p>
      ) : null}
    </>
  );
}

export function PipelinePanel(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="panel panel-flush">
      <ZoomableDag views={r.views} selectedId={r.selectedView?.task.id ?? null} onSelect={r.setSelectedId} />
    </div>
  );
}

export function DetailPanel(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="panel">
      {r.selectedView?.userError !== undefined ? <ErrorDetail err={r.selectedView.userError} /> : <TaskDetail view={r.selectedView} />}
    </div>
  );
}

export function MetricsPanel(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="panel">
      <MetricsBar m={r.metrics} />
    </div>
  );
}

/** Livrable final assemblé par l'étape de synthèse. */
export function ResultPanel(): React.JSX.Element {
  const r = useRelay();
  const [copied, setCopied] = useState(false);
  const s = r.synthesis;
  if (s === null) {
    return (
      <div className="panel">
        <p className="muted dag-empty">
          {!r.settings.synthesis
            ? "Synthèse désactivée (Réglages › Routage)."
            : r.busy
              ? "Le livrable final apparaîtra ici à la fin du run."
              : "Lance un pipeline : le compte rendu final (fichiers, comment lancer et tester) s'affichera ici."}
        </p>
      </div>
    );
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(s.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="panel result">
      <div className="result-head">
        <span className="muted small">
          assemblé par {s.provider} · {s.model} · {money(s.metrics.billedCost)} payé · {money(s.metrics.referenceCost)} équiv.
        </span>
        <button onClick={copy}>{copied ? "Copié ✓" : "Copier"}</button>
      </div>
      <pre className="output result-text">{s.text}</pre>
    </div>
  );
}

// ── Journal ─────────────────────────────────────────────────────────────────

type LogFilter = "all" | "plan" | "route" | "model" | "tool" | "fallback" | "error";

const LOG_FILTERS: Array<{ value: LogFilter; label: string }> = [
  { value: "all", label: "Tout" },
  { value: "plan", label: "Plan" },
  { value: "route", label: "Routage" },
  { value: "model", label: "Modèle" },
  { value: "tool", label: "Actions" },
  { value: "fallback", label: "Replis" },
  { value: "error", label: "Erreurs" },
];

const LOG_ICON: Record<LogEntry["category"], string> = {
  plan: "🗺",
  route: "🧭",
  request: "➜",
  response: "✓",
  fallback: "↺",
  tool: "⚙",
  error: "✖",
  info: "ℹ",
};

function matches(e: LogEntry, f: LogFilter): boolean {
  if (f === "all") return true;
  if (f === "model") return e.category === "request" || e.category === "response";
  if (f === "error") return e.level === "error";
  return e.category === f;
}

const time = (at: number): string => new Date(at).toLocaleTimeString("fr-FR", { hour12: false });

export function JournalPanel(): React.JSX.Element {
  const r = useRelay();
  const [filter, setFilter] = useState<LogFilter>("all");
  const [taskFilter, setTaskFilter] = useState("");
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return r.logs
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => matches(entry, filter))
      .filter(({ entry }) => taskFilter === "" || entry.taskId === taskFilter)
      .filter(({ entry }) => q === "" || `${entry.title}\n${entry.detail ?? ""}`.toLowerCase().includes(q));
  }, [r.logs, filter, taskFilter, query]);

  // Défile avec le flux tant que l'utilisateur est en bas de la liste.
  useEffect(() => {
    const el = listRef.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const taskIds = [...new Set(r.logs.map((e) => e.taskId).filter((id): id is string => id !== undefined))];

  const exportLogs = (): void => {
    const blob = new Blob([r.logs.map((e) => JSON.stringify(e)).join("\n")], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `relay-journal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggle = (i: number): void =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="panel panel-flush journal">
      <div className="journal-tools">
        <Segmented value={filter} onChange={setFilter} options={LOG_FILTERS} />
        <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)} aria-label="Filtrer par tâche">
          <option value="">toutes les tâches</option>
          {taskIds.map((id) => (
            <option key={id} value={id}>
              tâche #{id}
            </option>
          ))}
        </select>
        <input className="journal-search" placeholder="rechercher…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="muted small raw-toggle">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> vue brute
        </label>
        <button onClick={exportLogs} disabled={r.logs.length === 0}>
          Exporter
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted dag-empty">
          {r.logs.length === 0 ? "Le journal se remplira pendant l'exécution." : "Aucune entrée pour ce filtre."}
        </p>
      ) : (
        <ol
          ref={listRef}
          className="log-list"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {shown.map(({ entry, index }) => {
            const expanded = raw || open.has(index);
            return (
              <li key={index} className={`log log-${entry.level}`}>
                <button className="log-line" onClick={() => toggle(index)} disabled={raw}>
                  <span className="log-time">{time(entry.at)}</span>
                  <span className="log-icon">{LOG_ICON[entry.category]}</span>
                  <span className="log-title">{entry.title}</span>
                  {entry.detail !== undefined && !raw ? <span className="log-more">{expanded ? "▾" : "▸"}</span> : null}
                </button>
                {expanded && (raw || entry.detail !== undefined) ? (
                  <pre className="log-detail">{raw ? JSON.stringify(entry, null, 2) : entry.detail}</pre>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ── Aides ───────────────────────────────────────────────────────────────────

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

function whyDisabled(r: Relay): string {
  if (r.mode === "auto") {
    if (r.usableAccounts.length === 0) return "aucun compte utilisable : ajoute une clé (⚙ Réglages) ou active un compte (panneau Modèles)";
  } else {
    const p = r.selected;
    if (p === undefined || !p.ready) return "choisis un compte prêt (panneau Modèles) ou ajoute une clé (⚙ Réglages)";
    if (!r.tiersComplete) return "choisis un modèle pour chaque niveau (panneau Modèles)";
  }
  if (r.prompt.trim().length === 0) return "écris ta demande";
  return "";
}
