import {
  TIERS,
  type Capability,
  type ErrorDescription,
  type PipelineMetrics,
  type TaskView,
  type Tier,
  type TierModels,
} from "./types";

export const CAP_LABEL: Record<Capability, string> = {
  code: "code",
  reasoning: "raisonnement",
  long_context: "long contexte",
  web: "web",
  fast: "rapide",
};

export function NeedsChips({ needs }: { needs: Capability[] | undefined }): React.JSX.Element | null {
  if (needs === undefined || needs.length === 0) return null;
  return (
    <span className="chips">
      {needs.map((n) => (
        <span key={n} className={`chip chip-${n}`}>
          {CAP_LABEL[n]}
        </span>
      ))}
    </span>
  );
}

/** Choix exclusif compact (mode, stratégie…). */
export function Segmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  disabled?: boolean;
  onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup">
      {props.options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={props.value === o.value}
          className={props.value === o.value ? "on" : ""}
          disabled={props.disabled}
          title={o.hint}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const TIER_INFO: Record<Tier, { label: string; hint: string }> = {
  quick: { label: "Quick", hint: "tâches mécaniques" },
  build: { label: "Build", hint: "code standard · plan" },
  deep: { label: "Deep", hint: "architecture, cas durs" },
};

export const money = (n: number): string => `$${n.toFixed(4)}`;

export function TierPicker(props: {
  models: string[];
  value: TierModels;
  disabled: boolean;
  onChange: (next: TierModels) => void;
}): React.JSX.Element {
  const { models, value, disabled, onChange } = props;
  return (
    <div className="tiers">
      {TIERS.map((t) => {
        // La valeur courante reste sélectionnable même si elle n'est pas (plus) détectée.
        const options = value[t] && !models.includes(value[t]) ? [value[t], ...models] : models;
        return (
          <label key={t} className="tier-pick">
            <span className="tier-pick-head">
              <span className={`tier tier-${t}`}>{TIER_INFO[t].label}</span>
              <span className="muted small">{TIER_INFO[t].hint}</span>
            </span>
            {models.length > 0 ? (
              <select value={value[t]} disabled={disabled} onChange={(e) => onChange({ ...value, [t]: e.target.value })}>
                {options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={value[t]}
                disabled={disabled}
                placeholder="id du modèle"
                onChange={(e) => onChange({ ...value, [t]: e.target.value })}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export function ErrorCard(props: {
  error: ErrorDescription;
  onRetry?: () => void;
  onReset?: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const { error, onRetry, onReset, onDismiss } = props;
  return (
    <section className="error-card" role="alert">
      <div className="error-head">
        <span className="error-icon">!</span>
        <strong>{error.title}</strong>
        <button className="ghost" onClick={onDismiss} aria-label="Fermer">
          ×
        </button>
      </div>
      <p className="error-detail">{error.detail}</p>
      {error.hint !== undefined ? <p className="error-hint">→ {error.hint}</p> : null}
      {onRetry !== undefined || onReset !== undefined ? (
        <div className="error-actions">
          {onRetry !== undefined ? <button onClick={onRetry}>Réessayer</button> : null}
          {onReset !== undefined ? <button onClick={onReset}>Revenir aux modèles recommandés</button> : null}
        </div>
      ) : null}
    </section>
  );
}

export function MetricsBar({ m }: { m: PipelineMetrics | null }): React.JSX.Element {
  const v = (s: string): string => (m === null ? "—" : s);
  return (
    <section className="metrics">
      <Metric label="Payé" value={v(money(m?.totalBilledCost ?? 0))} tone="good" />
      <Metric label="Équivalent API" value={v(money(m?.totalReferenceCost ?? 0))} />
      <Metric label="Si tout en deep" value={v(money(m?.baselineCost ?? 0))} />
      <Metric label="Économie" value={v(`${(m?.savings ?? 0).toFixed(1)} %`)} tone="good" />
      <Metric label="Tokens" value={v(String(m?.totalTokens ?? 0))} />
      <Metric label="Durée" value={v(`${((m?.totalDurationMs ?? 0) / 1000).toFixed(1)} s`)} />
      <Metric label="Tâches" value={v(`${m?.successCount ?? 0}/${m?.taskCount ?? 0}`)} />
    </section>
  );
}

function Metric(props: { label: string; value: string; tone?: "good" }): React.JSX.Element {
  return (
    <div className={`metric ${props.tone === "good" ? "metric-good" : ""}`}>
      <div className="metric-value">{props.value}</div>
      <div className="metric-label">{props.label}</div>
    </div>
  );
}

const STATUS_LABEL: Record<TaskView["status"], string> = {
  pending: "en attente",
  running: "en cours",
  done: "terminée",
  failed: "échec",
};

export function TaskDetail({ view }: { view: TaskView | undefined }): React.JSX.Element {
  if (view === undefined) {
    return (
      <aside className="detail detail-empty">
        <p className="muted">Clique sur une tâche du graphe pour voir son modèle, son coût et son résultat.</p>
      </aside>
    );
  }
  const m = view.metrics;
  return (
    <aside className="detail">
      <div className="detail-head">
        <span className={`tier tier-${view.task.tier}`}>{view.task.tier}</span>
        <span className="muted small">
          #{view.task.id} · {view.task.type}
        </span>
        <span className={`status status-${view.status}`}>{STATUS_LABEL[view.status]}</span>
      </div>
      <h3 className="detail-title">{view.task.description}</h3>
      <NeedsChips needs={view.task.needs} />
      <dl className="kv">
        <dt>Modèle</dt>
        <dd>
          {view.provider !== undefined ? `${view.provider} · ` : ""}
          {view.model ?? "—"}
          {view.fallbackFrom !== undefined ? <span className="badge warn">repli (au lieu de {view.fallbackFrom})</span> : null}
        </dd>
        {view.reason !== undefined ? (
          <>
            <dt>Pourquoi</dt>
            <dd>{view.reason}</dd>
          </>
        ) : null}
        {view.alternatives !== undefined && view.alternatives.length > 0 ? (
          <>
            <dt>Replis prévus</dt>
            <dd>{view.alternatives.map((a) => `${a.provider} · ${a.model}`).join("  →  ")}</dd>
          </>
        ) : null}
        {m !== undefined ? (
          <>
            <dt>Coût</dt>
            <dd>{m.billedCost > 0 ? money(m.billedCost) : `${money(0)} payé · ${money(m.referenceCost)} équiv. API`}</dd>
            <dt>Tokens</dt>
            <dd>
              {m.inputTokens} entrée · {m.outputTokens} sortie
              {m.thinkingTokens > 0 ? ` · ${m.thinkingTokens} réflexion` : ""}
            </dd>
            <dt>Durée</dt>
            <dd>{(m.durationMs / 1000).toFixed(1)} s</dd>
          </>
        ) : null}
      </dl>
      {view.error !== undefined ? <p className="detail-error">{view.error}</p> : null}
      {view.truncated === true ? <p className="badge warn">Sortie tronquée (limite de tokens atteinte)</p> : null}
      <pre className="output">{view.output || (view.status === "running" ? "Génération en cours…" : "—")}</pre>
    </aside>
  );
}
