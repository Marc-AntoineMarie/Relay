/**
 * Écran Réglages : comptes et clés, catalogue des modèles, routage (mode, stratégie,
 * plafonds, budget, synthèse), général. Les réglages sont enregistrés côté moteur
 * (`.relay/settings.json`), les clés dans `.env` — rien ne quitte la machine.
 */
import { useEffect, useMemo, useState } from "react";
import { CAP_LABEL, Segmented } from "./components";
import { OllamaSection } from "./OllamaSettings";
import { MetricsSection } from "./Dashboard";
import { BILLING, useRelay, type Relay, type SettingsSection } from "./store";
import { TIERS, type CommandPolicy, type PoolAccount, type ProviderReadiness, type Strategy, type Tier } from "./types";

const SECTIONS: Array<{ id: SettingsSection; label: string; hint: string }> = [
  { id: "accounts", label: "Comptes et clés", hint: "connecter, tester, supprimer" },
  { id: "models", label: "Modèles", hint: "catalogue et pool automatique" },
  { id: "routing", label: "Routage", hint: "stratégie, plafonds, budget" },
  { id: "metrics", label: "Métriques", hint: "prix, référence, budget mensuel" },
  { id: "ollama", label: "Ollama", hint: "modèles gratuits, local ou VPS" },
  { id: "general", label: "Général", hint: "agents, mémoire, questions, disposition" },
];

export function SettingsView({ onResetLayout }: { onResetLayout: () => void }): React.JSX.Element | null {
  const r = useRelay();
  const section = r.settingsOpen;

  useEffect(() => {
    if (section === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") r.closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, r]);

  if (section === null) return null;

  return (
    <div className="settings-overlay" role="dialog" aria-label="Réglages" onClick={r.closeSettings}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <h2>Réglages</h2>
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? "on" : ""} onClick={() => r.openSettings(s.id)}>
              <span>{s.label}</span>
              <span className="muted small">{s.hint}</span>
            </button>
          ))}
          <p className="muted small settings-note">Enregistré automatiquement.</p>
        </nav>
        <div className="settings-body">
          <button className="ghost settings-close" onClick={r.closeSettings} aria-label="Fermer">
            ×
          </button>
          {section === "accounts" ? <AccountsSection r={r} /> : null}
          {section === "models" ? <ModelsSection r={r} /> : null}
          {section === "routing" ? <RoutingSection r={r} /> : null}
          {section === "ollama" ? <OllamaSection /> : null}
          {section === "metrics" ? <MetricsSection /> : null}
          {section === "general" ? <GeneralSection onResetLayout={onResetLayout} /> : null}
        </div>
      </div>
    </div>
  );
}

// ── Comptes et clés ─────────────────────────────────────────────────────────

function AccountsSection({ r }: { r: Relay }): React.JSX.Element {
  return (
    <section>
      <h3>Comptes et clés</h3>
      <p className="muted small">
        Les clés sont écrites dans le fichier <code>.env</code> de ta machine ; seule leur fin est affichée. « Tester »
        vérifie la clé sans rien consommer (liste des modèles, ou comptage de tokens gratuit chez Anthropic).
      </p>
      <div className="account-cards">
        {r.state?.providers.map((p) => (
          <AccountCard key={p.name} p={p} r={r} />
        ))}
      </div>
    </section>
  );
}

