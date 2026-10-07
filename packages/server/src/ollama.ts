/**
 * Phase F : Ollama intégré — machine, installation sans mot de passe, serveur, modèles,
 * et Ollama sur un VPS (tunnel SSH : rien n'est exposé sur Internet).
 *
 * Installation « pour moi seulement » : l'archive officielle (même fichier que le script
 * d'installation d'ollama.com) est extraite dans ~/.local/share/relay/ollama — pas de sudo,
 * pas de service système ; Relay démarre et arrête le serveur lui-même.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { arch, cpus, freemem, homedir, platform, totalmem } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createZstdDecompress } from "node:zlib";

export const LOCAL_URL = "http://127.0.0.1:11434";
/** Port local du tunnel SSH vers l'Ollama d'un VPS. */
export const TUNNEL_PORT = 11435;
export const TUNNEL_URL = `http://127.0.0.1:${TUNNEL_PORT}`;
const MANAGED_DIR = join(homedir(), ".local", "share", "relay", "ollama");
const MANAGED_BIN = join(MANAGED_DIR, "bin", "ollama");
const GB = 1024 ** 3;

// ── Machine ────────────────────────────────────────────────────────────────

export interface MachineInfo {
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  ramTotalGb: number;
  /** Mémoire réellement disponible (MemAvailable sous Linux). */
  ramAvailableGb: number;
  gpu: string | null;
  /** Mémoire vidéo dédiée (NVIDIA) ; null pour un GPU intégré ou inconnu. */
  vramGb: number | null;
  diskFreeGb: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function memAvailable(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m?.[1] !== undefined) return (Number(m[1]) * 1024) / GB;
  } catch {
    /* pas Linux */
  }
  return freemem() / GB;
}

function detectGpu(): { gpu: string | null; vramGb: number | null } {
  const nv = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 3000 });
  if (nv.status === 0 && nv.stdout.trim()) {
    const [name, mib] = nv.stdout.trim().split("\n")[0]?.split(",").map((x) => x.trim()) ?? [];
    return { gpu: name ?? "NVIDIA", vramGb: mib ? round1(Number(mib) / 1024) : null };
  }
  const pci = spawnSync("sh", ["-c", "lspci 2>/dev/null | grep -iE 'vga|3d|display' | head -1"], { encoding: "utf8", timeout: 3000 });
  const line = pci.stdout?.trim();
  if (line) return { gpu: line.replace(/^[\d:.]+\s+[^:]+:\s*/, ""), vramGb: null };
  return { gpu: platform() === "darwin" ? "Apple (mémoire unifiée)" : null, vramGb: null };
}

export function machineInfo(): MachineInfo {
  const c = cpus();
  let diskFreeGb: number | null = null;
  try {
    const s = statfsSync(homedir());
    diskFreeGb = round1((s.bavail * s.bsize) / GB);
  } catch {
    /* inconnu */
  }
  return {
    platform: platform(),
    arch: arch(),
    cpu: c[0]?.model.trim() ?? "inconnu",
    cores: c.length,
    ramTotalGb: round1(totalmem() / GB),
    ramAvailableGb: round1(memAvailable()),
    ...detectGpu(),
    diskFreeGb,
  };
}

// ── Modèles conseillés ─────────────────────────────────────────────────────

export interface ModelSuggestion {
  name: string;
  /** Taille approximative du téléchargement (Go). */
  sizeGb: number;
  tier: "quick" | "build" | "deep";
  use: string;
}

/** Sélection de départ (bibliothèque Ollama) ; tout autre nom de ollama.com/library fonctionne aussi. */
export const SUGGESTED_MODELS: ModelSuggestion[] = [
  { name: "qwen3:1.7b", sizeGb: 1.4, tier: "quick", use: "très léger : reformuler, petites tâches" },
  { name: "llama3.2:3b", sizeGb: 2.0, tier: "quick", use: "léger, généraliste" },
  { name: "qwen2.5-coder:3b", sizeGb: 1.9, tier: "quick", use: "léger, orienté code" },
  { name: "qwen3:4b", sizeGb: 2.5, tier: "quick", use: "petit mais raisonne bien" },
  { name: "gemma3:4b", sizeGb: 3.3, tier: "quick", use: "généraliste, bon en français" },
  { name: "qwen2.5-coder:7b", sizeGb: 4.7, tier: "build", use: "code, bon rapport qualité/taille" },
  { name: "qwen3:8b", sizeGb: 5.2, tier: "build", use: "généraliste solide" },
  { name: "deepseek-r1:8b", sizeGb: 5.2, tier: "build", use: "raisonnement (lent : il réfléchit)" },
  { name: "gpt-oss:20b", sizeGb: 14, tier: "build", use: "proche des modèles en ligne, demande 16 Go+" },
  { name: "qwen3-coder:30b", sizeGb: 19, tier: "build", use: "code avancé, demande 24 Go+" },
];

