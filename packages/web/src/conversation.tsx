/**
 * Phase E : Relay comme une conversation. Un projet = un dossier au nom simple, avec son fil
 * de messages (demandes, questions de cadrage, résultats, corrections), sa mémoire (RELAY.md)
 * et son historique, retrouvable plus tard.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { hasNativePicker, pickFolder } from "./api";
import { money } from "./components";
import { Stepper, whyDisabled } from "./panels";
import { useRelay } from "./store";
import type { ConversationMessage, PlanQuestion } from "./types";

// ── Nom de projet proposé (même règle que le moteur) ────────────────────────

const STOP_WORDS = new Set(
  (
    "cree creer creez fais fait faire faites moi nous une un le la les des de du d l en avec pour par sur dans je j veux voudrais " +
    "aimerais pouvoir peux puisse qui que qu et ou a au aux mon ma mes ton ta tes son sa ses ce cet cette ces simple petit petite " +
    "nouveau nouvelle mini application appli app programme projet code script logiciel outil python javascript js typescript ts html " +
    "css web page site interface graphique gui cli tests test lancer tester voir utiliser realise realiser genere generer ecris ecrire " +
    "developpe developper svp stp merci the an make create build me with and for in of to please write"
  ).split(" "),
);

export function suggestName(prompt: string): string {
  const words = prompt
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return words.slice(0, 2).join("-") || "projet";
}

const ago = (t: number): string => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

// ── Panneau ─────────────────────────────────────────────────────────────────

export function ConversationPanel(): React.JSX.Element {
  const r = useRelay();
  const threadRef = useRef<HTMLDivElement>(null);
  const lastLog = r.logs.at(-1)?.at;

  // Suit le fil (nouveau message, progression), comme une messagerie.
  useEffect(() => {
    const el = threadRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [r.messages.length, r.phase, lastLog]);

  const lastIndex = r.messages.length - 1;
  return (
    <div className="panel panel-flush convo">
      <ProjectBar />
      <div className="thread" ref={threadRef}>
        {r.messages.length === 0 && !r.busy ? <Welcome /> : null}
        {r.messages.map((m, i) => (
          <MessageView key={m.id} m={m} last={i === lastIndex} />
        ))}
        {r.busy ? <LiveCard /> : null}
      </div>
      <Composer />
    </div>
  );
}

function Welcome(): React.JSX.Element {
  const r = useRelay();
  return (
    <div className="welcome">
      <h3>{r.workspace === null ? "Nouveau projet" : `Projet ${r.projectName ?? ""}`}</h3>
      <p className="muted small">
        Décris ce que tu veux, même vaguement : si c'est trop flou, Relay te pose quelques questions avant de lancer les
        modèles. Ensuite, continue la conversation (« ajoute… », « le bouton ne marche pas ») : le projet garde sa mémoire.
      </p>
    </div>
  );
}

// ── Projets : historique, nouveau, import, mémoire ──────────────────────────

function ProjectBar(): React.JSX.Element {
  const r = useRelay();
  const [open, setOpen] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  return (
    <div className="project-bar">
      <button className="project-current" disabled={r.busy} onClick={() => setOpen((o) => !o)} title="Historique des projets">
        <span className="project-name">{r.projectName ?? "Nouveau projet"}</span> ▾
      </button>
      {r.workspace !== null ? (
        <button className="link" onClick={() => setMemOpen(true)} title="RELAY.md : ce que les modèles savent du projet">
          Mémoire{r.memory ? "" : " (vide)"}
        </button>
      ) : null}
      <button className="new-project" disabled={r.busy} onClick={r.newProject}>
        ＋ Nouveau
      </button>
      {open ? <ProjectList onClose={() => setOpen(false)} /> : null}
      {memOpen ? <MemoryEditor onClose={() => setMemOpen(false)} /> : null}
    </div>
  );
}

function ProjectList({ onClose }: { onClose: () => void }): React.JSX.Element {
  const r = useRelay();
  const [q, setQ] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => r.refreshProjects(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return r.projects.filter((p) => t === "" || `${p.name} ${p.last ?? ""}`.toLowerCase().includes(t));
  }, [r.projects, q]);

  const importFrom = async (): Promise<void> => {
    const picked = hasNativePicker() ? await pickFolder("Ouvrir un dossier existant comme projet") : path.trim();
    if (picked) {
      r.importFolder(picked);
      onClose();
    }
  };

  return (
    <div className="project-list" role="dialog">
      <input autoFocus placeholder="rechercher un projet…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
      <ul>
        {shown.map((p) => (
          <li key={p.root}>
            <button
              className={p.root === r.workspace ? "active" : ""}
              onClick={() => {
                r.loadProject(p.root);
                onClose();
              }}
              title={p.root}
            >
              <span className="pl-name">{p.name}</span>
              <span className="muted small">{ago(p.updated)}</span>
              {p.last !== undefined ? <span className="pl-last muted small">{p.last}</span> : null}
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="muted small pl-empty">Aucun projet.</li> : null}
      </ul>
      <div className="pl-import">
        {hasNativePicker() ? null : (
          <input placeholder="/chemin/vers/un/dossier/existant" value={path} onChange={(e) => setPath(e.target.value)} />
        )}
        <button onClick={() => void importFrom()} title="Les agents pourront lire et écrire dans ce dossier">
          Ouvrir un dossier existant…
        </button>
      </div>
    </div>
  );
}

function MemoryEditor({ onClose }: { onClose: () => void }): React.JSX.Element {
  const r = useRelay();
  const [text, setText] = useState(r.memory);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="memory-editor" onClick={(e) => e.stopPropagation()}>
        <h3>Mémoire du projet — RELAY.md</h3>
        <p className="muted small">
          Relue par le planificateur et les agents à chaque tour (comme CLAUDE.md pour Claude Code). Relay la réécrit
          après chaque tour avec un petit modèle{r.settings.projectMemory ? "" : " (désactivé dans Réglages › Général)"} ;
          ce que tu y écris est conservé.
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="# mon-projet&#10;## Objectif&#10;…" />
        <div className="run-actions">
          <button
            className="run-btn"
            onClick={() => {
              void r.saveMemory(text).then(onClose);
            }}
          >
            Enregistrer
          </button>
          <button onClick={onClose}>Annuler</button>
        </div>
      </div>
    </div>
  );
}

// ── Messages ────────────────────────────────────────────────────────────────

function MessageView({ m, last }: { m: ConversationMessage; last: boolean }): React.JSX.Element {
  if (m.role === "user") {
    return (
      <div className={`msg msg-user msg-${m.kind}`}>
        {m.kind === "fix" ? <span className="msg-tag">correction</span> : m.kind === "answer" ? <span className="msg-tag">réponses</span> : null}
        <div className="msg-text">{m.text}</div>
        {m.error ? (
          <details>
            <summary className="muted small">erreur transmise</summary>
            <pre className="log-detail">{m.error}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  if (m.kind === "questions") return <QuestionsCard m={m} active={last} />;
  return <ResultCard m={m} />;
}

function QuestionsCard({ m, active }: { m: ConversationMessage; active: boolean }): React.JSX.Element {
  const r = useRelay();
  const questions: PlanQuestion[] = m.questions ?? [];
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [free, setFree] = useState<Record<number, string>>({});
  const answerOf = (i: number): string => free[i]?.trim() || picks[i] || "";
  const allAnswered = questions.every((_q, i) => answerOf(i) !== "");
  const send = (): void =>
    r.answer(questions.map((q, i) => `${q.question} → ${answerOf(i) || "à toi de décider"}`).join("\n"));

  return (
    <div className="msg msg-relay msg-questions">
      <div className="msg-head">
        <span className="badge warn">questions</span>
        <span className="muted small">avant de lancer les modèles</span>
      </div>
      {m.text ? <p className="msg-analysis">{m.text}</p> : null}
      {questions.map((q, i) => (
        <div key={i} className="question">
          <strong>{q.question}</strong>
          <div className="options">
            {(q.options ?? []).map((o) => (
              <button
                key={o}
                className={`option ${picks[i] === o && !free[i]?.trim() ? "picked" : ""}`}
                disabled={!active || r.busy}
                onClick={() => setPicks((p) => ({ ...p, [i]: o }))}
              >
                {o}
              </button>
            ))}
            {active ? (
              <input
                className="option-free"
                placeholder="autre…"
                disabled={r.busy}
                value={free[i] ?? ""}
                onChange={(e) => setFree((f) => ({ ...f, [i]: e.target.value }))}
              />
            ) : null}
          </div>
        </div>
      ))}
      {active ? (
        <div className="run-actions">
          <button className="run-btn" disabled={r.busy || !allAnswered} onClick={send}>
            Répondre
          </button>
          <button
            disabled={r.busy}
            onClick={() => r.answer("Décide toi-même : prends des hypothèses raisonnables et indique-les.")}
            title="Relay planifie avec ses propres hypothèses, affichées dans le résultat"
          >
            Décide pour moi
          </button>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_ICON: Record<string, string> = { done: "✓", failed: "✗", running: "…", pending: "·", escalated: "↑" };
const OUTCOME: Record<string, { label: string; cls: string }> = {
  done: { label: "terminé", cls: "ok" },
  failed: { label: "échec", cls: "err" },
  stopped: { label: "arrêté", cls: "warn" },
};

function ResultCard({ m }: { m: ConversationMessage }): React.JSX.Element {
  const [full, setFull] = useState(false);
  const outcome = OUTCOME[m.outcome ?? "done"] ?? { label: "terminé", cls: "ok" };
  const lines = m.text.split("\n");
  const long = lines.length > 10 || m.text.length > 900;
  return (
    <div className={`msg msg-relay msg-result result-${outcome.cls}`}>
      <div className="msg-head">
        <span className={`badge ${outcome.cls}`}>{outcome.label}</span>
        <span className="muted small">
          {m.tasks?.length ?? 0} tâche(s)
          {m.cost !== undefined
            ? ` · ${(m.cost.durationMs / 1000).toFixed(0)} s · ${money(m.cost.billed)} payé · ${money(m.cost.reference)} équiv. API`
            : ""}
        </span>
      </div>
      {m.analysis ? <p className="msg-analysis">{m.analysis}</p> : null}
      {m.assumptions !== undefined && m.assumptions.length > 0 ? (
        <details className="assumptions">
          <summary>Hypothèses prises ({m.assumptions.length})</summary>
          <ul>
            {m.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {m.tasks !== undefined && m.tasks.length > 0 ? (
        <ul className="msg-tasks">
          {m.tasks.map((t) => (
            <li key={t.id} className={`st-${t.status}`}>
              <span className="st">{STATUS_ICON[t.status] ?? "·"}</span>
              <span className={`tier tier-${t.tier}`}>{t.tier}</span>
              <span className="mt-desc">{t.description}</span>
              {t.model !== undefined ? (
                <span className="muted small mt-model">
                  {t.provider !== undefined ? `${t.provider} · ` : ""}
                  {t.model}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {m.files !== undefined && m.files.length > 0 ? (
        <ul className="chips">
          {m.files.map((f) => (
            <li key={f} className="chip">
              {f}
            </li>
          ))}
        </ul>
      ) : null}
      {m.text ? (
        <>
          <pre className="msg-body">{full || !long ? m.text : `${lines.slice(0, 10).join("\n").slice(0, 900)}…`}</pre>
          {long ? (
            <button className="link" onClick={() => setFull((x) => !x)}>
              {full ? "réduire" : "voir tout"}
            </button>
          ) : null}
        </>
      ) : null}
      {m.error ? <p className="detail-error">{m.error}</p> : null}
    </div>
  );
}

/** Pendant le run : qui travaille sur quoi, en direct. */
function LiveCard(): React.JSX.Element {
  const r = useRelay();
  const running = r.views.find((v) => v.status === "running");
  const lastAction = [...r.logs].reverse().find((l) => l.category === "tool" || l.category === "fallback" || l.category === "plan");
  return (
    <div className="msg msg-relay msg-live">
      <div className="msg-head">
        <span className="spinner" />
        <strong>{r.phase === "planning" ? "Planification…" : `Exécution ${r.doneCount}/${r.taskCount}`}</strong>
        <span className="muted small">{r.elapsed} s</span>
      </div>
      {running !== undefined ? (
        <p className="live-task">
          <span className={`tier tier-${running.task.tier}`}>{running.task.tier}</span> #{running.task.id} {running.task.description}
          <span className="muted small">
            {" "}
            — {running.provider ?? "?"} · {running.model ?? "?"}
          </span>
        </p>
      ) : null}
      {lastAction !== undefined ? <p className="muted small live-action">{lastAction.title}</p> : null}
    </div>
  );
}

