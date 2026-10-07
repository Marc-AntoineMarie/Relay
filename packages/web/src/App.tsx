/**
 * Coquille du dashboard : barre du haut, erreurs globales et espace de travail en
 * panneaux libres (dockview) — chaque panneau se déplace (glisser son onglet à gauche,
 * à droite, en haut, en bas ou dans un autre groupe), se redimensionne indépendamment
 * et s'agrandit ; la disposition est mémorisée.
 */
import { useRef } from "react";
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ErrorCard } from "./components";
import { AccountsPanel, ComposerPanel, DetailPanel, MetricsPanel, PipelinePanel, RoutingPanel } from "./panels";
import { BILLING, load, RelayProvider, save, useRelay } from "./store";

const PANELS = {
  accounts: AccountsPanel,
  composer: ComposerPanel,
  routing: RoutingPanel,
  pipeline: PipelinePanel,
  detail: DetailPanel,
  metrics: MetricsPanel,
};

/** Incrémenter si la liste des panneaux change (invalide les dispositions mémorisées). */
const LAYOUT_KEY = "relay.layout.v1";

function defaultLayout(api: DockviewApi): void {
  api.clear();
  api.addPanel({ id: "accounts", component: "accounts", title: "Comptes" });
  api.addPanel({
    id: "pipeline",
    component: "pipeline",
    title: "Pipeline",
    position: { referencePanel: "accounts", direction: "right" },
  });
  api.addPanel({
    id: "composer",
    component: "composer",
    title: "Demande",
    position: { referencePanel: "pipeline", direction: "above" },
  });
  api.addPanel({
    id: "routing",
    component: "routing",
    title: "Modèles",
    position: { referencePanel: "pipeline", direction: "right" },
  });
  api.addPanel({
    id: "detail",
    component: "detail",
    title: "Tâche",
    position: { referencePanel: "routing", direction: "below" },
  });
  api.addPanel({
    id: "metrics",
    component: "metrics",
    title: "Coûts",
    position: { referencePanel: "pipeline", direction: "below" },
  });
  api.getPanel("accounts")?.group.api.setSize({ width: 280 });
  api.getPanel("routing")?.group.api.setSize({ width: 380 });
  api.getPanel("composer")?.group.api.setSize({ height: 170 });
  api.getPanel("metrics")?.group.api.setSize({ height: 140 });
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span> Relay
        </div>
        <div className="subtitle">orchestrateur de pipeline agentique</div>
        <div className="topbar-right">
          {r.selected !== undefined ? (
            <span className={`pill billing-${r.selected.billing}`}>
              {r.selected.label} · {BILLING[r.selected.billing]}
            </span>
          ) : null}
          <button className="ghost-btn" onClick={resetLayout} title="Remettre les panneaux à leur place">
            ⟲ Disposition par défaut
          </button>
        </div>
      </header>

      {r.serverDown ? <div className="banner">Moteur Relay injoignable — reconnexion automatique…</div> : null}

      {r.error !== null ? (
        <div className="error-zone">
          <ErrorCard
            error={r.error}
            onDismiss={() => r.setError(null)}
            {...(r.canRun ? { onRetry: () => void r.run() } : {})}
            {...(!r.isRecommended && r.catalog.suggested !== null ? { onReset: r.resetTiers } : {})}
          />
        </div>
      ) : null}

      <div className="dock">
        <DockviewReact components={PANELS} onReady={onReady} theme={themeDark} className="relay-dock" />
      </div>
    </div>
  );
}
