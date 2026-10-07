/**
 * Panneaux du dashboard. Chacun est rendu par dockview dans son propre conteneur
 * (déplaçable, redimensionnable, empilable) et lit l'état partagé via `useRelay`.
 */
import { MetricsBar, TaskDetail, TierPicker } from "./components";
import { ZoomableDag } from "./PipelineView";
import { BILLING, useRelay } from "./store";
import type { Phase, ProviderReadiness } from "./types";

export function AccountsPanel(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="panel">
      <p className="muted small">Connecte tes comptes. Les clés restent sur ta machine (fichier .env).</p>
      <ul className="providers">
        {r.state?.providers.map((p) => (
          <li key={p.name} className={`provider ${p.name === r.provider ? "active" : ""}`}>
            <button className="provider-pick" onClick={() => r.chooseProvider(p.name)} disabled={r.busy}>
              <span className={`dot ${p.ready ? "dot-done" : "dot-pending"}`} />
              <span className="provider-label">{p.label}</span>
              <span className={`billing billing-${p.billing}`}>{BILLING[p.billing]}</span>
            </button>
            {p.envKey !== undefined ? (
              <div className="key-row">
                <input
                  type="password"
                  placeholder={p.ready ? "clé enregistrée · remplacer" : `colle ta clé ${p.envKey}`}
                  value={r.keyDraft[p.name] ?? ""}
                  onChange={(e) => r.setKeyDraft((d) => ({ ...d, [p.name]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void r.saveKey(p.name)}
                />
                <button onClick={() => void r.saveKey(p.name)} disabled={!(r.keyDraft[p.name] ?? "").trim()}>
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
    </div>
  );
}

export function ComposerPanel(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="panel">
      <textarea
        className="prompt"
        placeholder="Décris ce que tu veux… ex. « Crée un parseur CSV en TypeScript avec gestion des erreurs et des tests »"
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
            Lancer le pipeline
          </button>
        )}
        <Stepper phase={r.phase} done={r.doneCount} total={r.views.length} elapsed={r.elapsed} />
        {!r.busy && !r.canRun ? (
          <span className="muted small">{whyDisabled(r.prompt, r.selected, r.tiersComplete)}</span>
        ) : null}
      </div>
    </div>
  );
}

export function RoutingPanel(): React.JSX.Element {
  const r = useRelay();
  const { catalog } = r;
  return (
    <div className="panel">
      <div className="composer-head">
        <strong>{r.selected?.label ?? "Aucun backend"}</strong>
        {r.isRecommended ? <span className="badge ok">recommandé</span> : null}
        {!r.isRecommended && catalog.suggested !== null && !r.busy ? (
          <button className="link" onClick={r.resetTiers}>
            revenir aux recommandés
          </button>
        ) : null}
      </div>
      <span className="muted small">
        {catalog.loading
          ? "détection des modèles…"
          : catalog.models.length > 0
            ? `${catalog.models.length} modèles détectés avec ta clé`
            : r.selected?.ready === false
              ? "ajoute la clé de ce backend pour détecter ses modèles"
              : ""}
      </span>
      {r.tiers !== null ? (
        <TierPicker models={catalog.models} value={r.tiers} disabled={r.busy} onChange={r.changeTiers} />
      ) : (
        <p className="muted small">Sélectionne un backend prêt pour choisir ses modèles.</p>
      )}
      {catalog.error !== undefined && r.selected?.ready === true ? (
        <p className="inline-error">
          ⚠ {catalog.error.title} — {catalog.error.detail}
        </p>
      ) : null}
    </div>
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
      <TaskDetail view={r.selectedView} />
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
  if (p === undefined) return "choisis un backend (panneau Comptes)";
  if (!p.ready) return "ajoute la clé de ce backend (panneau Comptes)";
  if (!tiersComplete) return "choisis un modèle pour chaque tier (panneau Modèles)";
  if (prompt.trim().length === 0) return "écris ta demande";
  return "";
}
