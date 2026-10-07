/**
 * Phase D : voir et tester ce que les agents ont réellement produit.
 * - Fichiers : arborescence du dossier du run + contenu, mis à jour en direct.
 * - Exécution : commandes des agents (sorties), et tes propres commandes (avec entrée).
 * - Validations : en mode Prudent, chaque commande d'agent attend ton accord.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "./api";
import { useRelay } from "./store";
import type { CommandView, WorkspaceFile } from "./types";

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
              <div className="file-view-head muted small">{content.path}</div>
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
          <CommandItem key={c.id} c={c} open={i === r.commands.length - 1} onReplay={() => setCommand(c.command)} />
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

function CommandItem({ c, open, onReplay }: { c: CommandView; open: boolean; onReplay: () => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  const state = c.running
    ? { icon: "…", cls: "run", text: "en cours" }
    : c.refused !== undefined
      ? { icon: "⊘", cls: "refused", text: c.refused }
      : c.launched === true
        ? { icon: "↗", cls: "ok", text: "lancée (fenêtre à part)" }
        : c.timedOut === true
          ? { icon: "⏱", cls: "fail", text: "délai dépassé" }
          : c.exitCode === 0
            ? { icon: "✓", cls: "ok", text: "code 0" }
            : { icon: "✗", cls: "fail", text: `code ${c.exitCode ?? "?"}` };
  return (
    <li className={`cmd cmd-${state.cls}`}>
      <button className="cmd-line" onClick={() => setExpanded((x) => !x)}>
        <span className="cmd-icon">{c.running ? <span className="spinner" /> : state.icon}</span>
        <code className="cmd-text">{c.command}</code>
        <span className="muted small">
          {c.by === "agent" ? `agent #${c.taskId ?? "?"}` : "toi"} · {state.text}
          {c.durationMs !== undefined && !c.running ? ` · ${(c.durationMs / 1000).toFixed(1)} s` : ""}
        </span>
      </button>
      {expanded && !c.running ? (
        <div className="cmd-out">
          {c.output !== undefined ? <pre className="log-detail">{c.output || "(aucune sortie)"}</pre> : null}
          <button className="link" onClick={onReplay}>
            reprendre cette commande
          </button>
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
