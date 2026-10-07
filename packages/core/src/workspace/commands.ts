/**
 * Exécution des commandes des agents dans le dossier de travail.
 *
 * Garde-fous : commandes destructrices évidentes refusées (tous modes), clés API retirées
 * de l'environnement, durée maximale, sortie bornée, processus tué avec ses enfants.
 *
 * Politiques :
 * - `ask`  (Prudent) : chaque commande attend la validation de l'utilisateur ;
 * - `safe` (Sûr)     : seuls des programmes de développement courants sont autorisés ;
 * - `auto` (Libre)   : tout sauf la liste noire.
 * Honnêteté : un interpréteur (python, node…) peut tout faire ; « Sûr » protège des erreurs,
 * pas d'un code malveillant. Le contrôle total, c'est « Prudent ».
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CommandPolicy = "ask" | "safe" | "auto";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandCheck {
  allowed: boolean;
  /** Raison du refus. */
  reason?: string;
  /** Mode Prudent : à faire valider par l'utilisateur. */
  needsApproval?: boolean;
}

const DENY: RegExp[] = [
  /\bsudo\b|\bsu\s/,
  /\brm\s+(-[a-z]*\s+)*(\/|~|\$HOME|\.\.)(\s|$)/i,
  /\b(mkfs|fdisk|shutdown|reboot|halt|poweroff)\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/, // fork bomb
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
  /\b(ssh|scp|rsync)\b/,
  /\bgit\s+push\b/,
  /\bchmod\s+(-R\s+)?[0-7]*\s+\//,
  />\s*\/dev\/sd/,
  /\bfind\b.*\s-(delete|exec)\b/,
];

/** Programmes autorisés en mode Sûr. */
const SAFE = new Set([
  "python", "python3", "pytest", "node", "deno", "go", "cargo", "rustc", "gcc", "g++", "cc", "clang",
  "make", "javac", "java", "ruby", "php", "npm", "ls", "cat", "echo", "head", "tail", "wc", "grep",
  "find", "diff", "tree", "pwd", "true", "test", "sort", "uniq", "mkdir", "touch",
]);

export function checkCommand(command: string, policy: CommandPolicy): CommandCheck {
  for (const re of DENY) {
    if (re.test(command)) return { allowed: false, reason: "commande potentiellement destructrice, refusée" };
  }
  if (policy === "auto") return { allowed: true };
  if (policy === "ask") return { allowed: true, needsApproval: true };

  for (const segment of command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean)) {
    const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const program = (words[0] ?? "").replace(/^.*\//, "");
    if (!SAFE.has(program)) {
      return { allowed: false, reason: `« ${program} » n'est pas autorisé en mode Sûr (Réglages › Général pour changer)` };
    }
    if (program === "npm" && !/^npm\s+(test|run)\b/.test(segment)) {
      return { allowed: false, reason: "seuls « npm test » et « npm run … » sont autorisés en mode Sûr" };
    }
  }
  return { allowed: true };
}

/** Environnement sans secrets (clés API, jetons) pour les commandes des agents. */
function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|GEMINI|GROQ|DEEPSEEK|OPENROUTER|ELECTRON/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, CI: "1", TERM: "dumb", NO_COLOR: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" };
}

export function trimOutput(out: string, max: number): string {
  return out.length > max ? `${out.slice(0, 3_000)}\n[…sortie tronquée…]\n${out.slice(-(max - 3_000))}` : out;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  /** Entrée standard (non interactive : envoyée puis fermée). */
  stdin?: string;
  maxOutput?: number;
}

export interface LaunchResult {
  pid?: number;
  /** Le programme s'est arrêté pendant la surveillance (souvent : plantage au démarrage). */
  exited: boolean;
  exitCode: number | null;
  /** Sortie des premières secondes. */
  output: string;
  /** Journal complet de la sortie (le programme continue d'y écrire). */
  logPath: string;
}

export interface LaunchOptions {
  /** Durée de surveillance avant de rendre la main. */
  watchMs?: number;
  /** Appelé quand le programme se termine, même bien après la surveillance. */
  onExit?: (exitCode: number | null) => void;
}

/**
 * Lance un programme sans l'attendre (application graphique…). Surveille les premières
 * secondes : s'il plante au démarrage, l'erreur est renvoyée au lieu d'être perdue.
 */
export function launchCommand(command: string, cwd: string, opts: LaunchOptions = {}): Promise<LaunchResult> {
  const watchMs = opts.watchMs ?? 2_500;
  const logPath = join(tmpdir(), `relay-launch-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logPath, "w");
  return new Promise((resolveLaunch, reject) => {
    const child = spawn("bash", ["-c", command], { cwd, env: safeEnv(), detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd); // l'enfant garde sa copie
    let exitCode: number | null | undefined;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      let output = "";
      try {
        output = trimOutput(readFileSync(logPath, "utf8"), 8_000);
      } catch {
        /* journal illisible : sortie vide */
      }
      resolveLaunch({ ...(child.pid !== undefined ? { pid: child.pid } : {}), exited: exitCode !== undefined, exitCode: exitCode ?? null, output, logPath });
    };
    const timer = setTimeout(finish, watchMs);
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      exitCode = code;
      opts.onExit?.(code);
      finish();
    });
  });
}

export function runCommand(command: string, opts: RunCommandOptions): Promise<CommandResult> {
  const max = opts.maxOutput ?? 20_000;
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", command], {
      cwd: opts.cwd,
      env: safeEnv(),
      detached: true, // groupe de processus : on tue aussi les enfants
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    const add = (d: Buffer): void => {
      out += d.toString("utf8");
      if (out.length > max * 2) out = trimOutput(out, max);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* déjà terminé */
      }
    }, opts.timeoutMs ?? 60_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolveResult({ command, exitCode: null, output: `impossible de lancer la commande : ${e.message}`, durationMs: Date.now() - started, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({
        command,
        exitCode: timedOut ? null : code,
        output: trimOutput(out, max) + (timedOut ? "\n[arrêtée : délai dépassé]" : ""),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
