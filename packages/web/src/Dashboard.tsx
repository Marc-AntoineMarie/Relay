/**
 * Phase H : tableau de bord (inspiré de Paperclip) et réglages des métriques.
 *
 * Tout vient du registre d'usage (chaque appel de modèle, réussi ou non) ; chaque chiffre dit
 * comment il est calculé. Graphiques en SVG simple : barres fines, infobulle au survol,
 * palette validée (daltonisme) sur le fond sombre de Relay.
 */
import { useEffect, useMemo, useState } from "react";
import { getBalances, getPrices, getUsage, resetUsage, USAGE_EXPORT_URL } from "./api";
import { Segmented } from "./components";
import { useRelay } from "./store";
import type { Period, PriceRow, UsageSummary } from "./types";

/** $ lisible : 4 décimales pour les centimes, 2 au-delà de 1 $. */
export const usd = (n: number): string => (n === 0 ? "$0" : Math.abs(n) < 0.01 ? `$${n.toFixed(4)}` : Math.abs(n) < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const int = (n: number): string => n.toLocaleString("fr-FR");
const secs = (ms: number | null | undefined): string => (ms === null || ms === undefined ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const ago = (t: number): string => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "day", label: "Aujourd'hui" },
  { value: "7d", label: "7 jours" },
  { value: "30d", label: "30 jours" },
  { value: "all", label: "Tout" },
];

const PURPOSE: Record<string, string> = { plan: "Planification", task: "Tâches", synthesis: "Synthèse", memory: "Mémoire", other: "Autre" };
/** Ordre fixe des usages = ordre fixe des couleurs (jamais recyclées). */
const PURPOSE_ORDER = ["task", "plan", "synthesis", "memory", "other"];
const OUTCOME: Record<string, { label: string; cls: string }> = {
  done: { label: "terminé", cls: "ok" },
  failed: { label: "échec", cls: "err" },
  stopped: { label: "arrêté", cls: "warn" },
  questions: { label: "questions", cls: "warn" },
  error: { label: "erreur", cls: "err" },
};

// ── Tableau de bord ────────────────────────────────────────────────────────