export type Fit = "ok" | "tight" | "too_big";

/**
 * Le modèle tient-il en mémoire ? Besoin ≈ taille × 1,2 + 1 Go (contexte). Sans GPU dédié,
 * tout passe par la RAM, dont ~2,5 Go restent au système, au navigateur et à Relay.
 */
export function modelFit(sizeGb: number, m: Pick<MachineInfo, "ramTotalGb" | "vramGb">): Fit {
  const need = sizeGb * 1.2 + 1;
  const budget = Math.max(m.vramGb ?? 0, m.ramTotalGb - 2.5);
  if (need <= budget * 0.8) return "ok";
  if (need <= budget) return "tight";
  return "too_big";
}

export function machineVerdict(m: MachineInfo): string {
  const budget = Math.max(m.vramGb ?? 0, m.ramTotalGb - 2.5);
  const maxModel = Math.max(0, (budget - 1) / 1.2);
  const where = m.vramGb !== null ? `${m.vramGb} Go de mémoire vidéo` : `${m.ramTotalGb} Go de RAM, sans GPU dédié (calcul sur CPU)`;
  if (maxModel < 1.5) return `${where} : trop juste pour un modèle local utile. Utilise un VPS ou Ollama Cloud.`;
  if (maxModel < 4) return `${where} : petits modèles seulement (jusqu'à ~${round1(maxModel)} Go), lents. Pour mieux : VPS ou Ollama Cloud.`;
  if (maxModel < 10) return `${where} : modèles moyens (7–8 milliards de paramètres) possibles${m.vramGb === null ? ", à vitesse modeste" : ""}.`;
  return `${where} : de gros modèles locaux sont possibles.`;
}

// ── Ollama local ───────────────────────────────────────────────────────────

export interface OllamaModel {
  name: string;
  sizeGb: number;
  parameters?: string;
  quantization?: string;
}

export interface OllamaStatus {
  url: string;
  /** Binaire présent (système ou installé par Relay). */
  installed: boolean;
  binary: string | null;
  /** Installé par Relay dans ~/.local/share/relay/ollama. */
  managed: boolean;
  /** Serveur démarré par Relay (arrêtable ici). */
  startedByRelay: boolean;
  running: boolean;
  version: string | null;
  models: OllamaModel[];
  loaded: string[];
}

let served: ChildProcess | null = null;

