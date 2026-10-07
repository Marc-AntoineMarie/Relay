/**
 * Phase D : voir et tester ce que les agents ont réellement produit.
 * - Fichiers : arborescence du dossier du run + contenu, mis à jour en direct.
 * - Exécution : commandes des agents (sorties), et tes propres commandes (avec entrée).
 * - Validations : en mode Prudent, chaque commande d'agent attend ton accord.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "./api";
import { useRelay } from "./store";
import type { CommandView, FixRequest, WorkspaceFile } from "./types";

const size = (n: number): string => (n < 1024 ? `${n} o` : `${(n / 1024).toFixed(1)} Ko`);
const runLabel = (root: string): string => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;

export function FilesPanel(): React.JSX.Element {
  const r = useRelay();
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Nouveau dossier : on oublie le fichier ouvert.
  useEffect(() => {
    setSelected(null);
    setContent(null);
  }, [r.workspace]);

  // Pendant le run, le dernier fichier écrit s'affiche (sauf si tu en as choisi un).
  useEffect(() => {
    if (r.lastWrite !== null && r.busy && (selected === null || selected === r.lastWrite.path)) setSelected(r.lastWrite.path);
  }, [r.lastWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (r.workspace === null || selected === null) return;
    let cancelled = false;
    readFile(r.workspace, selected).then(
      (f) => {
        if (cancelled) return;
        setContent({ path: f.path, text: f.content });
        setError(null);
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [r.workspace, selected, r.lastWrite?.path === selected ? r.lastWrite?.at : 0]);

  const options = useMemo(() => {
    const roots = r.runs.map((x) => x.root);
    return r.workspace !== null && !roots.includes(r.workspace) ? [r.workspace, ...roots] : roots;
  }, [r.runs, r.workspace]);

  if (r.workspace === null) {
    return (
      <div className="panel">
        <p className="muted dag-empty">
          {!r.settings.agentic
            ? "Mode agent désactivé (Réglages › Général) : les tâches renvoient du texte sans écrire de fichiers."
            : r.busy
              ? "Création du dossier de travail…"
              : "Lance un pipeline : les fichiers créés par les agents apparaîtront ici, en direct."}
        </p>
      </div>
    );
  }

  return (
    <div className="panel panel-flush files">
      <div className="files-tools">
        <select
          value={r.workspace}
          disabled={r.busy}
          onFocus={r.refreshRuns}
          onChange={(e) => r.selectWorkspace(e.target.value)}
          title={r.workspace}
        >
          {options.map((root) => (
            <option key={root} value={root}>
              {runLabel(root)}
            </option>
          ))}
        </select>
        <button onClick={r.refreshFiles} title="Relire le dossier">
          ↻
        </button>
        <button onClick={() => void r.openIn("folder")} title={r.workspace}>
          Ouvrir le dossier
        </button>
        <button onClick={() => void r.openIn("vscode")}>VS Code</button>
      </div>
      <div className="files-body">
        <FileTree files={r.files} selected={selected} recent={r.busy ? r.lastWrite?.path : undefined} onSelect={setSelected} />
        <div className="file-view">
          {error !== null ? (
            <p className="inline-error">⚠ {error}</p>
          ) : content !== null && content.path === selected ? (
            <>
              <div className="file-view-head muted small">
                {content.path}
                {/\.html?$/i.test(content.path) ? (
                  <>
                    <button className="link" onClick={() => r.openPreview(content.path)}>
                      Aperçu dans Relay
                    </button>
                    <button className="link" onClick={() => void r.openIn("folder", content.path)}>
                      Ouvrir dans le navigateur
                    </button>
                  </>
                ) : null}
              </div>
              <pre className="output file-content">
                {content.text.split("\n").map((line, i, all) =>
                  i === all.length - 1 && line === "" ? null : (
                    <span key={i} className="code-line">
                      <span className="ln">{i + 1}</span>
                      {line}
                      {"\n"}
                    </span>
                  ),
                )}
              </pre>
            </>
          ) : (
            <p className="muted small file-hint">{r.files.length === 0 ? "Dossier encore vide." : "Choisis un fichier."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTree(props: {
  files: WorkspaceFile[];
  selected: string | null;
  recent: string | undefined;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  // Liste plate triée, indentée par dossier : lisible sans état d'ouverture à gérer.
  const rows: Array<{ key: string; label: string; depth: number; file?: WorkspaceFile }> = [];
  const seenDirs = new Set<string>();
  for (const f of props.files) {
    const parts = f.path.split("/");
    for (let d = 0; d < parts.length - 1; d++) {
      const dir = parts.slice(0, d + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        rows.push({ key: `d:${dir}`, label: `${parts[d]}/`, depth: d });
      }
    }
    rows.push({ key: f.path, label: parts.at(-1) ?? f.path, depth: parts.length - 1, file: f });
  }
  return (
    <ul className="file-tree">
      {rows.map((row) =>
        row.file === undefined ? (
          <li key={row.key} className="tree-dir" style={{ paddingLeft: 8 + row.depth * 14 }}>
            {row.label}
          </li>
        ) : (
          <li key={row.key}>
            <button
              className={`tree-file ${props.selected === row.file.path ? "active" : ""} ${props.recent === row.file.path ? "recent" : ""}`}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              onClick={() => props.onSelect(row.file?.path ?? "")}
            >
              <span>{row.label}</span>
              <span className="muted small">{size(row.file.size)}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export function ExecPanel(): React.JSX.Element {
  const r = useRelay();
  const [command, setCommand] = useState("");
  const [stdin, setStdin] = useState("");
  const [showStdin, setShowStdin] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [r.commands.length]);

  // Commandes réussies des agents : à rejouer en un clic.
  const suggestions = useMemo(
    () => [...new Set(r.commands.filter((c) => c.by === "agent" && c.exitCode === 0).map((c) => c.command))].slice(-6),
    [r.commands],
  );

  if (r.workspace === null) {
    return (
      <div className="panel">
        <p className="muted dag-empty">Les commandes lancées par les agents (tests, exécution) et les tiennes apparaîtront ici.</p>
      </div>
    );
  }

  const submit = (): void => {
    void r.runUserCommand(command, showStdin ? stdin : undefined);
  };

  return (
    <div className="panel panel-flush exec">
      <ol ref={listRef} className="cmd-list">
        {r.commands.length === 0 ? <li className="muted small cmd-empty">Aucune commande pour l'instant.</li> : null}
        {r.commands.map((c, i) => (
          <CommandItem
            key={c.id}
            c={c}
            open={i === r.commands.length - 1}
            busy={r.busy}
            onReplay={() => setCommand(c.command)}
            onStop={() => r.stopApp(c)}
            onFix={() => r.fixError({ source: `« ${c.command} »`, output: c.output ?? "", exitCode: c.exitCode ?? null })}
          />
        ))}
      </ol>
      <div className="runner">
        {suggestions.length > 0 ? (
          <div className="suggestions">
            {suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => setCommand(s)} title="Reprendre cette commande">
                {s}
              </button>
            ))}
          </div>
        ) : null}
        <div className="runner-line">
          <span className="prompt-sign">$</span>
          <input
            className="runner-input"
            placeholder="python3 calculatrice.py  ·  python3 -m unittest -v"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button onClick={submit} disabled={command.trim().length === 0} title="Lancer et attendre la fin (60 s max), sortie affichée ici">
            Exécuter
          </button>
          <button
            onClick={() => void r.launchUserCommand(command)}
            disabled={command.trim().length === 0}
            title="Lancer sans attendre — pour une application avec fenêtre (Tkinter, jeu…)"
          >
            Lancer (fenêtre)
          </button>
          <label className="muted small raw-toggle" title="Texte envoyé au programme comme s'il était tapé au clavier">
            <input type="checkbox" checked={showStdin} onChange={(e) => setShowStdin(e.target.checked)} /> entrée
          </label>
        </div>
        {showStdin ? (
          <textarea
            className="stdin"
            placeholder={"Texte envoyé au programme, ligne par ligne :\n2 + 3\n10 / 4\nq"}
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
          />
        ) : null}
      </div>
    </div>
  );
}

const ERROR_OUTPUT = /Traceback|Exception|Error:/;

function CommandItem(props: {
  c: CommandView;
  open: boolean;
  busy: boolean;
  onReplay: () => void;
  onStop: () => void;
  onFix: () => void;
}): React.JSX.Element {
  const { c, open } = props;
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  const app = c.launched === true;
  const failed =
    c.refused === undefined && !(app && c.running) && ((c.exitCode !== undefined && c.exitCode !== 0 && c.exitCode !== null) || c.timedOut === true);
  // Une app peut planter sans se fermer (exception dans un clic) : on le voit dans sa sortie.
  const broken = failed || (app && ERROR_OUTPUT.test(c.output ?? ""));
  const state = c.running
    ? { icon: "…", cls: "run", text: app ? "fenêtre ouverte (sortie suivie)" : "en cours" }
    : c.refused !== undefined
      ? { icon: "⊘", cls: "refused", text: c.refused }
      : app && c.exitCode === null
        ? { icon: "■", cls: "ok", text: "fermée" }
        : app && c.exitCode === 0
          ? { icon: "↗", cls: "ok", text: "fermée normalement" }
          : c.timedOut === true
          ? { icon: "⏱", cls: "fail", text: "délai dépassé" }
          : c.exitCode === 0
            ? { icon: "✓", cls: "ok", text: "code 0" }
            : { icon: "✗", cls: "fail", text: `code ${c.exitCode ?? "?"}` };
  return (
    <li className={`cmd cmd-${state.cls}`}>
      <button className="cmd-line" onClick={() => setExpanded((x) => !x)}>
        <span className="cmd-icon">{c.running && !app ? <span className="spinner" /> : app && c.running ? "↗" : state.icon}</span>
        <code className="cmd-text">{c.command}</code>
        <span className="muted small">
          {c.by === "agent" ? `agent #${c.taskId ?? "?"}` : "toi"} · {state.text}
          {c.durationMs !== undefined && !c.running ? ` · ${(c.durationMs / 1000).toFixed(1)} s` : ""}
        </span>
      </button>
      {expanded && (!c.running || app) ? (
        <div className="cmd-out">
          {c.output !== undefined ? <pre className="log-detail">{c.output || "(aucune sortie pour l'instant)"}</pre> : null}
          <div className="cmd-actions">
            {broken ? (
              <button className="fix-btn" disabled={props.busy} onClick={props.onFix} title="Relay corrige dans le même dossier, avec cette erreur et l'historique du projet">
                Corriger avec Relay
              </button>
            ) : null}
            {app && c.running ? <button onClick={props.onStop}>Fermer l'app</button> : null}
            <button className="link" onClick={props.onReplay}>
              reprendre cette commande
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Commandes d'agents en attente de ta validation (mode Prudent) — toujours visibles. */
export function ApprovalBar(): React.JSX.Element | null {
  const r = useRelay();
  if (r.approvals.length === 0) return null;
  return (
    <div className="approvals">
      {r.approvals.map((a) => (
        <div key={a.key} className="approval">
          <span>
            Tâche #{a.taskId} veut lancer : <code>{a.command}</code>
          </span>
          <button className="run-btn" onClick={() => r.approve(a.key, true)}>
            Autoriser
          </button>
          <button onClick={() => r.approve(a.key, false)}>Refuser</button>
        </div>
      ))}
    </div>
  );
}

