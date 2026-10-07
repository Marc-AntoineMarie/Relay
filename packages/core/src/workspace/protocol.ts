/**
 * Protocole d'action texte : le modèle agit sur le dossier de travail en écrivant des
 * balises dans sa réponse. Choisi plutôt que l'appel d'outils natif pour fonctionner avec
 * tous les fournisseurs (Gemini, Groq, Claude Code…) et grouper plusieurs fichiers par
 * réponse (moins d'allers-retours, donc moins de tokens).
 */

export interface AgentActions {
  files: Array<{ path: string; content: string }>;
  runs: string[];
  reads: string[];
}

const FILE_RE = /^===FILE:\s*(.+?)\s*===[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?===END===[ \t]*$/gm;
const RUN_RE = /^===RUN:\s*(.+?)\s*===[ \t]*$/gm;
const READ_RE = /^===READ:\s*(.+?)\s*===[ \t]*$/gm;

export const ACTION_PROTOCOL = `## Protocole d'action (pour agir réellement sur le dossier de travail)
Créer ou remplacer un fichier — contenu COMPLET, sans bloc de code autour :
===FILE: chemin/relatif/fichier.py===
…contenu du fichier…
===END===
Lancer une commande dans le dossier (tests, exécution) — une ligne par commande :
===RUN: python3 -m unittest -v===
Lire un fichier existant avant de le modifier :
===READ: chemin/relatif/fichier.py===

Règles :
- Chemins relatifs au dossier de travail. Écris toujours le fichier entier, jamais un extrait.
- Pas de commande interactive ni de serveur qui ne s'arrête pas ; pas d'installation de paquets :
  utilise la bibliothèque standard (ex. unittest en Python).
- Après tes commandes, tu recevras leur sortie et pourras corriger.
- Termine par une phrase de résumé de ce que tu as fait.`;

/** Extrait les actions d'une réponse. Les RUN/READ à l'intérieur d'un fichier sont ignorés. */
export function parseActions(text: string): AgentActions {
  const files = [...text.matchAll(FILE_RE)].map((m) => ({
    path: (m[1] ?? "").trim(),
    content: normalizeContent(m[2] ?? ""),
  }));
  const outside = text.replace(FILE_RE, "");
  return {
    files,
    runs: [...outside.matchAll(RUN_RE)].map((m) => (m[1] ?? "").trim()).filter((c) => c.length > 0),
    reads: [...outside.matchAll(READ_RE)].map((m) => (m[1] ?? "").trim()).filter((p) => p.length > 0),
  };
}

/** Remplace les blocs de fichiers par une mention courte (résultat transmis aux tâches suivantes). */
export function condense(text: string): string {
  return text
    .replace(FILE_RE, (_all, path: string) => `[fichier écrit : ${path.trim()}]`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Retire un éventuel bloc de code Markdown englobant et garantit une fin de ligne. */
function normalizeContent(raw: string): string {
  const fenced = /^```[\w.+-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(raw);
  const body = fenced?.[1] ?? raw;
  return body.length === 0 || body.endsWith("\n") ? body : `${body}\n`;
}
