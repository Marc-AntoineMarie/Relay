/**
 * Phase G : terminal intégré. Un vrai shell interactif (pseudo-terminal) dans le dossier du
 * projet, affiché par xterm.js dans l'interface.
 *
 * Pas de module natif (node-pty) : un petit pont Python (`pty`, bibliothèque standard) crée le
 * pseudo-terminal — rien à compiler, et ça marche aussi bien dans Electron qu'en mode navigateur.
 * Les sessions vivent côté serveur : changer d'onglet ou recharger la page ne tue pas le shell
 * (les dernières sorties sont rejouées à la reconnexion).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { platform } from "node:os";
import { StringDecoder } from "node:string_decoder";

/** Pont pseudo-terminal : stdin → shell, shell → stdout, fd 3 = « lignes colonnes » (redimensionnement). */
const PTY_BRIDGE = String.raw`
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows, shell, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(shell, [shell, "-i"])
def size(r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
def write_all(f, data):
    while data:
        n = os.write(f, data)
        data = data[n:]
size(rows, cols)
watch = [fd, 0, 3]
pending = b""
while True:
    try:
        ready, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            break
        write_all(fd, data)
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            watch.remove(3)
            continue
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                r, c = map(int, line.split())
                size(r, c)
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
try:
    os.kill(pid, signal.SIGHUP)
except Exception:
    pass
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`;

/** Environnement du terminal : le tien, sans les clés API de Relay. */
function terminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|GEMINI|GROQ|DEEPSEEK|OPENROUTER|NVIDIA|CEREBRAS|MISTRAL|HF_|ELECTRON/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", RELAY_TERMINAL: "1" };
}

const MAX_REPLAY = 200_000;

interface Session {
  id: string;
  root: string;
  child: ChildProcess;
  decoder: StringDecoder;
  /** Dernières sorties, rejouées à la reconnexion. */
  replay: string;
  clients: Set<ServerResponse>;
  exitCode: number | null | undefined;
}

const sessions = new Map<string, Session>();

const send = (res: ServerResponse, event: Record<string, unknown>): void => {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
};

export function terminalSupported(): string | null {
  if (platform() === "win32") return "terminal intégré disponible sous Linux et macOS pour l'instant";
  const py = spawnSync("python3", ["-c", "import pty"], { timeout: 3000 });
  return py.status === 0 ? null : "python3 introuvable : il sert à créer le pseudo-terminal";
}

export function openTerminal(root: string, cols: number, rows: number): Session {
  const problem = terminalSupported();
  if (problem !== null) throw new Error(problem);
  const shell = process.env["SHELL"] || "/bin/bash";
  const child = spawn("python3", ["-u", "-c", PTY_BRIDGE, String(cols), String(rows), shell, root], {
    cwd: root,
    env: terminalEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const s: Session = { id: randomUUID(), root, child, decoder: new StringDecoder("utf8"), replay: "", clients: new Set(), exitCode: undefined };
  const out = (chunk: Buffer): void => {
    const text = s.decoder.write(chunk);
    if (!text) return;
    s.replay = (s.replay + text).slice(-MAX_REPLAY);
    for (const c of s.clients) send(c, { type: "data", data: text });
  };
  child.stdout?.on("data", out);
  child.stderr?.on("data", out);
  child.on("exit", (code) => {
    s.exitCode = code;
    for (const c of s.clients) {
      send(c, { type: "exit", code });
      c.end();
    }
    s.clients.clear();
  });
  child.on("error", (e) => out(Buffer.from(`\r\n[terminal] ${e.message}\r\n`)));
  sessions.set(s.id, s);
  return s;
}

function get(id: unknown): Session {
  const s = typeof id === "string" ? sessions.get(id) : undefined;
  if (s === undefined) throw new Error("terminal introuvable (fermé ?)");
  return s;
}

/** Flux SSE : rejoue l'historique récent, puis la sortie en direct. */
export function streamTerminal(id: unknown, res: ServerResponse): void {
  const s = get(id);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  if (s.replay) send(res, { type: "data", data: s.replay });
  if (s.exitCode !== undefined) {
    send(res, { type: "exit", code: s.exitCode });
    res.end();
    return;
  }
  s.clients.add(res);
  res.on("close", () => s.clients.delete(res));
}

export function writeTerminal(id: unknown, data: unknown): void {
  if (typeof data !== "string" || data.length > 100_000) throw new Error("entrée invalide");
  get(id).child.stdin?.write(data);
}

export function resizeTerminal(id: unknown, cols: unknown, rows: unknown): void {
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 10 || r < 2 || c > 1000 || r > 500) return;
  const ctrl = get(id).child.stdio[3];
  if (ctrl !== null && ctrl !== undefined && "write" in ctrl) (ctrl as NodeJS.WritableStream).write(`${r} ${c}\n`);
}

export function closeTerminal(id: unknown): void {
  const s = get(id);
  s.child.stdin?.end();
  s.child.kill("SIGHUP");
  sessions.delete(s.id);
}

/** Terminaux ouverts d'un projet (pour s'y rattacher après un changement d'onglet). */
export function listTerminals(root: string): Array<{ id: string; running: boolean }> {
  return [...sessions.values()].filter((s) => s.root === root).map((s) => ({ id: s.id, running: s.exitCode === undefined }));
}

export function shutdownTerminals(): void {
  for (const s of sessions.values()) s.child.kill("SIGHUP");
  sessions.clear();
}
