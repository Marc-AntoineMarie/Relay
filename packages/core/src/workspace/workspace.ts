/**
 * Dossier de travail d'un run : les tâches y écrivent leurs fichiers pour de vrai.
 * Tout chemin est confiné au dossier (pas de chemin absolu, pas de `..`, pas de sortie
 * via un lien symbolique).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Dossiers ignorés dans les listes et aperçus (dépendances, caches, VCS). */
const IGNORED = new Set([".relay", ".git", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", "dist", "build", ".idea"]);
const MAX_FILES = 400;

export interface WorkspaceFile {
  path: string;
  size: number;
}

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  /** Chemin absolu d'un chemin relatif, confiné au dossier. */
  resolve(rel: string): string {
    const clean = rel.trim().replace(/^\.\/+/, "");
    if (clean.length === 0 || isAbsolute(clean) || clean.includes("\0")) {
      throw new WorkspaceError(`chemin refusé : ${rel}`);
    }
    const abs = resolve(this.root, clean);
    if (!this.inside(abs)) throw new WorkspaceError(`chemin hors du dossier de travail : ${rel}`);
    // Un lien symbolique existant ne doit pas faire sortir du dossier.
    let probe = abs;
    while (!existsSync(probe) && probe !== this.root) probe = dirname(probe);
    if (!this.inside(realpathSync(probe), realpathSync(this.root))) {
      throw new WorkspaceError(`chemin hors du dossier de travail : ${rel}`);
    }
    return abs;
  }

  write(rel: string, content: string): { path: string; bytes: number; created: boolean } {
    const abs = this.resolve(rel);
    const created = !existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { path: this.relPath(abs), bytes: Buffer.byteLength(content), created };
  }

  read(rel: string, maxBytes = 200_000): string {
    const abs = this.resolve(rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new WorkspaceError(`fichier introuvable : ${rel}`);
    const buf = readFileSync(abs);
    if (buf.includes(0)) throw new WorkspaceError(`fichier binaire : ${rel}`);
    return buf.length > maxBytes ? `${buf.subarray(0, maxBytes).toString("utf8")}\n[…tronqué]` : buf.toString("utf8");
  }

  list(): WorkspaceFile[] {
    const out: WorkspaceFile[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= MAX_FILES) return;
        if (IGNORED.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) out.push({ path: this.relPath(abs), size: statSync(abs).size });
      }
    };
    walk(this.root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Aperçu pour un prompt : liste des fichiers + contenu des petits fichiers texte, dans un budget. */
  snapshot(budget = 12_000): string {
    const files = this.list();
    if (files.length === 0) return "(dossier vide)";
    const listing = files.map((f) => `- ${f.path} (${f.size} o)`).join("\n");
    const contents: string[] = [];
    let used = 0;
    for (const f of files) {
      if (f.size > 12_000) continue;
      let text: string;
      try {
        text = this.read(f.path);
      } catch {
        continue;
      }
      if (used + text.length > budget) break;
      used += text.length;
      contents.push(`--- ${f.path} ---\n${text}`);
    }
    const omitted = contents.length < files.length ? "\n(fichiers non affichés : demande-les avec ===READ: chemin===)" : "";
    return `${listing}${omitted}\n\n${contents.join("\n\n")}`;
  }

  private inside(abs: string, root = this.root): boolean {
    return abs === root || abs.startsWith(root + sep);
  }

  private relPath(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }
}
