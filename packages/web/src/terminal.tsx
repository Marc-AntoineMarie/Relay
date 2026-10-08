/**
 * Phase G : terminal intégré (xterm.js), ouvert dans le dossier du projet.
 * La session vit côté moteur : changer d'onglet ou de disposition ne tue pas le shell.
 * « Erreur → Relay » envoie la sélection (ou la fin de la sortie) au pipeline, comme une erreur
 * rencontrée en testant, pour la faire corriger.
 */
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { readSse } from "./api";
import { useRelay } from "./store";

/** Terminal ouvert par projet (survit au démontage du panneau). */
const sessionByRoot = new Map<string, string>();

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function findOrOpen(root: string, cols: number, rows: number, fresh: boolean): Promise<string> {
  const known = sessionByRoot.get(root);
  if (!fresh && known !== undefined) return known;
  if (!fresh) {
    const res = await fetch(`/api/terminal/list?root=${encodeURIComponent(root)}`);
    const data = (await res.json()) as { terminals?: Array<{ id: string; running: boolean }>; error?: string };
    const running = data.terminals?.find((t) => t.running);
    if (running !== undefined) {
      sessionByRoot.set(root, running.id);
      return running.id;
    }
  }
  const res = await post("/api/terminal/open", { root, cols, rows });
  const data = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || data.id === undefined) throw new Error(data.error ?? "ouverture impossible");
  sessionByRoot.set(root, data.id);
  return data.id;
}

/** Fin de la sortie visible (si rien n'est sélectionné). */
function lastLines(term: Terminal, n = 40): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = Math.max(0, buf.length - n); i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n").trim();
}

export function TerminalPanel(): React.JSX.Element {
  const r = useRelay();
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [generation, setGeneration] = useState(0);
  const root = r.workspace;

  useEffect(() => {
    if (root === null || host.current === null) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0d121a", foreground: "#e7ecf3", cursor: "#5b8cff", selectionBackground: "rgba(91, 140, 255, 0.35)" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    const abort = new AbortController();
    let queue = "";
    let flush: number | undefined;
    setError(null);
    setExited(false);

    try {
      fit.fit();
    } catch {
      /* panneau pas encore mesuré */
    }

    // Frappe → moteur, regroupée par petits paquets (moins de requêtes, ordre conservé).
    const onData = term.onData((d) => {
      queue += d;
      if (flush === undefined) {
        flush = window.setTimeout(() => {
          const data = queue;
          queue = "";
          flush = undefined;
          if (idRef.current !== null) void post("/api/terminal/input", { id: idRef.current, data });
        }, 8);
      }
    });

    let lastSize = "";
    const resize = (): void => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize && idRef.current !== null) {
        lastSize = size;
        void post("/api/terminal/resize", { id: idRef.current, cols: term.cols, rows: term.rows });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);

    void (async () => {
      try {
        const id = await findOrOpen(root, term.cols, term.rows, generation > 0);
        idRef.current = id;
        resize();
        const res = await fetch(`/api/terminal/stream?id=${encodeURIComponent(id)}`, { signal: abort.signal });
        if (!res.ok || !res.body) throw new Error("flux du terminal indisponible");
        for await (const ev of readSse(res.body)) {
          if (ev["type"] === "data") term.write(String(ev["data"]));
          else if (ev["type"] === "exit") {
            setExited(true);
            sessionByRoot.delete(root);
          }
        }
      } catch (e: unknown) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          sessionByRoot.delete(root);
        }
      }
    })();
    term.focus();

    return () => {
      abort.abort();
      observer.disconnect();
      onData.dispose();
      if (flush !== undefined) clearTimeout(flush);
      term.dispose();
      termRef.current = null;
      idRef.current = null;
    };
  }, [root, generation]);

  if (root === null) {
    return (
      <div className="panel">
        <p className="muted dag-empty">Ouvre ou crée un projet : le terminal s'ouvrira dans son dossier.</p>
      </div>
    );
  }

  const selectionOrTail = (): string => {
    const t = termRef.current;
    if (t === null) return "";
    return t.getSelection().trim() || lastLines(t);
  };

  const restart = (): void => {
    const id = idRef.current;
    if (id !== null) void post("/api/terminal/close", { id });
    sessionByRoot.delete(root);
    setGeneration((g) => g + 1);
  };

  return (
    <div className="panel panel-flush term">
      <div className="files-tools">
        <code className="muted small term-cwd" title={root}>
          {r.projectName ?? root}
        </code>
        <button
          onClick={() => {
            const text = selectionOrTail();
            if (text) r.raiseError({ source: "le terminal", output: text }, `terminal:${Date.now()}`);
          }}
          title="Envoie la sélection (ou la fin de la sortie) au pipeline comme une erreur à corriger"
        >
          Erreur → Relay
        </button>
        <button
          onClick={() => {
            const text = selectionOrTail();
            if (text) r.setPrompt(`${r.prompt ? `${r.prompt}\n\n` : ""}Sortie du terminal :\n${text}`);
          }}
          title="Ajoute la sélection (ou la fin de la sortie) à ton message dans la Conversation"
        >
          → Conversation
        </button>
        <button onClick={() => termRef.current?.clear()}>Effacer</button>
        <button onClick={restart} title="Ferme ce shell et en ouvre un nouveau">
          Nouveau terminal
        </button>
      </div>
      {error !== null ? (
        <p className="inline-error term-msg">
          ⚠ {error}{" "}
          <button className="link" onClick={restart}>
            réessayer
          </button>
        </p>
      ) : null}
      {exited ? (
        <p className="muted small term-msg">
          Le shell s'est terminé.{" "}
          <button className="link" onClick={restart}>
            Rouvrir un terminal
          </button>
        </p>
      ) : null}
      <div className="term-host" ref={host} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