// ── Saisie ──────────────────────────────────────────────────────────────────

function Composer(): React.JSX.Element {
  const r = useRelay();
  const newProject = r.workspace === null && r.settings.agentic;
  const shownName = r.draft.edited ? r.draft.name : suggestName(r.prompt);
  const location = r.draft.location.trim() || r.settings.workspaceRoot;
  return (
    <div className="composer">
      {newProject ? (
        <div className="new-project-fields">
          <label>
            <span className="field-label">Nom</span>
            <input
              value={shownName}
              disabled={r.busy}
              onChange={(e) => r.setDraft({ ...r.draft, name: e.target.value, edited: true })}
              title="Nom du dossier du projet (proposé d'après ta demande)"
            />
          </label>
          <label className="nf-location">
            <span className="field-label">Emplacement (facultatif)</span>
            <input
              value={r.draft.location}
              placeholder={r.settings.workspaceRoot}
              disabled={r.busy}
              onChange={(e) => r.setDraft({ ...r.draft, location: e.target.value })}
            />
          </label>
          {hasNativePicker() ? (
            <button
              disabled={r.busy}
              onClick={() => void pickFolder("Emplacement du projet").then((p) => p !== null && r.setDraft({ ...r.draft, location: p }))}
              title="Choisir l'emplacement"
            >
              📁
            </button>
          ) : null}
          <span className="muted small nf-path">→ {location.replace(/\/+$/, "")}/{shownName || "projet"}</span>
        </div>
      ) : null}
      <textarea
        className="prompt"
        placeholder={
          r.continuing
            ? "Continue la conversation… ex. « le bouton = ne fait rien », « ajoute un historique des calculs »"
            : "Décris ce que tu veux… même vaguement : Relay posera des questions si besoin"
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
          <button className="run-btn" disabled={!r.canRun} onClick={() => void r.run()} title="Ctrl+Entrée">
            {r.continuing ? "Envoyer" : "Créer le projet"}
          </button>
        )}
        {!r.busy && r.messages.at(-1)?.kind === "questions" ? (
          <span className="stepper stepper-waiting">En attente de tes réponses (ci-dessus)</span>
        ) : (
          <Stepper phase={r.phase} done={r.doneCount} total={r.taskCount} elapsed={r.elapsed} />
        )}
        {!r.busy && !r.canRun ? <span className="muted small">{whyDisabled(r)}</span> : null}
      </div>
    </div>
  );
}