/** Erreur rencontrée en testant (nœud rouge du graphe) : la faire corriger par Relay. */
export function ErrorDetail({ err, onBack }: { err: FixRequest; onBack?: () => void }): React.JSX.Element {
  const r = useRelay();
  const [note, setNote] = useState("");
  return (
    <aside className="detail">
      <div className="detail-head">
        <span className="tier tier-error">erreur</span>
        <span className="muted small">rencontrée en testant</span>
      </div>
      <h3 className="detail-title">{err.source}</h3>
      {err.exitCode !== undefined && err.exitCode !== null ? <p className="muted small">code de sortie {err.exitCode}</p> : null}
      <pre className="output error-output">{err.output || "(aucune sortie)"}</pre>
      <label className="field">
        <span className="field-label">Précision pour les modèles (facultatif)</span>
        <input
          placeholder="ex. « la fenêtre s'ouvre mais le bouton = ne fait rien »"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !r.busy && r.fixError(err, note)}
        />
      </label>
      <div className="run-actions">
        <button className="run-btn" disabled={r.busy} onClick={() => r.fixError(err, note)}>
          Corriger avec Relay
        </button>
        <span className="muted small">
          Une tâche d'agent reprend le dossier avec cette erreur et l'historique du projet, corrige, puis revérifie (escalade si
          besoin).
        </span>
      </div>
      {onBack !== undefined ? (
        <button className="link" onClick={onBack}>
          retour
        </button>
      ) : null}
    </aside>
  );
}

