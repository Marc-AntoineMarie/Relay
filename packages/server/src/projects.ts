/**
 * Projets (phase E) : un projet = un dossier au nom simple (« calculatrice »), où tu veux,
 * avec sa conversation (`.relay/conversation.json`), sa session technique
 * (`.relay/session.json`) et sa mémoire lisible (`RELAY.md`).
 *
 * Les projets créés hors de la racine des runs, ou importés, sont inscrits dans un index
 * (`.relay/projects.json` du dépôt Relay) : seuls ces dossiers sont accessibles à l'API.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PlanQuestion } from "@relay/core";

export interface ConversationMessage {
  id: string;
  at: string;
  role: "user" | "relay";
  /** prompt : demande ; answer : réponse aux questions ; fix : correction d'une erreur ; questions / result : Relay. */
  kind: "prompt" | "answer" | "fix" | "questions" | "result";
  text: string;
  analysis?: string;
  assumptions?: string[];
  questions?: PlanQuestion[];
  tasks?: Array<{ id: string; description: string; tier: string; status: string; model?: string; provider?: string }>;
  files?: string[];
  outcome?: "done" | "failed" | "stopped";
  cost?: { billed: number; reference: number; durationMs: number; tokens: number };
  /** Correction : sortie de l'erreur rencontrée. */
  error?: string;
  /** Vérification finale du lancement par Relay. */
  launch?: { command: string; ok: boolean };
}

export interface ProjectInfo {
  name: string;
  root: string;
  updated: number;
  messages: number;
  /** Dernière demande de l'utilisateur (aperçu dans l'historique). */
  last?: string;
}

const conversationFile = (root: string): string => join(root, ".relay", "conversation.json");
export const memoryFile = (root: string): string => join(root, "RELAY.md");

// ── Noms ────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(
  (
    "cree creer creez fais fait faire faites moi nous une un le la les des de du d l en avec pour par sur dans je j veux voudrais " +
    "aimerais pouvoir peux puisse qui que qu et ou a au aux mon ma mes ton ta tes son sa ses ce cet cette ces simple petit petite " +
    "nouveau nouvelle mini application appli app programme projet code script logiciel outil python javascript js typescript ts html " +
    "css web page site interface graphique gui cli tests test lancer tester voir utiliser realise realiser genere generer ecris ecrire " +
    "developpe developper svp stp merci the an make create build me with and for in of to please write"
  ).split(" "),
);

/** Nom court et lisible tiré de la demande : « Crée une calculatrice en Python » → « calculatrice ». */
export function suggestName(prompt: string): string {
  const words = prompt
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return slugify(words.slice(0, 2).join("-"));
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "");
  return slug || "projet";
}

/** `location/name`, ou `name-2`, `name-3`… si le dossier existe déjà. */
export function uniqueDir(location: string, name: string): string {
  let dir = join(location, name);
  for (let i = 2; existsSync(dir); i++) dir = join(location, `${name}-${i}`);
  return dir;
}

export function expandPath(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  return t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
}

// ── Index des projets ───────────────────────────────────────────────────────

const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p));
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

export class ProjectStore {
  constructor(
    private readonly indexPath: () => string,
    private readonly base: () => string,
  ) {}