function systemBinary(): string | null {
  const r = spawnSync("sh", ["-c", "command -v ollama"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function ollamaBinary(): string | null {
  return existsSync(MANAGED_BIN) ? MANAGED_BIN : systemBinary();
}

async function getJson<T>(url: string, timeoutMs = 2_500): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
  return (await res.json()) as T;
}

export async function ollamaStatus(url: string): Promise<OllamaStatus> {
  const binary = ollamaBinary();
  const status: OllamaStatus = {
    url,
    installed: binary !== null,
    binary,
    managed: binary === MANAGED_BIN,
    startedByRelay: served !== null && served.exitCode === null,
    running: false,
    version: null,
    models: [],
    loaded: [],
  };
  try {
    status.version = (await getJson<{ version: string }>(`${url}/api/version`)).version;
    status.running = true;
    const tags = await getJson<{ models?: Array<{ name: string; size: number; details?: { parameter_size?: string; quantization_level?: string } }> }>(`${url}/api/tags`);
    status.models = (tags.models ?? []).map((m) => ({
      name: m.name,
      sizeGb: round1(m.size / GB),
      ...(m.details?.parameter_size ? { parameters: m.details.parameter_size } : {}),
      ...(m.details?.quantization_level ? { quantization: m.details.quantization_level } : {}),
    }));
    const ps = await getJson<{ models?: Array<{ name: string }> }>(`${url}/api/ps`).catch(() => ({ models: [] }));
    status.loaded = (ps.models ?? []).map((m) => m.name);
  } catch {
    /* serveur arrêté ou injoignable */
  }
  return status;
}

export type Progress = (p: { status: string; completed?: number; total?: number }) => void;

/** Installe Ollama pour l'utilisateur courant (Linux), sans mot de passe. */
export async function installManaged(
  onProgress: Progress,
  signal?: AbortSignal,
  /** Pour les tests : autre source et autre dossier (jamais le dossier de l'utilisateur). */
  opts: { downloadBase?: string; dir?: string } = {},
): Promise<string> {
  const dir = opts.dir ?? MANAGED_DIR;
  const bin = join(dir, "bin", "ollama");
  if (platform() !== "linux") {
    throw new Error("installation automatique disponible sous Linux ; sur macOS et Windows, télécharge Ollama sur ollama.com/download");
  }
  const cpu = arch() === "x64" ? "amd64" : arch() === "arm64" ? "arm64" : null;
  if (cpu === null) throw new Error(`architecture non prise en charge : ${arch()}`);

  const base = `${opts.downloadBase ?? "https://ollama.com/download"}/ollama-linux-${cpu}`;
  let res = await fetch(`${base}.tar.zst`, { ...(signal ? { signal } : {}) });
  let decompress: NodeJS.ReadWriteStream = createZstdDecompress();
  if (!res.ok) {
    res = await fetch(`${base}.tgz`, { ...(signal ? { signal } : {}) });
    decompress = createGunzip();
  }
  if (!res.ok || res.body === null) throw new Error(`téléchargement impossible (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0) || undefined;

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
  let tarErr = "";
  tar.stderr?.on("data", (d: Buffer) => (tarErr += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`extraction échouée (${code}) ${tarErr.slice(-300)}`))));
    tar.on("error", reject);
  });

  let completed = 0;
  let lastPct = -1;
  const source = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    completed += chunk.length;
    const pct = total ? Math.floor((completed / total) * 100) : -1;
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress({ status: "téléchargement", completed, ...(total !== undefined ? { total } : {}) });
    }
  });
  source.on("error", (e) => tar.kill() && decompress.emit("error", e));
  decompress.on("error", (e) => {
    tar.kill();
    tarErr += String(e);
  });
  source.pipe(decompress).pipe(tar.stdin as NodeJS.WritableStream);
  await done;

  if (!existsSync(bin)) throw new Error("archive extraite, mais le binaire ollama est introuvable");
  chmodSync(bin, 0o755);
  onProgress({ status: "installé" });
  const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
  return /\d+(\.\d+)+/.exec(`${v.stdout} ${v.stderr}`)?.[0] ?? "?";
}

/** Démarre `ollama serve` (lié à 127.0.0.1 : rien n'est exposé sur le réseau). */
export async function startServer(): Promise<void> {
  const bin = ollamaBinary();
  if (bin === null) throw new Error("Ollama n'est pas installé");
  if ((await ollamaStatus(LOCAL_URL)).running) return;
  const logPath = join(MANAGED_DIR, "serve.log");
  mkdirSync(MANAGED_DIR, { recursive: true });
  const fd = openSync(logPath, "a");
  const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" };
  delete env["ELECTRON_RUN_AS_NODE"];
  served = spawn(bin, ["serve"], { detached: true, stdio: ["ignore", fd, fd], env });
  closeSync(fd);
  served.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if ((await ollamaStatus(LOCAL_URL)).running) return;
    if (served.exitCode !== null) break;
  }
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-600) : "";
  throw new Error(`le serveur Ollama n'a pas démarré${log ? ` : ${log}` : ""}`);
}

export function stopServer(): boolean {
  if (served === null || served.exitCode !== null || served.pid === undefined) return false;
  try {
    process.kill(-served.pid, "SIGTERM");
  } catch {
    served.kill("SIGTERM");
  }
  served = null;
  return true;
}

/** Télécharge un modèle, avec progression (flux NDJSON de /api/pull). */
export async function pullModel(url: string, model: string, onProgress: Progress, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${url}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || res.body === null) throw new Error(`téléchargement refusé (${res.status}) ${await res.text().catch(() => "")}`.trim());
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const ev = JSON.parse(line) as { status?: string; error?: string; total?: number; completed?: number };
        if (ev.error) throw new Error(ev.error);
        onProgress({ status: ev.status ?? "", ...(ev.total ? { total: ev.total } : {}), ...(ev.completed ? { completed: ev.completed } : {}) });
      }
      nl = buffer.indexOf("\n");
    }
  }
}

export async function deleteModel(url: string, model: string): Promise<void> {
  const res = await fetch(`${url}/api/delete`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
  if (!res.ok) throw new Error(`suppression refusée (${res.status})`);
}

/** Petit essai : temps de réponse et vitesse (tokens/s), pour savoir si le modèle est utilisable ici. */
export async function testModel(url: string, model: string): Promise<{ reply: string; seconds: number; tokensPerSecond: number | null }> {
  const started = Date.now();
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "Réponds en une phrase : à quoi sers-tu ?" }] }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
  const r = (await res.json()) as { message?: { content?: string }; eval_count?: number; eval_duration?: number };
  return {
    reply: (r.message?.content ?? "").trim().slice(0, 400),
    seconds: round1((Date.now() - started) / 1000),
    tokensPerSecond: r.eval_count && r.eval_duration ? round1(r.eval_count / (r.eval_duration / 1e9)) : null,
  };
}

// ── Ollama sur un VPS (SSH) ────────────────────────────────────────────────

export interface RemoteTarget {
  host: string;
  user: string;
  port: number;
  keyPath: string;
}