/** Aperçu d'une page du dossier dans Relay : les erreurs JavaScript remontent au pipeline. */
export function PreviewPanel(): React.JSX.Element {
  const r = useRelay();
  const frame = useRef<HTMLIFrameElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const p = r.preview;
  const run = r.workspace !== null ? runLabel(r.workspace) : null;
  const src = p !== null && run !== null ? `/ws/${encodeURIComponent(run)}/${p.path.split("/").map(encodeURIComponent).join("/")}?v=${p.nonce}` : null;
  const pages = r.files.filter((f) => /\.html?$/i.test(f.path));

  useEffect(() => setErrors([]), [src]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { relayPreview?: boolean; message?: string } | null;
      if (e.source !== frame.current?.contentWindow || data?.relayPreview !== true) return;
      setErrors((es) => (es.length >= 30 ? es : [...es, String(data.message)]));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Remonte au pipeline une fois par chargement, en regroupant les premières erreurs.
  useEffect(() => {
    if (errors.length === 0 || p === null) return;
    const t = window.setTimeout(() => r.raiseError({ source: `l'aperçu de ${p.path}`, output: errors.join("\n") }, `aperçu:${p.path}:${p.nonce}`), 700);
    return () => clearTimeout(t);
  }, [errors.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (src === null || p === null) {
    return (
      <div className="panel">
        <p className="muted dag-empty">
          {pages.length > 0
            ? "Choisis une page dans Fichiers › « Aperçu dans Relay »."
            : "Quand un run crée une page web (.html), elle s'affiche ici et ses erreurs JavaScript remontent dans le pipeline."}
        </p>
        {pages.length > 0 ? (
          <div className="chips">
            {pages.map((f) => (
              <button key={f.path} className="chip" onClick={() => r.openPreview(f.path)}>
                {f.path}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="panel panel-flush preview">
      <div className="files-tools">
        <select value={p.path} onChange={(e) => r.openPreview(e.target.value)}>
          {(pages.some((f) => f.path === p.path) ? pages : [{ path: p.path, size: 0 }, ...pages]).map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
        </select>
        <button onClick={r.reloadPreview} title="Recharger la page">
          ↻
        </button>
        <button onClick={() => void r.openIn("folder", p.path)}>Navigateur</button>
      </div>
      {/* Isolée (sandbox sans même origine) : la page ne peut pas appeler l'API de Relay. */}
      <iframe ref={frame} key={src} className="preview-frame" src={src} title="Aperçu" sandbox="allow-scripts allow-forms allow-modals allow-popups" />
      {errors.length > 0 ? (
        <div className="preview-errors">
          <span className="inline-error">⚠ {errors.length} erreur(s) JavaScript : {errors[0]}</span>
          <button
            className="fix-btn"
            disabled={r.busy}
            onClick={() => r.fixError({ source: `l'aperçu de ${p.path}`, output: errors.join("\n") })}
          >
            Corriger avec Relay
          </button>
        </div>
      ) : null}
    </div>
  );
}