function AccountCard({ p, r }: { p: ProviderReadiness; r: Relay }): React.JSX.Element {
  const test = r.keyTests[p.name];
  const draft = r.keyDraft[p.name] ?? "";
  return (
    <div className="account-card">
      <div className="account-card-head">
        <span className={`dot ${p.ready ? "dot-done" : "dot-pending"}`} />
        <strong>{p.label}</strong>
        <span className={`billing billing-${p.billing}`}>{BILLING[p.billing]}</span>
        <span className="muted small account-status">
          {p.envKey === undefined ? "sans clé" : p.ready ? `clé ${p.keyHint ?? "enregistrée"}` : "clé manquante"}
        </span>
      </div>
      {p.envKey !== undefined ? (
        <div className="key-row">
          <input
            type="password"
            placeholder={p.ready ? "nouvelle clé (remplace l'actuelle)" : `colle ta clé ${p.envKey}`}
            value={draft}
            onChange={(e) => r.setKeyDraft((d) => ({ ...d, [p.name]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && void r.saveKey(p.name)}
          />
          <button onClick={() => void r.saveKey(p.name)} disabled={!draft.trim()}>
            Enregistrer
          </button>
        </div>
      ) : (
        <p className="muted small">
          {p.name === "claude-code"
            ? "Utilise ton abonnement via le binaire « claude » déjà connecté."
            : "Serveur local sur http://localhost:11434 (à installer et lancer)."}
        </p>
      )}
      <div className="account-actions">
        <button onClick={() => void r.checkKey(p.name)} disabled={test === "pending" || (!p.ready && !draft.trim())}>
          {test === "pending" ? "Test…" : draft.trim() ? "Tester cette clé" : "Tester"}
        </button>
        {p.ready && p.envKey !== undefined ? (
          <button
            className="danger"
            onClick={() => window.confirm(`Supprimer la clé ${p.label} du fichier .env ?`) && void r.removeKey(p.name)}
          >
            Supprimer la clé
          </button>
        ) : null}
        {p.keyUrl !== undefined ? (
          <a className="small key-link" href={p.keyUrl} target="_blank" rel="noreferrer">
            Obtenir une clé →
          </a>
        ) : null}
      </div>
      {test !== undefined && test !== "pending" ? (
        test.ok ? (
          <p className="test-ok small">
            ✓ {test.detail}
            {test.ms !== undefined ? ` · ${test.ms} ms` : ""}
          </p>
        ) : (
          <p className="test-ko small">
            ✗ {test.error?.title} — {test.error?.detail}
            {test.error?.hint ? <span className="muted"> · {test.error.hint}</span> : null}
          </p>
        )
      ) : null}
    </div>
  );
}

// ── Modèles ─────────────────────────────────────────────────────────────────

function ModelsSection({ r }: { r: Relay }): React.JSX.Element {
  const [query, setQuery] = useState("");
  return (
    <section>
      <h3>Modèles</h3>
      <p className="muted small">
        Tous les modèles de chat détectés avec tes clés. Coche ceux que le mode automatique peut utiliser :
        « recommandé » = sélection éprouvée de Relay. Les prix sont des références API pour comparer (le palier
        gratuit et l'abonnement ne coûtent rien).
      </p>
      <input className="models-search" placeholder="filtrer (nom, famille…)" value={query} onChange={(e) => setQuery(e.target.value)} />
      {r.pool === null ? (
        <p className="muted">chargement…</p>
      ) : (
        r.pool.accounts.map((a) => <ModelTable key={a.name} account={a} r={r} query={query} />)
      )}
    </section>
  );
}

function ModelTable({ account: a, r, query }: { account: PoolAccount; r: Relay; query: string }): React.JSX.Element {
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      a.available
        .filter((m) => q === "" || `${m.model} ${m.family}`.toLowerCase().includes(q))
        .sort((x, y) => Number(y.inPool) - Number(x.inPool) || Number(y.known) - Number(x.known) || x.model.localeCompare(y.model)),
    [a.available, q],
  );
  return (
    <div className="model-table">
      <div className="model-table-head">
        <strong>{a.label}</strong>
        <span className={`billing billing-${a.billing}`}>{BILLING[a.billing]}</span>
        <span className="muted small">
          {a.error !== undefined ? `⚠ ${a.error.title}` : `${a.models.length} dans le pool · ${a.available.length} détectés`}
        </span>
      </div>
      {rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Pool</th>
              <th>Modèle</th>
              <th>Famille</th>
              <th>Niveau</th>
              <th>Forces</th>
              <th>Réf. $/M</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.model} className={m.inPool ? "" : "row-off"}>
                <td>
                  <input
                    type="checkbox"
                    checked={m.inPool}
                    disabled={r.busy}
                    onChange={(e) => r.setModelInPool(a.name, m.model, m.recommended, e.target.checked)}
                  />
                </td>
                <td className="mono">
                  {m.model}
                  {m.recommended ? <span className="badge ok">recommandé</span> : null}
                  {m.health !== undefined ? <span className="badge warn">{m.health}</span> : null}
                </td>
                <td className={m.known ? "" : "muted"}>{m.known ? m.family : "inconnue"}</td>
                <td>
                  <span className={`tier tier-${m.level}`}>{m.level}</span>
                </td>
                <td className="muted small">{m.tags.map((t) => CAP_LABEL[t]).join(", ") || "—"}</td>
                <td className="mono small">
                  {m.inputPerM || m.outputPerM ? `${m.inputPerM} / ${m.outputPerM}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

// ── Routage ─────────────────────────────────────────────────────────────────

const STRATEGY: Record<Strategy, { label: string; hint: string }> = {
  economy: { label: "Économie", hint: "Le moins cher qui fait le travail : gratuit d'abord, abonnement et payant en dernier." },
  balanced: { label: "Équilibré", hint: "Bon compromis coût / qualité ; peut monter d'un niveau quand c'est utile." },
  quality: { label: "Qualité", hint: "Le meilleur modèle de chaque niveau, même s'il coûte (abonnement, API)." },
};

function RoutingSection({ r }: { r: Relay }): React.JSX.Element {
  const s = r.settings;
  const [budgetDraft, setBudgetDraft] = useState(s.budgetPerRun === null ? "" : String(s.budgetPerRun));
  return (
    <section>
      <h3>Routage</h3>

      <div className="setting-row">
        <div>
          <strong>Mode par défaut</strong>
          <p className="muted small">Automatique : le routeur choisit parmi tous tes comptes. Manuel : un compte, un modèle par niveau.</p>
        </div>
        <Segmented
          value={s.mode}
          onChange={r.setMode}
          disabled={r.busy}
          options={[
            { value: "auto", label: "Automatique" },
            { value: "manual", label: "Manuel" },
          ]}
        />
      </div>

      <div className="setting-row">
        <div>
          <strong>Stratégie</strong>
          <p className="muted small">{STRATEGY[s.strategy].hint}</p>
        </div>
        <Segmented
          value={s.strategy}
          onChange={r.setStrategy}
          options={(["economy", "balanced", "quality"] as const).map((v) => ({ value: v, label: STRATEGY[v].label }))}
        />
      </div>

      <div className="setting-row">
        <div>
          <strong>Budget par run</strong>
          <p className="muted small">
            Plafond de dépense réelle ($) sur les comptes payants à l'usage. Atteint, le routeur ne garde que le gratuit
            et l'abonnement. Vide = illimité.
          </p>
        </div>
        <div className="budget">
          <span>$</span>
          <input
            type="number"
            min={0}
            step={0.05}
            placeholder="illimité"
            value={budgetDraft}
            onChange={(e) => setBudgetDraft(e.target.value)}
            onBlur={() => {
              const n = Number.parseFloat(budgetDraft);
              r.updateSettings({ budgetPerRun: Number.isFinite(n) && n >= 0 ? n : null });
            }}
          />
        </div>
      </div>

      <div className="setting-row">
        <div>
          <strong>Délai max par réponse de modèle</strong>
          <p className="muted small">
            Au-delà, Relay abandonne ce modèle et passe au suivant (le modèle est aussi évité quelques minutes). Un modèle
            qui ne donne aucun signe de vie pendant 90 s est abandonné plus tôt. Ollama sur CPU a droit à 3 fois plus.
          </p>
        </div>
        <label className="muted small max-calls">
          <input
            type="number"
            min={1}
            max={60}
            value={s.maxCallMinutes}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1 && n <= 60) r.updateSettings({ maxCallMinutes: n });
            }}
          />{" "}
          min
        </label>
      </div>

      <div className="setting-row">
        <div>
          <strong>Synthèse finale</strong>
          <p className="muted small">
            À la fin du run, un modèle assemble tous les résultats en un livrable unique (panneau Résultat). Coût compté
            dans les métriques.
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={s.synthesis} onChange={(e) => r.updateSettings({ synthesis: e.target.checked })} />
          <span>{s.synthesis ? "activée" : "désactivée"}</span>
        </label>
      </div>

      <h4>Plafonds par compte (mode automatique)</h4>
      {r.pool === null || r.pool.accounts.length === 0 ? (
        <p className="muted small">Aucun compte prêt : ajoute une clé dans « Comptes et clés ».</p>
      ) : (
        <ul className="accounts">
          {r.pool.accounts.map((a) => (
            <PolicyRow key={a.name} account={a} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PolicyRow({ account: a, r }: { account: PoolAccount; r: Relay }): React.JSX.Element {
  const policy = r.policyOf(a.name);
  const levels: Tier[] = policy.levels ?? [...TIERS];
  const toggleLevel = (t: Tier): void => {
    const next = levels.includes(t) ? levels.filter((l) => l !== t) : [...levels, t];
    r.setPolicy(a.name, { ...policy, levels: TIERS.filter((l) => next.includes(l)) });
  };
  return (
    <li className={`account ${policy.enabled ? "" : "account-off"}`}>
      <label className="account-head">
        <input
          type="checkbox"
          checked={policy.enabled}
          disabled={r.busy}
          onChange={(e) => r.setPolicy(a.name, { ...policy, enabled: e.target.checked })}
        />
        <span className="provider-label">{a.label}</span>
        <span className={`billing billing-${a.billing}`}>{BILLING[a.billing]}</span>
      </label>
      {policy.enabled ? (
        <div className="account-policy">
          <span className="muted small">niveaux autorisés :</span>
          {TIERS.map((t) => (
            <button key={t} className={`level-chip ${levels.includes(t) ? `tier tier-${t}` : "off"}`} disabled={r.busy} onClick={() => toggleLevel(t)}>
              {t}
            </button>
          ))}
          <label className="muted small max-calls">
            appels max par run
            <input
              type="number"
              min={0}
              max={50}
              value={policy.maxCallsPerRun ?? ""}
              placeholder="∞"
              disabled={r.busy}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                const { maxCallsPerRun: _drop, ...rest } = policy;
                r.setPolicy(a.name, Number.isFinite(n) ? { ...rest, maxCallsPerRun: n } : rest);
              }}
            />
          </label>
        </div>
      ) : null}
    </li>
  );
}

// ── Général ─────────────────────────────────────────────────────────────────

const POLICY_OPTIONS = [
  { value: "ask" as const, label: "Prudent", hint: "Chaque commande d'agent attend ton accord" },
  { value: "safe" as const, label: "Sûr", hint: "Outils de développement seulement (python, node, tests…)" },
  { value: "auto" as const, label: "Libre", hint: "Tout sauf les commandes destructrices" },
];
const POLICY_HINT: Record<CommandPolicy, string> = {
  ask: "Chaque commande proposée par un agent s'affiche en haut de l'écran et attend « Autoriser » (refusée au bout de 5 min). Contrôle total.",
  safe: "Seuls les programmes de développement courants sont lancés (python, node, pytest, make, ls, cat…). Le reste est refusé et l'agent en est informé. Attention : un interpréteur peut tout faire, ce mode évite les erreurs, pas un code malveillant.",
  auto: "Tout est lancé, sauf les commandes destructrices évidentes (sudo, rm -rf /, git push…). À réserver aux comptes et projets de confiance.",
};

function GlobalMemory(): React.JSX.Element {
  const r = useRelay();
  const [text, setText] = useState(r.settings.globalMemory);
  useEffect(() => setText(r.settings.globalMemory), [r.settings.globalMemory]);
  return (
    <textarea
      className="global-memory"
      value={text}
      placeholder={"ex. Réponds en français. Je préfère Python et des pages web simples. Pas de dépendances à installer."}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== r.settings.globalMemory && r.updateSettings({ globalMemory: text })}
    />
  );
}

function GeneralSection({ onResetLayout }: { onResetLayout: () => void }): React.JSX.Element {
  const r = useRelay();
  const s = r.settings;
  const [rootDraft, setRootDraft] = useState(s.workspaceRoot);
  useEffect(() => setRootDraft(s.workspaceRoot), [s.workspaceRoot]);
  return (
    <section>
      <h3>Général</h3>
      <h4>Actions réelles des agents</h4>
      <div className="setting-row">
        <div>
          <strong>Mode agent</strong>
          <p className="muted small">
            Les tâches écrivent de vrais fichiers dans un dossier neuf par run et lancent des commandes (tests, exécution)
            pour vérifier leur travail. Désactivé : elles renvoient seulement du texte.
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={s.agentic} disabled={r.busy} onChange={(e) => r.updateSettings({ agentic: e.target.checked })} />
          <span>{s.agentic ? "activé" : "désactivé"}</span>
        </label>
      </div>
      <div className="setting-row">
        <div>
          <strong>Dossier des runs</strong>
          <p className="muted small">Chaque run crée un sous-dossier daté ici. Chemin absolu (ou commençant par ~/).</p>
        </div>
        <input
          className="path-input"
          value={rootDraft}
          disabled={r.busy}
          onChange={(e) => setRootDraft(e.target.value)}
          onBlur={() => rootDraft.trim() !== s.workspaceRoot && r.updateSettings({ workspaceRoot: rootDraft.trim() })}
        />
      </div>
      <div className="setting-row setting-col">
        <div>
          <strong>Commandes des agents</strong>
          <p className="muted small">{POLICY_HINT[s.commandPolicy]}</p>
          <p className="muted small">
            Dans tous les modes : commandes lancées dans le dossier du run, sans tes clés API dans l'environnement, 60 s
            maximum, et tu peux arrêter le pipeline à tout moment.
          </p>
        </div>
        <Segmented value={s.commandPolicy} disabled={r.busy} onChange={(v) => r.updateSettings({ commandPolicy: v })} options={POLICY_OPTIONS} />
      </div>

      <div className="setting-row">
        <div>
          <strong>Vérification finale et correction automatique</strong>
          <p className="muted small">
            À la fin de chaque run, Relay lance lui-même la commande du projet (8 s). S'il ne démarre pas, l'erreur remonte
            dans le graphe et une correction part automatiquement (une seule fois, jamais en chaîne). Désactivé : l'erreur
            remonte, tu cliques « Corriger avec Relay » si tu veux.
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={s.autoFix} onChange={(e) => r.updateSettings({ autoFix: e.target.checked })} />
          <span>{s.autoFix ? "correction auto" : "manuelle"}</span>
        </label>
      </div>

      <h4>Conversation et mémoire</h4>
      <div className="setting-row">
        <div>
          <strong>Questions de cadrage</strong>
          <p className="muted small">
            Si ta demande est trop floue pour un plan fiable, le planificateur te pose 1 à 3 questions (réponses proposées,
            ou « Décide pour moi ») avant de lancer les modèles. Désactivé : il planifie avec des hypothèses, affichées
            dans le résultat.
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={s.askQuestions} onChange={(e) => r.updateSettings({ askQuestions: e.target.checked })} />
          <span>{s.askQuestions ? "activées" : "désactivées"}</span>
        </label>
      </div>
      <div className="setting-row">
        <div>
          <strong>Mémoire du projet (RELAY.md)</strong>
          <p className="muted small">
            Après chaque tour, un petit modèle réécrit RELAY.md à la racine du projet : objectif, structure, commandes,
            décisions, historique. Il est relu à chaque tour. Coût : un appel court par tour (souvent gratuit).
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={s.projectMemory} onChange={(e) => r.updateSettings({ projectMemory: e.target.checked })} />
          <span>{s.projectMemory ? "tenue à jour" : "manuelle"}</span>
        </label>
      </div>
      <div className="setting-row setting-col">
        <div>
          <strong>Mémoire globale (tes préférences)</strong>
          <p className="muted small">
            Transmise à tous les projets, comme le CLAUDE.md global de Claude Code : langue, technos préférées, style,
            contraintes de ta machine…
          </p>
        </div>
        <GlobalMemory />
      </div>

      <h4>Interface</h4>
      <div className="setting-row">
        <div>
          <strong>Disposition des panneaux</strong>
          <p className="muted small">Remet les panneaux de l'espace de travail à leur place par défaut.</p>
        </div>
        <button onClick={onResetLayout}>Réinitialiser</button>
      </div>
      <div className="setting-row">
        <div>
          <strong>Fichiers</strong>
          <p className="muted small">
            Clés : <code>.env</code> (racine du projet, ignoré par git) · Réglages : <code>.relay/settings.json</code> ·
            Runs : <code>{s.workspaceRoot}</code>
          </p>
        </div>
      </div>
    </section>
  );
}
