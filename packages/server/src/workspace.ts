/**
 * Dossiers de travail des runs (phase D) : création, confinement, outils de la machine,
 * ouverture dans le gestionnaire de fichiers ou VS Code.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_WORKSPACE_ROOT = join(homedir(), "relay-workspaces");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `20261007-231502-cree-une-calculatrice` : trié par date, lisible. */
export function runDirName(prompt: string, now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = prompt
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${stamp}-${slug || "run"}`;
}

export function newRunDir(base: string, prompt: string): string {
  const name = runDirName(prompt);
  let dir = join(base, name);
  for (let i = 2; existsSync(dir); i++) dir = join(base, `${name}-${i}`);
  return dir;
}

const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);

/** `root` doit être un dossier de run existant sous la racine des espaces de travail. */
export function confineRunDir(base: string, root: string): string {
  const r = real(resolve(root));
  const rel = relative(real(resolve(base)), r);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("dossier hors des espaces de travail Relay");
  if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error("dossier introuvable");
  return r;
}

export interface RunDir {
  name: string;
  root: string;
  modified: number;
}

/** Runs précédents, du plus récent au plus ancien. */
export function listRunDirs(base: string, max = 40): RunDir[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const root = join(base, e.name);
      return { name: e.name, root, modified: statSync(root).mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, max);
}

const TOOLS: Array<[label: string, cmd: string, args: string[]]> = [
  ["python3", "python3", ["--version"]],
  ["python", "python", ["--version"]],
  ["pytest", "python3", ["-m", "pytest", "--version"]],
  ["tkinter", "python3", ["-c", "import tkinter; print(tkinter.TkVersion)"]],
  ["node", "node", ["--version"]],
  ["gcc", "gcc", ["--version"]],
  ["go", "go", ["version"]],
  ["cargo", "cargo", ["--version"]],
  ["java", "javac", ["-version"]],
];

/** Modules Python souvent supposés présents alors qu'ils sont empaquetés à part (Debian : python3-tk). */
const PYTHON_EXTRAS: Record<string, string> = {
  python: "commande « python » (écrire python3)",
  pytest: "pytest (utiliser unittest)",
  tkinter: "tkinter (aucune interface graphique Tk possible)",
};

export interface MachineEnvironment {
  /** Outils présents, avec version. */
  tools: string;
  /** Modules courants absents, à signaler pour ne pas écrire du code qui ne démarrera pas. */
  missing: string[];
}

let environment: Promise<MachineEnvironment> | undefined;

/** Outils présents sur la machine (indiqués aux agents pour qu'ils écrivent du code lançable ici). */
export function detectEnvironment(): Promise<MachineEnvironment> {
  environment ??= Promise.all(
    TOOLS.map(
      ([label, cmd, args]) =>
        new Promise<string>((done) => {
          execFile(cmd, args, { timeout: 3_000 }, (err, stdout, stderr) => {
            const version = /\d+(\.\d+)+/.exec(`${stdout} ${stderr}`)?.[0];
            done(err === null && version !== undefined ? `${label} ${version}` : "");
          });
        }),
    ),
  ).then((found) => {
    const present = found.filter(Boolean);
    const has = (label: string): boolean => present.some((t) => t.startsWith(`${label} `));
    const missing = has("python3") ? Object.keys(PYTHON_EXTRAS).filter((m) => !has(m)).map((m) => PYTHON_EXTRAS[m] ?? m) : [];
    return { tools: present.join(", "), missing };
  });
  return environment;
}

/** Une ligne pour les agents : présents, puis absents. */
export function describeEnvironment(env: MachineEnvironment): string {
  return `${env.tools || "aucun outil détecté"}${env.missing.length > 0 ? ` — ABSENTS : ${env.missing.join(", ")}` : ""}`;
}

/** Ouvre un dossier (gestionnaire de fichiers), un fichier (application par défaut, ex. navigateur pour .html), ou VS Code. */
export function openDir(root: string, target: "folder" | "vscode"): Promise<void> {
  const os = platform();
  const cmd = target === "vscode" ? "code" : os === "darwin" ? "open" : os === "win32" ? "explorer" : "xdg-open";
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"]; // sinon VS Code (Electron) démarrerait comme Node
  return new Promise((done, fail) => {
    const child = spawn(cmd, [root], { detached: true, stdio: "ignore", env, shell: os === "win32" });
    child.once("error", (e) => fail(new Error(target === "vscode" ? `commande « code » introuvable (${e.message})` : e.message)));
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}