  private registered(): string[] {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath(), "utf8")) as { projects?: unknown };
      return Array.isArray(raw.projects) ? raw.projects.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  register(root: string): void {
    const all = new Set(this.registered());
    all.add(real(root));
    mkdirSync(dirname(this.indexPath()), { recursive: true });
    writeFileSync(this.indexPath(), `${JSON.stringify({ projects: [...all] }, null, 2)}\n`);
  }

  /** Le dossier est-il un projet que l'API peut toucher ? (sous la racine des runs, ou inscrit) */
  resolveProject(root: unknown): string {
    if (typeof root !== "string" || root.trim().length === 0) throw new Error("projet non précisé");
    const r = real(resolve(root));
    if (!isDir(r)) throw new Error("dossier du projet introuvable");
    const rel = relative(real(this.base()), r);
    const underBase = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    if (underBase || this.registered().includes(r)) return r;
    throw new Error("dossier hors des projets Relay");
  }

  list(): ProjectInfo[] {
    const base = this.base();
    const roots = new Set<string>(this.registered().filter(isDir));
    if (isDir(base)) {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".")) roots.add(real(join(base, e.name)));
      }
    }
    return [...roots]
      .map((root) => {
        const messages = loadConversation(root);
        const last = [...messages].reverse().find((m) => m.role === "user");
        const updated = messages.length > 0 ? Date.parse(messages.at(-1)?.at ?? "") || statSync(root).mtimeMs : statSync(root).mtimeMs;
        return { name: basename(root), root, updated, messages: messages.length, ...(last !== undefined ? { last: last.text.slice(0, 160) } : {}) };
      })
      .sort((a, b) => b.updated - a.updated);
  }
}

/** Un dossier existant à toi peut devenir un projet — pas la racine, ton dossier personnel ou Relay lui-même. */
export function checkImportable(root: string, forbidden: string[]): string {
  const r = real(resolve(expandPath(root)));
  if (!isAbsolute(expandPath(root))) throw new Error("chemin absolu attendu (ou commençant par ~/)");
  if (!isDir(r)) throw new Error("dossier introuvable");
  const bad = ["/", homedir(), ...forbidden].map((f) => real(f));
  if (bad.includes(r)) throw new Error("ce dossier ne peut pas être un projet (trop large, ou c'est Relay lui-même)");
  return r;
}

// ── Conversation et mémoire ────────────────────────────────────────────────

export function loadConversation(root: string): ConversationMessage[] {
  try {
    const raw = JSON.parse(readFileSync(conversationFile(root), "utf8")) as { messages?: unknown };
    return Array.isArray(raw.messages) ? (raw.messages as ConversationMessage[]) : [];
  } catch {
    return [];
  }
}

export function appendMessage(root: string, message: Omit<ConversationMessage, "id" | "at">): ConversationMessage {
  const full: ConversationMessage = { id: crypto.randomUUID(), at: new Date().toISOString(), ...message };
  const messages = loadConversation(root);
  messages.push(full);
  mkdirSync(join(root, ".relay"), { recursive: true });
  writeFileSync(conversationFile(root), `${JSON.stringify({ messages }, null, 2)}\n`);
  return full;
}

export function readMemory(root: string): string {
  try {
    return readFileSync(memoryFile(root), "utf8");
  } catch {
    return "";
  }
}

export function writeMemory(root: string, text: string): void {
  writeFileSync(memoryFile(root), text.endsWith("\n") || text.length === 0 ? text : `${text}\n`);
}

/** Conversation récente, condensée, pour le planificateur et les agents. */
export function conversationContext(messages: ConversationMessage[], budget = 4_000): string {
  if (messages.length === 0) return "";
  const lines = messages.map((m) => {
    const who = m.role === "user" ? (m.kind === "fix" ? "Toi (correction)" : m.kind === "answer" ? "Toi (réponses)" : "Toi") : "Relay";
    const body =
      m.kind === "questions"
        ? `questions : ${(m.questions ?? []).map((q) => q.question).join(" / ")}`
        : m.kind === "result"
          ? `${m.outcome === "done" ? "terminé" : m.outcome === "failed" ? "échec" : "arrêté"} — ${m.text}`
          : m.text;
    return `- ${who} : ${body.replace(/\s+/g, " ").slice(0, 700)}`;
  });
  const kept: string[] = [];
  let used = 0;
  for (const l of lines.reverse()) {
    if (kept.length > 0 && used + l.length > budget) break;
    kept.unshift(l);
    used += l.length;
  }
  return `## Conversation récente avec l'utilisateur\n${kept.join("\n")}`;
}
