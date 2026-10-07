/**
 * Coquille du dashboard : barre du haut, erreurs globales, Réglages et espace de
 * travail en panneaux libres (dockview) — chaque panneau se déplace (glisser son
 * onglet), se redimensionne indépendamment et s'agrandit ; la disposition est mémorisée.
 */
import { useEffect, useRef } from "react";
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ErrorCard } from "./components";
import {
  ComposerPanel,
  DetailPanel,
  JournalPanel,
  MetricsPanel,
  PipelinePanel,
  ResultPanel,
  RoutingPanel,
} from "./panels";
import { SettingsView } from "./Settings";
import { ApprovalBar, ExecPanel, FilesPanel, PreviewPanel } from "./workspace-panels";
import { BILLING, load, RelayProvider, save, useRelay } from "./store";

const PANELS = {
  composer: ComposerPanel,
  routing: RoutingPanel,
  pipeline: PipelinePanel,
  detail: DetailPanel,
  result: ResultPanel,
  metrics: MetricsPanel,
  journal: JournalPanel,
  files: FilesPanel,
  exec: ExecPanel,
  preview: PreviewPanel,
};

/** Incrémenter si la liste des panneaux change (invalide les dispositions mémorisées). */
const LAYOUT_KEY = "relay.layout.v5";

function defaultLayout(api: DockviewApi): void {
  api.clear();
  api.addPanel({ id: "routing", component: "routing", title: "Modèles" });
  api.addPanel({ id: "pipeline", component: "pipeline", title: "Pipeline", position: { referencePanel: "routing", direction: "right" } });
  api.addPanel({ id: "composer", component: "composer", title: "Demande", position: { referencePanel: "pipeline", direction: "above" } });
  api.addPanel({ id: "detail", component: "detail", title: "Tâche", position: { referencePanel: "pipeline", direction: "right" } });
  api.addPanel({ id: "files", component: "files", title: "Fichiers", position: { referencePanel: "detail", direction: "within" }, inactive: true });
  api.addPanel({ id: "preview", component: "preview", title: "Aperçu", position: { referencePanel: "detail", direction: "within" }, inactive: true });
  api.addPanel({ id: "result", component: "result", title: "Résultat", position: { referencePanel: "detail", direction: "within" }, inactive: true });
  api.addPanel({ id: "journal", component: "journal", title: "Journal", position: { referencePanel: "pipeline", direction: "below" } });
  api.addPanel({ id: "exec", component: "exec", title: "Exécution", position: { referencePanel: "journal", direction: "within" }, inactive: true });
  api.addPanel({ id: "metrics", component: "metrics", title: "Coûts", position: { referencePanel: "journal", direction: "within" }, inactive: true });
  api.getPanel("routing")?.group.api.setSize({ width: 330 });
  api.getPanel("detail")?.group.api.setSize({ width: 480 });
  api.getPanel("composer")?.group.api.setSize({ height: 150 });
  api.getPanel("journal")?.group.api.setSize({ height: 240 });
}

export default function App(): React.JSX.Element {
  return (
    <RelayProvider>
      <Shell />
    </RelayProvider>
  );
}

function Shell(): React.JSX.Element {
  const r = useRelay();
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = (event: DockviewReadyEvent): void => {
    apiRef.current = event.api;
    const saved = load<Parameters<DockviewApi["fromJSON"]>[0]>(LAYOUT_KEY);
    let restored = false;
    if (saved !== null) {
      try {
        event.api.fromJSON(saved);
        restored = event.api.panels.length > 0;
      } catch {
        restored = false;
      }
    }
    if (!restored) defaultLayout(event.api);
    event.api.onDidLayoutChange(() => save(LAYOUT_KEY, event.api.toJSON()));
  };

  const resetLayout = (): void => {
    const api = apiRef.current;
    if (api === null) return;
    defaultLayout(api);
    save(LAYOUT_KEY, api.toJSON());
  };

  // Aperçu demandé (Fichiers › « Aperçu dans Relay ») : on montre l'onglet.
  useEffect(() => {
    if (r.previewTick > 0) apiRef.current?.getPanel("preview")?.api.setActive();
  }, [r.previewTick]);

  // Erreur remontée en testant : le détail (avec « Corriger avec Relay ») passe devant.
  useEffect(() => {
    if (r.errorTick > 0) apiRef.current?.getPanel("detail")?.api.setActive();
  }, [r.errorTick]);

  // Le livrable final arrive : on montre l'onglet Résultat.
  useEffect(() => {
    if (r.synthesis !== null) apiRef.current?.getPanel("result")?.api.setActive();
  }, [r.synthesis]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span> Relay
        </div>
        <div className="subtitle">orchestrateur de pipeline agentique</div>
        <div className="topbar-right">
          {r.mode === "auto" ? (
            <span className="pill billing-free">
              Auto · {r.usableAccounts.length} compte(s) · {r.usableAccounts.reduce((n, a) => n + a.models.length, 0)} modèles
            </span>
          ) : r.selected !== undefined ? (
            <span className={`pill billing-${r.selected.billing}`}>
              Manuel · {r.selected.label} · {BILLING[r.selected.billing]}
            </span>
          ) : null}
          <button className="ghost-btn" onClick={() => r.openSettings()} title="Comptes, clés, modèles, routage">
            ⚙ Réglages
          </button>
        </div>
      </header>

      {r.serverDown ? <div className="banner">Moteur Relay injoignable — reconnexion automatique…</div> : null}

      <ApprovalBar />

      {r.error !== null ? (
        <div className="error-zone">
          <ErrorCard
            error={r.error}
            onDismiss={() => r.setError(null)}
            {...(r.canRun ? { onRetry: () => void r.run() } : {})}
            {...(r.mode === "manual" && !r.isRecommended && r.catalog.suggested !== null ? { onReset: r.resetTiers } : {})}
          />
        </div>
      ) : null}

      <div className="dock">
        <DockviewReact components={PANELS} onReady={onReady} theme={themeDark} className="relay-dock" />
      </div>

      <SettingsView onResetLayout={resetLayout} />
    </div>
  );
}