export const DEFAULT_KEY = join(homedir(), ".ssh", "relay_ed25519");

/** Champs SSH sûrs (passés en arguments, jamais à un shell local). */
export function checkRemote(raw: Partial<RemoteTarget>): RemoteTarget {
  const host = (raw.host ?? "").trim();
  const user = (raw.user ?? "").trim() || "ubuntu";
  const port = Number(raw.port ?? 22) || 22;
  const keyPath = (raw.keyPath ?? "").trim() || DEFAULT_KEY;
  if (!/^[A-Za-z0-9.-]+$|^\[?[0-9a-fA-F:]+\]?$/.test(host)) throw new Error("adresse du VPS invalide (IP ou nom de domaine)");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("nom d'utilisateur invalide");
  if (port < 1 || port > 65535) throw new Error("port invalide");
  if (!existsSync(keyPath)) throw new Error(`clé SSH introuvable : ${keyPath} (génère-en une avec le bouton prévu)`);
  return { host, user, port, keyPath };
}

const sshBase = (t: RemoteTarget): string[] => [
  "-i", t.keyPath,
  "-p", String(t.port),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=30",
];

/** Clé dédiée à Relay (sans phrase de passe) : la partie publique est à coller chez l'hébergeur. */
export function ensureKey(): { keyPath: string; publicKey: string; created: boolean } {
  let created = false;
  if (!existsSync(DEFAULT_KEY)) {
    mkdirSync(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
    const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "relay", "-f", DEFAULT_KEY], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ssh-keygen a échoué : ${r.stderr || r.error?.message || ""}`);
    created = true;
  }
  return { keyPath: DEFAULT_KEY, publicKey: readFileSync(`${DEFAULT_KEY}.pub`, "utf8").trim(), created };
}

/** Commande distante fixe ; la sortie arrive ligne par ligne. */
export function sshRun(t: RemoteTarget, remoteCommand: string, onLine: (line: string) => void, timeoutMs = 600_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshBase(t), `${t.user}@${t.host}`, remoteCommand], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let rest = "";
    const feed = (d: Buffer): void => {
      rest += d.toString();
      const lines = rest.split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(l);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ssh introuvable ou impossible à lancer : ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (rest.trim()) onLine(rest);
      resolve(code);
    });
  });
}

export const REMOTE_SPECS =
  "echo \"système : $(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME) $(uname -m)\"; echo \"cœurs : $(nproc)\"; free -g | awk '/Mem:/ {print \"RAM : \" $2 \" Go (dispo \" $7 \" Go)\"}'; df -h ~ | awk 'NR==2 {print \"disque libre : \" $4}'; (command -v ollama >/dev/null && echo \"ollama : $(ollama --version 2>&1 | tail -1)\") || echo 'ollama : non installé'";

/** Installation officielle sur le VPS (demande sudo sans mot de passe, comme l'utilisateur ubuntu d'Oracle). */
export const REMOTE_INSTALL =
  "set -e; if command -v ollama >/dev/null; then echo 'Ollama déjà installé'; else curl -fsSL https://ollama.com/install.sh | sudo -n sh; fi; sudo -n systemctl enable --now ollama >/dev/null 2>&1 || true; sleep 2; curl -fsS http://127.0.0.1:11434/api/version && echo && echo 'Ollama prêt (écoute en local sur le VPS, joignable par tunnel SSH)'";

let tunnel: ChildProcess | null = null;
let tunnelError: string | null = null;

export function tunnelState(): { running: boolean; error: string | null } {
  return { running: tunnel !== null && tunnel.exitCode === null, error: tunnelError };
}

/** Tunnel SSH : 127.0.0.1:11435 (ici) → 127.0.0.1:11434 (VPS). Chiffré, rien d'ouvert sur le VPS. */
export async function openTunnel(t: RemoteTarget): Promise<void> {
  closeTunnel();
  tunnelError = null;
  let stderr = "";
  tunnel = spawn("ssh", [...sshBase(t), "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${TUNNEL_PORT}:127.0.0.1:11434`, `${t.user}@${t.host}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  tunnel.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  tunnel.on("close", () => {
    if (stderr.trim()) tunnelError = stderr.trim().slice(-400);
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (tunnel.exitCode !== null) break;
    if ((await ollamaStatus(TUNNEL_URL)).running) return;
  }
  const err = stderr.trim() || "le VPS ne répond pas sur Ollama (installé et démarré ?)";
  closeTunnel();
  tunnelError = err.slice(-400);
  throw new Error(err);
}

export function closeTunnel(): void {
  if (tunnel !== null && tunnel.exitCode === null) tunnel.kill("SIGTERM");
  tunnel = null;
}

/** Relay quitte : on n'abandonne ni tunnel ni serveur derrière soi. */
export function shutdownOllama(): void {
  closeTunnel();
  stopServer();
}