export function DashboardView(): React.JSX.Element | null {
  const r = useRelay();
  const [period, setPeriod] = useState<Period>("7d");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, { ok: boolean; detail: string }> | null>(null);

  useEffect(() => {
    if (!r.dashboardOpen) return;
    let cancelled = false;
    getUsage(period).then(
      (d) => !cancelled && (setData(d), setError(null)),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [r.dashboardOpen, period, r.usageTick]);

  useEffect(() => {
    if (!r.dashboardOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") r.closeDashboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [r.dashboardOpen, r]);

  if (!r.dashboardOpen) return null;
  const label = (name: string): string => r.state?.providers.find((p) => p.name === name)?.label ?? name;
  const t = data?.totals;

  return (
    <div className="settings-overlay" role="dialog" aria-label="Tableau de bord" onClick={r.closeDashboard}>
      <div className="dashboard" onClick={(e) => e.stopPropagation()}>
        <header className="dash-head">
          <h2>Tableau de bord</h2>
          <Segmented value={period} onChange={setPeriod} options={PERIODS} />
          <a className="ghost-btn" href={USAGE_EXPORT_URL} download>
            Exporter (CSV)
          </a>
          <button className="ghost-btn" onClick={() => r.openSettings("metrics")}>
            Réglages des métriques
          </button>
          <button className="ghost settings-close" onClick={r.closeDashboard} aria-label="Fermer">
            ×
          </button>
        </header>

        {error !== null ? <p className="inline-error">⚠ {error}</p> : null}
        {data === null || t === undefined ? (
          <p className="muted">Chargement…</p>
        ) : (
          <div className="dash-body">
            <BudgetBar budget={data.budget} onSettings={() => r.openSettings("metrics")} />

            <section className="kpis">
              <Kpi label="Payé réellement" value={usd(t.billed)} sub="comptes à l'usage" how="Somme de ce que les comptes facturés à l'usage ont réellement coûté. Gratuit et abonnement comptent 0 $ (l'abonnement se paie à part)." />
              <Kpi label="Équivalent API" value={usd(t.reference)} sub="au prix public des modèles utilisés" how="Tokens de chaque appel × prix public de référence de son modèle (Réglages › Métriques). Ce que tout cela aurait coûté sans palier gratuit ni abonnement." />
              <Kpi label="Référence" value={usd(t.baseline)} sub={`si tout passait par ${data.baselineModel}`} how={`Mêmes tokens × prix de ${data.baselineModel}. Hypothèse simplificatrice : un autre modèle n'aurait pas produit exactement le même nombre de tokens.`} />
              <Kpi
                label="Économie"
                value={usd(t.totalSavings)}
                sub={`dont routage ${usd(t.routingSavings)}`}
                tone="good"
                how={`Économie totale = « si tout passait par ${data.baselineModel} » − payé. Dont routage = référence − équivalent API (gain du choix de modèles moins chers) ; le reste vient des comptes gratuits ou de l'abonnement.`}
              />
              <Kpi
                label="Runs réussis"
                value={`${t.runsDone}/${t.runs}`}
                sub={t.launchChecked > 0 ? `démarrage vérifié ${t.launchOk}/${t.launchChecked}` : "aucune vérification de lancement"}
                how="Runs terminés sur runs lancés. « Démarrage vérifié » : Relay a lancé lui-même la commande du projet en fin de run (8 s)."
              />
              <Kpi
                label="Appels de modèles"
                value={int(t.calls)}
                sub={t.failed > 0 ? `${t.failed} en échec, dont ${t.rateLimited} quota` : "aucun échec"}
                how="Chaque requête à un modèle, réussie ou non : plan, tâches (replis et escalades compris), synthèse, mémoire du projet."
              />
              <Kpi label="Tokens" value={int(t.inputTokens + t.outputTokens)} sub={`${int(t.inputTokens)} lus · ${int(t.outputTokens)} écrits${t.thinkingTokens ? ` (dont ${int(t.thinkingTokens)} réflexion)` : ""}`} how="Tokens annoncés par les fournisseurs (lus = envoyés au modèle, écrits = sa réponse, réflexion comprise)." />
            </section>

            <section className="dash-grid">
              <div className="dash-card">
                <h3>Équivalent API par jour</h3>
                <DailyChart days={data.daily} />
              </div>
              <div className="dash-card">
                <h3>Où va le travail</h3>
                <PurposeBar rows={data.byPurpose} />
                <p className="muted small">
                  Part de l'équivalent API par usage. L'<strong>orchestration</strong> (planification, synthèse, mémoire) est
                  le coût de Relay lui-même ; les <strong>tâches</strong> sont le travail demandé.
                </p>
              </div>
            </section>

            <section className="dash-card">
              <div className="card-head">
                <h3>Comptes</h3>
                <button className="link" onClick={() => void getBalances().then(setBalances, () => setBalances({}))}>
                  vérifier les soldes (OpenRouter, DeepSeek)
                </button>
              </div>
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Compte</th>
                    <th className="num">Appels</th>
                    <th className="num">Échecs</th>
                    <th className="num">Tokens</th>
                    <th className="num">Payé</th>
                    <th className="num">Équivalent API</th>
                    <th className="num" title="Temps médian avant le premier morceau de réponse (file d'attente comprise)">1re réponse</th>
                    <th>Quota annoncé</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProvider.map((p) => (
                    <tr key={p.provider}>
                      <td>
                        {label(p.provider)} <span className={`billing billing-${p.billing}`}>{p.billing === "free" ? "gratuit" : p.billing === "subscription" ? "abonnement" : "à l'usage"}</span>
                      </td>
                      <td className="num">{int(p.calls)}</td>
                      <td className="num">{p.failed > 0 ? `${p.failed}${p.rateLimited ? ` (${p.rateLimited} quota)` : ""}` : "—"}</td>
                      <td className="num">{int(p.tokens)}</td>
                      <td className="num">{usd(p.billed)}</td>
                      <td className="num">{usd(p.reference)}</td>
                      <td className="num">{secs(p.medianFirstChunkMs)}</td>
                      <td className="small">
                        <QuotaCell q={p.quota} />
                        {balances?.[p.provider] ? <div className="muted small">{balances[p.provider]?.detail}</div> : null}
                      </td>
                    </tr>
                  ))}
                  {data.byProvider.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="muted">
                        Aucun appel sur cette période.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <p className="muted small">
                Quota annoncé : ce que le fournisseur renvoie dans ses en-têtes (Groq, OpenAI, NVIDIA…) au dernier appel. Gemini
                n'en envoie pas : ses limites se voient aux échecs « quota ».
              </p>
            </section>

            <section className="dash-grid">
              <div className="dash-card">
                <h3>Modèles les plus utilisés</h3>
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Modèle</th>
                      <th className="num">Appels</th>
                      <th className="num">Échecs</th>
                      <th className="num">Équivalent</th>
                      <th className="num">1re réponse</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.slice(0, 10).map((m) => (
                      <tr key={`${m.provider}/${m.model}`}>
                        <td>
                          <code>{m.model}</code> <span className="muted small">{label(m.provider)}</span>
                        </td>
                        <td className="num">{int(m.calls)}</td>
                        <td className="num">{m.failed || "—"}</td>
                        <td className="num">{usd(m.reference)}</td>
                        <td className="num">{secs(m.medianFirstChunkMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="dash-card">
                <h3>Projets</h3>
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Projet</th>
                      <th className="num">Runs</th>
                      <th className="num">Équivalent</th>
                      <th className="num">Payé</th>
                      <th>Dernier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byProject.map((p) => (
                      <tr key={p.project}>
                        <td>
                          <code>{p.project}</code>
                        </td>
                        <td className="num">{p.runs}</td>
                        <td className="num">{usd(p.reference)}</td>
                        <td className="num">{usd(p.billed)}</td>
                        <td className="muted small">{ago(p.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="dash-card">
              <h3>Activité récente</h3>
              <ul className="activity">
                {data.recentRuns.map((run) => {
                  const o = OUTCOME[run.outcome] ?? { label: run.outcome, cls: "" };
                  return (
                    <li key={run.runId}>
                      <button
                        disabled={!run.root || r.busy}
                        onClick={() => {
                          r.loadProject(run.root);
                          r.closeDashboard();
                        }}
                        title={run.root ? "Ouvrir ce projet" : undefined}
                      >
                        <span className="muted small act-time">{ago(run.at)}</span>
                        <span className={`badge ${o.cls}`}>{o.label}</span>
                        <code className="act-project">{run.project || "—"}</code>
                        <span className="act-prompt">{run.prompt}</span>
                        <span className="muted small act-meta">
                          {run.launchOk === true ? "▶ démarre · " : run.launchOk === false ? "⚠ ne démarre pas · " : ""}
                          {run.calls} appels · {usd(run.reference)} équiv. · {usd(run.billed)} payé · {Math.round(run.durationMs / 1000)} s
                        </span>
                      </button>
                    </li>
                  );
                })}
                {data.recentRuns.length === 0 ? <li className="muted">Aucun run sur cette période.</li> : null}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi(props: { label: string; value: string; sub: string; how: string; tone?: "good" }): React.JSX.Element {
  return (
    <div className={`kpi ${props.tone === "good" ? "kpi-good" : ""}`}>
      <span className="kpi-label">{props.label}</span>
      <strong className="kpi-value">{props.value}</strong>
      <span className="muted small">{props.sub}</span>
      <details className="kpi-how">
        <summary>comment c'est calculé</summary>
        <p>{props.how}</p>
      </details>
    </div>
  );
}

function QuotaCell({ q }: { q: UsageSummary["byProvider"][number]["quota"] }): React.JSX.Element {
  if (q === undefined) return <span className="muted">—</span>;
  const parts = [
    q.remainingRequests !== undefined ? `${int(q.remainingRequests)}${q.limitRequests ? ` / ${int(q.limitRequests)}` : ""} requêtes` : "",
    q.remainingTokens !== undefined ? `${int(q.remainingTokens)}${q.limitTokens ? ` / ${int(q.limitTokens)}` : ""} tokens` : "",
  ].filter(Boolean);
  return (
    <span title={`relevé ${ago(q.at)}${q.resetTokens ? ` · tokens rechargés dans ${q.resetTokens}` : ""}${q.resetRequests ? ` · requêtes dans ${q.resetRequests}` : ""}`}>
      {parts.join(" · ") || "—"} <span className="muted">({ago(q.at)})</span>
    </span>
  );
}

function BudgetBar({ budget, onSettings }: { budget: UsageSummary["budget"]; onSettings: () => void }): React.JSX.Element {
  if (budget.monthly === null) {
    return (
      <p className="muted small">
        Pas de budget mensuel.{" "}
        <button className="link" onClick={onSettings}>
          En définir un
        </button>{" "}
        (au-delà, Relay n'utilise plus que les comptes gratuits et l'abonnement).
      </p>
    );
  }
  const pct = budget.monthly > 0 ? Math.min(100, (budget.spentThisMonth / budget.monthly) * 100) : 100;
  const state = budget.exceeded ? { cls: "critical", icon: "⛔", text: "atteint : comptes payants exclus" } : budget.alert ? { cls: "warning", icon: "⚠", text: `au-delà de ${budget.alertPct} %` } : { cls: "good", icon: "✓", text: "dans le budget" };
  return (
    <div className={`budget budget-${state.cls}`}>
      <span>
        {state.icon} Budget du mois : <strong>{usd(budget.spentThisMonth)}</strong> / {usd(budget.monthly)} — {state.text}
      </span>
      <span className="budget-track" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <span className="budget-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/** Barres verticales : une par jour (une seule série → pas de légende, le titre la nomme). */
function DailyChart({ days }: { days: UsageSummary["daily"] }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  if (days.length === 0) return <p className="muted small">Aucune donnée sur cette période.</p>;
  const W = 560;
  const H = 180;
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const max = Math.max(...days.map((d) => d.reference), 1e-9);
  const slot = (W - pad.l - pad.r) / days.length;
  const bar = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number): number => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const h = hover !== null ? days[hover] : undefined;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Équivalent API par jour">
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={pad.l - 6} y={y(v) + 4} textAnchor="end">
              {usd(v)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * slot + (slot - bar) / 2;
          const top = y(d.reference);
          const height = Math.max(0, H - pad.b - top);
          const r = Math.min(4, bar / 2, height);
          return (
            <g key={d.day}>
              {height > 0 ? (
                <path
                  className={`bar ${hover === i ? "on" : ""}`}
                  d={`M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + bar - r} Q${x + bar},${top} ${x + bar},${top + r} V${H - pad.b} Z`}
                />
              ) : null}
              {/* Zone de survol plus large que la barre */}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              {days.length <= 10 || i % Math.ceil(days.length / 8) === 0 ? (
                <text className="axis" x={pad.l + i * slot + slot / 2} y={H - 8} textAnchor="middle">
                  {d.day.slice(5).replace("-", "/")}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {h !== undefined && hover !== null ? (
        <div className="tooltip" style={{ left: `${((pad.l + hover * slot + slot / 2) / W) * 100}%` }}>
          <strong>{h.day}</strong>
          <span>{usd(h.reference)} équivalent API</span>
          <span>{usd(h.billed)} payé · {usd(h.baseline)} si tout en référence</span>
          <span>
            {h.calls} appels{h.failed ? `, ${h.failed} en échec` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Barre empilée 100 % par usage : ≤ 5 segments, légende + étiquettes directes, 2 px d'écart. */
function PurposeBar({ rows }: { rows: UsageSummary["byPurpose"] }): React.JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  const ordered = useMemo(() => PURPOSE_ORDER.map((p) => rows.find((r) => r.purpose === p)).filter((r): r is UsageSummary["byPurpose"][number] => r !== undefined), [rows]);
  const total = ordered.reduce((n, r) => n + r.reference, 0);
  if (total <= 0) return <p className="muted small">Aucune donnée sur cette période.</p>;
  const h = ordered.find((r) => r.purpose === hover);
  return (
    <div className="purpose">
      <div className="stack" role="img" aria-label="Répartition de l'équivalent API par usage">
        {ordered.map((r) => {
          const pct = (r.reference / total) * 100;
          return (
            <span
              key={r.purpose}
              className={`seg seg-${r.purpose}`}
              style={{ flexGrow: pct, flexBasis: 0 }}
              onMouseEnter={() => setHover(r.purpose)}
              onMouseLeave={() => setHover(null)}
            >
              {pct >= 12 ? `${Math.round(pct)} %` : ""}
            </span>
          );
        })}
      </div>
      <ul className="legend">
        {ordered.map((r) => (
          <li key={r.purpose} className={hover === r.purpose ? "on" : ""}>
            <span className={`swatch seg-${r.purpose}`} />
            {PURPOSE[r.purpose] ?? r.purpose} <span className="muted">{Math.round((r.reference / total) * 100)} % · {usd(r.reference)} · {r.calls} appels</span>
          </li>
        ))}
      </ul>
      {h !== undefined ? (
        <p className="muted small">
          {PURPOSE[h.purpose] ?? h.purpose} : {h.calls} appels, {int(h.tokens)} tokens, {usd(h.reference)} équivalent API, {usd(h.billed)} payé.
        </p>
      ) : null}
    </div>
  );
}

// ── Réglages › Métriques ──────────────────────────────────────────────────

const BASELINES = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5"];

export function MetricsSection(): React.JSX.Element {
  const r = useRelay();
  const s = r.settings;
  const [prices, setPrices] = useState<{ reviewed: string; table: PriceRow[] } | null>(null);
  const [budgetDraft, setBudgetDraft] = useState(s.budgetMonthly === null ? "" : String(s.budgetMonthly));
  const [baselineDraft, setBaselineDraft] = useState(s.baselineModel);
  const [confirmReset, setConfirmReset] = useState(false);

  const loadPrices = (): void => void getPrices().then(setPrices, () => setPrices(null));
  useEffect(loadPrices, [s.priceOverrides]);
  useEffect(() => setBaselineDraft(s.baselineModel), [s.baselineModel]);

  const setPrice = (family: string, field: "inputPerM" | "outputPerM", value: string, row: PriceRow): void => {
    const n = Number.parseFloat(value.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return;
    const current = s.priceOverrides[family] ?? { inputPerM: row.inputPerM, outputPerM: row.outputPerM };
    r.updateSettings({ priceOverrides: { ...s.priceOverrides, [family]: { ...current, [field]: n } } });
  };
  const resetPrice = (family: string): void => {
    const { [family]: _drop, ...rest } = s.priceOverrides;
    r.updateSettings({ priceOverrides: rest });
  };

  return (
    <section>
      <h3>Métriques</h3>
      <p className="muted small">
        Chaque appel de modèle (réussi ou non) est enregistré dans <code>.relay/relay.db</code>, sur ta machine. Le tableau de
        bord, le budget et l'export en découlent.{" "}
        <button className="link" onClick={r.openDashboard}>
          Ouvrir le tableau de bord
        </button>
      </p>

      <div className="setting-row">
        <div>
          <strong>Modèle de référence (économies)</strong>
          <p className="muted small">
            « Et si tout était passé par ce modèle ? » : les mêmes tokens, à son prix. L'économie affichée en découle. Choisis
            ce que tu aurais utilisé sans Relay.
          </p>
        </div>
        <div className="baseline-pick">
          <input list="baselines" value={baselineDraft} onChange={(e) => setBaselineDraft(e.target.value)} onBlur={() => baselineDraft.trim() && baselineDraft !== s.baselineModel && r.updateSettings({ baselineModel: baselineDraft.trim() })} />
          <datalist id="baselines">
            {[...new Set([...BASELINES, ...(r.pool?.accounts.flatMap((a) => a.models.map((m) => m.model)) ?? [])])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="setting-row">
        <div>
          <strong>Budget mensuel</strong>
          <p className="muted small">
            Dépense réelle maximum par mois (comptes à l'usage). Au seuil d'alerte, un avertissement s'affiche ; une fois le
            budget atteint, le routeur n'utilise plus que les comptes gratuits et l'abonnement. S'ajoute au budget par run
            (Réglages › Routage).
          </p>
        </div>
        <div className="budget-fields">
          <label className="muted small">
            $
            <input
              type="number"
              min={0}
              step={0.5}
              placeholder="illimité"
              value={budgetDraft}
              onChange={(e) => setBudgetDraft(e.target.value)}
              onBlur={() => {
                const n = Number.parseFloat(budgetDraft);
                r.updateSettings({ budgetMonthly: Number.isFinite(n) && n >= 0 ? n : null });
              }}
            />
          </label>
          <label className="muted small">
            alerte à
            <input
              type="number"
              min={1}
              max={100}
              value={s.budgetAlertPct}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (n >= 1 && n <= 100) r.updateSettings({ budgetAlertPct: n });
              }}
            />
            %
          </label>
        </div>
      </div>

      <h4>Prix de référence</h4>
      <p className="muted small">
        Prix publics approximatifs ($ par million de tokens) pour comparer les modèles et calculer l'« équivalent API » —
        <strong> pas une facture</strong>. Revue du catalogue : {prices?.reviewed ?? "…"}. Modifie un prix si tu connais le
        tarif exact : l'équivalent API et la référence sont recalculés partout (le montant payé reste celui du moment de
        l'appel).
      </p>
      {prices === null ? (
        <p className="muted small">Chargement…</p>
      ) : (
        <table className="dash-table prices">
          <thead>
            <tr>
              <th>Famille</th>
              <th>Niveau</th>
              <th className="num">Entrée $/M</th>
              <th className="num">Sortie $/M</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {prices.table.map((row) => (
              <tr key={row.family}>
                <td>{row.family}</td>
                <td>
                  <span className={`tier tier-${row.level}`}>{row.level}</span>
                </td>
                <td className="num">
                  <input type="number" min={0} step={0.01} defaultValue={row.inputPerM} key={`${row.family}-in-${row.inputPerM}`} onBlur={(e) => setPrice(row.family, "inputPerM", e.target.value, row)} />
                </td>
                <td className="num">
                  <input type="number" min={0} step={0.01} defaultValue={row.outputPerM} key={`${row.family}-out-${row.outputPerM}`} onBlur={(e) => setPrice(row.family, "outputPerM", e.target.value, row)} />
                </td>
                <td className="small">
                  {row.source === "personnalisé" ? (
                    <>
                      <span className="badge warn">personnalisé</span>{" "}
                      <button className="link" onClick={() => resetPrice(row.family)} title={`catalogue : ${row.defaultInputPerM} / ${row.defaultOutputPerM}`}>
                        rétablir
                      </button>
                    </>
                  ) : (
                    <span className="muted">catalogue Relay</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Données</h4>
      <div className="setting-row">
        <div>
          <strong>Historique d'usage</strong>
          <p className="muted small">Export complet (une ligne par appel, coûts recalculés) ou remise à zéro.</p>
        </div>
        <div className="data-actions">
          <a className="ghost-btn" href={USAGE_EXPORT_URL} download>
            Exporter (CSV)
          </a>
          {confirmReset ? (
            <>
              <button className="stop-btn" onClick={() => void resetUsage().then(() => setConfirmReset(false))}>
                Confirmer l'effacement
              </button>
              <button onClick={() => setConfirmReset(false)}>Annuler</button>
            </>
          ) : (
            <button onClick={() => setConfirmReset(true)}>Effacer l'historique…</button>
          )}
        </div>
      </div>
    </section>
  );
}
